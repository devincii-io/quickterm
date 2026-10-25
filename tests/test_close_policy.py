"""The keep rule and the window process's side of closing.

The keep rule: when the last window goes, the backend stays only when a live,
actually-used session would be lost. Fresh/untouched shells -> it quits. The
backend applies it (tests/test_pty_host.py); the window process never hides a
window on close, it ends with its last one.

With several windows in one process this file also owns the far more
dangerous question of WHICH close does what."""

import threading
from dataclasses import dataclass
from types import SimpleNamespace

import pytest

from quickterm.app import _sessions_worth_keeping


@dataclass
class _Info:
    alive: bool
    touched: bool
    retained: bool = False


class _Manager:
    def __init__(self, infos):
        self._infos = infos

    def list(self):
        return self._infos


class _Broken:
    def list(self):
        raise RuntimeError("boom")


def test_touched_live_session_keeps_app_resident():
    assert _sessions_worth_keeping(_Manager([_Info(alive=True, touched=True)])) is True


def test_untouched_scratch_shell_quits():
    assert _sessions_worth_keeping(_Manager([_Info(alive=True, touched=False)])) is False


def test_explicitly_retained_shell_keeps_app_resident_without_faking_input():
    info = _Info(alive=True, touched=False, retained=True)
    assert _sessions_worth_keeping(_Manager([info])) is True
    assert info.touched is False


def test_dead_sessions_do_not_keep_app_alive():
    assert _sessions_worth_keeping(_Manager([_Info(alive=False, touched=True)])) is False


def test_no_sessions_quits():
    assert _sessions_worth_keeping(_Manager([])) is False


def test_mixed_sessions_keep_if_any_touched_alive():
    infos = [
        _Info(alive=True, touched=False),
        _Info(alive=False, touched=True),
        _Info(alive=True, touched=True),
    ]
    assert _sessions_worth_keeping(_Manager(infos)) is True


# Fail safe: an unexpected error while evaluating the keep policy must keep the
# backend, never quit and take the user's running terminals with it.
def test_manager_error_defaults_to_hiding():
    assert _sessions_worth_keeping(_Broken()) is True


def test_missing_manager_defaults_to_hiding():
    assert _sessions_worth_keeping(None) is True


# --- several windows in one window process ----------------------------------
# None of it is reachable from a GUI test, so the policy is exercised here
# against fakes shaped like pywebview's window and its events.


class _FakeEvent:
    def __init__(self):
        self.handlers = []

    def __iadd__(self, handler):
        self.handlers.append(handler)
        return self

    def fire(self):
        return [handler() for handler in self.handlers]


class _FakeEvents:
    def __init__(self):
        self.closing = _FakeEvent()
        self.closed = _FakeEvent()
        self.loaded = _FakeEvent()


class _FakeWindow:
    def __init__(self, uid, title="QuickTerm"):
        self.uid = uid
        self.title = title
        self.events = _FakeEvents()
        self.hidden = False
        self.destroyed = False

    def hide(self):
        self.hidden = True

    def show(self):
        self.hidden = False

    def restore(self):
        pass

    def destroy(self):
        self.destroyed = True

    def set_title(self, title):
        self.title = title


class _ReportingRegistry:
    """The backend link as the window process sees it: the registry plus the
    adopted/closed reports the backend uses to drop a dead process's claims."""

    def __init__(self):
        from quickterm.windows import WindowRegistry

        self.registry = WindowRegistry()
        self.adopted_ids = []
        self.forgotten = []

    def owner_of(self, name):
        return self.registry.owner_of(name)

    def adopted(self, window_id):
        self.adopted_ids.append(window_id)

    def forget(self, window_id):
        self.forgotten.append(window_id)
        return self.registry.forget(window_id)


@pytest.fixture
def viewers():
    from quickterm import app as app_mod

    cfg = SimpleNamespace(port=8620, host="127.0.0.1")
    return app_mod._ViewerWindows(cfg, _ReportingRegistry(), base_title="QuickTerm")


def _open(viewers, uid, window_id, *, title="QuickTerm"):
    window = _FakeWindow(uid, title)
    viewers.adopt(window, window_id)
    return window


def _close(window):
    """Run pywebview's close sequence: closing may veto, closed is the fact."""
    cancelled = any(result is False for result in window.events.closing.fire())
    if not cancelled:
        window.events.closed.fire()
    return not cancelled


def test_closing_a_secondary_window_never_touches_the_rest(viewers):
    first = _open(viewers, "master", "w1")
    second = _open(viewers, "child_1", "w2", title="QuickTerm - dev")

    assert _close(second) is True
    assert first.destroyed is False
    assert viewers.quitting.is_set() is False
    assert viewers.count() == 1


def test_the_last_window_closes_for_real_and_the_backend_decides(viewers):
    # Hiding kept a whole WebView2 resident for the tray. The terminals live in
    # the backend now, which sees this process end and applies the keep rule.
    window = _open(viewers, "master", "w1")
    assert _close(window) is True
    assert window.hidden is False
    assert viewers.count() == 0


def test_every_window_reports_itself_to_the_backend(viewers):
    _open(viewers, "master", "w1")
    _open(viewers, "child_1", "w2", title="QuickTerm - dev")
    # The backend drops these claims if this process dies without goodbyes.
    assert viewers._registry.adopted_ids == ["w1", "w2"]


def test_quit_destroys_every_window(viewers):
    first = _open(viewers, "master", "w1")
    second = _open(viewers, "child_1", "w2")

    viewers.quit_all()
    assert (first.destroyed, second.destroyed) == (True, True)
    assert _close(first) is True
    assert _close(second) is True
    assert viewers.count() == 0


def test_a_closed_window_releases_its_workspace_at_once(viewers):
    _open(viewers, "master", "w1")
    window = _open(viewers, "child_1", "w2", title="QuickTerm - dev")
    viewers._registry.registry.register(window_id="w2", workspace="dev")

    _close(window)
    # Waiting out the heartbeat TTL would block reopening the very workspace
    # the user just closed.
    assert viewers._registry.forgotten == ["w2"]
    assert viewers._registry.owner_of("dev") is None


def test_closing_the_first_window_hands_the_bare_title_on(viewers):
    first = _open(viewers, "master", "w1")
    second = _open(viewers, "child_1", "w2", title="QuickTerm - dev")

    _close(first)
    # hotkeys.py summons by exact title match, so exactly one window must hold
    # it or the summon key and the Explorer handoff have nothing to aim at.
    assert second.title == "QuickTerm"


def test_show_all_restores_every_window(viewers):
    first = _open(viewers, "master", "w1")
    second = _open(viewers, "child_1", "w2")
    first.hidden = second.hidden = True
    viewers.show_all()
    assert (first.hidden, second.hidden) == (False, False)


def test_show_all_leaves_the_primary_to_the_backend_s_overlay(viewers):
    # The backend owns the drop-down state, so when it dropped the primary down
    # the window process must not show it a second time as a normal window.
    first = _open(viewers, "master", "w1")
    second = _open(viewers, "child_1", "w2", title="QuickTerm - dev")
    first.hidden = second.hidden = True
    viewers.show_all(skip_primary=True)
    assert (first.hidden, second.hidden) == (True, False)


def test_a_window_cannot_be_opened_from_the_main_thread(viewers):
    # pywebview only materialises a runtime window off the main thread; from the
    # main thread it would queue one that never appears.
    with pytest.raises(RuntimeError):
        viewers.open(workspace="dev")


def test_opening_a_workspace_another_window_owns_is_refused(viewers):
    from quickterm.windows import WorkspaceClaimed

    viewers._registry.registry.register(window_id="w1", workspace="dev")
    failures = []

    def attempt():
        try:
            viewers.open(workspace="dev")
        except BaseException as exc:  # noqa: BLE001 - the test asserts the type
            failures.append(exc)

    worker = threading.Thread(target=attempt)
    worker.start()
    worker.join(5)
    # Refused before any window is drawn: an empty shell with no explanation is
    # worse than a clear refusal.
    assert isinstance(failures[0], WorkspaceClaimed)


def test_a_second_window_opens_at_the_configured_size_beside_the_primary(viewers, monkeypatch):
    from quickterm import app as app_mod

    monkeypatch.setattr(
        app_mod, "_screen_list", lambda: [{"x": 0, "y": 0, "width": 1920, "height": 1080}]
    )
    viewers._cfg.window = SimpleNamespace(width=1440, height=900, remember_bounds=True)
    first = _open(viewers, "master", "w1")
    assert viewers._secondary_geometry() == {"width": 1440, "height": 900}

    first.x, first.y = 200, 120
    assert viewers._secondary_geometry() == {"width": 1440, "height": 900, "x": 232, "y": 152}


def test_a_minimized_primary_does_not_send_the_new_window_off_screen(viewers, monkeypatch):
    from quickterm import app as app_mod

    monkeypatch.setattr(
        app_mod, "_screen_list", lambda: [{"x": 0, "y": 0, "width": 1920, "height": 1080}]
    )
    viewers._cfg.window = SimpleNamespace(width=1440, height=900, remember_bounds=True)
    first = _open(viewers, "master", "w1")
    first.x, first.y = -32000, -32000
    assert viewers._secondary_geometry() == {"width": 1440, "height": 900}


# --- the control channel, as the window process runs it ----------------------


class _Channel:
    def __init__(self, commands):
        self._commands = commands
        self.sent = []

    def commands(self):
        yield from self._commands

    def send(self, message):
        self.sent.append(message)
        return True


def test_the_backend_s_commands_open_show_and_quit(viewers, monkeypatch):
    from quickterm import app as app_mod

    first = _open(viewers, "master", "w1")
    first.hidden = True
    opened = []

    def fake_open(*, workspace=None, cwd=None, check_claim=True):
        # The backend checked the claim before it asked.
        opened.append((workspace, cwd, check_claim))
        return "w9"

    monkeypatch.setattr(viewers, "open", fake_open)
    channel = _Channel([
        {"op": "open", "request": "r1", "workspace": "dev", "cwd": None},
        {"op": "show"},
        {"op": "quit"},
        {"op": "open", "request": "never"},
    ])
    app_mod._serve_viewer_control(channel, viewers)

    assert opened == [("dev", None, False)]
    assert channel.sent == [{"event": "opened", "request": "r1", "window_id": "w9"}]
    assert first.hidden is False
    assert first.destroyed is True  # quit closes every window, then nothing more runs


def test_a_refused_open_is_an_answer_not_a_hang(viewers, monkeypatch):
    from quickterm import app as app_mod
    from quickterm.windows import WindowInfo, WorkspaceClaimed

    def refuse(**_kwargs):
        raise WorkspaceClaimed("dev", WindowInfo(id="w1", workspace="dev"))

    monkeypatch.setattr(viewers, "open", refuse)
    channel = _Channel([{"op": "open", "request": "r1", "workspace": "dev"}])
    app_mod._serve_viewer_control(channel, viewers)
    assert channel.sent[0]["event"] == "open_failed"
    assert channel.sent[0]["error"] == "workspace_claimed"


def test_a_backend_that_goes_away_closes_the_windows(viewers):
    from quickterm import app as app_mod

    window = _open(viewers, "master", "w1")
    # EOF on the control pipe: a window onto a dead backend shows dead panes.
    app_mod._serve_viewer_control(_Channel([]), viewers)
    assert window.destroyed is True


def test_window_url_carries_the_window_identity(monkeypatch):
    from quickterm import app as app_mod
    from quickterm import auth

    monkeypatch.setattr(auth, "get_or_create_token", lambda: "tok")
    url = app_mod._window_url(8620, r"C:\dev\my proj", workspace="dev", window_id="w2")
    assert url.startswith("http://127.0.0.1:8620/?")
    assert "workspace=dev" in url
    assert "window=w2" in url
    assert url.endswith("#t=tok")
    assert app_mod._window_url(8620, None, primary=True).startswith(
        "http://127.0.0.1:8620/?primary=1#"
    )
    assert app_mod._window_url(8620) == "http://127.0.0.1:8620/#t=tok"


def test_client_urls_follow_the_configured_host(monkeypatch):
    # validate_config accepts ::1, and a window aimed at 127.0.0.1 could then
    # reach nothing while a second launch started a second backend.
    from quickterm import app as app_mod
    from quickterm import auth

    monkeypatch.setattr(auth, "get_or_create_token", lambda: "tok")
    assert app_mod._window_url(8620, host="::1") == "http://[::1]:8620/#t=tok"
    assert app_mod._window_url(8620, host="localhost") == "http://localhost:8620/#t=tok"
    probed = []

    def fake_open(url, timeout):
        probed.append(url)
        raise OSError("nothing there")

    monkeypatch.setattr(app_mod.cli, "_open", fake_open)
    assert app_mod._already_running(8620, "::1") is False
    assert len(probed) == 1
    assert probed[0].startswith("http://[::1]:8620/api/health?challenge=")


def test_a_runtime_port_is_recorded_as_an_override():
    from quickterm import app as app_mod

    cfg = SimpleNamespace(port=8620, host="127.0.0.1")
    app_mod._override_port(cfg, 53871)
    assert (cfg.port, cfg.runtime_overrides) == (53871, {"port"})


def _ipv6_loopback() -> bool:
    import socket

    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as sock:
            sock.bind(("::1", 0))
        return True
    except OSError:
        return False


def test_a_free_port_is_probed_on_ipv4_loopback_by_default():
    from quickterm import app as app_mod

    assert 0 < app_mod._free_port() < 65536
    assert 0 < app_mod._free_port("localhost") < 65536


@pytest.mark.skipif(not _ipv6_loopback(), reason="no IPv6 loopback on this machine")
def test_a_free_port_is_probed_on_ipv6_loopback_for_an_ipv6_host():
    import socket

    from quickterm import app as app_mod

    port = app_mod._free_port("::1")
    with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as sock:
        sock.bind(("::1", port))  # free on the family the server binds
