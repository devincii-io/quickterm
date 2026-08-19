"""The hide-to-tray decision: closing the window only stays resident when a
live, actually-used session would be lost. Fresh/untouched shells -> quit.

With several windows on one backend the same file also owns the far more
dangerous question of WHICH close is allowed to end the process at all."""

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


# Fail safe: an unexpected error while evaluating the keep policy must hide to
# tray, never quit and take the user's running terminals with it.
def test_manager_error_defaults_to_hiding():
    assert _sessions_worth_keeping(_Broken()) is True


def test_missing_manager_defaults_to_hiding():
    assert _sessions_worth_keeping(None) is True


# --- several windows on one backend ----------------------------------------
# Closing a window is the most dangerous thing in a multi-window app: get it
# wrong and one closed viewer takes down every terminal in every other window.
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


class _FakeTray:
    def __init__(self):
        self.balloons = []

    def balloon_once(self, title, text):
        self.balloons.append((title, text))


@pytest.fixture
def viewers(monkeypatch):
    from quickterm import app as app_mod
    from quickterm.windows import WindowRegistry

    monkeypatch.setattr(app_mod, "_updating", threading.Event())
    cfg = SimpleNamespace(port=8620)
    state = {"manager": _Manager([_Info(alive=True, touched=True)])}
    return app_mod._ViewerWindows(
        cfg, state, WindowRegistry(), elevated=False, base_title="QuickTerm"
    )


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
    viewers.tray = _FakeTray()

    assert _close(second) is True
    # Sessions are backend-owned: nothing was quit, hidden, or killed.
    assert second.hidden is False
    assert first.destroyed is False
    assert viewers.quitting.is_set() is False
    assert viewers.tray.balloons == []
    assert viewers.count() == 1


def test_the_last_window_still_hides_to_tray_when_work_would_be_lost(viewers):
    first = _open(viewers, "master", "w1")
    second = _open(viewers, "child_1", "w2")
    viewers.tray = _FakeTray()

    assert _close(second) is True
    assert _close(first) is False  # last window: the tray rules apply again
    assert first.hidden is True
    assert len(viewers.tray.balloons) == 1


def test_the_last_window_quits_when_nothing_is_worth_keeping(viewers):
    window = _open(viewers, "master", "w1")
    viewers.tray = _FakeTray()
    viewers._state["manager"] = _Manager([_Info(alive=True, touched=False)])

    assert _close(window) is True
    assert window.hidden is False


def test_an_elevated_window_always_quits_on_close(monkeypatch):
    # A resident admin backend visible only in the notification area would be a
    # foot-gun, so an elevated instance never hides, tray icon or not.
    from quickterm import app as app_mod
    from quickterm.windows import WindowRegistry

    monkeypatch.setattr(app_mod, "_updating", threading.Event())
    viewers = app_mod._ViewerWindows(
        SimpleNamespace(port=8620),
        {"manager": _Manager([_Info(alive=True, touched=True)])},
        WindowRegistry(),
        elevated=True,
        base_title="QuickTerm - Administrator",
    )
    window = _open(viewers, "master", "w1")
    viewers.tray = _FakeTray()
    assert _close(window) is True
    assert window.hidden is False


def test_the_last_window_quits_when_no_tray_icon_exists(viewers):
    # Hiding behind an icon that could not be created would look like a crash.
    window = _open(viewers, "master", "w1")
    viewers.tray = None
    assert _close(window) is True
    assert window.hidden is False


def test_an_update_shutdown_lets_every_window_close(viewers):
    from quickterm import app as app_mod

    first = _open(viewers, "master", "w1")
    second = _open(viewers, "child_1", "w2")
    viewers.tray = _FakeTray()
    # Hiding to tray here would leave Inno Setup asking a window that refuses
    # to go away, so the updater's stand-down must reach every window.
    app_mod._updating.set()
    assert _close(second) is True
    assert _close(first) is True
    assert first.hidden is False


def test_quit_destroys_every_window_and_close_stops_vetoing(viewers):
    first = _open(viewers, "master", "w1")
    second = _open(viewers, "child_1", "w2")
    viewers.tray = _FakeTray()

    viewers.quit_all()
    assert (first.destroyed, second.destroyed) == (True, True)
    # Destroy triggers the real close; with quitting set nothing may veto it.
    assert _close(first) is True
    assert _close(second) is True
    assert viewers.count() == 0


def test_a_closed_window_releases_its_workspace_at_once(viewers):
    _open(viewers, "master", "w1")
    window = _open(viewers, "child_1", "w2", title="QuickTerm - dev")
    viewers.tray = _FakeTray()
    viewers._registry.register(window_id="w2", workspace="dev")

    _close(window)
    # Waiting out the heartbeat TTL would block reopening the very workspace
    # the user just closed.
    assert viewers._registry.owner_of("dev") is None


def test_closing_the_first_window_hands_the_bare_title_on(viewers):
    first = _open(viewers, "master", "w1")
    second = _open(viewers, "child_1", "w2", title="QuickTerm - dev")
    viewers.tray = _FakeTray()

    _close(first)
    # hotkeys.py summons by exact title match, so exactly one window must hold
    # it or the Explorer handoff has nothing to aim at.
    assert second.title == "QuickTerm"


def test_show_all_restores_every_window(viewers):
    first = _open(viewers, "master", "w1")
    second = _open(viewers, "child_1", "w2")
    first.hidden = True
    viewers.show_all()
    assert (first.hidden, second.hidden) == (False, False)


def test_a_window_cannot_be_opened_from_the_main_thread(viewers):
    # pywebview only materialises a runtime window off the main thread; from the
    # main thread it would queue one that never appears.
    with pytest.raises(RuntimeError):
        viewers.open(workspace="dev")


def test_opening_a_workspace_another_window_owns_is_refused(viewers):
    from quickterm.windows import WorkspaceClaimed

    viewers._registry.register(window_id="w1", workspace="dev")
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
