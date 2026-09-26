"""Output-pump send coalescing: replay frames and live frames stay bounded and
ordered. The ring and the attachment queue have their own tests
(test_scrollback.py, test_fanout.py)."""

import asyncio
import json

import quickterm.server as server
from quickterm.fanout import AttachmentQueue
from quickterm.session_manager import SessionInfo


# ---- replay frames ----


def test_replay_frames_are_nonempty_ordered_and_bounded(monkeypatch):
    monkeypatch.setattr(server, "_SEND_COALESCE_BYTES", 4)
    frames = list(server._coalesce_replay((b"", b"abc", b"defghi")))
    assert frames == [b"abcd", b"efgh", b"i"]


def test_replay_frames_end_at_a_resize(monkeypatch):
    monkeypatch.setattr(server, "_SEND_COALESCE_BYTES", 4)
    frames = list(server._coalesce_replay((b"ab", (80, 24), b"cdefg", (90, 30))))
    assert frames == [b"ab", (80, 24), b"cdef", b"g", (90, 30)]


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
