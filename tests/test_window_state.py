"""Remembered window bounds: the file, the on-screen check, and the recorder
that feeds it from pywebview's window events."""

import json
import threading
from types import SimpleNamespace

import pytest

from quickterm import window_state

SCREEN = {"x": 0, "y": 0, "width": 1920, "height": 1080}
LEFT_SCREEN = {"x": -2560, "y": -200, "width": 2560, "height": 1440}
BOUNDS = {"x": 100, "y": 80, "width": 1280, "height": 800, "maximized": False}


def test_a_missing_file_is_no_state(tmp_path):
    assert window_state.load(tmp_path / "window_state.json") is None


@pytest.mark.parametrize(
    "text",
    [
        "{not json",
        "[]",
        '{"x": 1, "y": 2, "width": 3}',
        '{"x": "1", "y": 2, "width": 300, "height": 200}',
        '{"x": 1, "y": 2, "width": 0, "height": 200}',
        '{"x": true, "y": 2, "width": 300, "height": 200}',
    ],
)
def test_a_corrupt_file_is_ignored(tmp_path, text):
    path = tmp_path / "window_state.json"
    path.write_text(text, encoding="utf-8")
    assert window_state.load(path) is None


def test_save_and_load_round_trip(tmp_path):
    path = tmp_path / "window_state.json"
    window_state.save({**BOUNDS, "maximized": True, "extra": "dropped"}, path)

    assert window_state.load(path) == {**BOUNDS, "maximized": True}
    assert json.loads(path.read_text(encoding="utf-8"))["width"] == 1280
    assert [p.name for p in tmp_path.iterdir()] == ["window_state.json"]


def test_invalid_bounds_are_never_written(tmp_path):
    path = tmp_path / "window_state.json"
    window_state.save({"x": 1, "y": 2}, path)
    assert not path.exists()


def test_the_state_file_lives_in_the_config_folder(monkeypatch, tmp_path):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    assert window_state.state_path() == tmp_path / "quickterm" / "window_state.json"


def test_bounds_on_a_screen_are_kept():
    assert window_state.clamp_to_screens(BOUNDS, [SCREEN]) == BOUNDS


def test_bounds_on_a_monitor_left_of_the_primary_are_kept():
    bounds = {**BOUNDS, "x": -1800, "y": -100}
    assert window_state.clamp_to_screens(bounds, [SCREEN, LEFT_SCREEN]) == bounds


def test_bounds_on_an_unplugged_monitor_are_dropped():
    bounds = {**BOUNDS, "x": -1800, "y": -100}
    assert window_state.clamp_to_screens(bounds, [SCREEN]) is None


def test_a_sliver_on_screen_is_not_enough():
    # 40 px of the window is left on the screen: too little to grab.
    bounds = {**BOUNDS, "x": SCREEN["width"] - 40}
    assert window_state.clamp_to_screens(bounds, [SCREEN]) is None
    bounds = {**BOUNDS, "x": SCREEN["width"] - 64}
    assert window_state.clamp_to_screens(bounds, [SCREEN]) == bounds


def test_screens_may_be_pywebview_screen_objects():
    screen = SimpleNamespace(x=0, y=0, width=1920, height=1080)
    assert window_state.clamp_to_screens(BOUNDS, [screen]) == BOUNDS


def test_no_screens_or_no_bounds_mean_no_bounds():
    assert window_state.clamp_to_screens(BOUNDS, []) is None
    assert window_state.clamp_to_screens(None, [SCREEN]) is None


# --- app.py: the primary window's geometry -----------------------------------


def _cfg(**window):
    settings = {"width": 1440, "height": 900, "remember_bounds": True, **window}
    return SimpleNamespace(window=SimpleNamespace(**settings))


def test_the_configured_size_opens_without_remembered_bounds(monkeypatch):
    from quickterm import app

    monkeypatch.setattr(window_state, "load", lambda: None)
    assert app._initial_geometry(_cfg(), lambda: [SCREEN]) == {"width": 1440, "height": 900}


def test_remembered_bounds_open_when_they_still_meet_a_monitor(monkeypatch):
    from quickterm import app

    monkeypatch.setattr(window_state, "load", lambda: {**BOUNDS, "maximized": True})
    assert app._initial_geometry(_cfg(), lambda: [SCREEN]) == {**BOUNDS, "maximized": True}


def test_remembered_bounds_off_every_monitor_fall_back_to_the_size(monkeypatch):
    from quickterm import app

    monkeypatch.setattr(window_state, "load", lambda: {**BOUNDS, "x": 5000})
    assert app._initial_geometry(_cfg(), lambda: [SCREEN]) == {"width": 1440, "height": 900}


def test_remember_off_ignores_the_file(monkeypatch):
    from quickterm import app

    monkeypatch.setattr(window_state, "load", lambda: BOUNDS)
    geometry = app._initial_geometry(_cfg(remember_bounds=False), lambda: [SCREEN])
    assert geometry == {"width": 1440, "height": 900}


def test_a_config_without_window_settings_uses_the_spec_defaults(monkeypatch):
    from quickterm import app

    monkeypatch.setattr(window_state, "load", lambda: None)
    assert app._initial_geometry(SimpleNamespace(), lambda: []) == {"width": 1280, "height": 800}


def test_screen_list_reads_pywebviews_module_property(monkeypatch):
    """pywebview 6 serves `screens` as a proxy around a list; calling it
    raised TypeError and the remembered bounds were never restored."""
    import sys

    from proxy_tools import Proxy

    from quickterm import app

    monkeypatch.setitem(sys.modules, "webview", SimpleNamespace(screens=Proxy(lambda: [SCREEN])))
    assert app._screen_list() == [SCREEN]
    monkeypatch.setitem(sys.modules, "webview", SimpleNamespace(screens=lambda: [SCREEN]))
    assert app._screen_list() == [SCREEN]


def test_the_primary_window_restores_through_the_screen_list(monkeypatch):
    """Pin the call site: the desktop path hands _initial_geometry a callable."""
    import inspect

    from quickterm import app

    source = inspect.getsource(app._run_desktop)
    assert "_initial_geometry(cfg, _screen_list)" in source
    assert "webview.screens)" not in source


def test_remembered_bounds_never_open_below_the_minimum_size(monkeypatch):
    from quickterm import app

    monkeypatch.setattr(window_state, "load", lambda: {**BOUNDS, "width": 300, "height": 200})
    geometry = app._initial_geometry(_cfg(), lambda: [SCREEN])
    assert (geometry["width"], geometry["height"]) == app.MIN_WINDOW_SIZE


# --- app.py: the debounced recorder ------------------------------------------


class _Event:
    def __init__(self):
        self.handlers = []

    def __iadd__(self, handler):
        self.handlers.append(handler)
        return self

    def fire(self, *args):
        for handler in self.handlers:
            handler(*args)


class _Window:
    def __init__(self):
        self.events = SimpleNamespace(
            resized=_Event(), moved=_Event(), maximized=_Event(),
            restored=_Event(), minimized=_Event(),
        )
        self.x, self.y, self.width, self.height = 10, 20, 1300, 820


def _recorder(cfg=None, overlay=False, initial=None, delay=0.01):
    from quickterm import app

    saved = []
    done = threading.Event()

    def save(bounds):
        saved.append(bounds)
        done.set()

    window = _Window()
    recorder = app._BoundsRecorder(
        window, cfg or _cfg(), initial=initial, delay=delay,
        save=save, overlay_applied=lambda: overlay,
    )
    recorder.wire()
    return window, recorder, saved, done


def test_a_resize_is_saved_once_after_the_burst():
    window, _recorder_obj, saved, done = _recorder(delay=0.05)
    for width in (1000, 1100, 1300):
        window.events.resized.fire(width, 820)
    window.events.moved.fire(10, 20)
    assert done.wait(2)
    # Debounced: one write, with the geometry read from the window at the end.
    threading.Event().wait(0.1)  # twice the delay: a second write would have landed
    assert saved == [{"x": 10, "y": 20, "width": 1300, "height": 820, "maximized": False}]


def test_maximizing_keeps_the_normal_bounds_and_sets_the_flag():
    window, recorder, saved, done = _recorder(initial=BOUNDS, delay=0.05)
    window.width, window.height = 1920, 1040
    window.events.resized.fire(1920, 1040)
    window.events.maximized.fire()
    assert done.wait(2)
    assert saved[-1] == {**BOUNDS, "maximized": True}


def test_nothing_is_recorded_while_minimized():
    window, recorder, saved, _done = _recorder(initial=BOUNDS)
    window.events.minimized.fire()
    window.x = window.y = -32000
    window.events.moved.fire(-32000, -32000)
    recorder.flush()
    assert saved == []


def test_nothing_is_recorded_while_the_overlay_owns_the_window():
    window, recorder, saved, _done = _recorder(overlay=True)
    window.events.resized.fire(1920, 540)
    recorder.flush()
    assert saved == []


def test_nothing_is_recorded_with_remember_bounds_off():
    window, recorder, saved, _done = _recorder(cfg=_cfg(remember_bounds=False))
    window.events.resized.fire(1300, 820)
    recorder.flush()
    assert saved == []
