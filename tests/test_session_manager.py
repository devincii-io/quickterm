import asyncio

import pytest

from quickterm.session_manager import QUEUE_MAXSIZE, SessionManager


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
    info = manager.spawn(cmd="cmd.exe", args=["/c", "echo hi"], name="t1")
    assert info.alive and info.cols == 120 and info.rows == 30
    assert len(info.id) == 8
    att = manager.attach(info.id)
    out = await _drain(att)
    assert b"hi" in out
    sess = manager.get(info.id)
    assert sess.info.alive is False
    assert sess.info.exit_code == 0
    att.detach()


async def test_scrollback_and_late_attach(manager):
    info = manager.spawn(cmd="cmd.exe", args=["/c", "echo scrollme"], cols=90, rows=20)
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
        info = mgr.spawn(
            cmd="cmd.exe",
            args=["/c", "for /l %i in (1,1,40) do @echo 0123456789"],
        )
        att = mgr.attach(info.id)
        full = await _drain(att)
        assert len(full) > 64  # queue saw everything
        data, _, _ = mgr.get(info.id).scrollback()
        assert len(data) <= 64
        assert data == full[-len(data):]  # ring keeps the tail
    finally:
        mgr.shutdown()


async def test_slow_subscriber_drops_oldest_only(manager):
    info = manager.spawn(cmd="cmd.exe", args=["/c", "echo hi"])
    att = manager.attach(info.id)
    sess = manager.get(info.id)
    # saturate the queue directly, then push one more chunk
    while not att.queue.full():
        att.queue.put_nowait(b"x")
    sess._fanout(b"NEW")
    assert att.queue.qsize() == QUEUE_MAXSIZE
    items = []
    while not att.queue.empty():
        items.append(att.queue.get_nowait())
    assert items[-1] == b"NEW"  # newest kept, oldest dropped


async def test_kill_and_list_and_focus(manager):
    info = manager.spawn(cmd="cmd.exe", args=["/q", "/k"], name="longlived")
    assert any(s.id == info.id for s in manager.list())
    manager.focused_session_id = info.id
    att = manager.attach(info.id)
    await asyncio.sleep(0.3)
    manager.kill(info.id)
    await _drain(att)  # sentinel arrives on tree kill
    assert manager.get(info.id).info.alive is False
    await asyncio.sleep(1.2)  # grace period: session removed from registry
    assert manager.get(info.id) is None
