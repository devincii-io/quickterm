"""The backend's side of "needs you": flash the taskbar, or a tray balloon.

The tray lives in the backend and the windows in its window process, so every
window check here is about that process's windows."""

from __future__ import annotations

import os
import sys
import threading
import types
from types import SimpleNamespace

import pytest

import quickterm
from quickterm import app as app_mod
from quickterm import pty_host
from quickterm.windows import WindowRegistry


class _Tray:
    def __init__(self):
        self.balloons = []

    def balloon_once(self, title, text):
        pass

    def balloon(self, title, text, quiet=False):
        assert quiet, "the Sound setting decides, never the balloon's own sound"
        self.balloons.append((title, text))


@pytest.fixture
def fake_tray_module(monkeypatch):
    mod = types.ModuleType("quickterm.tray")
    mod.foreground = False
    mod.window = (101, True)
    mod.flashed = []
    mod.asked = []

    def foreground_is_ours(pids=None):
        mod.asked.append(pids)
        return mod.foreground

    def own_window(title, pids=None):
        return mod.window if title == "QuickTerm" and pids == {77} else None

    mod.foreground_is_ours = foreground_is_ours
    mod.own_window = own_window
    mod.flash_window = mod.flashed.append
    monkeypatch.setitem(sys.modules, "quickterm.tray", mod)
    monkeypatch.setattr(quickterm, "tray", mod, raising=False)
    return mod


@pytest.fixture
def host():
    cfg = SimpleNamespace(port=8650, host="127.0.0.1")
    shell = pty_host.Host(cfg, WindowRegistry(), from_copy=True)
    # A running window process with one window (pid 77).
    shell._viewer = SimpleNamespace(pid=77, window_ids=["w1"])
    shell.tray = _Tray()
    return shell


@pytest.fixture
def sounds(monkeypatch):
    played = []
    monkeypatch.setattr(pty_host, "play_notification_sound", lambda: played.append(True))
    return played


def test_flash_flashes_a_visible_primary_window_and_nothing_else(host, fake_tray_module, sounds):
    host.notify_now("claude", "notify", "Approve?", mode="flash")
    assert fake_tray_module.flashed == [101]
    assert host.tray.balloons == []
    assert sounds == []
    # "In front" means the window process's window, not the backend's.
    assert fake_tray_module.asked == [{77}]


def test_notify_flashes_and_shows_a_notification(host, fake_tray_module, sounds):
    host.notify_now("claude", "done", "Tests pass.", mode="notify", sound=True)
    assert fake_tray_module.flashed == [101]
    assert host.tray.balloons == [("claude finished", "Tests pass.")]
    assert sounds == [True]


def test_off_does_nothing(host, fake_tray_module, sounds):
    host.notify_now("claude", "done", "x", mode="off", sound=True)
    fake_tray_module.window = (101, False)
    host.notify_now("claude", "notify", "x", mode="off", sound=True)
    assert (fake_tray_module.flashed, host.tray.balloons, sounds) == ([], [], [])


def test_flash_with_everything_in_the_tray_stays_quiet(host, fake_tray_module, sounds):
    fake_tray_module.window = (101, False)
    host.notify_now("claude", "done", "x", mode="flash", sound=True)
    assert (fake_tray_module.flashed, host.tray.balloons, sounds) == ([], [], [])


def test_the_terminal_on_screen_is_never_announced(host, fake_tray_module, sounds):
    # QuickTerm in front: the terminal is on screen or one click away in the
    # sidebar, which already says it finished.
    fake_tray_module.foreground = True
    for kind in ("done", "notify"):
        host.notify_now("claude", kind, "x", mode="notify", sound=True)
    assert (fake_tray_module.flashed, host.tray.balloons, sounds) == ([], [], [])


def test_notice_actions_policy():
    actions = pty_host.notice_actions
    common = {"has_tray": True, "hidden_only": True}
    assert actions("notify", in_front=False, window_visible=True, **common) == (True, True)
    assert actions("flash", in_front=False, window_visible=True, **common) == (True, False)
    assert actions("off", in_front=False, window_visible=True, **common) == (False, False)
    assert actions("notify", in_front=True, window_visible=True, **common) == (False, False)
    assert actions("notify", in_front=False, window_visible=False, **common) == (False, True)
    # Another window is visible somewhere: its sidebar shows it.
    assert actions("notify", in_front=False, window_visible=False, has_tray=True,
                   hidden_only=False) == (False, False)
    assert actions("notify", in_front=False, window_visible=True, has_tray=False,
                   hidden_only=True) == (True, False)


def test_nothing_happens_while_quickterm_is_in_front(host, fake_tray_module):
    fake_tray_module.foreground = True
    host.notify_now("claude", "bell", None)
    assert fake_tray_module.flashed == []
    assert host.tray.balloons == []


def test_a_hidden_primary_shows_a_balloon(host, fake_tray_module):
    fake_tray_module.window = (101, False)
    host.notify_now("build", "exit", "exited with code 1")
    assert fake_tray_module.flashed == []
    assert host.tray.balloons == [("build needs you", "exited with code 1")]


def test_no_window_process_at_all_shows_a_balloon(host, fake_tray_module):
    # The backend stayed in the tray after the last window closed.
    host._viewer = None
    host.notify_now("build", "exit", None)
    assert host.tray.balloons == [("build needs you", "It has finished.")]


def test_hidden_without_a_tray_icon_stays_quiet(host, fake_tray_module):
    fake_tray_module.window = (101, False)
    host.tray = None
    host.notify_now("build", "bell", None)
    assert fake_tray_module.flashed == []


def test_a_quitting_app_notifies_nobody(host, fake_tray_module):
    host.quitting.set()
    host.notify_now("claude", "bell", None)
    assert fake_tray_module.flashed == []


def test_the_hook_returns_at_once_and_notifies_off_the_loop(host, monkeypatch):
    done = threading.Event()
    seen = []

    def record(name, kind, text, **settings):
        seen.append((threading.current_thread().name, name, kind, text, settings))
        done.set()

    monkeypatch.setattr(host, "notify_now", record)
    host.notify_attention("sid", "claude", "notify", "hi", mode="flash", sound=True)
    assert done.wait(5)
    assert seen == [("attention-notify", "claude", "notify", "hi", {"mode": "flash", "sound": True})]


def test_balloon_copy():
    assert app_mod.attention_balloon("claude", "notify", "Approve the edit?") == (
        "claude needs you", "Approve the edit?",
    )
    assert app_mod.attention_balloon("pwsh", "bell", None) == ("pwsh needs you", "It rang the bell.")
    assert app_mod.attention_balloon("", "exit", None) == ("A terminal needs you", "It has finished.")
    assert app_mod.attention_balloon("Fix login", "done", "Tests pass.") == ("Fix login finished", "Tests pass.")
    assert app_mod.attention_balloon("", "done", None) == ("An agent finished", "Its turn is done.")


@pytest.mark.skipif(os.name != "nt", reason="Win32 window helpers")
def test_the_win32_helpers_answer_without_a_window():
    from quickterm import tray

    assert tray.own_window("QuickTerm no such window title") is None
    assert tray.foreground_is_ours() in (True, False)


@pytest.mark.skipif(os.name != "nt", reason="tray.py is the Win32 tray")
def test_balloon_text_is_cut_by_utf16_units_not_code_points():
    # The balloon fields are fixed WCHAR arrays: 200 emoji are 400 units and
    # overflowed a 256-unit field, so ctypes raised and the balloon was lost.
    from quickterm.tray import _utf16_prefix

    cut = _utf16_prefix("\U0001f600" * 200, 255)
    assert len(cut.encode("utf-16-le")) <= 255 * 2
    assert cut == "\U0001f600" * 127  # never half a surrogate pair
    assert _utf16_prefix("short", 63) == "short"
