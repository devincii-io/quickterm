"""Per-viewer fan-out: the byte-bounded queue and the overflow-to-resync policy."""

import asyncio

import pytest

import quickterm.fanout as fanout
from quickterm.fanout import Attachment, AttachmentQueue, Viewers


# ---- byte-bounded attachment queue ----


def test_queue_merges_small_chunks_up_to_the_frame_cap():
    q = AttachmentQueue()
    for _ in range(4):
        q.put_nowait(b"a" * 1000)
    assert q.qsize() == 1
    item = q.get_nowait()
    assert isinstance(item, bytes) and item == b"a" * 4000
    assert q.pending_bytes() == 0


def test_queue_does_not_merge_past_128_kib_or_across_markers():
    q = AttachmentQueue()
    q.put_nowait(b"a" * (128 * 1024 - 1))
    q.put_nowait(b"bb")  # would make the tail 128 KiB + 1
    marker = object()
    q.put_nowait(marker)
    q.put_nowait(b"c")
    q.put_nowait(None)
    assert [len(q.get_nowait()), len(q.get_nowait())] == [128 * 1024 - 1, 2]
    assert q.get_nowait() is marker
    assert q.get_nowait() == b"c"
    assert q.get_nowait() is None
    with pytest.raises(asyncio.QueueEmpty):
        q.get_nowait()
    assert q.empty()


def test_queue_is_full_only_past_the_byte_bound():
    q = AttachmentQueue()
    q.put_nowait(b"x" * fanout.QUEUE_MAX_BYTES)
    with pytest.raises(asyncio.QueueFull):
        q.put_nowait(b"y")
    q.put_nowait(None)  # markers never overflow
    assert q.pending_bytes() == fanout.QUEUE_MAX_BYTES


async def test_queue_get_waits_for_a_put():
    q = AttachmentQueue()
    getter = asyncio.ensure_future(q.get())
    await asyncio.sleep(0)
    assert not getter.done()
    q.put_nowait(b"late")
    assert await asyncio.wait_for(getter, timeout=1) == b"late"


async def test_getter_cancelled_after_its_wake_up_passes_the_item_on():
    q = AttachmentQueue()
    first = asyncio.ensure_future(q.get())
    second = asyncio.ensure_future(q.get())
    await asyncio.sleep(0)  # both are waiting, first in line
    q.put_nowait(b"data")  # wakes only the first getter...
    first.cancel()  # ...which is cancelled before it gets to run
    with pytest.raises(asyncio.CancelledError):
        await first
    assert await asyncio.wait_for(second, timeout=1) == b"data"
    assert q.empty()


# ---- publishing to viewers ----


def test_slow_viewer_gets_one_resync_sentinel_and_nothing_after():
    viewers = Viewers()
    slow = Attachment(viewers)
    viewers.add(slow)
    # fill the queue to its byte bound, then push one more chunk
    viewers.publish(b"x" * fanout.QUEUE_MAX_BYTES)
    assert slow.overflowed is False
    viewers.publish(b"NEW")
    assert slow.overflowed is True
    assert slow.queue.qsize() == 1
    assert slow.queue.get_nowait() is slow.overflow_sentinel
    viewers.publish(None)  # an overflowed viewer gets nothing more
    assert slow.queue.empty()


def test_one_slow_viewer_does_not_hold_back_the_others():
    viewers = Viewers()
    slow, fast = Attachment(viewers), Attachment(viewers)
    viewers.update((slow, fast))
    viewers.publish(b"x" * fanout.QUEUE_MAX_BYTES)
    fast.queue.get_nowait()
    viewers.publish(b"NEW")
    assert slow.overflowed is True
    assert fast.overflowed is False
    assert fast.queue.get_nowait() == b"NEW"


def test_detach_stops_delivery():
    viewers = Viewers()
    att = Attachment(viewers)
    viewers.add(att)
    att.detach()
    assert not viewers
    viewers.publish(b"late")
    assert att.queue.empty()
    att.detach()  # a second detach is harmless
