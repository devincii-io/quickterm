"""Unit tests for the output-throughput changes: the deque scrollback ring and
the output-pump send coalescing."""

import asyncio
import json

import quickterm.server as server
from quickterm.session_manager import Session, SessionInfo


def _session(cap: int) -> Session:
    info = SessionInfo(
        id="x", name="x", profile=None, alive=True, exit_code=None, cols=80, rows=24
    )
    return Session(info, cap)


# ---- deque scrollback ring ----


def test_ring_keeps_tail_within_cap():
    s = _session(10)
    s._record(b"abcde")
    s._record(b"fghij")
    s._record(b"klmno")
    data, cols, rows = s.scrollback()
    assert data == b"fghijklmno"  # last cap bytes only
    assert (cols, rows) == (80, 24)


def test_ring_oversized_single_chunk_trims_front():
    s = _session(4)
    s._record(b"0123456789")
    data, _, _ = s.scrollback()
    assert data == b"6789"


def test_ring_partial_trim_of_oldest_chunk():
    s = _session(6)
    s._record(b"aaaaaa")  # exactly cap
    s._record(b"bb")      # overflow 2 -> trim 2 from the front of the oldest chunk
    data, _, _ = s.scrollback()
    assert data == b"aaaabb"


def test_ring_records_current_size_even_for_empty_write():
    s = _session(100)
    s.info.cols, s.info.rows = 111, 22
    s._record(b"")  # no data, but size still refreshed
    _, cols, rows = s.scrollback()
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


async def test_pump_immediate_exit_on_leading_sentinel():
    ws = await _run_pump([None])
    assert ws.sent_bytes == []
    assert ws.closed
    assert json.loads(ws.sent_text[0]) == {"type": "exit", "code": 0}
