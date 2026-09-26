"""The desktop shell's side of "needs you": flash the taskbar, or a tray balloon."""

from __future__ import annotations

import os
import sys
import threading
import types
from types import SimpleNamespace

import pytest

import quickterm
from quickterm import app as app_mod
from quickterm.windows import WindowRegistry
from tests.test_close_policy import _FakeWindow


class _Tray:
    def __init__(self):
        self.balloons = []

    def balloon_once(self, title, text):
        pass

    def balloon(self, title, text):
        self.balloons.append((title, text))


@pytest.fixture
def fake_tray_module(monkeypatch):
    mod = types.ModuleType("quickterm.tray")
    mod.foreground = False
    mod.window = (101, True)
    mod.flashed = []
    mod.foreground_is_ours = lambda: mod.foreground
    mod.own_window = lambda title: mod.window if title == "QuickTerm" else None
    mod.flash_window = mod.flashed.append
    monkeypatch.setitem(sys.modules, "quickterm.tray", mod)
    monkeypatch.setattr(quickterm, "tray", mod, raising=False)
    return mod


@pytest.fixture
def viewers(monkeypatch):
    monkeypatch.setattr(app_mod, "_updating", threading.Event())
    cfg = SimpleNamespace(port=8620, host="127.0.0.1")
    shell = app_mod._ViewerWindows(
        cfg, {}, WindowRegistry(), elevated=False, base_title="QuickTerm"
    )
    shell.adopt(_FakeWindow("master"), "w1")
    shell.tray = _Tray()
    return shell


def test_a_visible_primary_window_is_flashed(viewers, fake_tray_module):
    viewers._notify_now("claude", "notify", "Approve?")
    assert fake_tray_module.flashed == [101]
    assert viewers.tray.balloons == []


def test_nothing_happens_while_quickterm_is_in_front(viewers, fake_tray_module):
    fake_tray_module.foreground = True
    viewers._notify_now("claude", "bell", None)
    assert fake_tray_module.flashed == []
    assert viewers.tray.balloons == []


def test_a_tray_hidden_app_shows_a_balloon(viewers, fake_tray_module):
    fake_tray_module.window = (101, False)
    viewers._notify_now("build", "exit", "exited with code 1")
    assert fake_tray_module.flashed == []
    assert viewers.tray.balloons == [("build needs you", "exited with code 1")]


def test_hidden_without_a_tray_icon_stays_quiet(viewers, fake_tray_module):
    fake_tray_module.window = (101, False)
    viewers.tray = None
    viewers._notify_now("build", "bell", None)
    assert fake_tray_module.flashed == []


def test_a_quitting_app_notifies_nobody(viewers, fake_tray_module):
    viewers.quitting.set()
    viewers._notify_now("claude", "bell", None)
    assert fake_tray_module.flashed == []


def test_the_hook_returns_at_once_and_notifies_off_the_loop(viewers, monkeypatch):
    done = threading.Event()
    seen = []

    def record(name, kind, text):
        seen.append((threading.current_thread().name, name, kind, text))
        done.set()

    monkeypatch.setattr(viewers, "_notify_now", record)
    viewers.notify_attention("sid", "claude", "notify", "hi")
    assert done.wait(5)
    assert seen == [("attention-notify", "claude", "notify", "hi")]


def test_balloon_copy():
    assert app_mod.attention_balloon("claude", "notify", "Approve the edit?") == (
        "claude needs you", "Approve the edit?",
    )
    assert app_mod.attention_balloon("pwsh", "bell", None) == ("pwsh needs you", "It rang the bell.")
    assert app_mod.attention_balloon("", "exit", None) == ("A terminal needs you", "It has finished.")


@pytest.mark.skipif(os.name != "nt", reason="Win32 window helpers")
def test_the_win32_helpers_answer_without_a_window():
    from quickterm import tray

    assert tray.own_window("QuickTerm no such window title") is None
    assert tray.foreground_is_ours() in (True, False)
