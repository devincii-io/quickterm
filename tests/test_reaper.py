"""Idle cleanup: what the reaper spares, what it removes, and the loop-thread
claim that keeps a session the user picked up mid-pass alive."""

import asyncio
import threading
import time

import pytest

import quickterm.reaper as reaper
import quickterm.session_manager as session_manager
from quickterm.session_manager import SessionManager
from tests.test_session_manager import _interactive, _RecordingPty, _wait_for


@pytest.fixture
async def manager():
    mgr = SessionManager(asyncio.get_running_loop())
    yield mgr
    mgr.shutdown()


@pytest.fixture
async def fake_manager(monkeypatch):
    monkeypatch.setattr(session_manager, "PtySession", _RecordingPty)
    monkeypatch.setattr(session_manager, "process_identities", lambda: [])
    mgr = SessionManager(asyncio.get_running_loop())
    yield mgr
    mgr._sessions.clear()


async def test_idle_reaper_spares_attached_and_workspace_sessions(manager):
    cmd, args = _interactive()
    first = manager.spawn(cmd=cmd, args=args, name="idle")
    second = manager.spawn(cmd=cmd, args=args, name="protected")
    attached = manager.attach(first.id)
    manager.get(first.id).last_activity -= 600
    manager.get(second.id).last_activity -= 600
    assert manager.reap_idle(300, {second.id}) == []
    attached.detach()
    assert manager.reap_idle(300, {second.id}) == [first.id]


async def test_idle_reaper_spares_touched_sessions(manager):
    cmd, args = _interactive()
    info = manager.spawn(cmd=cmd, args=args, name="work")
    sess = manager.get(info.id)
    sess.info.touched = True
    sess.last_activity -= 600
    assert manager.reap_idle(300, set()) == []


async def test_idle_reaper_spares_explicitly_retained_sessions(manager):
    cmd, args = _interactive()
    info = manager.spawn(cmd=cmd, args=args, name="detached")
    sess = manager.get(info.id)
    sess.info.retained = True
    sess.last_activity -= 600
    assert manager.reap_idle(300, set()) == []
    assert sess.info.touched is False


class _SlowKillPty(_RecordingPty):
    """kill() blocks until the test releases it, like taskkill on a big tree."""

    started: threading.Event
    release: threading.Event
    result = True

    def kill(self):
        type(self).started.set()
        type(self).release.wait(10)
        return type(self).result


@pytest.fixture
def slow_kill(monkeypatch):
    class Pty(_SlowKillPty):
        started = threading.Event()
        release = threading.Event()
        result = True

    monkeypatch.setattr(session_manager, "PtySession", Pty)
    monkeypatch.setattr(session_manager, "process_identities", lambda: [])
    return Pty


async def test_reaper_rechecks_each_session_right_before_its_kill(slow_kill):
    mgr = SessionManager(asyncio.get_running_loop())
    first = mgr.spawn(cmd="x.exe", name="a")
    second = mgr.spawn(cmd="x.exe", name="b")
    for sid in (first.id, second.id):
        mgr.get(sid).last_activity -= 600
    # app._reap_loop runs the pass in a worker thread
    reaping = asyncio.ensure_future(asyncio.to_thread(mgr.reap_idle, 300, set()))
    await _wait_for(slow_kill.started.is_set)
    # While the first kill is still running, the user opens b and types.
    att = mgr.attach(second.id)
    mgr.touch(second.id)
    slow_kill.release.set()
    assert await asyncio.wait_for(reaping, timeout=10) == [first.id]
    await asyncio.sleep(0)
    assert mgr.get(second.id).info.alive is True
    assert mgr.get(second.id).reaping is False
    att.detach()
    mgr._sessions.clear()


async def test_attach_refuses_a_session_the_reaper_is_killing(slow_kill):
    mgr = SessionManager(asyncio.get_running_loop())
    info = mgr.spawn(cmd="x.exe")
    mgr.get(info.id).last_activity -= 600
    reaping = asyncio.ensure_future(asyncio.to_thread(mgr.reap_idle, 300, set()))
    await _wait_for(slow_kill.started.is_set)
    assert mgr.get(info.id).reaping is True
    with pytest.raises(KeyError):
        mgr.attach(info.id)
    slow_kill.release.set()
    assert await asyncio.wait_for(reaping, timeout=10) == [info.id]
    mgr._sessions.clear()


async def test_failed_reaper_kill_releases_the_session(slow_kill):
    slow_kill.result = False
    slow_kill.release.set()
    mgr = SessionManager(asyncio.get_running_loop())
    info = mgr.spawn(cmd="x.exe")
    mgr.get(info.id).last_activity -= 600
    assert await asyncio.to_thread(mgr.reap_idle, 300, set()) == []
    assert mgr.get(info.id).reaping is False
    mgr.attach(info.id).detach()  # attachable again
    mgr._sessions.clear()


async def test_failed_kill_release_survives_a_stalled_loop(slow_kill, monkeypatch):
    """The release must not be a wait-then-cancel call: if the loop is busy
    past that wait, the claim would stay and every attach would answer 4404."""
    monkeypatch.setattr(reaper, "_LOOP_CALL_TIMEOUT_S", 0.05)
    slow_kill.result = False
    mgr = SessionManager(asyncio.get_running_loop())
    info = mgr.spawn(cmd="x.exe")
    mgr.get(info.id).last_activity -= 600
    reaping = asyncio.ensure_future(asyncio.to_thread(mgr.reap_idle, 300, set()))
    await _wait_for(slow_kill.started.is_set)
    slow_kill.release.set()
    time.sleep(0.3)  # the loop stalls while the worker releases the claim
    assert await asyncio.wait_for(reaping, timeout=10) == []
    await asyncio.sleep(0)
    assert mgr.get(info.id).reaping is False
    mgr.attach(info.id).detach()
    mgr._sessions.clear()


def _finished_in_background(mgr, *, retained=False, touched=False, output=b"BUILD FAILED\r\n"):
    info = mgr.spawn(cmd="x.exe")
    session = mgr.get(info.id)
    mgr.attach(info.id).detach()
    info.retained, info.touched = retained, touched
    if output:
        mgr._on_output(session, output)
    mgr._on_exit(session, 1)
    return info, session


async def test_reaper_keeps_retained_exited_session_with_unread_output(fake_manager):
    mgr = fake_manager
    info, _ = _finished_in_background(mgr, retained=True)
    assert mgr.reap_idle(300, set()) == []
    assert mgr.get(info.id) is not None
    mgr.acknowledge(info.id)  # the server's replay-only reattach
    assert mgr.reap_idle(300, set()) == [info.id]


async def test_reaper_keeps_touched_exited_session_until_attached(fake_manager):
    mgr = fake_manager
    info, _ = _finished_in_background(mgr, touched=True)
    assert mgr.reap_idle(300, {info.id}) == []
    mgr.attach(info.id).detach()
    assert mgr.reap_idle(300, {info.id}) == [info.id]


async def test_reaper_drops_unread_exited_session_after_retention_ttl(fake_manager):
    mgr = fake_manager
    info, session = _finished_in_background(mgr, retained=True)
    session.ended_at -= reaper.EXITED_UNREAD_RETENTION_S + 1
    assert mgr.reap_idle(300, set()) == [info.id]


async def test_reaper_drops_exited_sessions_nobody_cared_about(fake_manager):
    mgr = fake_manager
    never_attached = mgr.spawn(cmd="x.exe")
    mgr._on_output(mgr.get(never_attached.id), b"output nobody asked for")
    mgr._on_exit(mgr.get(never_attached.id), 0)
    untouched, _ = _finished_in_background(mgr)
    seen, _ = _finished_in_background(mgr, retained=True, output=b"")
    assert sorted(mgr.reap_idle(300, set())) == sorted(
        [never_attached.id, untouched.id, seen.id]
    )
