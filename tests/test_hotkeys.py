import asyncio
import os
import time

import pytest

from quickterm import hotkeys
from quickterm.hotkeys import (
    MOD_ALT,
    MOD_CONTROL,
    MOD_NOREPEAT,
    MOD_SHIFT,
    MOD_WIN,
    HotkeyManager,
    _title_matches,
    parse_binding,
)

VK_F11 = 0x7A
VK_F12 = 0x7B
VK_OEM_3 = 0xC0  # grave/backtick
VK_SPACE = 0x20
VK_TAB = 0x09
VK_ESCAPE = 0x1B


def test_parse_ctrl_alt_1():
    assert parse_binding("ctrl+alt+1") == (
        MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, ord("1"))


def test_normal_window_title_never_matches_administrator_viewer():
    assert _title_matches("QuickTerm", "QuickTerm") is True
    assert _title_matches("QuickTerm - Administrator", "QuickTerm") is False


def test_parse_win_f12():
    assert parse_binding("win+f12") == (MOD_WIN | MOD_NOREPEAT, VK_F12)


def test_parse_grave_and_backtick(monkeypatch):
    monkeypatch.setattr(hotkeys, "_vk_for_scan", lambda scan, fallback: fallback)
    expected = (MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_OEM_3)
    assert parse_binding("ctrl+alt+grave") == expected
    assert parse_binding("ctrl+alt+backtick") == expected


def test_named_punctuation_resolves_the_physical_key(monkeypatch):
    # Settings records `e.code`, a position. On QWERTZ the US "-" position is
    # the ß key, whose virtual key is VK_OEM_4, so the layout decides the VK.
    seen = []

    def qwertz(scan, fallback):
        seen.append(scan)
        return {0x0C: 0xDB, 0x29: 0xDC}.get(scan, fallback)

    monkeypatch.setattr(hotkeys, "_vk_for_scan", qwertz)
    assert parse_binding("ctrl+alt+minus") == (MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 0xDB)
    assert parse_binding("ctrl+alt+grave") == (MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 0xDC)
    assert seen == [0x0C, 0x29]


def test_scan_code_falls_back_to_the_us_key_off_windows(monkeypatch):
    monkeypatch.setattr(hotkeys.os, "name", "posix")
    assert hotkeys._vk_for_scan(0x0C, 0xBD) == 0xBD


def test_parse_shift_space():
    assert parse_binding("shift+space") == (MOD_SHIFT | MOD_NOREPEAT, VK_SPACE)


def test_parse_named_keys():
    assert parse_binding("ctrl+tab") == (MOD_CONTROL | MOD_NOREPEAT, VK_TAB)
    assert parse_binding("ctrl+esc") == (MOD_CONTROL | MOD_NOREPEAT, VK_ESCAPE)


def test_parse_letter():
    assert parse_binding("ctrl+alt+v") == (
        MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, ord("V"))


def test_parse_case_insensitive():
    assert parse_binding("CTRL+Alt+A") == parse_binding("ctrl+alt+a")
    assert parse_binding("WIN+F12") == parse_binding("win+f12")


def test_parse_whitespace_tolerant():
    assert parse_binding("ctrl + alt + 1") == parse_binding("ctrl+alt+1")


def test_parse_key_only():
    assert parse_binding("f24") == (MOD_NOREPEAT, 0x70 + 23)


def test_parse_noreapeat_always_set():
    for b in ("ctrl+a", "f1", "win+shift+9"):
        mods, _vk = parse_binding(b)
        assert mods & MOD_NOREPEAT


@pytest.mark.parametrize("bad", [
    "",
    "ctrl+",
    "+a",
    "ctrl++a",
    "ctrl+alt",          # modifier in key position
    "nosuchkey",
    "ctrl+nosuchkey",
    "bogus+a",           # unknown modifier
    "ctrl+f25",          # beyond f24
    "ctrl+ab",           # multi-char non-named key
])
def test_parse_invalid_raises(bad):
    with pytest.raises(ValueError):
        parse_binding(bad)


def test_manager_lifecycle_and_register():
    loop = asyncio.new_event_loop()
    try:
        mgr = HotkeyManager(loop)
        mgr.start()
        result = mgr.register("ctrl+alt+f11", lambda: None)
        assert isinstance(result, bool)  # may be False if taken on this machine
        if os.name != "nt":
            assert result is False
        t0 = time.monotonic()
        mgr.stop()
        assert time.monotonic() - t0 < 2.0
        assert mgr._thread is None
    finally:
        loop.close()


def test_manager_register_invalid_returns_false():
    loop = asyncio.new_event_loop()
    try:
        mgr = HotkeyManager(loop)
        assert mgr.register("not+a+real+key+!!nope!!", lambda: None) is False
        mgr.stop()
    finally:
        loop.close()


@pytest.mark.parametrize(
    ("key", "vk"),
    [
        ("minus", 0xBD), ("equal", 0xBB), ("comma", 0xBC), ("period", 0xBE),
        ("slash", 0xBF), ("semicolon", 0xBA), ("quote", 0xDE), ("bracketleft", 0xDB),
        ("bracketright", 0xDD), ("backslash", 0xDC), ("left", 0x25), ("up", 0x26),
        ("right", 0x27), ("down", 0x28), ("home", 0x24), ("end", 0x23), ("pageup", 0x21),
        ("pagedown", 0x22), ("insert", 0x2D), ("delete", 0x2E), ("numpad0", 0x60),
        ("numpad9", 0x69),
    ],
)
def test_named_keys_from_the_shared_grammar(monkeypatch, key, vk):
    # The US layout's answer; the layout lookup itself is tested above.
    monkeypatch.setattr(hotkeys, "_vk_for_scan", lambda scan, fallback: fallback)
    assert parse_binding(f"ctrl+alt+{key}") == (MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, vk)


def test_control_is_an_alias_of_ctrl():
    assert parse_binding("control+shift+pageup") == parse_binding("ctrl+shift+pageup")


@pytest.mark.skipif(os.name != "nt", reason="VkKeyScanW maps legacy punctuation")
def test_legacy_single_punctuation_still_parses():
    mods, vk = parse_binding("ctrl+alt+-")
    assert mods == MOD_CONTROL | MOD_ALT | MOD_NOREPEAT
    assert 0 < vk < 0xFF


# --- the manager's jobs, against a fake user32 ------------------------------


class FakeUser32:
    def __init__(self, taken=()):
        self.taken = set(taken)
        self.registered: dict[int, tuple[int, int]] = {}

    def RegisterHotKey(self, _hwnd, hotkey_id, mods, vk):
        if (mods, vk) in self.taken:
            return 0
        self.registered[hotkey_id] = (mods, vk)
        return 1

    def UnregisterHotKey(self, _hwnd, hotkey_id):
        self.registered.pop(hotkey_id, None)
        return 1


@pytest.fixture
def fake_manager(monkeypatch):
    """A manager whose jobs run synchronously against FakeUser32."""
    from types import SimpleNamespace

    from quickterm import hotkeys

    monkeypatch.setattr(hotkeys, "os", SimpleNamespace(name="nt"))
    loop = asyncio.new_event_loop()
    mgr = HotkeyManager(loop)
    user32 = FakeUser32(taken={parse_binding("ctrl+alt+q")})
    mgr._submit = lambda run: run(user32)
    yield mgr, user32, loop
    mgr._cancel_resume()
    loop.close()


def _bindings(user32):
    return sorted(user32.registered.values())


def test_rebind_replaces_every_registration_and_reports_each(fake_manager):
    mgr, user32, _loop = fake_manager
    assert mgr.register("ctrl+alt+1", lambda: None) is True

    results = mgr.rebind([("ctrl+alt+2", lambda: None), ("ctrl+alt+q", lambda: None),
                          ("ctrl+nosuchkey", lambda: None)])

    assert results == [True, False, False]
    assert _bindings(user32) == [parse_binding("ctrl+alt+2")]


def test_unregister_all_releases_everything(fake_manager):
    mgr, user32, _loop = fake_manager
    mgr.register("ctrl+alt+1", lambda: None)
    mgr.register("ctrl+alt+2", lambda: None)
    mgr.unregister_all()
    assert user32.registered == {}


def test_suspend_releases_the_keys_and_resume_takes_them_back(fake_manager):
    mgr, user32, _loop = fake_manager
    mgr.register("ctrl+alt+1", lambda: None)
    mgr.register("ctrl+alt+grave", lambda: None, on_hotkey_thread=True)
    before = _bindings(user32)

    mgr.suspend(seconds=60)
    assert user32.registered == {}
    mgr.suspend(seconds=60)  # a second suspend must not lose the parked keys
    mgr.resume()

    assert _bindings(user32) == before
    assert mgr._resume_timer is None


def test_suspend_resumes_on_its_own(fake_manager):
    mgr, user32, _loop = fake_manager
    mgr.register("ctrl+alt+1", lambda: None)
    mgr.suspend(seconds=0.01)
    deadline = time.monotonic() + 2
    while not user32.registered and time.monotonic() < deadline:
        time.sleep(0.01)
    assert _bindings(user32) == [parse_binding("ctrl+alt+1")]


def test_rebind_during_a_suspension_ends_it(fake_manager):
    mgr, user32, _loop = fake_manager
    mgr.register("ctrl+alt+1", lambda: None)
    mgr.suspend(seconds=60)
    mgr.rebind([("ctrl+alt+3", lambda: None)])
    mgr.resume()  # nothing parked any more: the old key stays released
    assert _bindings(user32) == [parse_binding("ctrl+alt+3")]


def test_hotkey_thread_callbacks_run_in_place_others_go_to_the_loop(fake_manager):
    mgr, _user32, loop = fake_manager
    calls = []
    mgr.register("ctrl+alt+1", lambda: calls.append("loop"))
    mgr.register("ctrl+alt+2", lambda: calls.append("thread"), on_hotkey_thread=True)
    loop_id, thread_id = sorted(mgr._active)

    mgr._dispatch(thread_id)
    assert calls == ["thread"]
    mgr._dispatch(loop_id)
    assert calls == ["thread"]  # scheduled, not run
    loop.run_until_complete(asyncio.sleep(0))
    assert calls == ["thread", "loop"]


def test_a_failing_hotkey_thread_callback_is_contained(fake_manager):
    mgr, _user32, _loop = fake_manager

    def boom():
        raise RuntimeError("boom")

    mgr.register("ctrl+alt+1", boom, on_hotkey_thread=True)
    mgr._dispatch(next(iter(mgr._active)))  # must not raise into the message loop


# --- toggle_window with and without the overlay ------------------------------


class FakeWindows:
    def __init__(self, foreground):
        self.foreground = foreground
        self.calls = []

    def GetForegroundWindow(self):
        return self.foreground

    def ShowWindow(self, hwnd, command):
        self.calls.append(("show", hwnd, command))

    def SetForegroundWindow(self, hwnd):
        self.calls.append(("foreground", hwnd))


@pytest.fixture
def toggle_env(monkeypatch):
    from types import SimpleNamespace

    from quickterm import hotkeys, overlay

    state = SimpleNamespace(visible=[7], hidden=[], applied=set(), calls=[], user32=None)

    def windows(_title, *, own_process=False):
        # The toggle restyles what it finds, so it must never look at another
        # process's "QuickTerm" window.
        assert own_process is True
        return state.user32, state.visible, state.hidden

    monkeypatch.setattr(hotkeys, "_quickterm_windows", windows)
    monkeypatch.setattr(overlay, "is_applied", lambda hwnd=None: hwnd in state.applied)
    monkeypatch.setattr(overlay, "show_overlay", lambda hwnd, cfg: state.calls.append(("show_overlay", hwnd)))
    monkeypatch.setattr(overlay, "hide_overlay", lambda hwnd, cfg: state.calls.append(("hide_overlay", hwnd)))
    monkeypatch.setattr(overlay, "show_normal", lambda hwnd: state.calls.append(("show_normal", hwnd)))
    return state


def _overlay_cfg(enabled=True):
    from types import SimpleNamespace

    return SimpleNamespace(enabled=enabled)


def test_the_overlay_drops_down_when_it_is_not_in_front(toggle_env):
    from quickterm.hotkeys import toggle_window

    toggle_env.user32 = FakeWindows(foreground=99)
    toggle_window("QuickTerm", _overlay_cfg())
    assert toggle_env.calls == [("show_overlay", 7)]


def test_the_overlay_hides_on_the_second_press(toggle_env):
    from quickterm.hotkeys import toggle_window

    toggle_env.user32 = FakeWindows(foreground=7)
    toggle_env.applied.add(7)
    toggle_window("QuickTerm", _overlay_cfg())
    assert toggle_env.calls == [("hide_overlay", 7)]


def test_a_hidden_overlay_drops_down_again(toggle_env):
    from quickterm.hotkeys import toggle_window

    toggle_env.user32 = FakeWindows(foreground=0)
    toggle_env.visible, toggle_env.hidden = [], [7]
    toggle_env.applied.add(7)
    toggle_window("QuickTerm", _overlay_cfg())
    assert toggle_env.calls == [("show_overlay", 7)]


def test_turning_the_overlay_off_restores_a_normal_window(toggle_env):
    from quickterm.hotkeys import toggle_window

    toggle_env.user32 = FakeWindows(foreground=7)
    toggle_env.applied.add(7)
    toggle_window("QuickTerm", _overlay_cfg(enabled=False))
    assert toggle_env.calls == [("show_normal", 7)]
    assert toggle_env.user32.calls == []  # not minimized away


def test_without_the_overlay_the_toggle_minimizes_and_restores(toggle_env):
    from quickterm import hotkeys

    toggle_env.user32 = FakeWindows(foreground=7)
    hotkeys.toggle_window("QuickTerm", None)
    assert toggle_env.user32.calls == [("show", 7, hotkeys._SW_MINIMIZE)]

    toggle_env.user32 = FakeWindows(foreground=99)
    hotkeys.toggle_window("QuickTerm")
    assert toggle_env.user32.calls == [("show", 7, hotkeys._SW_RESTORE), ("foreground", 7)]


# --- app.py: live rebinding --------------------------------------------------


class _RecordingManager:
    def __init__(self, results):
        self.results = results
        self.entries = None

    def rebind(self, entries):
        self.entries = list(entries)
        return self.results(self.entries)


def _app_cfg(summon="ctrl+alt+grave", keys=("ctrl+alt+1",)):
    from types import SimpleNamespace

    profiles = [SimpleNamespace(name=f"p{i}", keybinding=key) for i, key in enumerate(keys)]
    profiles.append(SimpleNamespace(name="plain", keybinding=None))
    return SimpleNamespace(summon_hotkey=summon, profiles=profiles, hotkey_error="stale")


def test_rebind_registers_summon_on_the_hotkey_thread_and_clears_the_error(monkeypatch):
    from quickterm import app, hotkeys

    loop = asyncio.new_event_loop()
    try:
        manager = _RecordingManager(lambda entries: [True] * len(entries))
        cfg = _app_cfg()
        app._GlobalHotkeys(hotkeys, manager, loop, None, cfg).rebind(cfg)

        assert [(e.binding, e.on_hotkey_thread) for e in manager.entries] == [
            ("ctrl+alt+1", False), ("ctrl+alt+grave", True),
        ]
        assert cfg.hotkey_error is None
    finally:
        loop.close()


@pytest.mark.skipif(os.name != "nt", reason="only Windows reports refused hotkeys")
def test_rebind_names_a_key_another_program_owns():
    from quickterm import app, hotkeys

    loop = asyncio.new_event_loop()
    try:
        manager = _RecordingManager(lambda entries: [e.binding != "ctrl+alt+grave" for e in entries])
        cfg = _app_cfg()
        app._GlobalHotkeys(hotkeys, manager, loop, None, cfg).rebind(cfg)
        assert cfg.hotkey_error == "ctrl+alt+grave is in use by another program"
    finally:
        loop.close()


def test_the_summon_callback_reads_the_overlay_at_press_time(monkeypatch):
    from types import SimpleNamespace

    from quickterm import app, hotkeys

    pressed = []
    monkeypatch.setattr(hotkeys, "toggle_window", lambda title, overlay: pressed.append((title, overlay)))
    loop = asyncio.new_event_loop()
    try:
        manager = _RecordingManager(lambda entries: [True] * len(entries))
        cfg = _app_cfg(keys=())
        app._GlobalHotkeys(hotkeys, manager, loop, None, cfg).rebind(cfg)
        cfg.overlay = SimpleNamespace(enabled=True)
        manager.entries[-1].callback()
        assert pressed == [("QuickTerm", cfg.overlay)]
    finally:
        loop.close()


def test_hotkey_error_text():
    from quickterm.app import hotkey_error_text

    assert hotkey_error_text([]) is None
    assert hotkey_error_text(["ctrl+alt+1 (pwsh)"]) == "ctrl+alt+1 (pwsh) is in use by another program"
    assert hotkey_error_text(["a", "b"]) == "a, b are in use by other programs"


def test_voice_package_imports_without_deps():
    import quickterm.voice as voice

    assert isinstance(voice.voice_available(), bool)
    # submodules and lazy exports must import cleanly even without extras
    from quickterm.voice import Recorder, Transcriber, VoiceInput  # noqa: F401
    import quickterm.voice.capture  # noqa: F401
    import quickterm.voice.transcribe  # noqa: F401
