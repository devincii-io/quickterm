import asyncio
import os
import time

import pytest

from quickterm.hotkeys import (
    MOD_ALT,
    MOD_CONTROL,
    MOD_NOREPEAT,
    MOD_SHIFT,
    MOD_WIN,
    HotkeyManager,
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


def test_parse_win_f12():
    assert parse_binding("win+f12") == (MOD_WIN | MOD_NOREPEAT, VK_F12)


def test_parse_grave_and_backtick():
    expected = (MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_OEM_3)
    assert parse_binding("ctrl+alt+grave") == expected
    assert parse_binding("ctrl+alt+backtick") == expected


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


def test_voice_package_imports_without_deps():
    import quickterm.voice as voice

    assert isinstance(voice.voice_available(), bool)
    # submodules and lazy exports must import cleanly even without extras
    from quickterm.voice import Recorder, Transcriber, VoiceInput  # noqa: F401
    import quickterm.voice.capture  # noqa: F401
    import quickterm.voice.transcribe  # noqa: F401
