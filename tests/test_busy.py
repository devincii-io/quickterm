"""Busy detection: a session is busy while its shell has a child process."""

import asyncio
import logging
import os
import subprocess
import sys
import time

import pytest

import quickterm.session_manager as session_manager_module
from quickterm.session_manager import SessionManager, pids_with_children


def test_pids_with_children_sees_own_child():
    child = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if os.getpid() in pids_with_children():
                break
            time.sleep(0.1)
        else:
            raise AssertionError("own pid never showed up as a parent")
    finally:
        child.kill()
        child.wait()


@pytest.fixture
async def manager():
    mgr = SessionManager(asyncio.get_running_loop())
    yield mgr
    mgr.shutdown()


async def test_busy_ids_flags_shell_with_running_child(manager):
    # a shell that runs a long-lived child: busy while the child lives
    if os.name == "nt":
        info = manager.spawn(cmd="cmd.exe", args=["/c", "ping -n 30 127.0.0.1 >nul"])
    else:
        info = manager.spawn(cmd="/bin/sh", args=["-c", "sleep 30"])
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if info.id in manager.busy_ids():
            break
        await asyncio.sleep(0.15)
    else:
        raise AssertionError("session with a running child was never busy")
    manager.kill(info.id)


async def test_busy_ids_skips_dead_sessions(manager):
    if os.name == "nt":
        info = manager.spawn(cmd="cmd.exe", args=["/c", "echo hi"])
    else:
        info = manager.spawn(cmd="/bin/sh", args=["-c", "echo hi"])
    att = manager.attach(info.id)
    while await asyncio.wait_for(att.queue.get(), timeout=15) is not None:
        pass  # drain to the exit sentinel
    assert info.id not in manager.busy_ids()


async def test_busy_snapshot_failure_is_debuggable(manager, monkeypatch, caplog):
    def fail(identities=None):
        raise RuntimeError("snapshot broke")

    monkeypatch.setattr(session_manager_module, "pids_with_children", fail)
    with caplog.at_level(logging.DEBUG, logger="quickterm.session_manager"):
        assert manager.busy_ids() == set()
    assert "process child snapshot failed" in caplog.text
    assert "snapshot broke" in caplog.text


class _FakePty:
    def __init__(self, cmd, args, cwd, env, cols, rows, loop, on_output, on_exit):
        self.pid = int(cmd)
        self.exit_code = None

    def write(self, data):
        pass

    def resize(self, cols, rows):
        pass

    def kill(self):
        return True


async def test_metrics_and_busy_ids_share_one_definition(monkeypatch):
    """Busy is "the root PID has a direct child" everywhere. The dashboard
    used to require readable counters as well, so a root it could not open
    looked idle there while the reaper treated it as busy."""
    monkeypatch.setattr(session_manager_module, "PtySession", _FakePty)
    table = [(1001, 1), (1002, 1001), (2001, 1), (3001, 1), (3002, 3001)]
    reads = []

    def identities():
        reads.append(1)
        return list(table)

    snapshots = []

    def snapshot(roots=None, identities=None):
        snapshots.append(identities)
        return {}  # no counters readable at all

    monkeypatch.setattr(session_manager_module, "process_identities", identities)
    monkeypatch.setattr(session_manager_module, "snapshot_processes", snapshot)
    mgr = SessionManager(asyncio.get_running_loop())
    with_child = mgr.spawn(cmd="1001")
    idle = mgr.spawn(cmd="2001")
    exited = mgr.spawn(cmd="3001")
    mgr._on_exit(mgr.get(exited.id), 0)

    busy, metrics = mgr.session_metrics()
    assert busy == {with_child.id}
    assert reads == [1]  # one process table read feeds busy and samples
    assert snapshots == [table]
    assert metrics[with_child.id]["available"] is False
    assert mgr.busy_ids() == busy
    assert idle.id not in busy and exited.id not in busy
    mgr._sessions.clear()
