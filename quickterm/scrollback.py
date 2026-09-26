"""Scrollback ring: the retained output of one session and its clean replay.

Owns the chunk deque, the byte cap and the trim that keeps the ring front on
a clean start: never inside an escape sequence, a UTF-8 character or an OSC,
DCS, APC, PM or SOS string. Also owns the DEC private mode tracker that feeds
on trimmed bytes, so a replay can restore the modes in effect at the front.
Pure byte handling: no asyncio, no PTY, no registry.
"""

from __future__ import annotations

import re
from collections import deque

# How far the ring front may move past a cut to reach a sequence boundary, and
# how far back the cut looks for the ESC that might enclose it. The forward
# side first looks at a short peek, which settles almost every CSI.
_RESYNC_SCAN_BYTES = 4096
_RESYNC_PEEK_BYTES = 64

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


class ScrollbackRing:
    """The last ``cap`` bytes of a session's output, kept as separate chunks.

    ``cols`` and ``rows`` are the terminal size the retained bytes were last
    written at (or last resized to), which a replay has to start with.
    """

    def __init__(self, cap: int, cols: int, rows: int) -> None:
        self._cap = cap
        # A deque of chunks + running byte count. The live part of the oldest
        # chunk starts at _head, so trimming moves an offset instead of copying
        # the rest of that chunk on every write; the slice happens once, at
        # replay time.
        self._chunks: deque[bytes] = deque()
        self._head = 0
        self._size = 0
        self._modes = _ModeTracker()
        self.cols = cols
        self.rows = rows

    def __len__(self) -> int:
        """Retained bytes, without the replay preamble."""
        return self._size

    def snapshot(self) -> tuple[tuple[bytes, ...], int, int]:
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
        return tuple(chunks), self.cols, self.rows

    def preamble(self) -> bytes:
        """The mode-restoring prefix a replay would start with right now."""
        return self._modes.preamble()

    def record(self, data: bytes, cols: int, rows: int) -> None:
        """Append output written at ``cols`` x ``rows`` (the output hot path)."""
        if data:
            self._chunks.append(data)
            self._size += len(data)
            # A non-ground tracker state means an earlier trim emptied the
            # ring inside a string, so the new bytes are its payload and go
            # too, even below the cap.
            if self._size > self._cap or self._modes.state:
                self._trim()
        self.cols = cols
        self.rows = rows

    def set_cap(self, cap: int) -> None:
        self._cap = cap
        if self._size > self._cap:
            self._trim()

    def _trim(self) -> None:
        """Drop the oldest bytes down to the cap, then on to a clean start."""
        excess = self._size - self._cap
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
        skip = _resync_skip(lookback + forward, len(lookback), len(forward) >= self._size)
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
        self._drop(self._size)

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
                self._size -= available
                count -= available
            else:
                spans.append((chunk, self._head, self._head + count))
                self._head += count
                self._size -= count
                count = 0
        for chunk, start, end in spans:
            self._modes.feed(chunk, start, end)
        return spans
