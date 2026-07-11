"""Busy detection: a session is busy while its shell has a child process."""

import asyncio
import os
import subprocess
import sys
import time

import pytest

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
