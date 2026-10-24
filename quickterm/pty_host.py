"""The PTY host: the backend process that owns the terminals, apart from the window.

One program, three roles, chosen by `app.main()`:

- **launcher** (`QuickTerm.exe`, no role flag): finds the backend through the
  verified health probe or starts it detached, asks it for a window and exits.
- **backend** (`--serve`): server, session manager, global hotkeys and the tray
  icon. When the program is frozen it runs from a versioned copy under
  `host_root()`, so an installer can replace the program files while every
  terminal keeps running.
- **viewer** (`--viewer`): the pywebview windows. The backend starts it as a
  child and talks to it over the child's stdin and stdout, one JSON object per
  line. Closing the last window ends the viewer; the backend then stays only
  while it holds something worth keeping (the old close-to-tray rule).

Everything here is stdlib only and never runs on the event loop: spawning,
waiting for a viewer and the Win32 window work happen on the tray thread, the
hotkey thread, the control reader thread or a route's worker thread.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from quickterm import __version__

log = logging.getLogger("quickterm.host")

HOST_EXE = "QuickTerm-host.exe"
INSTALL_EXE = "QuickTerm.exe"
COMPLETE_MARKER = ".complete"
SOURCE_FILE = ".source"
# A copy is ~100 MB: the running build plus one more (normally the previous
# backend, still running until it has nothing left to keep) is the budget.
KEEP_OTHER_BUILDS = 1
STALE_STAGING_S = 600.0
CHECK_INTERVAL_S = 15.0
# A backend nobody ever opened a window on (its launcher died) leaves after
# this long when it holds nothing worth keeping.
ORPHAN_GRACE_S = 60.0
VIEWER_READY_S = 30.0
OPEN_TIMEOUT_S = 20.0
QUIT_WAIT_S = 5.0
_ASFW_ANY = 0xFFFFFFFF

# ---------------------------------------------------------------------------
# The versioned copy
# ---------------------------------------------------------------------------


def host_root() -> Path:
    """Where the backend copies live. `QUICKTERM_HOST_DIR` isolates smoke runs."""
    override = os.environ.get("QUICKTERM_HOST_DIR")
    if override:
        return Path(override)
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "QuickTerm" / "host"


def frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def build_id(folder: Path, exe_name: str = INSTALL_EXE) -> str:
    """Version plus a fingerprint of the executable.

    Inno Setup keeps the build's file times, so reinstalling one build gives
    the same id and an update a new one; a rebuild of one version differs too.
    """
    stat = (folder / exe_name).stat()
    digest = hashlib.sha256(f"{stat.st_size}:{stat.st_mtime_ns}".encode()).hexdigest()[:10]
    return f"{__version__}-{digest}"


def running_build() -> str:
    """This process's build: the copy's folder name, the install's id, or dev."""
    if not frozen():
        return f"{__version__}-dev"
    exe = Path(sys.executable).resolve()
    if exe.name.lower() == HOST_EXE.lower():
        return exe.parent.name
    try:
        return build_id(exe.parent, exe.name)
    except OSError:
        return __version__


def running_from_copy() -> bool:
    return frozen() and Path(sys.executable).name.lower() == HOST_EXE.lower()


def _is_complete(folder: Path) -> bool:
    return (folder / COMPLETE_MARKER).is_file() and (folder / HOST_EXE).is_file()


def ensure_copy(
    source: Path, root: Path, build: str, *, exe_name: str = INSTALL_EXE
) -> Path:
    """The backend executable of `build` under `root`, copied from `source` once.

    The copy is staged under a private name and renamed into place with its
    completion marker already inside, so a reader never sees half a copy and two
    launchers racing each other end up sharing the winner's folder. The
    executable is renamed to `HOST_EXE`: the installer closes `QuickTerm.exe`
    by image name, and that must never reach a backend.
    """
    target = root / build
    if _is_complete(target):
        _touch(target / COMPLETE_MARKER)
        return target / HOST_EXE
    root.mkdir(parents=True, exist_ok=True)
    staging = root / f".staging-{build}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
    try:
        shutil.copytree(source, staging, ignore=shutil.ignore_patterns("unins*"))
        os.replace(staging / exe_name, staging / HOST_EXE)
        (staging / SOURCE_FILE).write_text(str(source / exe_name), encoding="utf-8")
        (staging / COMPLETE_MARKER).write_text(build, encoding="utf-8")
        if target.exists() and not _is_complete(target) and not discard(target):
            raise OSError(f"an incomplete copy of {build} is in use")
        try:
            os.rename(staging, target)
        except OSError:
            if not _is_complete(target):
                raise
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
    return target / HOST_EXE


def _touch(path: Path) -> None:
    try:
        os.utime(path)
    except OSError:
        pass


def _last_used(folder: Path) -> float:
    try:
        return (folder / COMPLETE_MARKER).stat().st_mtime
    except OSError:
        return 0.0


def discard(folder: Path) -> bool:
    """Delete one copy unless something runs from it. Returns whether it went.

    Windows lets a folder be renamed while a program inside it runs, but it
    refuses to delete a running executable, so deleting the host executable
    first is the test; a copy without it can no longer be started.
    """
    exe = folder / HOST_EXE
    try:
        exe.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        return False
    trash = folder.with_name(f".trash-{folder.name}-{uuid.uuid4().hex[:6]}")
    try:
        os.rename(folder, trash)
    except OSError:
        trash = folder
    shutil.rmtree(trash, ignore_errors=True)
    return True


def prune(root: Path, keep: str, *, others: int = KEEP_OTHER_BUILDS) -> list[str]:
    """Remove copies beyond `keep` and the `others` most recently used ones.

    A copy that is still running survives, whatever its age: its backend may
    hold terminals the user has not decided about yet.
    """
    try:
        entries = list(root.iterdir())
    except OSError:
        return []
    now = time.time()
    builds: list[Path] = []
    for entry in entries:
        if not entry.is_dir():
            continue
        if entry.name.startswith(".trash-"):
            shutil.rmtree(entry, ignore_errors=True)
        elif entry.name.startswith(".staging-"):
            # Another launcher may be copying right now; only an old one is junk.
            try:
                stale = now - entry.stat().st_mtime > STALE_STAGING_S
            except OSError:
                stale = False
            if stale:
                shutil.rmtree(entry, ignore_errors=True)
        elif entry.name != keep:
            builds.append(entry)
    builds.sort(key=_last_used, reverse=True)
    removed: list[str] = []
    for folder in builds[others:]:
        if discard(folder):
            removed.append(folder.name)
    return removed


# ---------------------------------------------------------------------------
# Processes
# ---------------------------------------------------------------------------


def program_command(argv: list[str]) -> list[str]:
    """This program with `argv`: the executable when frozen, else the source."""
    if frozen():
        return [sys.executable, *argv]
    return [sys.executable, "-c", "from quickterm.app import main; main()", *argv]


def _home() -> str:
    try:
        return str(Path.home())
    except (OSError, RuntimeError):
        return os.getcwd()


def spawn_backend(command: list[str]) -> subprocess.Popen:
    """Start a backend that outlives the launcher, its console and its job.

    CREATE_NO_WINDOW gives a console program (the source checkout's python.exe)
    a console without a window, which is what the terminals' console programs
    inherit; the frozen GUI build ignores it and allocates its hidden console in
    pty_session. Breaking away from the job matters when QuickTerm is started
    from a terminal whose host kills its job on close (Windows Terminal, VS
    Code): the backend would otherwise go with that tab.
    """
    options: dict[str, Any] = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
        "cwd": _home(),
    }
    if sys.platform != "win32":
        return subprocess.Popen(command, start_new_session=True, **options)
    flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    try:
        return subprocess.Popen(
            command, creationflags=flags | subprocess.CREATE_BREAKAWAY_FROM_JOB, **options
        )
    except OSError:
        # A job that forbids breakaway refuses the flag outright.
        return subprocess.Popen(command, creationflags=flags, **options)


def spawn_viewer(command: list[str]) -> subprocess.Popen:
    """Start the viewer as a child whose stdin and stdout are the control channel."""
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        cwd=_home(),
        creationflags=flags,
    )


def allow_foreground(pid: int = _ASFW_ANY) -> None:
    """Pass this process's right to take the foreground on (Windows only).

    A window the backend shows or a viewer it starts would otherwise only
    flash in the taskbar: the click or hotkey press went to another process.
    """
    if os.name != "nt":
        return
    try:
        import ctypes

        ctypes.windll.user32.AllowSetForegroundWindow(ctypes.c_uint32(pid).value)
    except Exception:
        log.debug("AllowSetForegroundWindow failed", exc_info=True)


# ---------------------------------------------------------------------------
# The control channel: one JSON object per line
# ---------------------------------------------------------------------------


def encode(message: dict[str, Any]) -> bytes:
    return (json.dumps(message, separators=(",", ":")) + "\n").encode("utf-8")


def decode(line: bytes) -> dict[str, Any] | None:
    try:
        value = json.loads(line.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


class ViewerChannel:
    """The viewer's end: commands arrive on stdin, events leave on stdout.

    The frozen build is a GUI program, where `sys.stdin` and `sys.stdout` are
    None even when the parent handed it pipes, so this reads the descriptors.
    """

    def __init__(self, reader: Any | None = None, writer: Any | None = None) -> None:
        self._reader = reader if reader is not None else open(0, "rb", buffering=0, closefd=False)
        self._writer = writer if writer is not None else open(1, "wb", buffering=0, closefd=False)
        self._lock = threading.Lock()

    def send(self, message: dict[str, Any]) -> bool:
        data = encode(message)
        with self._lock:
            try:
                self._writer.write(data)
                flush = getattr(self._writer, "flush", None)
                if flush is not None:
                    flush()
                return True
            except (OSError, ValueError):
                return False

    def commands(self) -> Any:
        """Yield each command until the backend closes the pipe or dies."""
        buffer = b""
        while True:
            try:
                chunk = self._reader.read(65536)
            except (OSError, ValueError):
                return
            if not chunk:
                return
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                message = decode(line)
                if message is not None:
                    yield message


class ViewerProcess:
    """The backend's handle on one viewer process."""

    def __init__(
        self,
        process: Any,
        on_event: Callable[[ViewerProcess, dict[str, Any]], None],
        on_exit: Callable[[ViewerProcess], None],
    ) -> None:
        self.process = process
        self.pid = int(process.pid)
        self.window_ids: list[str] = []
        self.ready = threading.Event()
        self.exited = threading.Event()
        self._on_event = on_event
        self._on_exit = on_exit
        self._lock = threading.Lock()
        self._thread = threading.Thread(
            target=self._read, name=f"viewer-control-{self.pid}", daemon=True
        )

    def start(self) -> None:
        self._thread.start()

    def send(self, message: dict[str, Any]) -> bool:
        stream = self.process.stdin
        if stream is None:
            return False
        with self._lock:
            try:
                stream.write(encode(message))
                stream.flush()
                return True
            except (OSError, ValueError):
                return False

    def close_input(self) -> None:
        with self._lock:
            try:
                if self.process.stdin is not None:
                    self.process.stdin.close()
            except (OSError, ValueError):
                pass

    def wait(self, timeout: float) -> bool:
        return self.exited.wait(timeout)

    def kill(self) -> None:
        try:
            self.process.kill()
        except OSError:
            pass

    def _read(self) -> None:
        stream = self.process.stdout
        try:
            if stream is not None:
                for line in iter(stream.readline, b""):
                    message = decode(line)
                    if message is not None:
                        try:
                            self._on_event(self, message)
                        except Exception:
                            log.exception("viewer event failed")
        except (OSError, ValueError):
            pass
        try:
            self.process.wait()
        except Exception:
            pass
        self.exited.set()
        self.ready.set()
        try:
            self._on_exit(self)
        except Exception:
            log.exception("viewer exit handling failed")


# ---------------------------------------------------------------------------
# Keep policies
# ---------------------------------------------------------------------------


def sessions_worth_keeping(manager: Any) -> bool:
    """The close-to-tray rule: a live session touched, retained, or busy.

    Fail safe: when the answer cannot be computed the backend stays, because
    leaving takes the user's running terminals with it.
    """
    try:
        busy = manager.busy_ids() if hasattr(manager, "busy_ids") else set()
        return any(
            i.alive
            and (
                getattr(i, "touched", False)
                or getattr(i, "retained", False)
                or getattr(i, "id", None) in busy
            )
            for i in manager.list()
        )
    except Exception:
        log.exception("could not evaluate session keep policy; staying")
        return True


def sessions_at_risk(manager: Any) -> list[dict[str, Any]] | None:
    """Live sessions a restart would lose work in: touched or busy.

    None when the answer cannot be computed, which callers treat as "ask".
    """
    try:
        busy = manager.busy_ids() if hasattr(manager, "busy_ids") else set()
        found = []
        for info in manager.list():
            sid = getattr(info, "id", None)
            is_busy = sid in busy
            touched = bool(getattr(info, "touched", False))
            if info.alive and (touched or is_busy):
                found.append(
                    {"id": sid, "name": getattr(info, "name", "") or "", "busy": is_busy,
                     "touched": touched}
                )
        return found
    except Exception:
        log.exception("could not list the sessions at risk")
        return None


def attention_balloon(name: str, kind: str, text: str | None) -> tuple[str, str]:
    """Title and body of the tray balloon for a terminal that wants the user."""
    title = f"{name or 'A terminal'} needs you"
    if text:
        body = text
    elif kind == "bell":
        body = "It rang the bell."
    elif kind == "exit":
        body = "It has finished."
    else:
        body = "It is waiting for you."
    return title, body


# ---------------------------------------------------------------------------
# The backend's side
# ---------------------------------------------------------------------------


class Host:
    """The backend's view of its viewer process, its tray and its lifetime.

    There is at most one viewer process per backend; it holds every native
    window. Opening a window while it runs is a command to it, not a second
    process, so the window that holds the bare title (the one the summon key
    and the Explorer handoff aim at) stays unique.
    """

    def __init__(
        self,
        cfg: Any,
        registry: Any,
        *,
        base_title: str = "QuickTerm",
        elevated: bool = False,
        manager: Callable[[], Any] = lambda: None,
        request_exit: Callable[[], None] = lambda: None,
        viewer_command: Callable[[list[str]], list[str]] = lambda argv: program_command(
            ["--viewer", *argv]
        ),
        spawn: Callable[[list[str]], Any] = spawn_viewer,
        from_copy: bool | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.cfg = cfg
        self.registry = registry
        self.base_title = base_title
        self.elevated = elevated
        self.tray: Any | None = None
        self._manager = manager
        self._request_exit = request_exit
        self._viewer_command = viewer_command
        self._spawn = spawn
        self.from_copy = running_from_copy() if from_copy is None else from_copy
        self._clock = clock
        self._started_at = clock()
        self._lock = threading.RLock()
        self._viewer: ViewerProcess | None = None
        self._ever_viewed = False
        self._pending: dict[str, tuple[threading.Event, dict[str, Any]]] = {}
        self.quitting = threading.Event()
        self.superseded = False
        self._checker: threading.Thread | None = None

    # ---- lifetime ----------------------------------------------------------

    def start_checks(self, interval: float = CHECK_INTERVAL_S) -> None:
        """Re-evaluate, every `interval`, whether a windowless backend should go."""

        def loop() -> None:
            while not self.quitting.wait(interval):
                try:
                    self.check()
                except Exception:
                    log.exception("host check failed")

        self._checker = threading.Thread(target=loop, name="host-check", daemon=True)
        self._checker.start()

    def check(self) -> None:
        with self._lock:
            if self.quitting.is_set() or self._viewer is not None:
                return
            ever_viewed = self._ever_viewed
        manager = self._manager()
        if self.superseded:
            at_risk = sessions_at_risk(manager)
            if at_risk == []:
                log.info("a newer QuickTerm is installed and nothing is at risk; leaving")
                self.exit()
            return
        if (
            not ever_viewed
            and self._clock() - self._started_at > ORPHAN_GRACE_S
            and not sessions_worth_keeping(manager)
        ):
            log.info("no window ever attached and nothing to keep; leaving")
            self.exit()

    def exit(self) -> None:
        """Stop the backend (and with it every terminal)."""
        self.quitting.set()
        try:
            self._request_exit()
        except Exception:
            log.exception("could not stop the backend")

    def quit(self) -> None:
        """Tray Quit: close the windows, then stop the backend."""
        self.quitting.set()
        self._close_viewer()
        self.exit()

    def close(self) -> None:
        """The backend is going: take its windows along."""
        self.quitting.set()
        self._close_viewer()

    def _close_viewer(self) -> None:
        with self._lock:
            viewer = self._viewer
        if viewer is None:
            return
        viewer.send({"op": "quit"})
        viewer.close_input()
        if not viewer.wait(QUIT_WAIT_S):
            viewer.kill()

    def begin_update(self) -> bool:
        """The in-app updater is about to run Setup. Returns whether we quit.

        A backend running from its copy holds no file Setup replaces, so it
        stays, and so do its windows (they run from the copy too). The new
        version's launcher, which Setup starts at the end, decides about the
        handover. A backend running in place (source checkout, the elevated
        instance, a copy that could not be made) would be killed mid-install
        and has to go first.
        """
        if self.from_copy:
            log.info("update: the backend runs from its copy and stays")
            return False
        timer = threading.Timer(1.5, self.quit)
        timer.daemon = True
        timer.start()
        return True

    def retire(self, force: bool = False) -> tuple[bool, list[dict[str, Any]]]:
        """Make way for another backend. Refused while work is at risk, unless forced.

        A refusal marks this backend superseded: it leaves on its own the next
        time it has no window and nothing at risk, so the new version takes
        over at the next launch.
        """
        manager = self._manager()
        at_risk = sessions_at_risk(manager)
        if not force and at_risk != []:
            self.superseded = True
            return False, at_risk or []
        self.quitting.set()
        timer = threading.Timer(0.3, self.quit)
        timer.daemon = True
        timer.start()
        return True, []

    def info(self) -> dict[str, Any]:
        with self._lock:
            viewer = self._viewer
        return {
            "managed": True,
            "pid": os.getpid(),
            "version": __version__,
            "build": running_build(),
            "frozen": frozen(),
            "copy": self.from_copy,
            "viewer": viewer.pid if viewer is not None else None,
            "superseded": self.superseded,
        }

    # ---- windows -----------------------------------------------------------

    def viewer_pids(self) -> set[int]:
        with self._lock:
            return {self._viewer.pid} if self._viewer is not None else set()

    def window_count(self) -> int:
        with self._lock:
            return len(self._viewer.window_ids) if self._viewer is not None else 0

    def open_window(self, workspace: str | None, cwd: str | None) -> str:
        """The server's `open_window` hook. Blocks; the route runs it off the loop."""
        with self._lock:
            if self.quitting.is_set():
                raise RuntimeError("QuickTerm is shutting down")
            viewer = self._viewer
            started = None
            if viewer is None:
                started = self._spawn_viewer_locked(workspace=workspace, cwd=cwd)
        if started is not None:
            self._await_ready(started[0])
            return started[1]
        request = uuid.uuid4().hex
        done = threading.Event()
        result: dict[str, Any] = {}
        self._pending[request] = (done, result)
        try:
            allow_foreground(viewer.pid)
            if not viewer.send(
                {"op": "open", "request": request, "workspace": workspace, "cwd": cwd}
            ):
                raise RuntimeError("the window process is gone")
            if not done.wait(OPEN_TIMEOUT_S):
                raise RuntimeError("the window process did not answer")
        finally:
            self._pending.pop(request, None)
        if result.get("event") != "opened":
            if result.get("error") == "workspace_claimed":
                from quickterm.windows import WorkspaceClaimed

                owner = self.registry.owner_of(workspace) if workspace else None
                if owner is not None:
                    raise WorkspaceClaimed(str(workspace), owner)
            raise RuntimeError(str(result.get("detail") or "the window could not be opened"))
        return str(result.get("window_id"))

    def summon(self, cwd: str | None = None, *, wait: bool = True) -> str:
        """Show the windows, or start a viewer when there is none.

        "shown", "started", or "unavailable" while the backend is leaving.
        `wait=False` returns as soon as the process is started: the hotkey and
        tray threads must not sit through a WebView2 cold start, so the rest
        (the drop-down for the overlay) runs on a thread of its own.
        """
        with self._lock:
            if self.quitting.is_set():
                return "unavailable"
            started = None
            if self._viewer is None:
                started = self._spawn_viewer_locked(cwd=cwd)
        if started is None:
            self.show()
            return "shown"
        overlay = self._overlay_on()
        if wait:
            self._await_ready(started[0], overlay=overlay)
        else:
            threading.Thread(
                target=self._await_ready, args=(started[0],), kwargs={"overlay": overlay},
                name="viewer-start", daemon=True,
            ).start()
        return "started"

    def show(self) -> None:
        """Tray Open: the primary as the drop-down when the overlay is on.

        Runs on the tray thread or a worker thread, never on the event loop.
        """
        with self._lock:
            viewer = self._viewer
            start = viewer is None and not self.quitting.is_set()
        if start:
            self.summon(wait=False)
            return
        if viewer is None:
            return
        allow_foreground(viewer.pid)
        dropped = self._drop_down(viewer.pid)
        viewer.send({"op": "show", "skip_primary": dropped})

    def toggle(self) -> None:
        """The summon hotkey. Runs on the hotkey thread."""
        pids = self.viewer_pids()
        found = False
        if pids:
            try:
                from quickterm import hotkeys

                found = bool(
                    hotkeys.toggle_window(
                        self.base_title, getattr(self.cfg, "overlay", None), pids=pids
                    )
                )
            except Exception:
                log.debug("summon toggle failed", exc_info=True)
        if not found:
            self.summon(wait=False)

    def _overlay_on(self) -> bool:
        if os.name != "nt":
            return False
        try:
            from quickterm import overlay

            return bool(overlay.enabled(getattr(self.cfg, "overlay", None)))
        except Exception:
            return False

    def _primary_hwnd(self, pid: int) -> int | None:
        if os.name != "nt":
            return None
        try:
            from quickterm import tray

            found = tray.own_window(self.base_title, pids={pid})
        except Exception:
            log.debug("primary window lookup failed", exc_info=True)
            return None
        return found[0] if found else None

    def _drop_down(self, pid: int) -> bool:
        """The overlay half of tray Open. Returns whether the primary was shown."""
        if os.name != "nt":
            return False
        try:
            from quickterm import overlay

            overlay_cfg = getattr(self.cfg, "overlay", None)
            if not overlay.enabled(overlay_cfg):
                for hwnd in overlay.applied_windows():
                    overlay.restore_normal(hwnd)
                return False
            hwnd = self._primary_hwnd(pid)
            if hwnd is None:
                return False
            overlay.show_overlay(hwnd, overlay_cfg)
            return True
        except Exception:
            log.debug("overlay show failed", exc_info=True)
            return False

    def _spawn_viewer_locked(
        self, *, workspace: str | None = None, cwd: str | None = None
    ) -> tuple[ViewerProcess, str]:
        """Start the viewer with its primary window. Call with the lock held,
        and wait for it with `_await_ready` after letting go: the viewer's
        first events need the lock."""
        from quickterm.windows import new_window_id

        window_id = new_window_id()
        argv = ["--port", str(self.cfg.port), "--window-id", window_id]
        if workspace:
            argv += ["--workspace", workspace]
        if cwd:
            argv += ["--cwd", cwd]
        if self.elevated:
            argv.append("--elevated")
        allow_foreground()
        process = self._spawn(self._viewer_command(argv))
        viewer = ViewerProcess(process, self._on_event, self._on_exit)
        viewer.window_ids.append(window_id)
        self._viewer = viewer
        self._ever_viewed = True
        viewer.start()
        return viewer, window_id

    def _await_ready(self, viewer: ViewerProcess, *, overlay: bool = False) -> None:
        if not viewer.ready.wait(VIEWER_READY_S):
            log.warning("the window process did not report ready")
        # The first window opens as an ordinary one and is then dropped down:
        # the backend owns the overlay state, so the viewer never restyles.
        if overlay and not viewer.exited.is_set():
            self._drop_down(viewer.pid)

    # ---- viewer events -----------------------------------------------------

    def _on_event(self, viewer: ViewerProcess, message: dict[str, Any]) -> None:
        event = message.get("event")
        window_id = message.get("window_id")
        if event == "ready":
            viewer.ready.set()
        elif event == "adopted" and isinstance(window_id, str):
            with self._lock:
                if window_id not in viewer.window_ids:
                    viewer.window_ids.append(window_id)
        elif event == "closed" and isinstance(window_id, str):
            with self._lock:
                if window_id in viewer.window_ids:
                    viewer.window_ids.remove(window_id)
            # Free the claim now instead of waiting out the heartbeat TTL: the
            # user may well be reopening that workspace right away.
            self.registry.forget(window_id)
        elif event in ("opened", "open_failed"):
            pending = self._pending.get(str(message.get("request")))
            if pending is not None:
                pending[1].update(message)
                pending[0].set()

    def _on_exit(self, viewer: ViewerProcess) -> None:
        with self._lock:
            if self._viewer is viewer:
                self._viewer = None
            ids = list(viewer.window_ids)
            viewer.window_ids.clear()
        # A viewer that crashed sent no goodbyes; its claims would otherwise
        # lock its workspaces out of the next window for the heartbeat TTL.
        for window_id in ids:
            self.registry.forget(window_id)
        for pending in list(self._pending.values()):
            pending[0].set()
        self._forget_dead_overlays()
        self.after_last_window()

    def _forget_dead_overlays(self) -> None:
        if os.name != "nt":
            return
        try:
            from quickterm import overlay

            overlay.forget_dead()
        except Exception:
            log.debug("overlay cleanup failed", exc_info=True)

    def after_last_window(self) -> None:
        """The viewer is gone: stay in the tray, or leave.

        The order is the old close-to-tray order: a quit in progress decides
        nothing; an elevated backend, or one with no tray icon, leaves (a
        resident admin backend visible only in the notification area would be a
        foot-gun, and hiding behind no icon looks like a crash); a superseded
        backend leaves once nothing is at risk; otherwise it stays exactly when
        a live session is touched, retained or busy.
        """
        if self.quitting.is_set():
            return
        with self._lock:
            if self._viewer is not None:
                return
        if self.elevated or self.tray is None:
            self.exit()
            return
        manager = self._manager()
        if self.superseded and sessions_at_risk(manager) == []:
            self.exit()
            return
        if sessions_worth_keeping(manager):
            self.tray.balloon_once(
                "QuickTerm is still running",
                "Your terminals keep running in the background. "
                "Click the tray icon to reopen, right-click it to quit.",
            )
            return
        self.exit()

    # ---- attention -----------------------------------------------------------

    def notify_attention(self, session_id: str, name: str, kind: str, text: str | None) -> None:
        """The server's `notify` hook. Called on the loop; returns at once.

        Shell_NotifyIconW talks to Explorer and stalls with it, and no terminal
        may stall with Explorer, so the Win32 calls run on a thread of their own.
        """
        threading.Thread(
            target=self.notify_now, args=(name, kind, text), name="attention-notify", daemon=True
        ).start()

    def notify_now(self, name: str, kind: str, text: str | None) -> None:
        if self.quitting.is_set():
            return
        try:
            from quickterm import tray as tray_mod

            pids = self.viewer_pids()
            # Someone is looking at QuickTerm already; the sidebar says it.
            if pids and tray_mod.foreground_is_ours(pids=pids):
                return
            primary = tray_mod.own_window(self.base_title, pids=pids) if pids else None
            if primary is not None and primary[1]:
                tray_mod.flash_window(primary[0])
            elif self.tray is not None and self.window_count() <= 1:
                # No window, or only a hidden primary: everything is in the tray.
                self.tray.balloon(*attention_balloon(name, kind, text))
        except Exception:
            log.debug("attention notification failed", exc_info=True)


_current: Host | None = None


def install(host: Host | None) -> None:
    """Make `host` the one the API routes and the updater talk to."""
    global _current
    _current = host


def current() -> Host | None:
    return _current


def unmanaged_info() -> dict[str, Any]:
    """`GET /api/host` for a backend without a host (headless, POSIX, tests)."""
    return {
        "managed": False,
        "pid": os.getpid(),
        "version": __version__,
        "build": running_build(),
        "frozen": frozen(),
        "copy": running_from_copy(),
        "viewer": None,
        "superseded": False,
    }


def begin_update() -> bool:
    """The in-app updater's stand-down. Returns whether this backend quits."""
    host = _current
    if host is None:
        return False
    return host.begin_update()
