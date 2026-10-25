"""Update check against GitHub releases, background download, installer hand-off.

check() asks the pinned repo's latest-release endpoint whether a newer version
exists (cached; at most one network call per _CACHE_TTL_S unless forced) and
tells the updater what it found. The updater (one per backend) downloads the
Windows Setup asset in a worker thread, streamed into a fresh
``quickterm-update-*`` temp folder while its SHA-256 is computed, and checks
it against the release's SHA256SUMS.txt. install() re-verifies the file and
starts Setup with /SILENT. The Inno Setup installer replaces the program
folder; the backend runs from its own copy (pty_host.py), so its terminals
keep running through the install.

States: idle (nothing newer known), available, downloading, verifying, ready,
installing, installed (Setup succeeded but this backend was kept), failed. status() is what GET /api/update/status serves.

Trust model: only https URLs from the pinned REPO's release payload are ever
fetched, every final URL after redirects is re-checked against the GitHub
hosts, and the installer must hash-match the checksums file published by the
same release, once when downloaded and again right before it runs. Stdlib
urllib only; network calls never run on the event loop.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from quickterm import __version__, update_win

REPO = "devincii-io/quickterm"
API_LATEST = f"https://api.github.com/repos/{REPO}/releases/latest"
RELEASES_URL = f"https://github.com/{REPO}/releases/latest"
_SUMS_NAME = "SHA256SUMS.txt"
_CACHE_TTL_S = 6 * 3600
_MAX_SETUP_BYTES = 200 * 1024 * 1024
_MAX_METADATA_BYTES = 2 * 1024 * 1024
_CHUNK_BYTES = 256 * 1024
_DOWNLOAD_TIMEOUT_S = 60
_ALLOWED_DOWNLOAD_HOSTS = {
    "api.github.com",
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
}
# A tag ends up in a file name and on a command line.
_VERSION_RE = re.compile(r"[0-9A-Za-z][0-9A-Za-z.\-]{0,40}")
_SHA256_RE = re.compile(r"[0-9a-fA-F]{64}")

_cache: dict | None = None
_cache_at = 0.0


def _on_windows() -> bool:
    return os.name == "nt"


class UpdateNotReady(Exception):
    """Install was asked for while no verified installer is ready (409)."""


@dataclass(frozen=True)
class Release:
    version: str
    notes_url: str
    notes: str
    setup_name: str | None
    setup_url: str | None
    setup_size: int | None
    sums_url: str | None

    @property
    def installable(self) -> bool:
        return (
            _on_windows()
            and self.setup_url is not None
            and self.sums_url is not None
            and self.setup_size is not None
            and 0 < self.setup_size <= _MAX_SETUP_BYTES
        )


def _validate_download_url(url: str) -> None:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in _ALLOWED_DOWNLOAD_HOSTS:
        raise ValueError(f"refusing non-GitHub https url: {url}")


def _open(url: str, timeout: int) -> Any:
    """An open response for a pinned-host https URL, its final URL re-checked."""
    _validate_download_url(url)
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": f"quickterm/{__version__}",
        },
    )
    resp = urllib.request.urlopen(req, timeout=timeout)
    try:
        # urllib follows redirects. Re-check the final location so a poisoned
        # redirect cannot move downloads outside GitHub's asset infrastructure.
        _validate_download_url(resp.geturl())
    except BaseException:
        resp.close()
        raise
    return resp


def _get(url: str, timeout: int = 15, max_bytes: int = _MAX_METADATA_BYTES) -> bytes:
    with _open(url, timeout) as resp:
        data: bytes = resp.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ValueError(f"download exceeds {max_bytes} bytes")
        return data


def _version_tuple(v: str) -> tuple[int, ...]:
    parts = []
    for piece in v.strip().lstrip("v").split("."):
        m = re.match(r"\d+", piece)
        parts.append(int(m.group()) if m else 0)
    return tuple(parts) or (0,)


def is_newer(latest: str, current: str) -> bool:
    a, b = _version_tuple(latest), _version_tuple(current)
    width = max(len(a), len(b))
    return a + (0,) * (width - len(a)) > b + (0,) * (width - len(b))


def _notes_url(value: Any) -> str:
    # Opened through POST /api/open, so only the pinned repo's release pages.
    url = str(value or "")
    if url.startswith(f"https://github.com/{REPO}/releases"):
        return url
    return RELEASES_URL


def _parse_release(data: dict) -> Release:
    latest = str(data.get("tag_name") or "").lstrip("v")
    if latest and not _VERSION_RE.fullmatch(latest):
        latest = ""
    assets = data.get("assets") or []

    def _asset(name: str) -> dict | None:
        return next((a for a in assets if str(a.get("name", "")) == name), None)

    setup = _asset(f"QuickTerm-v{latest}-Setup.exe") if latest else None
    sums = _asset(_SUMS_NAME)
    size: int | None = None
    if setup is not None:
        try:
            size = int(setup.get("size", 0))
        except (TypeError, ValueError):
            size = None
    return Release(
        version=latest,
        notes_url=_notes_url(data.get("html_url")),
        notes=(data.get("body") or "")[:2000],
        setup_name=str(setup["name"]) if setup else None,
        setup_url=str(setup.get("browser_download_url") or "") or None if setup else None,
        setup_size=size,
        sums_url=str(sums.get("browser_download_url") or "") or None if sums else None,
    )


def check(force: bool = False) -> dict:
    """Latest-release probe. Raises on network failure (caller maps to 502)."""
    global _cache, _cache_at
    if not force and _cache is not None and time.monotonic() - _cache_at < _CACHE_TTL_S:
        return _cache
    release = _parse_release(json.loads(_get(API_LATEST)))
    available = bool(release.version) and is_newer(release.version, __version__)
    result = {
        "current": __version__,
        "latest": release.version,
        "update_available": available,
        "url": release.notes_url,
        "notes": release.notes,
        "installable": available and release.installable,
    }
    _updater.note_release(release if available else None)
    _cache, _cache_at = result, time.monotonic()
    return result


def _one_line(exc: BaseException) -> str:
    text = " ".join(str(exc).split()) or type(exc).__name__
    return text[:200]


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


class Updater:
    """The one download per backend and the state the card shows."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.state = "idle"
        self.version: str | None = None
        self.notes_url: str | None = None
        self.received = 0
        self.total: int | None = None
        self.error: str | None = None
        self._release: Release | None = None
        self._path: Path | None = None
        self._digest: str | None = None
        self._thread: threading.Thread | None = None
        # Update folders this backend created, the only ones a fresh sweep removes.
        self._made: set[Path] = set()
        # The installed QuickTerm.exe to start for "Restart now" once installed.
        self._launcher: Path | None = None

    def status(self) -> dict:
        with self._lock:
            return {
                "state": self.state,
                "version": self.version,
                "received": self.received,
                "total": self.total,
                "error": self.error,
                "notes_url": self.notes_url,
                "can_restart": self.state == "installed" and self._launcher is not None,
            }

    def note_release(self, release: Release | None) -> None:
        """What the latest check found: a newer release, or None."""
        with self._lock:
            if self.state in ("downloading", "verifying", "installing"):
                return
            if self.state == "installed" and (release is None or release.version == self.version):
                # Installed, waiting for a restart: only a newer release replaces it.
                return
            if release is not None and not release.installable:
                release = None
            if release is not None and release.version == self.version:
                # Same version: keep a ready file and a failure as they are.
                self._release = release
                self.notes_url = release.notes_url
                if self.state == "idle":
                    self.state = "available"
                return
            stale = self._path
            self._release = release
            self._path = self._digest = None
            self.received, self.total, self.error = 0, None, None
            if release is None:
                self.state, self.version, self.notes_url = "idle", None, None
            else:
                self.state, self.version = "available", release.version
                self.notes_url = release.notes_url
        if stale is not None:
            shutil.rmtree(stale.parent, ignore_errors=True)

    def start_download(self) -> bool:
        """Start the download, or join the one running. True when it started."""
        if not _on_windows():
            raise ValueError("in-app update is only available on Windows")
        with self._lock:
            if self.state in ("downloading", "verifying", "ready", "installing", "installed"):
                return False
            release = self._release
            if release is None or not release.installable:
                raise ValueError("no installable update is available")
            self.state = "downloading"
            self.received, self.total, self.error = 0, None, None
            self.version, self.notes_url = release.version, release.notes_url
            thread = threading.Thread(
                target=self._run, args=(release,), name="quickterm-update", daemon=True
            )
            self._thread = thread
        thread.start()
        return True

    def wait(self, timeout: float | None = None) -> None:
        """Test seam: block until the running download finished."""
        thread = self._thread
        if thread is not None:
            thread.join(timeout)

    def _run(self, release: Release) -> None:
        try:
            path, digest = self._download(release)
        except Exception as exc:
            with self._lock:
                self.state, self.error = "failed", _one_line(exc)
            return
        with self._lock:
            self.state, self._path, self._digest = "ready", path, digest

    def _download(self, release: Release) -> tuple[Path, str]:
        assert release.setup_url and release.sums_url and release.setup_name
        # The checksum first: without one there is nothing to download for.
        sums_text = _get(release.sums_url).decode("utf-8", "replace")
        wanted = _expected_hash(sums_text, release.setup_name)
        if wanted is None or not _SHA256_RE.fullmatch(wanted):
            raise ValueError(f"{_SUMS_NAME} has no valid checksum for the installer")
        # Nothing of this backend is in use here: a download never runs while
        # an installer is ready or installing.
        _sweep_old_update_dirs(self._made)
        update_dir = Path(tempfile.mkdtemp(prefix="quickterm-update-"))
        self._made.add(update_dir)
        try:
            final = update_dir / release.setup_name
            part = update_dir / (release.setup_name + ".part")
            digest = hashlib.sha256()
            received = 0
            with _open(release.setup_url, _DOWNLOAD_TIMEOUT_S) as resp, part.open("wb") as fh:
                total = _content_length(resp)
                if total is not None and total > _MAX_SETUP_BYTES:
                    raise ValueError("installer is implausibly large")
                with self._lock:
                    self.total = total
                while chunk := resp.read(_CHUNK_BYTES):
                    received += len(chunk)
                    if received > _MAX_SETUP_BYTES:
                        raise ValueError(f"download exceeds {_MAX_SETUP_BYTES} bytes")
                    digest.update(chunk)
                    fh.write(chunk)
                    with self._lock:
                        self.received = received
            with self._lock:
                self.state = "verifying"
            actual = digest.hexdigest()
            if actual != wanted.lower():
                raise ValueError("installer failed checksum verification")
            part.replace(final)
            return final, actual
        except BaseException:
            shutil.rmtree(update_dir, ignore_errors=True)
            raise

    def install(self) -> dict:
        """Re-verify the ready installer and hand over to it.

        The script and the installer are written and locked first (no writer,
        no rename, no delete while the handles are open), then hashed and
        compared through those handles, and stay locked until Setup is over,
        so neither can be swapped between the check and the run.
        """
        with self._lock:
            if self.state != "ready" or self._path is None or self._digest is None:
                raise UpdateNotReady("no verified installer is ready")
            path, wanted, version = self._path, self._digest, self.version
            self.state = "installing"
        locks: list[int] = []
        try:
            script = _write_handover_script(path.parent)
            locks.append(update_win.open_locked(script))
            locks.append(update_win.open_locked(path))
            intact = (
                update_win.read_all(locks[0]) == _HANDOVER_SCRIPT.encode("ascii")
                and update_win.sha256_fd(locks[1]) == wanted
            )
        except OSError:
            intact = False
        if not intact:
            _close_all(locks)
            self._fail("the downloaded installer changed on disk; download it again", path)
            raise UpdateNotReady("installer failed checksum verification")
        relaunch = _relaunch_target()
        try:
            handover = _launch_installer(path, relaunch, script)
        except OSError as exc:
            _close_all(locks)
            self._fail(f"Setup could not be started: {_one_line(exc)}", path)
            raise
        # Only now that Setup runs: one that runs from its versioned copy
        # (pty_host.py) holds no file Setup replaces and stays with its
        # terminals; the new version's launcher, started once Setup is done,
        # takes over when nothing is busy or touched and asks otherwise. One
        # that runs from the install folder (the elevated instance, or a backend
        # whose copy could not be made) quits, or Setup would stall on it or kill
        # it mid-install; so does a source checkout. A failed start above leaves
        # it running.
        _request_app_shutdown()
        waiter = threading.Thread(
            target=self._await_setup, args=(handover, locks, path, wanted, version, relaunch),
            name="quickterm-update-setup", daemon=True,
        )
        self._thread = waiter
        waiter.start()
        return {"launched": True, "version": version}

    def _await_setup(
        self, handover: Any, locks: list[int], path: Path, wanted: str, version: str | None,
        launcher: Path | None = None,
    ) -> None:
        """Setup ended (or never reported back) and this backend still runs.

        A successful update usually replaces this backend before this point.
        Still being here after Setup returned 0 means the hand-over to the
        new launcher was declined: the new version is installed and waits for
        a restart. A failed Setup, a cancelled UAC prompt or no answer within
        the timeout offers the install again; the card must not stay on
        "installing" for good.
        """
        code: int | None = None
        try:
            code = handover.wait(_SETUP_TIMEOUT_S)
        except Exception:
            code = None
        finally:
            _close_all(locks)
        with self._lock:
            if self.state != "installing" or self.version != version:
                return
        if code == 0:
            with self._lock:
                self.state, self.error = "installed", None
                self._path = self._digest = None
                self._launcher = launcher
            shutil.rmtree(path.parent, ignore_errors=True)
            return
        try:
            intact = _file_sha256(path) == wanted
        except OSError:
            intact = False
        if intact:
            with self._lock:
                self.state, self.error = "ready", None
        else:
            self._fail("Setup did not finish", path)

    def restart(self) -> dict:
        """Start the installed launcher, as Setup's hand-over would have.

        That launcher finds this older backend and replaces it at once when
        no terminal is busy or touched, and asks otherwise (pty_host.py).
        """
        with self._lock:
            if self.state != "installed" or self._launcher is None:
                raise UpdateNotReady("no installed update waits for a restart")
            launcher = self._launcher
        _start_launcher(launcher)
        return {"started": True}

    def _fail(self, error: str, path: Path | None) -> None:
        with self._lock:
            self.state, self.error = "failed", error
            self._path = self._digest = None
        if path is not None:
            shutil.rmtree(path.parent, ignore_errors=True)


def _content_length(resp: Any) -> int | None:
    headers = getattr(resp, "headers", None)
    value = headers.get("Content-Length") if headers is not None else None
    try:
        length = int(str(value))
    except (TypeError, ValueError):
        return None
    return length if length >= 0 else None


_updater = Updater()


def status() -> dict:
    return _updater.status()


def start_download() -> bool:
    return _updater.start_download()


def install() -> dict:
    return _updater.install()


def restart() -> dict:
    return _updater.restart()


def _start_launcher(exe: Path) -> None:
    """Start the installed QuickTerm.exe detached, the way Setup's last step did."""
    if not exe.is_file():
        raise UpdateNotReady("the installed QuickTerm was not found")
    _launch_detached(exe)


def _relaunch_target() -> Path | None:
    """The installed QuickTerm.exe to start once Setup is done, if known.

    Setup's own "Launch QuickTerm" step is skipped under /SILENT
    (packaging/quickterm.iss, skipifsilent), so the hand-over starts the new
    launcher itself. Asked before Setup runs: the answer compares build ids.
    """
    try:
        import quickterm.pty_host as pty_host

        return pty_host.install_executable()
    except Exception:
        return None


# Runs Setup, waits for it, starts the new launcher when Setup succeeded, and
# exits with Setup's code. Paths come in as arguments, so the file is plain
# ASCII whatever the user's folder names are.
_HANDOVER_SCRIPT = (
    "@echo off\r\n"
    '"%~1" /SILENT\r\n'
    "set rc=%errorlevel%\r\n"
    'if "%rc%"=="0" if not "%~2"=="" start "" "%~2"\r\n'
    "exit /b %rc%\r\n"
)
_HANDOVER_NAME = "handover.cmd"
# Characters cmd.exe would act on in the unquoted stretches of the line below.
_CMD_UNSAFE = set('"%&|<>^')
# How long the updater waits for Setup before it offers the install again.
_SETUP_TIMEOUT_S = 30 * 60


def _write_handover_script(folder: Path) -> Path:
    script = folder / _HANDOVER_NAME
    script.write_bytes(_HANDOVER_SCRIPT.encode("ascii"))
    return script


def _close_all(fds: list[int]) -> None:
    for fd in fds:
        try:
            os.close(fd)
        except OSError:
            pass
    fds.clear()


def _launch_installer(path: Path, relaunch: Path | None, script: Path) -> Any:
    """Start Setup silently so it outlives us and is not part of our tree.

    Returns an object whose ``wait(timeout)`` ends with the hand-over.

    A bare ``Popen`` leaves Setup a *child* of the process it is replacing. Two
    things go wrong with a child: it dies with any process-tree cleanup aimed at
    QuickTerm, and it shares our console and job object, so the moment the app
    quits for the upgrade the installer can go with it.

    ``CREATE_BREAKAWAY_FROM_JOB`` fixes the job membership but *not* the
    recorded parent, which is why everything goes through ``cmd /c start``:
    that intermediary exits immediately and leaves the hand-over script (and
    Setup under it) with no live ancestor, so a ``taskkill /T`` aimed at
    QuickTerm can never reach it. The script runs in the intermediary's hidden
    console (``CREATE_NO_WINDOW`` plus ``start /b``), so no window flashes.
    update_win.launch then finds that script's process and holds a handle.
    """
    if os.name != "nt":
        subprocess.Popen([str(path)], close_fds=True)  # noqa: S603
        return update_win.Handover(None, fallback_wait=True)
    flags = 0
    for name in ("CREATE_NO_WINDOW", "CREATE_NEW_PROCESS_GROUP", "CREATE_BREAKAWAY_FROM_JOB"):
        flags |= getattr(subprocess, name, 0)
    target = str(relaunch) if relaunch is not None else ""
    parts = (str(script), str(path), target)
    if any(_CMD_UNSAFE & set(part) for part in parts):
        _launch_detached(path, ["/SILENT"])
        return update_win.Handover(None, fallback_wait=True)
    # The inner cmd /c strips the outermost quote pair (more than two quotes),
    # leaving the three quoted arguments. "" is start's title argument.
    command = f'cmd.exe /d /c start "" /b cmd.exe /d /c ""{script}" "{path}" "{target}""'
    return update_win.launch(command, flags)


def _launch_detached(path: Path, args: list[str] | None = None) -> None:
    """Plain detached start of Setup, without the relaunch afterwards."""
    flags = 0
    for name in ("DETACHED_PROCESS", "CREATE_NEW_PROCESS_GROUP", "CREATE_BREAKAWAY_FROM_JOB"):
        flags |= getattr(subprocess, name, 0)
    # The empty "" is start's title argument; without it a quoted path is
    # swallowed as the window title and nothing runs.
    command = ["cmd.exe", "/c", "start", "", "/b", str(path), *(args or [])]
    try:
        subprocess.Popen(command, close_fds=True, creationflags=flags)  # noqa: S603
    except OSError:
        # A job object that forbids breakaway rejects the flag outright. A
        # child installer still beats no installer.
        subprocess.Popen([str(path), *(args or [])], close_fds=True)  # noqa: S603


def _request_app_shutdown() -> None:
    # pty_host, not app: in the frozen build app.py is __main__, so importing
    # quickterm.app made a second copy whose host was never set.
    try:
        import quickterm.pty_host as pty_host

        pty_host.begin_update()
    except Exception:  # headless/test runs have no host
        pass


_SWEEP_AGE_S = 24 * 3600


def _sweep_old_update_dirs(own: set[Path] | None = None) -> None:
    """Remove installers left behind by earlier in-app updates (up to 200 MB each).

    Only folders this backend made, or ones older than a day: a second
    backend on another port may hold a ready installer of its own.
    """
    own = own or set()
    cutoff = time.time() - _SWEEP_AGE_S
    try:
        for entry in Path(tempfile.gettempdir()).glob("quickterm-update-*"):
            try:
                if not entry.is_dir():
                    continue
                if entry in own or entry.stat().st_mtime < cutoff:
                    shutil.rmtree(entry, ignore_errors=True)
                    own.discard(entry)
            except OSError:
                continue
    except OSError:
        pass


def _expected_hash(sums_text: str, filename: str) -> str | None:
    for line in sums_text.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[-1].strip("*") == filename:
            return parts[0]
    return None
