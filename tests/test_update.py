"""Update module: version comparison, checksum parsing, release-probe parsing."""

import hashlib
import json
import os
import threading
import time

import pytest

import quickterm.update as update
from quickterm import __version__
from quickterm.update import _expected_hash, is_newer


@pytest.fixture(autouse=True)
def _fresh_updater(monkeypatch):
    # check() reports to the module's updater; keep that state per test.
    monkeypatch.setattr(update, "_updater", update.Updater())


def test_is_newer_basic():
    assert is_newer("0.2.1", "0.2.0")
    assert is_newer("0.10.0", "0.9.9")
    assert is_newer("1.0.0", "0.99.99")
    assert not is_newer("0.2.0", "0.2.0")
    assert not is_newer("0.1.9", "0.2.0")


def test_is_newer_handles_v_prefix_and_ragged_lengths():
    assert is_newer("v0.3", "0.2.5")
    assert not is_newer("0.2", "0.2.0")
    assert is_newer("0.2.0.1", "0.2.0")


def test_expected_hash_parses_sha256sums():
    sums = "abc123  QuickTerm-v0.2.0-Setup.exe\ndef456  QuickTerm-v0.2.0-windows-x64.zip\n"
    assert _expected_hash(sums, "QuickTerm-v0.2.0-Setup.exe") == "abc123"
    assert _expected_hash(sums, "QuickTerm-v0.2.0-windows-x64.zip") == "def456"
    assert _expected_hash(sums, "missing.exe") is None
    # binary-mode marker ("*name") also matches
    assert _expected_hash("fff *QuickTerm-v9-Setup.exe", "QuickTerm-v9-Setup.exe") == "fff"


def _release_payload(tag: str, with_setup: bool = True) -> bytes:
    assets = []
    if with_setup:
        assets.append({
            "name": f"QuickTerm-{tag}-Setup.exe",
            "browser_download_url": f"https://example.invalid/{tag}/setup.exe",
            "size": 1000,
        })
    return json.dumps({
        "tag_name": tag,
        "html_url": f"https://github.com/devincii-io/quickterm/releases/tag/{tag}",
        "body": "notes",
        "assets": assets,
    }).encode()


def test_check_reports_newer_release(monkeypatch):
    monkeypatch.setattr(update, "_cache", None)
    monkeypatch.setattr(update, "_get", lambda url, timeout=15: _release_payload("v99.0.0"))
    result = update.check(force=True)
    assert result["update_available"] is True
    assert result["latest"] == "99.0.0"
    assert result["current"] == __version__
    assert result["url"].startswith("https://github.com/")


def test_check_current_release_is_not_an_update(monkeypatch):
    monkeypatch.setattr(update, "_cache", None)
    monkeypatch.setattr(
        update, "_get", lambda url, timeout=15: _release_payload(f"v{__version__}")
    )
    result = update.check(force=True)
    assert result["update_available"] is False


def test_check_caches_probe(monkeypatch):
    monkeypatch.setattr(update, "_cache", None)
    calls = []

    def fake_get(url, timeout=15):
        calls.append(url)
        return _release_payload("v99.0.0")

    monkeypatch.setattr(update, "_get", fake_get)
    update.check(force=True)
    update.check()  # served from cache
    assert len(calls) == 1


def test_get_refuses_plain_http():
    try:
        update._get("http://example.com")
    except ValueError as exc:
        assert "https" in str(exc)
    else:
        raise AssertionError("plain http must be refused")


def test_download_url_is_pinned_to_github_hosts():
    update._validate_download_url("https://github.com/devincii-io/quickterm/releases/download/v2/a.exe")
    update._validate_download_url("https://release-assets.githubusercontent.com/object")
    with pytest.raises(ValueError, match="non-GitHub"):
        update._validate_download_url("https://example.invalid/QuickTerm-Setup.exe")


# --- background download: a fake HTTP layer under urllib --------------------

SETUP_URL = "https://github.com/devincii-io/quickterm/releases/download/v99.0.0/QuickTerm-v99.0.0-Setup.exe"
ASSET_URL = "https://release-assets.githubusercontent.com/object/setup"
SUMS_URL = "https://github.com/devincii-io/quickterm/releases/download/v99.0.0/SHA256SUMS.txt"
SETUP_NAME = "QuickTerm-v99.0.0-Setup.exe"
BLOB = b"MZ" + bytes(range(256)) * 40


class FakeResponse:
    def __init__(self, final_url, body, length=True, chunk=None):
        self._final = final_url
        self._body = body
        self._pos = 0
        self._chunk = chunk
        self.headers = {"Content-Length": str(len(body))} if length else {}
        self.closed = False

    def geturl(self):
        return self._final

    def read(self, n=-1):
        if self._chunk:
            n = min(n, self._chunk) if n and n > 0 else self._chunk
        if n is None or n < 0:
            n = len(self._body) - self._pos
        data = self._body[self._pos:self._pos + n]
        self._pos += len(data)
        return data

    def close(self):
        self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class FakeNet:
    """Routes: url -> (final url after redirects, body, send Content-Length)."""

    def __init__(self, blob=BLOB, sums=None, setup_final=ASSET_URL, length=True, gate=None):
        digest = hashlib.sha256(blob).hexdigest()
        self.routes = {
            update.API_LATEST: (update.API_LATEST, _installable_payload(), True),
            SUMS_URL: (SUMS_URL, (sums if sums is not None else f"{digest}  {SETUP_NAME}\n").encode(), True),
            SETUP_URL: (setup_final, blob, length),
        }
        self.calls = []
        self.gate = gate
        self.opened = []

    def urlopen(self, req, timeout=None):
        url = req.full_url
        self.calls.append(url)
        if url == SETUP_URL and self.gate is not None:
            self.gate.wait(5)
        final, body, length = self.routes[url]
        resp = FakeResponse(final, body, length=length, chunk=1000)
        self.opened.append(resp)
        return resp


def _installable_payload():
    return json.dumps({
        "tag_name": "v99.0.0",
        "html_url": "https://github.com/devincii-io/quickterm/releases/tag/v99.0.0",
        "body": "notes",
        "assets": [
            {"name": SETUP_NAME, "browser_download_url": SETUP_URL, "size": len(BLOB)},
            {"name": "SHA256SUMS.txt", "browser_download_url": SUMS_URL, "size": 100},
        ],
    }).encode()


@pytest.fixture
def net(monkeypatch, tmp_path):
    """A fresh updater, the temp folder in tmp_path, Windows, no real launch."""
    fake = FakeNet()
    monkeypatch.setattr(update.urllib.request, "urlopen", fake.urlopen)
    monkeypatch.setattr(update, "_updater", update.Updater())
    monkeypatch.setattr(update, "_cache", None)
    monkeypatch.setattr(update, "_on_windows", lambda: True)
    monkeypatch.setattr(update.tempfile, "tempdir", str(tmp_path))
    monkeypatch.setattr(update, "_CHUNK_BYTES", 1000)
    launched = []
    fake.setup = FakeSetup()

    def launch(path, relaunch, script):
        launched.append((path, relaunch, script.name))
        if fake.launch_error is not None:
            raise fake.launch_error
        return fake.setup

    fake.launch_error = None
    monkeypatch.setattr(update, "_launch_installer", launch)
    monkeypatch.setattr(update, "_request_app_shutdown", lambda: launched.append("shutdown"))
    monkeypatch.setattr(update, "_relaunch_target", lambda: None)
    fake.launched = launched
    fake.tmp = tmp_path
    yield fake
    fake.setup.finish()
    update._updater.wait(5)


class FakeSetup:
    """The hand-over as install() sees it: wait() ends when the test says."""

    def __init__(self):
        self.done = threading.Event()
        self.waiting = threading.Event()
        self.code = 0
        self.timeouts = []

    def wait(self, timeout):
        self.timeouts.append(timeout)
        self.waiting.set()
        return self.code if self.done.wait(5) else None

    def finish(self, code=0):
        self.code = code
        self.done.set()


def _download(net):
    update.check(force=True)
    assert update.start_download() is True
    update._updater.wait(5)
    return update.status()


def _update_dirs(tmp_path):
    return sorted(p for p in tmp_path.iterdir() if p.name.startswith("quickterm-update-"))


def test_check_marks_an_installable_release_available(net):
    result = update.check(force=True)
    assert result["installable"] is True
    status = update.status()
    assert status == {
        "state": "available", "version": "99.0.0", "received": 0, "total": None,
        "error": None, "notes_url": "https://github.com/devincii-io/quickterm/releases/tag/v99.0.0",
        "can_restart": False,
    }


def test_status_is_idle_without_a_check(net):
    assert update.status()["state"] == "idle"


def test_download_streams_in_chunks_and_becomes_ready(net):
    status = _download(net)
    assert status["state"] == "ready"
    assert status["received"] == len(BLOB)
    assert status["total"] == len(BLOB)
    assert status["error"] is None
    [folder] = _update_dirs(net.tmp)
    assert [p.name for p in folder.iterdir()] == [SETUP_NAME]
    assert (folder / SETUP_NAME).read_bytes() == BLOB
    assert all(resp.closed for resp in net.opened)


def test_download_with_unknown_total(net):
    final, body, _ = net.routes[SETUP_URL]
    net.routes[SETUP_URL] = (final, body, False)
    status = _download(net)
    assert status["state"] == "ready"
    assert status["total"] is None
    assert status["received"] == len(BLOB)


def test_download_over_the_size_cap_fails_and_leaves_nothing(net, monkeypatch):
    monkeypatch.setattr(update, "_MAX_SETUP_BYTES", 5000)
    monkeypatch.setattr(update.Release, "installable", property(lambda self: True))
    final, body, _ = net.routes[SETUP_URL]
    net.routes[SETUP_URL] = (final, body, False)  # no Content-Length: caught while streaming
    status = _download(net)
    assert status["state"] == "failed"
    assert "exceeds" in status["error"]
    assert _update_dirs(net.tmp) == []


def test_declared_length_over_the_cap_fails_before_streaming(net, monkeypatch):
    monkeypatch.setattr(update, "_MAX_SETUP_BYTES", 5000)
    monkeypatch.setattr(update.Release, "installable", property(lambda self: True))
    status = _download(net)
    assert status["state"] == "failed"
    assert "implausibly large" in status["error"]
    assert status["received"] == 0
    assert _update_dirs(net.tmp) == []


def test_checksum_mismatch_fails_and_removes_the_file(net):
    net.routes[SUMS_URL] = (SUMS_URL, f"{'0' * 64}  {SETUP_NAME}\n".encode(), True)
    status = _download(net)
    assert status["state"] == "failed"
    assert "checksum" in status["error"]
    assert _update_dirs(net.tmp) == []


def test_missing_checksum_line_never_downloads_the_installer(net):
    net.routes[SUMS_URL] = (SUMS_URL, b"abc  other.zip\n", True)
    status = _download(net)
    assert status["state"] == "failed"
    assert SETUP_URL not in net.calls
    assert _update_dirs(net.tmp) == []


def test_redirect_to_a_foreign_host_fails(net):
    net.routes[SETUP_URL] = ("https://evil.example/setup.exe", BLOB, True)
    status = _download(net)
    assert status["state"] == "failed"
    assert "non-GitHub" in status["error"]
    assert _update_dirs(net.tmp) == []
    assert all(resp.closed for resp in net.opened)


def test_a_second_request_joins_the_running_download(net):
    gate = threading.Event()
    net.gate = gate
    update.check(force=True)
    assert update.start_download() is True
    assert update.start_download() is False
    assert update.status()["state"] == "downloading"
    gate.set()
    update._updater.wait(5)
    assert net.calls.count(SETUP_URL) == 1
    assert update.status()["state"] == "ready"
    assert update.start_download() is False  # ready: nothing to start


def test_download_refused_without_an_installable_update(net):
    with pytest.raises(ValueError, match="no installable update"):
        update.start_download()


def test_download_refused_off_windows(net, monkeypatch):
    update.check(force=True)
    monkeypatch.setattr(update, "_on_windows", lambda: False)
    with pytest.raises(ValueError, match="only available on Windows"):
        update.start_download()


def test_retry_after_a_failure(net):
    net.routes[SUMS_URL] = (SUMS_URL, b"nothing\n", True)
    assert _download(net)["state"] == "failed"
    digest = hashlib.sha256(BLOB).hexdigest()
    net.routes[SUMS_URL] = (SUMS_URL, f"{digest} *{SETUP_NAME}\n".encode(), True)
    assert update.start_download() is True
    update._updater.wait(5)
    assert update.status()["state"] == "ready"


def test_a_new_download_sweeps_day_old_and_own_folders_only(net):
    stale = net.tmp / "quickterm-update-old"
    stale.mkdir()
    (stale / "QuickTerm-v1-Setup.exe").write_bytes(b"x")
    old = time.time() - 2 * 86400
    os.utime(stale, (old, old))
    # A second backend's ready installer, made a minute ago: not ours to delete.
    other = net.tmp / "quickterm-update-other"
    other.mkdir()
    _download(net)
    [own] = [p for p in _update_dirs(net.tmp) if p not in (stale, other)]
    assert stale not in _update_dirs(net.tmp)
    assert other in _update_dirs(net.tmp)
    # A retry removes the folder this backend made before.
    update._updater._fail("x", None)
    update.start_download()
    update._updater.wait(5)
    assert own not in _update_dirs(net.tmp)
    assert other in _update_dirs(net.tmp)


def test_install_requires_ready(net):
    with pytest.raises(update.UpdateNotReady):
        update.install()
    update.check(force=True)
    with pytest.raises(update.UpdateNotReady):
        update.install()
    assert net.launched == []


def test_install_starts_setup_before_standing_down(net):
    _download(net)
    result = update.install()
    assert result == {"launched": True, "version": "99.0.0"}
    [folder] = _update_dirs(net.tmp)
    assert net.launched == [(folder / SETUP_NAME, None, "handover.cmd"), "shutdown"]
    assert (folder / "handover.cmd").read_bytes() == update._HANDOVER_SCRIPT.encode("ascii")
    assert update.status()["state"] == "installing"
    with pytest.raises(update.UpdateNotReady):
        update.install()  # one hand-over only


def test_a_failed_setup_start_does_not_stand_down(net):
    _download(net)
    net.launch_error = OSError("access denied")
    with pytest.raises(OSError):
        update.install()
    assert "shutdown" not in net.launched
    assert update.status()["state"] == "failed"
    assert "could not be started" in update.status()["error"]


@pytest.mark.parametrize("code", [1, None])
def test_setup_ending_while_this_backend_runs_offers_the_install_again(net, code):
    # Setup failed or UAC was cancelled (non-zero), or the wait timed out (None).
    _download(net)
    update.install()
    assert net.setup.waiting.wait(5)
    assert update.status()["state"] == "installing"
    net.setup.finish(code)
    update._updater.wait(5)
    assert update.status()["state"] == "ready"
    assert update.status()["error"] is None
    assert net.setup.timeouts == [update._SETUP_TIMEOUT_S]
    update.install()  # possible again


def _installed(net, monkeypatch, launcher):
    monkeypatch.setattr(update, "_relaunch_target", lambda: launcher)
    _download(net)
    update.install()
    assert net.setup.waiting.wait(5)
    net.setup.finish(0)
    update._updater.wait(5)
    return update.status()


def test_a_successful_setup_with_a_declined_hand_over_is_installed(net, monkeypatch, tmp_path):
    launcher = tmp_path / "QuickTerm.exe"
    launcher.write_bytes(b"MZ")
    status = _installed(net, monkeypatch, launcher)
    assert status["state"] == "installed"
    assert status["version"] == "99.0.0"
    assert status["can_restart"] is True
    assert _update_dirs(net.tmp) == []  # the installer is no longer needed
    with pytest.raises(update.UpdateNotReady):
        update.install()  # never offers the installed version again
    assert update.start_download() is False
    update.check(force=True)  # the same release again keeps it installed
    assert update.status()["state"] == "installed"


def test_restart_starts_the_installed_launcher(net, monkeypatch, tmp_path):
    launcher = tmp_path / "QuickTerm.exe"
    launcher.write_bytes(b"MZ")
    _installed(net, monkeypatch, launcher)
    started = []
    monkeypatch.setattr(update, "_launch_detached", lambda path, args=None: started.append((path, args)))
    assert update.restart() == {"started": True}
    assert started == [(launcher, None)]


def test_installed_without_a_known_launcher_offers_no_restart(net, monkeypatch):
    status = _installed(net, monkeypatch, None)
    assert status["state"] == "installed"
    assert status["can_restart"] is False
    with pytest.raises(update.UpdateNotReady):
        update.restart()


def test_restart_refused_before_installed(net):
    with pytest.raises(update.UpdateNotReady):
        update.restart()


def test_a_newer_release_replaces_installed(net, monkeypatch):
    _installed(net, monkeypatch, None)
    payload = json.loads(_installable_payload())
    payload["tag_name"] = "v99.0.1"
    for asset in payload["assets"]:
        asset["name"] = asset["name"].replace("99.0.0", "99.0.1")
    net.routes[update.API_LATEST] = (update.API_LATEST, json.dumps(payload).encode(), True)
    update.check(force=True)
    assert update.status()["state"] == "available"
    assert update.status()["version"] == "99.0.1"


def test_setup_did_not_finish_when_the_file_is_gone_afterwards(net, monkeypatch):
    _download(net)
    update.install()
    assert net.setup.waiting.wait(5)
    monkeypatch.setattr(update, "_file_sha256", lambda path: "0" * 64)
    net.setup.finish(1)
    update._updater.wait(5)
    status = update.status()
    assert status["state"] == "failed"
    assert status["error"] == "Setup did not finish"


@pytest.mark.skipif(os.name != "nt", reason="share modes are a Windows thing")
def test_installer_and_script_are_locked_until_setup_is_over(net):
    _download(net)
    update.install()
    assert net.setup.waiting.wait(5)
    [folder] = _update_dirs(net.tmp)
    setup, script = folder / SETUP_NAME, folder / "handover.cmd"
    for path in (setup, script):
        with pytest.raises(PermissionError):
            path.open("r+b")
        with pytest.raises(PermissionError):
            os.replace(path, folder / "moved")
        with pytest.raises(PermissionError):
            path.unlink()
        assert path.read_bytes()  # reading is still allowed
    net.setup.finish(1)  # a failed Setup keeps the file, now unlocked
    update._updater.wait(5)
    with setup.open("r+b"):
        pass


def test_install_reverifies_and_refuses_a_changed_file(net):
    _download(net)
    [folder] = _update_dirs(net.tmp)
    (folder / SETUP_NAME).write_bytes(BLOB + b"tampered")
    with pytest.raises(update.UpdateNotReady, match="checksum"):
        update.install()
    assert net.launched == []
    status = update.status()
    assert status["state"] == "failed"
    assert _update_dirs(net.tmp) == []


def test_a_check_keeps_a_ready_download_of_the_same_version(net):
    _download(net)
    update.check(force=True)
    assert update.status()["state"] == "ready"


def test_a_check_without_a_newer_release_drops_a_ready_file(net):
    _download(net)
    net.routes[update.API_LATEST] = (update.API_LATEST, _release_payload(f"v{__version__}"), True)
    update.check(force=True)
    assert update.status()["state"] == "idle"
    assert _update_dirs(net.tmp) == []


def test_notes_url_outside_the_repo_falls_back(net):
    payload = json.loads(_installable_payload())
    payload["html_url"] = "https://evil.example/notes"
    net.routes[update.API_LATEST] = (update.API_LATEST, json.dumps(payload).encode(), True)
    update.check(force=True)
    assert update.status()["notes_url"] == update.RELEASES_URL


def test_odd_tag_is_not_installable(net):
    payload = json.loads(_installable_payload())
    payload["tag_name"] = "v99.0.0 & calc"
    net.routes[update.API_LATEST] = (update.API_LATEST, json.dumps(payload).encode(), True)
    assert update.check(force=True)["installable"] is False
    assert update.status()["state"] == "idle"


def test_handover_script_runs_setup_silently_then_the_launcher():
    script = update._HANDOVER_SCRIPT
    assert '"%~1" /SILENT' in script
    assert 'start "" "%~2"' in script
    script.encode("ascii")
