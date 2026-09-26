"""Session registry: lifecycle, scrollback ring buffer, subscriber fan-out."""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import os
import re
import time
import uuid
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, TypeVar

from .config import default_cwd, validate_environment
from .process_usage import (
    pids_with_children,
    process_identities,
    snapshot_processes,
    summarize_trees,
)

log = logging.getLogger(__name__)

if os.name == "nt":
    from .pty_session import PtySession
else:
    from .pty_posix import PtySession

_T = TypeVar("_T")

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
_KILL_REMOVE_GRACE_S = 1.0
# An exited session that the user retained or typed into, and that printed
# output nobody has seen, is kept this long after it ended (unless a viewer
# acknowledges it first). A day covers a build or agent left running
# overnight; memory stays bounded by the scrollback cap per session, and
# untouched never-attached exited sessions still go on the next pass.
EXITED_UNREAD_RETENTION_S = 24 * 60 * 60
# How far the ring front may move past a cut to reach a sequence boundary, and
# how far back the cut looks for the ESC that might enclose it. The forward
# side first looks at a short peek, which settles almost every CSI.
_RESYNC_SCAN_BYTES = 4096
_RESYNC_PEEK_BYTES = 64
# A reaper claim that the loop does not run within this time (the app is
# shutting down) is treated as "not reaped".
_LOOP_CALL_TIMEOUT_S = 5.0


class SessionLimitError(RuntimeError):
    """A new spawn would exceed the configured live-session limit."""


class SpawnError(ValueError):
    """The PTY backend could not start the process (missing command, bad folder)."""


@dataclass
class SessionInfo:
    id: str
    name: str
    profile: str | None
    alive: bool
    exit_code: int | None
    cols: int
    rows: int
    touched: bool = False  # True once the user typed or pasted (the client's touch frame)
    retained: bool = False  # Explicit detach: keep even if untouched and idle
    workspace: str | None = None  # workspace this session belongs to
    cwd: str | None = None  # directory the shell was started in


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

    def __init__(self, session: Session) -> None:
        self.queue = AttachmentQueue()
        self.overflow_sentinel = object()
        self.overflowed = False
        self._session = session

    def detach(self) -> None:
        self._session._attachments.discard(self)


# DEC private modes worth re-establishing on replay. Synchronized output
# (2026) is deliberately absent: replaying a stale "begin" would freeze the
# fresh view until a matching "end" that already went by.
_MOUSE_TRACKING = (1000, 1002, 1003)
_MOUSE_ENCODING = (1006, 1015)
_ALT_SCREEN = (47, 1047, 1049)
_REPLAYED_MODES = frozenset((1, 25, 1004, 2004, *_MOUSE_TRACKING, *_MOUSE_ENCODING, *_ALT_SCREEN))
# Modes that are on in a fresh xterm; the preamble only states differences.
_DEFAULT_ON = frozenset((25,))
# xterm.js keeps one value per group: setting a member replaces the others and
# resetting any member clears the group. Tracking them as independent flags
# would replay a mouse mode the application had already replaced.
_MODE_GROUP = {
    mode: group for group in (_MOUSE_TRACKING, _MOUSE_ENCODING, _ALT_SCREEN) for mode in group
}
_DECSET = re.compile(rb"\x1b\[\?([0-9;]*)([hl])")
# A tail that could still become a DECSET/DECRST or RIS once the next bytes
# arrive: ESC, ESC [, or ESC [ ? followed by parameters only.
_PARTIAL_MODE_TAIL = re.compile(rb"\x1b(?:\[(?:\?[0-9;]*)?)?")
_MODE_CARRY_MAX = 64
_GROUND = 0
_AFTER_ESC = 1
_OSC = 0x5D
_STRING_INTRODUCERS = b"]P_^X"  # OSC, DCS, APC, PM, SOS
# Both always match (possibly empty), so .match(...).end() is safe.
_CSI_BODY = re.compile(rb"[\x20-\x3f]*")
_ESC_INTERMEDIATES = re.compile(rb"[\x20-\x2f]*")


class _ModeTracker:
    """DEC private mode state of the bytes that have left the scrollback ring.

    Fed only with trimmed bytes, so its state is the terminal's mode state at
    the first retained byte: exactly what a replay has to restore before the
    ring. Scanning is two bytes.find passes per trimmed span; the Python loop
    runs once per mode sequence, not per byte.
    """

    def __init__(self) -> None:
        self.modes: dict[int, bool] = {}
        # Where the trimmed bytes end: _GROUND, _AFTER_ESC (the last one was
        # an ESC whose next byte is not known yet) or, inside an OSC, DCS,
        # APC, PM or SOS string, that string's introducer byte. The ring
        # front is clean only in _GROUND; this is exact however long the
        # string is, which the bounded resync window cannot be.
        self.state = _GROUND
        # Tail of the previous span that may be the start of a sequence split
        # across a chunk boundary.
        self._carry = b""

    def end_string(self) -> None:
        """The retained front is an ESC, which ends any string before it."""
        self.state = _GROUND

    def feed(self, buf: bytes, start: int, end: int) -> None:
        if start >= end:
            return
        self._track_string(buf, start, end)
        if self._carry:
            carry = self._carry
            self._carry = b""
            head = carry + buf[start : min(end, start + _MODE_CARRY_MAX)]
            if head[1:2] == b"c":
                self._reset()
                start += 2 - len(carry)
            else:
                match = _DECSET.match(head)
                if match:
                    self._apply(match)
                    start += match.end() - len(carry)
                elif _PARTIAL_MODE_TAIL.fullmatch(head) and len(head) <= _MODE_CARRY_MAX:
                    if end - start == len(head) - len(carry):
                        self._carry = head  # still incomplete and the span is used up
                        return
            if start >= end:
                return
        pos = start
        next_mode = buf.find(b"\x1b[?", pos, end)
        next_ris = buf.find(b"\x1bc", pos, end)
        while next_mode >= 0 or next_ris >= 0:
            if next_ris >= 0 and (next_mode < 0 or next_ris < next_mode):
                self._reset()
                pos = next_ris + 2
                next_ris = buf.find(b"\x1bc", pos, end)
                if 0 <= next_mode < pos:
                    next_mode = buf.find(b"\x1b[?", pos, end)
                continue
            match = _DECSET.match(buf, next_mode, end)
            pos = next_mode + 3
            if match:
                self._apply(match)
                pos = match.end()
            next_mode = buf.find(b"\x1b[?", pos, end)
            if 0 <= next_ris < pos:
                next_ris = buf.find(b"\x1bc", pos, end)
        # From the span start, not from pos: a DECSET cut short at the span end
        # failed to match above and was stepped over, and it is exactly what
        # the carry is for. Completed sequences never match the partial form.
        last_esc = buf.rfind(b"\x1b", max(start, end - _MODE_CARRY_MAX), end)
        if last_esc >= 0 and _PARTIAL_MODE_TAIL.fullmatch(buf, last_esc, end):
            self._carry = buf[last_esc:end]

    def _track_string(self, buf: bytes, start: int, end: int) -> None:
        # Every ESC ends a string, so only the last ESC of the span matters,
        # plus, for an OSC, a BEL after it. Without an ESC the state carries
        # over from the previous span.
        esc = buf.rfind(b"\x1b", start, end)
        if esc < 0:
            if self.state == _AFTER_ESC:
                esc, intro = start - 1, buf[start]
            elif self.state == _OSC and buf.find(b"\x07", start, end) >= 0:
                self.state = _GROUND
                return
            else:
                return
        elif esc == end - 1:
            self.state = _AFTER_ESC
            return
        else:
            intro = buf[esc + 1]
        if intro not in _STRING_INTRODUCERS:
            self.state = _GROUND
        elif intro == _OSC and buf.find(b"\x07", esc + 2, end) >= 0:
            self.state = _GROUND
        else:
            self.state = intro

    def preamble(self) -> bytes:
        parts = [
            b"\x1b[?%d%s" % (mode, b"h" if on else b"l")
            for mode, on in sorted(self.modes.items())
            if on != (mode in _DEFAULT_ON)
        ]
        return b"".join(parts)

    def _reset(self) -> None:
        self.modes.clear()

    def _apply(self, match: re.Match[bytes]) -> None:
        on = match.group(2) == b"h"
        for param in match.group(1).split(b";"):
            # Length first: int() refuses digit strings past 4300 characters,
            # and an exception here would cost the fan-out of the whole chunk.
            if not param or len(param) > 5:
                continue
            mode = int(param)
            if mode not in _REPLAYED_MODES:
                continue
            group = _MODE_GROUP.get(mode)
            if group is not None:
                for member in group:
                    self.modes.pop(member, None)
                if on:
                    self.modes[mode] = True
            else:
                self.modes[mode] = on


def _sequence_end(window: bytes, esc: int) -> int:
    """Index just past the escape sequence starting at ``esc``, or -1 when it
    does not end inside ``window``."""
    n = len(window)
    if esc + 1 >= n:
        return -1
    kind = window[esc + 1]
    if kind == 0x5B:  # CSI: parameter and intermediate bytes, then one final byte
        pos = _CSI_BODY.match(window, esc + 2).end()  # type: ignore[union-attr]
        if pos >= n:
            return -1
        return pos + 1 if 0x40 <= window[pos] <= 0x7E else pos
    if kind in b"]P_^X":  # OSC, DCS, APC, PM, SOS: a string up to BEL (OSC) or ESC
        nxt = window.find(b"\x1b", esc + 2)
        bel = window.find(b"\x07", esc + 2) if kind == 0x5D else -1
        if bel >= 0 and (nxt < 0 or bel < nxt):
            return bel + 1
        if nxt < 0:
            return -1
        # Any ESC ends the string; ESC \ is the proper terminator and belongs
        # to it, any other ESC already starts the next sequence.
        return nxt + 2 if window[nxt + 1 : nxt + 2] == b"\\" else nxt
    pos = _ESC_INTERMEDIATES.match(window, esc + 1).end()  # type: ignore[union-attr]
    if pos >= n:  # plain escape: intermediates, then one final byte
        return -1
    return pos + 1 if 0x30 <= window[pos] <= 0x7E else pos


def _resync_skip(window: bytes, cut: int, final: bool) -> int | None:
    """How many bytes after ``cut`` a replay must skip to start cleanly.

    ``window`` is the tail of the trimmed bytes followed by the head of the
    retained ones, with the ring front at ``cut``. The front must not land
    inside an escape sequence (xterm would print its tail as text) or a UTF-8
    character (U+FFFD). Only the last ESC before the cut can enclose it, so
    one rfind decides; the scan is bounded by the window. Returns None when
    the sequence is still open at the window end and ``final`` is false, so
    the caller can retry with more bytes.
    """
    pos = cut
    esc = window.rfind(b"\x1b", 0, cut)
    if esc >= 0:
        end = _sequence_end(window, esc)
        if end < 0:
            if not final:
                return None
            # Unterminated within the window: every ESC ends whatever came
            # before it, so the next one is a safe start.
            nxt = window.find(b"\x1b", cut)
            pos = nxt if nxt >= 0 else len(window)
        elif end > cut:
            pos = end
    limit = min(len(window), pos + 3)
    while pos < limit and 0x80 <= window[pos] <= 0xBF:
        pos += 1
    return pos - cut


class Session:
    def __init__(self, info: SessionInfo, cap: int) -> None:
        self.info = info
        self.pty: PtySession | None = None
        self._cap = cap
        # Scrollback ring as a deque of chunks + running byte count. The live
        # part of the oldest chunk starts at _head, so trimming moves an
        # offset instead of copying the rest of that chunk on every write; the
        # slice happens once, at replay time.
        self._chunks: deque[bytes] = deque()
        self._head = 0
        self._ring_bytes = 0
        self._ring_cols = info.cols
        self._ring_rows = info.rows
        self._modes = _ModeTracker()
        self._attachments: set[Attachment] = set()
        self.last_activity = time.monotonic()  # updated on output and input
        self.started_at = self.last_activity
        self.ended_at: float | None = None
        self.resource_scope = "host-process-tree"
        # Set on the loop thread while the reaper is between its final check
        # and the kill; attach() refuses such a session.
        self.reaping = False
        # Background output is a deliberately simple, deterministic attention
        # signal: bytes produced after a viewer has detached remain unread until
        # the next attach.  This is useful for long-running builds and coding
        # agents without trying to infer semantic "working/waiting" state from
        # terminal escape sequences.
        self.ever_attached = False
        self.background_output_bytes = 0
        self.background_output_at: float | None = None

    def scrollback_chunks(self) -> tuple[tuple[bytes, ...], int, int]:
        """Replay snapshot: an optional mode preamble, then the ring's chunks.

        The ring is never joined into one allocation. Its first byte is never
        inside an escape sequence or a UTF-8 character, and the preamble
        re-establishes the DEC private modes that were in effect there.
        """
        chunks = list(self._chunks)
        if chunks and self._head:
            chunks[0] = chunks[0][self._head :]
        preamble = self._modes.preamble()
        if preamble:
            chunks.insert(0, preamble)
        return tuple(chunks), self._ring_cols, self._ring_rows

    def _record(self, data: bytes) -> None:
        if data:
            self._chunks.append(data)
            self._ring_bytes += len(data)
            # A non-ground tracker state means an earlier trim emptied the
            # ring inside a string, so the new bytes are its payload and go
            # too, even below the cap.
            if self._ring_bytes > self._cap or self._modes.state:
                self._trim()
        self._ring_cols, self._ring_rows = self.info.cols, self.info.rows

    def set_scrollback_cap(self, cap: int) -> None:
        self._cap = cap
        if self._ring_bytes > self._cap:
            self._trim()

    def _trim(self) -> None:
        """Drop the oldest bytes down to the cap, then on to a clean start."""
        excess = self._ring_bytes - self._cap
        spans = self._drop(excess) if excess > 0 else []
        modes = self._modes
        while modes.state == _AFTER_ESC and self._chunks:
            spans += self._drop(1)  # the byte after the ESC decides
        if modes.state:
            self._drop_string_rest()
            return
        if not spans or not self._chunks:
            return
        # Only the last ESC before the cut can enclose it, so the lookback is
        # just the bytes from there to the cut (none when there is no ESC in
        # reach). This runs on every write once the ring is full; copying a
        # fixed window each time made small writes ten times dearer.
        lookback = b""
        reach: list[tuple[bytes, int, int]] = []
        budget = _RESYNC_SCAN_BYTES
        for chunk, start, end in reversed(spans):
            low = max(start, end - budget)
            esc = chunk.rfind(b"\x1b", low, end)
            if esc >= 0:
                reach.append((chunk, esc, end))
                lookback = b"".join(c[s:e] for c, s, e in reversed(reach))
                break
            reach.append((chunk, low, end))
            budget -= end - low
            if budget <= 0:
                break
        forward = self._peek(_RESYNC_PEEK_BYTES)
        skip = _resync_skip(lookback + forward, len(lookback), len(forward) >= self._ring_bytes)
        if skip is None:
            # The sequence is still open at the end of the short peek.
            forward = self._peek(_RESYNC_SCAN_BYTES)
            skip = _resync_skip(lookback + forward, len(lookback), True)
        if skip:
            self._drop(skip)
            if modes.state:
                self._trim()  # the skip itself ended inside a string or after an ESC

    def _drop_string_rest(self) -> None:
        """The front is inside a string (an OSC 52 clipboard write, sixel, an
        inline image): drop through its terminator, or everything retained
        when it has not arrived yet. Replaying payload as text is worse than
        replaying nothing. Rare, so scanning the ring here is fine."""
        bel_ends = self._modes.state == _OSC
        count = 0
        offset = self._head
        for index, chunk in enumerate(self._chunks):
            esc = chunk.find(b"\x1b", offset)
            bel = chunk.find(b"\x07", offset, esc if esc >= 0 else len(chunk)) if bel_ends else -1
            if bel >= 0:
                self._drop(count + bel + 1 - offset)
                return
            if esc >= 0:
                if chunk[esc + 1 : esc + 2] == b"\\":
                    self._drop(count + esc + 2 - offset)
                    return
                if esc + 1 == len(chunk) and index + 1 < len(self._chunks):
                    if self._chunks[index + 1][:1] == b"\\":
                        self._drop(count + esc + 2 - offset)
                        return
                # Any other ESC ends the string and starts the next sequence,
                # so it stays as the new front.
                self._drop(count + esc - offset)
                self._modes.end_string()
                return
            count += len(chunk) - offset
            offset = 0
        self._drop(self._ring_bytes)

    def _peek(self, count: int) -> bytes:
        """The first ``count`` retained bytes (fewer when the ring is shorter)."""
        parts: list[bytes] = []
        size = 0
        offset = self._head
        for chunk in self._chunks:
            piece = chunk[offset : offset + count - size]
            parts.append(piece)
            size += len(piece)
            offset = 0
            if size >= count:
                break
        return parts[0] if len(parts) == 1 else b"".join(parts)

    def _drop(self, count: int) -> list[tuple[bytes, int, int]]:
        """Remove ``count`` bytes from the ring front, feeding them to the mode
        tracker; returns the removed spans as (chunk, start, end)."""
        spans: list[tuple[bytes, int, int]] = []
        chunks = self._chunks
        while count > 0 and chunks:
            chunk = chunks[0]
            available = len(chunk) - self._head
            if available <= count:
                spans.append((chunk, self._head, len(chunk)))
                chunks.popleft()
                self._head = 0
                self._ring_bytes -= available
                count -= available
            else:
                spans.append((chunk, self._head, self._head + count))
                self._head += count
                self._ring_bytes -= count
                count = 0
        for chunk, start, end in spans:
            self._modes.feed(chunk, start, end)
        return spans

    def _fanout(self, item: bytes | None) -> None:
        for att in tuple(self._attachments):
            if att.overflowed:
                continue
            q = att.queue
            try:
                q.put_nowait(item)
            except asyncio.QueueFull:
                att.overflowed = True
                q.clear()
                q.put_nowait(att.overflow_sentinel)


class SessionManager:
    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        scrollback_bytes: int = 512 * 1024,
        max_sessions: int = 0,
    ) -> None:
        self._loop = loop
        self._cap = scrollback_bytes
        self._sessions: dict[str, Session] = {}
        self._max_sessions = max_sessions
        self._cpu_samples: dict[str, tuple[float, float]] = {}
        # spawn_async calls between their limit check and their registry
        # insert; counted against the limit so parallel requests cannot all
        # pass the check while their PTYs are still being built.
        self._spawning = 0

    def set_max_sessions(self, limit: int) -> None:
        self._max_sessions = limit

    def set_scrollback_bytes(self, cap: int) -> None:
        self._cap = cap
        for session in list(self._sessions.values()):
            session.set_scrollback_cap(cap)

    def live_count(self) -> int:
        return sum(1 for session in list(self._sessions.values()) if session.info.alive)

    def _check_limit(self) -> None:
        if self._max_sessions and self.live_count() + self._spawning >= self._max_sessions:
            raise SessionLimitError(
                f"terminal limit reached ({self._max_sessions}); stop a terminal or raise the limit"
            )

    def spawn(
        self,
        *,
        name: str | None = None,
        profile: str | None = None,
        cmd: str,
        args: list[str] | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        cols: int = 120,
        rows: int = 30,
        workspace: str | None = None,
    ) -> SessionInfo:
        """Start a session synchronously (loop thread: app startup, hotkeys)."""
        self._check_limit()
        session = self._build(
            name=name,
            profile=profile,
            cmd=cmd,
            args=args,
            cwd=cwd,
            env=env,
            cols=cols,
            rows=rows,
            workspace=workspace,
        )
        self._sessions[session.info.id] = session
        return session.info

    async def spawn_async(
        self,
        *,
        name: str | None = None,
        profile: str | None = None,
        cmd: str,
        args: list[str] | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        cols: int = 120,
        rows: int = 30,
        workspace: str | None = None,
    ) -> SessionInfo:
        """``spawn`` for request handlers: the PTY is built off the loop.

        Starting a child resolves the command on PATH, stats the folder and,
        on Windows, creates a pseudo console and a process: tens to hundreds
        of milliseconds during which every pane's output would otherwise
        stall and fill its fan-out queue.
        """
        self._check_limit()
        self._spawning += 1
        build = asyncio.ensure_future(
            asyncio.to_thread(
                self._build,
                name=name,
                profile=profile,
                cmd=cmd,
                args=args,
                cwd=cwd,
                env=env,
                cols=cols,
                rows=rows,
                workspace=workspace,
            )
        )
        build.add_done_callback(self._finish_async_spawn)
        # The worker thread cannot be interrupted, so a cancelled request
        # still gets its session registered by the done callback: an
        # unregistered PTY would be a process nobody can see or stop. The
        # reaper removes it later if nobody ever attaches.
        session = await asyncio.shield(build)
        return session.info

    def _finish_async_spawn(self, build: asyncio.Future[Session]) -> None:
        self._spawning -= 1
        if build.cancelled() or build.exception() is not None:
            return
        session = build.result()
        self._sessions[session.info.id] = session

    def _build(
        self,
        *,
        name: str | None,
        profile: str | None,
        cmd: str,
        args: list[str] | None,
        cwd: str | None,
        env: dict[str, str] | None,
        cols: int,
        rows: int,
        workspace: str | None,
    ) -> Session:
        """Create the Session and start its PTY. Blocking; touches no registry."""
        child_env = dict(validate_environment(env or {}))
        start_dir = cwd or default_cwd()
        info = SessionInfo(
            id=uuid.uuid4().hex,
            name=name or profile or cmd,
            profile=profile,
            alive=True,
            exit_code=None,
            cols=cols,
            rows=rows,
            workspace=workspace,
            cwd=start_dir,
        )
        session = Session(info, self._cap)
        if os.path.basename(cmd).casefold() in {"wsl", "wsl.exe"}:
            session.resource_scope = "host-process-tree-partial-wsl"
        try:
            session.pty = PtySession(
                cmd,
                list(args or []),
                start_dir,
                child_env,
                cols,
                rows,
                self._loop,
                on_output=lambda data, s=session: self._on_output(s, data),
                on_exit=lambda code, s=session: self._on_exit(s, code),
            )
        except FileNotFoundError as exc:
            raise SpawnError(
                f"command not found: {cmd}. QuickTerm reads PATH when it starts; "
                "restart it after installing a program."
            ) from exc
        except OSError as exc:
            raise SpawnError(str(exc)) from exc
        return session

    def list(self) -> list[SessionInfo]:
        # The registry is mutated on the event-loop thread but iterated from
        # the anyio threadpool (sync REST handlers) and the pywebview GUI
        # thread (the close policy). Every iteration here snapshots first, so a
        # spawn or reap mid-scan can never raise "dictionary changed size".
        return [s.info for s in list(self._sessions.values())]

    def sync_workspace(self, name: str, session_ids: set[str]) -> None:
        """Mirror one saved workspace's membership into live session metadata.

        Workspace JSON remains the durable authority. This lightweight live
        label makes global/session views accurate immediately after a Scratch
        promotion or an explicit move without scanning every workspace on each
        sidebar poll.
        """
        for sid, session in list(self._sessions.items()):
            if sid in session_ids:
                session.info.workspace = name
            elif session.info.workspace == name:
                session.info.workspace = None

    def get(self, sid: str) -> Session | None:
        return self._sessions.get(sid)

    def write(self, sid: str, data: bytes) -> None:
        # Deliberately not `touched`: WS input also carries xterm's automatic
        # replies (DA, CPR, focus reports), which must not make a shell look
        # typed into. The client says so explicitly through touch().
        s = self._sessions.get(sid)
        if s and s.pty and s.info.alive:
            s.last_activity = time.monotonic()
            s.pty.write(data)

    def touch(self, sid: str) -> None:
        """Record real user input (the client's explicit touch frame)."""
        s = self._sessions.get(sid)
        if s and s.info.alive:
            s.info.touched = True
            s.last_activity = time.monotonic()

    def _busy_from(self, identities: list[tuple[int, int]]) -> set[str]:
        """The one busy definition: alive, and the root PID has a direct child."""
        parents = pids_with_children(identities)
        return {
            sid
            for sid, s in list(self._sessions.items())
            if s.info.alive and s.pty is not None and s.pty.pid in parents
        }

    def busy_ids(self) -> set[str]:
        """Sessions whose shell has a child process right now (ssh, a build,
        an editor, ...). One process snapshot for all sessions; used by the UI
        to guard close actions that would lose running work. WSL in-VM
        processes are invisible to the snapshot, a known blind spot.
        """
        try:
            return self._busy_from(process_identities())
        except Exception:
            log.debug("process child snapshot failed; busy state unavailable", exc_info=True)
            return set()

    def session_metrics(self) -> tuple[set[str], dict[str, dict[str, Any]]]:
        """Resource usage and busy state for every session from one OS snapshot.

        CPU is the process-tree CPU time consumed between API samples divided by
        wall time, so 100% represents one logical CPU and multi-process workloads
        may exceed 100%.
        """
        now = time.monotonic()
        roots = {
            session.pty.pid
            for session in list(self._sessions.values())
            if session.info.alive and session.pty is not None and session.pty.pid
        }
        # One process table read feeds both busy and the samples, so the
        # dashboard and the reaper can never disagree about a session.
        try:
            identities = process_identities()
            busy = self._busy_from(identities)
        except Exception:
            log.debug("process snapshot failed; metrics unavailable", exc_info=True)
            identities, busy = [], set()
        # Sample only the session trees. Opening a handle and reading counters
        # for every PID on the machine was the expensive half of the snapshot,
        # and summarize_trees discarded all of it anyway.
        processes = snapshot_processes(roots, identities=identities)
        totals = summarize_trees(processes, roots)
        metrics: dict[str, dict[str, Any]] = {}
        active_ids: set[str] = set()
        for sid, session in list(self._sessions.items()):
            active_ids.add(sid)
            root = session.pty.pid if session.pty is not None else 0
            total = totals.get(root)
            measured = bool(session.info.alive and total and total.process_count)
            cpu_percent: float | None = None
            if measured and total is not None:
                previous = self._cpu_samples.get(sid)
                if previous is not None and now > previous[0]:
                    cpu_percent = max(0.0, (total.cpu_time_s - previous[1]) / (now - previous[0]) * 100)
                self._cpu_samples[sid] = (now, total.cpu_time_s)
            else:
                self._cpu_samples.pop(sid, None)
            stopped_at = session.ended_at or now
            metrics[sid] = {
                "available": measured,
                "working_set_bytes": total.working_set_bytes if measured and total else None,
                "cpu_percent": round(cpu_percent, 1) if cpu_percent is not None else None,
                "process_count": total.process_count if measured and total else 0,
                "uptime_seconds": max(0, int(stopped_at - session.started_at)),
                "scope": session.resource_scope,
            }
        for sid in set(self._cpu_samples) - active_ids:
            self._cpu_samples.pop(sid, None)
        return busy, metrics

    def session_activity(self, sid: str) -> dict[str, int | None]:
        """Return lightweight attention metadata for one session."""
        session = self._sessions.get(sid)
        if session is None:
            return {
                "idle_seconds": 0,
                "background_output_bytes": 0,
                "background_output_age_seconds": None,
            }
        now = time.monotonic()
        return {
            "idle_seconds": max(0, int(now - session.last_activity)),
            "background_output_bytes": session.background_output_bytes,
            "background_output_age_seconds": (
                max(0, int(now - session.background_output_at))
                if session.background_output_at is not None
                else None
            ),
        }

    def has_attachments(self, sid: str) -> bool:
        s = self._sessions.get(sid)
        return bool(s and s._attachments)

    def attachment_count(self, sid: str) -> int:
        s = self._sessions.get(sid)
        return len(s._attachments) if s else 0

    def resize(self, sid: str, cols: int, rows: int) -> None:
        s = self._sessions.get(sid)
        if s and s.pty and s.info.alive:
            s.info.cols, s.info.rows = cols, rows
            # Reconnect geometry must stay current even while the PTY is silent.
            s._ring_cols, s._ring_rows = cols, rows
            s.pty.resize(cols, rows)

    def kill(self, sid: str) -> bool:
        """Stop a session, returning only after the backend confirms the kill.

        True means verified stopped, False that the process survived. Raises
        KeyError when ``sid`` is not in the registry: callers must be able to
        tell "already gone" (404, or success in a bulk path) from a failure.

        REST sync handlers run in a worker thread, so all asyncio queue and
        timer mutation is marshalled back to the owning loop.  Previously the
        grace-period timer was installed directly from that worker and the
        session stayed visibly alive until the PTY reader eventually reported
        EOF, which made dashboard kills look ineffective.
        """
        s = self._sessions.get(sid)
        if s is None:
            raise KeyError(sid)
        # Exactly True: a backend regression returning None must read as a
        # failure, never as a verified kill that hides a running process.
        if s.pty is not None and s.pty.kill() is not True:
            return False
        try:
            self._loop.call_soon_threadsafe(self._finish_kill, sid, s)
        except RuntimeError:
            # The app is already shutting down; the OS process is nevertheless
            # confirmed stopped, and there is no live registry to notify.
            pass
        return True

    def _finish_kill(self, sid: str, session: Session) -> None:
        if self._sessions.get(sid) is not session:
            return
        if session.info.alive:
            session.info.alive = False
            session.info.exit_code = session.pty.exit_code if session.pty else 1
            if session.info.exit_code is None:
                session.info.exit_code = 1
            session.ended_at = time.monotonic()
            session._fanout(None)
        self._loop.call_later(_KILL_REMOVE_GRACE_S, self._remove_if_same, sid, session)

    def _remove_if_same(self, sid: str, session: Session) -> None:
        if self._sessions.get(sid) is session:
            self._sessions.pop(sid, None)
            self._cpu_samples.pop(sid, None)

    def attach(self, sid: str) -> Attachment:
        """Subscribe a viewer. Raises KeyError for an unknown id, and also for
        a session the reaper has claimed: it is being killed, so the viewer is
        told it is gone (the WS answers 4404) instead of watching it die."""
        s = self._sessions[sid]
        if s.reaping:
            raise KeyError(sid)
        # Opening the terminal acknowledges output accumulated while it was in
        # the background. Do this before registering the viewer so the state is
        # consistent for concurrent session-list requests.
        self._acknowledge(s)
        att = Attachment(s)
        s._attachments.add(att)
        if not s.info.alive:
            att.queue.put_nowait(None)
        return att

    def acknowledge(self, sid: str) -> None:
        """Mark background output as read without subscribing (the server's
        replay-only reattach of an exited session)."""
        s = self._sessions.get(sid)
        if s is not None:
            self._acknowledge(s)

    @staticmethod
    def _acknowledge(s: Session) -> None:
        s.ever_attached = True
        s.background_output_bytes = 0
        s.background_output_at = None

    def shutdown(self) -> None:
        for s in list(self._sessions.values()):
            if s.pty:
                s.pty.kill()
        self._sessions.clear()

    def reap_idle(self, timeout_s: int, protected: set[str] | None = None) -> list[str]:
        """Clean stopped sessions and untouched background shells.

        A silent session that the user typed into may be an SSH connection,
        server, or WSL job, so it is never expired automatically. Exited sessions
        are cleaned even when a stale workspace file still references them,
        unless they hold final output the user has not seen (see
        EXITED_UNREAD_RETENTION_S).

        Runs in a worker thread (app._reap_loop) or on the loop thread. Each
        candidate is rechecked and claimed on the loop thread right before its
        kill: one kill can take seconds on Windows, and a session the user
        picked up meanwhile must survive the pass.
        """
        protected = protected or set()
        busy = self.busy_ids()
        now = time.monotonic()
        candidates = [
            sid
            for sid, s in list(self._sessions.items())
            if self._reapable(s, sid, now, timeout_s, protected, busy)
        ]
        reaped: list[str] = []
        for sid in candidates:
            session = self._on_loop(self._claim, sid, timeout_s, protected, busy)
            if session is None:
                continue
            try:
                stopped = self.kill(sid)
            except KeyError:
                continue  # removed meanwhile; nothing left to stop
            except Exception:
                self._release_soon(session)
                raise
            if stopped:
                reaped.append(sid)
            else:
                self._release_soon(session)
        return reaped

    def _release_soon(self, session: Session) -> None:
        # Fire and forget, never through _on_loop: its timeout cancels the
        # call, and a release lost to a stalled loop would leave the session
        # claimed for good, answering every attach with 4404.
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self._loop:
            self._release(session)
            return
        try:
            self._loop.call_soon_threadsafe(self._release, session)
        except RuntimeError:
            pass  # loop closed: no attach can come any more

    def _reapable(
        self,
        s: Session,
        sid: str,
        now: float,
        timeout_s: int,
        protected: set[str],
        busy: set[str],
    ) -> bool:
        if s._attachments or s.reaping:
            return False
        if not s.info.alive:
            return not self._keeps_unread_exit(s, now)
        if sid in protected or s.info.touched or s.info.retained or sid in busy:
            return False
        return timeout_s > 0 and now - s.last_activity > timeout_s

    @staticmethod
    def _keeps_unread_exit(s: Session, now: float) -> bool:
        # A retained or typed-into session was something the user cared
        # about; its last output (the build result, the agent's reply) exists
        # only in this ring, so it stays until someone has seen it.
        if not (s.info.retained or s.info.touched) or s.background_output_bytes <= 0:
            return False
        ended = s.ended_at if s.ended_at is not None else now
        return now - ended < EXITED_UNREAD_RETENTION_S

    def _claim(
        self, sid: str, timeout_s: int, protected: set[str], busy: set[str]
    ) -> Session | None:
        """Loop thread: recheck one candidate and mark it for killing."""
        s = self._sessions.get(sid)
        if s is None or not self._reapable(s, sid, time.monotonic(), timeout_s, protected, busy):
            return None
        s.reaping = True
        return s

    @staticmethod
    def _release(s: Session) -> None:
        s.reaping = False

    def _on_loop(self, fn: Callable[..., _T], *args: Any) -> _T | None:
        """Run ``fn`` on the loop thread and return its result.

        Called directly when already on that thread (tests call reap_idle
        there, and blocking on our own loop would deadlock). Returns None when
        the loop does not run it in time, which callers read as "leave it".
        """
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self._loop:
            return fn(*args)
        result: concurrent.futures.Future[_T] = concurrent.futures.Future()

        def run() -> None:
            if result.set_running_or_notify_cancel():
                try:
                    result.set_result(fn(*args))
                except BaseException as exc:
                    result.set_exception(exc)

        try:
            self._loop.call_soon_threadsafe(run)
        except RuntimeError:
            return None  # loop closed
        try:
            return result.result(timeout=_LOOP_CALL_TIMEOUT_S)
        except concurrent.futures.TimeoutError:
            if result.cancel():
                return None
        # It started just as the wait ran out. It is short, and its effect (a
        # claim) must not be left behind with nobody to act on it.
        return result.result()

    # loop-thread callbacks from PtySession

    def _on_output(self, session: Session, data: bytes) -> None:
        session.last_activity = time.monotonic()
        if data and session.ever_attached and not session._attachments:
            session.background_output_bytes += len(data)
            session.background_output_at = session.last_activity
        session._record(data)
        session._fanout(data)

    def _on_exit(self, session: Session, code: int) -> None:
        was_alive = session.info.alive
        session.info.alive = False
        session.info.exit_code = code
        session.ended_at = time.monotonic()
        if was_alive:
            session._fanout(None)
