"""Subscriber fan-out: one byte-bounded queue per viewer of a session.

Owns the queue (merging, the byte bound, the asyncio wake-up) and the
overflow policy: a viewer that falls too far behind gets one sentinel and is
resynced from the scrollback ring instead of losing bytes. Loop thread only.
"""

from __future__ import annotations

import asyncio
from collections import deque
from typing import Any

# Keep slow-viewer memory bounded. If a viewer falls behind this window it is
# explicitly told to reconnect and replay the current scrollback; arbitrary VT
# bytes are never silently discarded because that corrupts terminal state.
# The bound is in bytes, not items: the POSIX reader posts one callback per
# os.read, so an item cap of 8 overflowed a consumer that did nothing but
# await get() as soon as one loop iteration ran nine reader callbacks.
QUEUE_MAX_BYTES = 2 * 1024 * 1024
# Consecutive chunks merge into one pending item up to this size, the same cap
# as the server's WS frame coalescing, so one get() never hands the pump more
# than it sends in one frame.
QUEUE_MERGE_BYTES = 128 * 1024


class AttachmentQueue:
    """Byte-bounded FIFO with the part of the asyncio.Queue API the server uses.

    Items are bytes, None (session exited) or an attachment's overflow
    sentinel. Consecutive bytes merge into the pending tail while it stays at
    or below QUEUE_MERGE_BYTES, so a burst of small reads costs one wake-up
    and one WS frame instead of one each. put_nowait raises asyncio.QueueFull
    only when pending bytes would pass QUEUE_MAX_BYTES; markers never do.
    """

    def __init__(self) -> None:
        # A merged run is held as a list of its chunks and joined once, when
        # it is taken: growing a bytes or bytearray tail copied every chunk
        # at least twice more on the output hot path.
        self._items: deque[Any] = deque()
        self._bytes = 0
        # Size of the last item when it is data that can still grow, else -1.
        self._tail_bytes = -1
        self._getters: deque[asyncio.Future[None]] = deque()

    def qsize(self) -> int:
        return len(self._items)

    def empty(self) -> bool:
        return not self._items

    def pending_bytes(self) -> int:
        return self._bytes

    def put_nowait(self, item: Any) -> None:
        items = self._items
        if isinstance(item, bytes):
            size = len(item)
            if not size:
                return
            if self._bytes + size > QUEUE_MAX_BYTES:
                raise asyncio.QueueFull
            self._bytes += size
            if items and 0 <= self._tail_bytes <= QUEUE_MERGE_BYTES - size:
                tail = items[-1]
                if type(tail) is list:
                    tail.append(item)
                else:
                    items[-1] = [tail, item]
                self._tail_bytes += size
                return
            items.append(item)
            self._tail_bytes = size
        else:
            items.append(item)
            self._tail_bytes = -1
        self._wake()

    def get_nowait(self) -> Any:
        if not self._items:
            raise asyncio.QueueEmpty
        item = self._items.popleft()
        if type(item) is list:
            item = b"".join(item)
        if isinstance(item, bytes):
            self._bytes -= len(item)
        return item

    async def get(self) -> Any:
        while not self._items:
            waiter = asyncio.get_running_loop().create_future()
            self._getters.append(waiter)
            try:
                await waiter
            except BaseException:
                waiter.cancel()
                try:
                    self._getters.remove(waiter)
                except ValueError:
                    pass
                # A put may have woken this getter just before it was
                # cancelled; pass the wake-up on so the item is not stranded.
                if self._items and not waiter.cancelled():
                    self._wake()
                raise
        return self.get_nowait()

    def clear(self) -> None:
        self._items.clear()
        self._bytes = 0
        self._tail_bytes = -1

    def _wake(self) -> None:
        while self._getters:
            waiter = self._getters.popleft()
            if not waiter.done():
                waiter.set_result(None)
                return


class Attachment:
    """Per-subscriber bounded queue; None = exit, overflow_sentinel = resync."""

    def __init__(self, viewers: Viewers) -> None:
        self.queue = AttachmentQueue()
        self.overflow_sentinel = object()
        self.overflowed = False
        self._viewers = viewers

    def detach(self) -> None:
        self._viewers.discard(self)


class Viewers(set[Attachment]):
    """The attachments of one session, and the one way output reaches them.

    A set subclass rather than a wrapper: the output hot path asks "anyone
    attached?" on every burst, and a Python-level __len__ would put a call on
    that path where the set answers in C.
    """

    def publish(self, item: bytes | None) -> None:
        """Queue ``item`` (output, or None for exit) for every viewer; one that
        overflows gets the resync sentinel instead and nothing after it."""
        for att in tuple(self):
            if att.overflowed:
                continue
            q = att.queue
            try:
                q.put_nowait(item)
            except asyncio.QueueFull:
                att.overflowed = True
                q.clear()
                q.put_nowait(att.overflow_sentinel)
