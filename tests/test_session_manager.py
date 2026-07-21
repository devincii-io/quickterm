import asyncio
import os

import pytest

import quickterm.session_manager as session_manager
from quickterm.session_manager import SessionManager


class _RecordingPty:
    """Stand-in for PtySession that captures the environment it was handed."""

    last: "_RecordingPty | None" = None

    def __init__(self, cmd, args, cwd, env, cols, rows, loop, on_output, on_exit):
        self.cmd, self.env = cmd, env
        self.alive, self.exit_code, self.pid = True, None, 4242
        _RecordingPty.last = self

    def write(self, data):
        pass

    def resize(self, cols, rows):
        pass

    def kill(self):
        pass


async def test_spawn_preserves_profile_env_and_workspace_metadata(monkeypatch):
    monkeypatch.setattr(session_manager, "PtySession", _RecordingPty)
    mgr = SessionManager(asyncio.get_running_loop())
    info = mgr.spawn(cmd="x.exe", workspace="proj", env={"USER_SET": "1"})
    env = _RecordingPty.last.env
    assert "QUICKTERM_TOKEN" not in env
    assert "QUICKTERM_SESSION_ID" not in env
    assert env["USER_SET"] == "1"
    assert info.workspace == "proj"


def _short(script: str) -> tuple[str, list[str]]:
    if os.name == "nt":
        return "cmd.exe", ["/c", script]
    return "/bin/sh", ["-c", script]


def _interactive() -> tuple[str, list[str]]:
    return ("cmd.exe", ["/q", "/k"]) if os.name == "nt" else ("/bin/sh", [])


async def _drain(att, timeout=15) -> bytes:
    """Collect chunks until the None sentinel."""
    out = bytearray()
    while True:
        item = await asyncio.wait_for(att.queue.get(), timeout=timeout)
        if item is None:
            return bytes(out)
        out += item


@pytest.fixture
async def manager():
    mgr = SessionManager(asyncio.get_running_loop())
    yield mgr
    mgr.shutdown()


async def test_spawn_attach_output_and_sentinel(manager):
    cmd, args = _short("echo hi")
    info = manager.spawn(cmd=cmd, args=args, name="t1")
    assert info.alive and info.cols == 120 and info.rows == 30
    assert len(info.id) == 32
    att = manager.attach(info.id)
    out = await _drain(att)
    assert b"hi" in out
    sess = manager.get(info.id)
    assert sess.info.alive is False
    assert sess.info.exit_code == 0
    att.detach()


async def test_scrollback_and_late_attach(manager):
    cmd, args = _short("echo scrollme")
    info = manager.spawn(cmd=cmd, args=args, cols=90, rows=20)
    att = manager.attach(info.id)
    await _drain(att)
    data, cols, rows = manager.get(info.id).scrollback()
    assert b"scrollme" in data
    assert (cols, rows) == (90, 20)
    # attaching after exit yields an immediate sentinel
    late = manager.attach(info.id)
    assert await asyncio.wait_for(late.queue.get(), timeout=5) is None


async def test_scrollback_ring_truncates():
    mgr = SessionManager(asyncio.get_running_loop(), scrollback_bytes=64)
    try:
        script = (
            "for /l %i in (1,1,40) do @echo 0123456789"
            if os.name == "nt"
            else "i=0; while [ $i -lt 40 ]; do echo 0123456789; i=$((i+1)); done"
        )
        cmd, args = _short(script)
        info = mgr.spawn(cmd=cmd, args=args)
        att = mgr.attach(info.id)
        full = await _drain(att)
        assert len(full) > 64  # queue saw everything
        data, _, _ = mgr.get(info.id).scrollback()
        assert len(data) <= 64
        assert data == full[-len(data):]  # ring keeps the tail
    finally:
        mgr.shutdown()


async def test_slow_subscriber_requests_clean_resync(manager):
    cmd, args = _short("echo hi")
    info = manager.spawn(cmd=cmd, args=args)
    att = manager.attach(info.id)
    sess = manager.get(info.id)
    # saturate the queue directly, then push one more chunk
    while not att.queue.full():
        att.queue.put_nowait(b"x")
    sess._fanout(b"NEW")
    assert att.overflowed is True
    assert att.queue.qsize() == 1
    assert att.queue.get_nowait() is att.overflow_sentinel


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


async def test_kill_and_list_and_focus(manager):
    cmd, args = _interactive()
    info = manager.spawn(cmd=cmd, args=args, name="longlived")
    assert any(s.id == info.id for s in manager.list())
    att = manager.attach(info.id)
    await asyncio.sleep(0.3)
    manager.kill(info.id)
    await _drain(att)  # sentinel arrives on tree kill
    assert manager.get(info.id).info.alive is False
    await asyncio.sleep(1.2)  # grace period: session removed from registry
    assert manager.get(info.id) is None
