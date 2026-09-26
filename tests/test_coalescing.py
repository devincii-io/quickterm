"""Unit tests for the output-throughput changes: the deque scrollback ring,
the byte-bounded attachment queue and the output-pump send coalescing."""

import asyncio
import json
import random

import pytest

import quickterm.server as server
import quickterm.session_manager as session_manager
from quickterm.session_manager import AttachmentQueue, Session, SessionInfo


def _session(cap: int) -> Session:
    info = SessionInfo(
        id="x", name="x", profile=None, alive=True, exit_code=None, cols=80, rows=24
    )
    return Session(info, cap)


def _replay(s: Session) -> bytes:
    chunks, _, _ = s.scrollback_chunks()
    return b"".join(chunks)


def _ring(s: Session) -> bytes:
    """The retained ring without the synthesized mode preamble."""
    return _replay(s)[len(s._modes.preamble()):]


# ---- deque scrollback ring ----


def test_ring_keeps_tail_within_cap():
    s = _session(10)
    s._record(b"abcde")
    s._record(b"fghij")
    s._record(b"klmno")
    chunks, cols, rows = s.scrollback_chunks()
    assert b"".join(chunks) == b"fghijklmno"  # last cap bytes only
    assert (cols, rows) == (80, 24)


def test_ring_oversized_single_chunk_trims_front():
    s = _session(4)
    s._record(b"0123456789")
    assert _replay(s) == b"6789"


def test_ring_partial_trim_of_oldest_chunk():
    s = _session(6)
    s._record(b"aaaaaa")  # exactly cap
    s._record(b"bb")      # overflow 2 -> trim 2 from the front of the oldest chunk
    assert _replay(s) == b"aaaabb"
    assert s._ring_bytes == 6


def test_ring_records_current_size_even_for_empty_write():
    s = _session(100)
    s.info.cols, s.info.rows = 111, 22
    s._record(b"")  # no data, but size still refreshed
    _, cols, rows = s.scrollback_chunks()
    assert (cols, rows) == (111, 22)


def test_scrollback_chunk_snapshot_avoids_full_join():
    s = _session(100)
    s._record(b"abc")
    s._record(b"def")
    chunks, cols, rows = s.scrollback_chunks()
    assert chunks == (b"abc", b"def")
    assert (cols, rows) == (80, 24)


def test_replay_frames_are_nonempty_ordered_and_bounded(monkeypatch):
    monkeypatch.setattr(server, "_SEND_COALESCE_BYTES", 4)
    frames = list(server._coalesce_replay((b"", b"abc", b"defghi")))
    assert frames == [b"abcd", b"efgh", b"i"]


# ---- the ring front never starts inside a sequence ----


def test_trim_inside_csi_skips_to_the_end_of_the_sequence():
    s = _session(16)
    s._record(b"\x1b[38;5;196mred text here")  # 25 bytes: the cut lands in the CSI
    assert _replay(s) == b"red text here"


def test_trim_inside_osc_skips_past_its_terminator():
    s = _session(20)
    s._record(b"\x1b]0;a long window title\x07prompt> ")
    assert _replay(s) == b"prompt> "
    s = _session(20)
    s._record(b"\x1b]0;a long window title\x1b\\prompt> ")
    assert _replay(s) == b"prompt> "


def test_trim_inside_utf8_character_skips_continuation_bytes():
    s = _session(8)
    s._record("───".encode())  # three 3-byte box characters
    ring = _replay(s)
    assert ring == "──".encode()
    ring.decode("utf-8")  # no partial character at the front


def test_trim_across_chunk_boundary_finds_the_enclosing_sequence():
    s = _session(12)
    s._record(b"text\x1b[38;5")  # the CSI starts in this chunk...
    s._record(b";196mhello")     # ...and ends in the next one
    s._record(b" world")
    assert _replay(s) == b"hello world"


def test_ring_front_always_lands_on_a_token_boundary():
    """Record a tokenized stream in random chunk sizes; after every trim the
    retained ring must begin exactly where some token began."""
    rng = random.Random(1604)
    tokens = [
        b"a", b"Z", b" ", b"\r", b"\n", "é".encode(), "─".encode(), "\U0001f600".encode(),
        b"\x1b[0m", b"\x1b[38;5;196m", b"\x1b[?2004h", b"\x1b[?1000;1006l", b"\x1b[2J",
        b"\x1b]0;window title\x07", b"\x1b]8;;https://example.com/x\x1b\\", b"\x1b7", b"\x1b(B",
    ]
    stream = [rng.choice(tokens) for _ in range(20000)]
    boundaries = {0}
    offset = 0
    for token in stream:
        offset += len(token)
        boundaries.add(offset)
    data = b"".join(stream)
    for cap in (37, 256, 1000):
        s = _session(cap)
        pos = 0
        while pos < len(data):
            size = rng.randint(1, 300)
            s._record(data[pos : pos + size])
            pos += size
            ring = _ring(s)
            front = min(pos, len(data)) - len(ring)
            assert data[front : front + len(ring)] == ring
            assert front in boundaries, (cap, front, ring[:24])


def test_oversized_mode_parameters_do_not_break_recording():
    s = _session(10000)
    s._record(b"\x1b[?" + b"9" * 5000 + b"h" + b"\x1b[?2004h")
    s._record(b"k" * 32)
    s.set_scrollback_cap(16)  # the whole first chunk leaves in one span
    assert s._modes.preamble() == b"\x1b[?2004h"
    assert _ring(s) == b"k" * 16


def test_trim_at_a_clean_boundary_drops_nothing_extra():
    s = _session(10)
    s._record(b"\x1b[1mbold\x1b[0m")
    s._record(b"0123456789")
    assert _replay(s) == b"0123456789"


def test_set_scrollback_cap_uses_the_same_safe_trim():
    s = _session(1000)
    s._record(b"\x1b[?2004h\x1b[38;5;196mred\x1b[0m plain tail")
    s.set_scrollback_cap(20)
    assert _ring(s) == b"red\x1b[0m plain tail"
    assert s._modes.preamble() == b"\x1b[?2004h"


# ---- DEC private modes survive the trim ----


def test_modes_set_before_the_trimmed_region_are_restored_by_the_preamble():
    s = _session(32)
    s._record(b"\x1b[?1049h\x1b[?2004h\x1b[?1000;1006h\x1b[?1h\x1b[?25l")
    s._record(b"x" * 64)
    chunks, _, _ = s.scrollback_chunks()
    assert chunks[0] == b"\x1b[?1h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?1049h\x1b[?2004h"
    assert b"".join(chunks[1:]) == b"x" * 32


def test_mode_set_then_reset_is_not_restored():
    s = _session(8)
    s._record(b"\x1b[?2004h\x1b[?1000h")
    s._record(b"\x1b[?2004l\x1b[?1000l")
    s._record(b"y" * 16)
    assert s.scrollback_chunks()[0] == (b"y" * 8,)


def test_mouse_modes_replace_each_other_like_xterm():
    s = _session(8)
    s._record(b"\x1b[?1003h\x1b[?1000h\x1b[?1015h\x1b[?1006h")
    s._record(b"z" * 16)
    assert s._modes.preamble() == b"\x1b[?1000h\x1b[?1006h"


def test_ris_clears_every_tracked_mode():
    s = _session(8)
    s._record(b"\x1b[?1049h\x1b[?2004h\x1b[?25l")
    s._record(b"\x1bc")
    s._record(b"\x1b[?1h")
    s._record(b"w" * 16)
    assert s._modes.preamble() == b"\x1b[?1h"


def test_mode_sequence_split_across_chunks_is_tracked():
    s = _session(8)
    s._record(b"ab\x1b[?20")
    s._record(b"04h")
    s._record(b"cd\x1b")
    s._record(b"[?1049h")
    s._record(b"q" * 32)
    assert s._modes.preamble() == b"\x1b[?1049h\x1b[?2004h"


def test_ris_split_across_chunks_is_tracked():
    s = _session(8)
    s._record(b"\x1b[?2004h\x1b")
    s._record(b"c")
    s._record(b"q" * 32)
    assert s._modes.preamble() == b""


def test_untracked_and_synchronized_output_modes_are_not_replayed():
    s = _session(8)
    s._record(b"\x1b[?2026h\x1b[?9001h\x1b[?7727h")
    s._record(b"v" * 16)
    assert s._modes.preamble() == b""


def test_scrollback_without_trim_has_no_preamble():
    s = _session(1000)
    s._record(b"\x1b[?1049h\x1b[?2004hhello")
    assert s.scrollback_chunks()[0] == (b"\x1b[?1049h\x1b[?2004hhello",)


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
    q.put_nowait(b"x" * session_manager.QUEUE_MAX_BYTES)
    with pytest.raises(asyncio.QueueFull):
        q.put_nowait(b"y")
    q.put_nowait(None)  # markers never overflow
    assert q.pending_bytes() == session_manager.QUEUE_MAX_BYTES


async def test_queue_get_waits_for_a_put():
    q = AttachmentQueue()
    getter = asyncio.ensure_future(q.get())
    await asyncio.sleep(0)
    assert not getter.done()
    q.put_nowait(b"late")
    assert await asyncio.wait_for(getter, timeout=1) == b"late"


async def test_cancelled_getter_does_not_strand_the_next_item():
    q = AttachmentQueue()
    first = asyncio.ensure_future(q.get())
    await asyncio.sleep(0)
    first.cancel()
    await asyncio.sleep(0)
    second = asyncio.ensure_future(q.get())
    await asyncio.sleep(0)
    q.put_nowait(b"data")
    assert await asyncio.wait_for(second, timeout=1) == b"data"


# ---- output pump send coalescing ----


class _FakeWS:
    def __init__(self):
        self.sent_bytes: list[bytes] = []
        self.sent_text: list[str] = []
        self.closed = False

    async def send_bytes(self, data):
        self.sent_bytes.append(bytes(data))

    async def send_text(self, text):
        self.sent_text.append(text)

    async def close(self):
        self.closed = True


class _FakeAtt:
    def __init__(self, queue):
        self.queue = queue
        self.overflow_sentinel = object()


class _FakeSession:
    def __init__(self, code):
        self.info = SessionInfo(
            id="x", name="x", profile=None, alive=False, exit_code=code, cols=80, rows=24
        )


async def _run_pump(items):
    q = asyncio.Queue()
    for x in items:
        q.put_nowait(x)
    ws = _FakeWS()
    await server._pump_output(ws, _FakeAtt(q), _FakeSession(0))
    return ws


async def test_pump_coalesces_queued_frames_then_exits():
    ws = await _run_pump([b"a", b"b", b"c", None])
    assert ws.sent_bytes == [b"abc"]  # three chunks merged into one frame
    assert ws.closed
    assert json.loads(ws.sent_text[0]) == {"type": "exit", "code": 0}


async def test_pump_flushes_before_exit_when_none_is_mid_batch():
    ws = await _run_pump([b"hello", None])
    assert ws.sent_bytes == [b"hello"]  # data flushed before the exit frame
    assert json.loads(ws.sent_text[0]) == {"type": "exit", "code": 0}


async def test_pump_respects_coalesce_cap(monkeypatch):
    monkeypatch.setattr(server, "_SEND_COALESCE_BYTES", 2)
    ws = await _run_pump([b"aa", b"bb", None])
    assert ws.sent_bytes == [b"aa", b"bb"]  # cap prevents merging past 2 bytes
    assert json.loads(ws.sent_text[0])["type"] == "exit"


async def test_pump_splits_chunks_and_merged_frames_at_cap(monkeypatch):
    monkeypatch.setattr(server, "_SEND_COALESCE_BYTES", 4)
    ws = await _run_pump([b"abc", b"defghi", None])
    assert ws.sent_bytes == [b"abcd", b"efgh", b"i"]
    assert all(len(frame) <= 4 for frame in ws.sent_bytes)
    assert b"".join(ws.sent_bytes) == b"abcdefghi"
    assert json.loads(ws.sent_text[0])["type"] == "exit"


async def test_pump_immediate_exit_on_leading_sentinel():
    ws = await _run_pump([None])
    assert ws.sent_bytes == []
    assert ws.closed
    assert json.loads(ws.sent_text[0]) == {"type": "exit", "code": 0}


async def test_pump_drains_the_real_attachment_queue():
    q = AttachmentQueue()
    q.put_nowait(b"a")
    q.put_nowait(b"b")  # merged into the pending tail
    q.put_nowait(None)
    ws = _FakeWS()
    await server._pump_output(ws, _FakeAtt(q), _FakeSession(0))
    assert ws.sent_bytes == [b"ab"]
    assert json.loads(ws.sent_text[0])["type"] == "exit"
