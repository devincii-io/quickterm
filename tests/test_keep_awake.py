"""Keep awake: hold off system sleep while an agent works, and only then."""

from __future__ import annotations

import asyncio
import os

import pytest

import quickterm.session_manager as session_manager
from quickterm import keep_awake
from quickterm.config import AppConfig, validate_config
from quickterm.keep_awake import HOLD, RELEASE, KeepAwake, wanted
from quickterm.session_manager import SessionManager
from tests.test_session_manager import _RecordingPty


def test_the_modes():
    assert wanted("agents", True) and not wanted("agents", False)
    assert wanted("always", False) and wanted("always", True)
    assert not wanted("off", True)
    # A mode from a newer or hand-edited config falls back to the default.
    assert wanted("sometimes", True) and not wanted("sometimes", False)


def test_windows_is_called_only_on_a_change():
    calls = []
    awake = KeepAwake(set_state=lambda flags: calls.append(flags) or True)
    awake.update("agents", False)
    assert calls == []
    awake.update("agents", True)
    awake.update("agents", True)
    assert calls == [HOLD] and awake.held
    awake.update("off", True)
    assert calls == [HOLD, RELEASE] and not awake.held
    awake.update("always", False)
    awake.release()
    awake.release()
    assert calls == [HOLD, RELEASE, HOLD, RELEASE]


def test_a_refused_hold_is_tried_again():
    answers = iter([False, True])
    calls = []

    def set_state(flags):
        calls.append(flags)
        return next(answers)

    awake = KeepAwake(set_state=set_state)
    awake.update("agents", True)
    assert not awake.held
    awake.update("agents", True)
    assert awake.held and calls == [HOLD, HOLD]


def test_the_flags_ask_for_the_system_only():
    assert HOLD == keep_awake.ES_CONTINUOUS | keep_awake.ES_SYSTEM_REQUIRED
    assert RELEASE == keep_awake.ES_CONTINUOUS
    assert not HOLD & 0x2  # ES_DISPLAY_REQUIRED: the screen may still turn off


def test_the_config_takes_the_three_modes():
    cfg = AppConfig()
    assert cfg.keep_awake == "agents"
    for mode in keep_awake.MODES:
        cfg.keep_awake = mode
        validate_config(cfg)
    cfg.keep_awake = "sometimes"
    with pytest.raises(ValueError, match="Keep awake"):
        validate_config(cfg)


@pytest.fixture
async def manager(monkeypatch):
    monkeypatch.setattr(session_manager, "PtySession", _RecordingPty)
    calls = []
    monkeypatch.setattr(keep_awake, "_set_execution_state", lambda flags: calls.append(flags) or True)
    mgr = SessionManager(asyncio.get_running_loop())
    mgr.calls = calls
    mode = ["agents"]
    mgr.mode = mode
    mgr.set_keep_awake(lambda: mode[0])
    yield mgr
    mgr.shutdown()


async def test_held_while_an_agent_works_and_released_when_the_last_one_stops(manager):
    one = manager.spawn(cmd="claude.exe")
    two = manager.spawn(cmd="claude.exe")
    assert manager.calls == []
    manager.agent_event(one.id, "claude", "UserPromptSubmit", {"prompt": "p"})
    manager.agent_event(two.id, "claude", "UserPromptSubmit", {"prompt": "q"})
    assert manager.calls == [HOLD]
    manager.agent_event(one.id, "claude", "Stop", {})
    assert manager.calls == [HOLD]
    # Waiting for a permission is not working: the person may be away.
    manager.agent_event(two.id, "claude", "PermissionRequest", {})
    assert manager.calls == [HOLD, RELEASE]
    manager.agent_event(one.id, "claude", "UserPromptSubmit", {"prompt": "again"})
    assert manager.calls == [HOLD, RELEASE, HOLD]


async def test_released_when_the_agent_exits_or_the_terminal_ends(manager):
    info = manager.spawn(cmd="claude.exe")
    pty = _RecordingPty.last
    manager.agent_event(info.id, "claude", "UserPromptSubmit", {"prompt": "p"})
    assert manager.calls == [HOLD]
    pty.on_exit(0)
    assert manager.calls == [HOLD, RELEASE]


async def test_a_settings_change_applies_on_the_next_check(manager):
    info = manager.spawn(cmd="claude.exe")
    manager.agent_event(info.id, "claude", "UserPromptSubmit", {"prompt": "p"})
    manager.mode[0] = "off"
    manager.check_keep_awake()
    assert manager.calls == [HOLD, RELEASE]
    manager.mode[0] = "always"
    manager.agent_event(info.id, "claude", "Stop", {})
    assert manager.calls == [HOLD, RELEASE, HOLD]


async def test_released_on_shutdown(manager):
    manager.mode[0] = "always"
    manager.check_keep_awake()
    assert manager.calls == [HOLD]
    manager.shutdown()
    assert manager.calls == [HOLD, RELEASE]
    assert manager._keep_awake_timer is None


async def test_the_timer_keeps_looking_without_events(manager, monkeypatch):
    # An agent that left the shell is noticed by the process snapshot, not by
    # an event; the tick is what releases then.
    assert manager._keep_awake_timer is not None
    manager.mode[0] = "always"
    manager._keep_awake_tick()
    assert manager.calls == [HOLD]


@pytest.mark.skipif(os.name != "nt", reason="SetThreadExecutionState is Win32")
def test_the_real_call_answers(monkeypatch):
    monkeypatch.undo()  # the conftest stub
    # ES_CONTINUOUS alone clears what this thread held, which is nothing.
    assert keep_awake._set_execution_state(keep_awake.RELEASE) is True
