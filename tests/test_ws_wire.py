"""The WS attach protocol end to end through ws_session, including every way
it ends that is not a clean exit: overflow resync, a bad or missing replay
acknowledgement, oversized input and a full input queue.

The "never lose bytes" contract rests on these close codes; the client
reconnects and replays on 1013 and gives up on 1002."""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import json
import time

import pytest
from fastapi.testclient import TestClient

from quickterm.server import create_app
from tests.test_server import FakeConfig, FakeSessionManager

FRAME = 128 * 1024
HOST = {"host": "127.0.0.1:8620"}


class _SentinelManager(FakeSessionManager):
    """Queues items (the attachment's own overflow sentinel included) at attach."""

    def __init__(self) -> None:
        super().__init__()
        self.at_attach: list = []

    def attach(self, sid):
        att = super().attach(sid)
        for item in self.at_attach:
            att.queue.put_nowait(att.overflow_sentinel if item == "overflow" else item)
        return att


@pytest.fixture
def manager() -> _SentinelManager:
    return _SentinelManager()


@pytest.fixture
def client(manager):
    with TestClient(create_app(manager, FakeConfig()), base_url="http://127.0.0.1:8620") as c:
        yield c


def _connect(client, sid):
    return client.websocket_connect(f"/ws/session/{sid}", headers=HOST)


def _replay(ws) -> bytes:
    """Run the client side of the handshake, acking every frame."""
    assert json.loads(ws.receive_text())["type"] == "replay_size"
    received = b""
    while True:
        message = ws.receive()
        if message.get("text") is not None:
            assert json.loads(message["text"]) == {"type": "replay_done"}
            return received
        received += message["bytes"]
        ws.send_text(json.dumps({"type": "replay_ack"}))


def _closed(ws) -> dict:
    message = ws.receive()
    assert message["type"] == "websocket.close", message
    return message


def test_replay_is_sent_from_scrollback_chunks_one_ack_per_frame(client, manager):
    chunks = (b"a" * 100_000, b"b" * 100_000, b"c" * 100_000)
    info = manager.add_session(scrollback=chunks, cols=90, rows=33)
    with _connect(client, info.id) as ws:
        assert json.loads(ws.receive_text()) == {"type": "replay_size", "cols": 90, "rows": 33}
        frames = []
        for _ in range(3):
            frame = ws.receive_bytes()
            frames.append(frame)
            ws.send_text(json.dumps({"type": "replay_ack"}))
        assert json.loads(ws.receive_text()) == {"type": "replay_done"}
    # Frames are capped at the live-frame size and cut across chunk borders.
    assert [len(frame) for frame in frames] == [FRAME, FRAME, 300_000 - 2 * FRAME]
    assert b"".join(frames) == b"".join(chunks)


def test_a_resize_in_the_ring_is_sent_after_the_frames_before_it_are_acknowledged(
    client, manager
):
    steps = (b"wide", (60, 20), (61, 21), b"narrow" * 30_000, b"more", (90, 33))
    info = manager.add_session(scrollback=steps, cols=120, rows=30)
    with _connect(client, info.id) as ws:
        assert json.loads(ws.receive_text()) == {"type": "replay_size", "cols": 120, "rows": 30}
        assert ws.receive_bytes() == b"wide"  # never merged with what follows the resize
        ws.send_text(json.dumps({"type": "replay_ack"}))
        assert json.loads(ws.receive_text()) == {"type": "replay_resize", "cols": 60, "rows": 20}
        assert json.loads(ws.receive_text()) == {"type": "replay_resize", "cols": 61, "rows": 21}
        received = b""
        while len(received) < 180_004:
            received += ws.receive_bytes()
            ws.send_text(json.dumps({"type": "replay_ack"}))
        assert received == b"narrow" * 30_000 + b"more"
        assert json.loads(ws.receive_text()) == {"type": "replay_resize", "cols": 90, "rows": 33}
        assert json.loads(ws.receive_text()) == {"type": "replay_done"}


def test_an_empty_ring_sends_one_empty_frame_without_an_ack(client, manager):
    info = manager.add_session()
    with _connect(client, info.id) as ws:
        assert json.loads(ws.receive_text())["type"] == "replay_size"
        assert ws.receive_bytes() == b""
        assert json.loads(ws.receive_text()) == {"type": "replay_done"}


@pytest.mark.parametrize("queued", [["overflow"], [b"early", "overflow"]])
def test_overflow_sends_the_resync_notice_and_closes_1013(client, manager, queued):
    # ["overflow"]: the sentinel leads a batch. [b"early", "overflow"]: it turns
    # up while the pump is coalescing a batch that already started.
    manager.at_attach = queued
    info = manager.add_session(scrollback=b"old")
    with _connect(client, info.id) as ws:
        assert _replay(ws) == b"old"
        assert json.loads(ws.receive_text()) == {"type": "overflow"}
        assert _closed(ws)["code"] == 1013
    assert manager.last_attachment.detached is True


def test_overflow_during_the_live_phase_closes_1013(client, manager):
    info = manager.add_session(scrollback=b"old")
    with _connect(client, info.id) as ws:
        _replay(ws)
        attachment = manager.last_attachment
        attachment.push_threadsafe(attachment.overflow_sentinel)
        assert json.loads(ws.receive_text()) == {"type": "overflow"}
        assert _closed(ws)["code"] == 1013


@pytest.mark.parametrize("reply", [
    ("text", json.dumps({"type": "resize", "cols": 80, "rows": 24})),
    ("text", "not json"),
    ("text", json.dumps(["replay_ack"])),
    ("bytes", b"typed too early"),
])
def test_anything_but_a_replay_ack_closes_1002(client, manager, reply):
    info = manager.add_session(scrollback=b"old")
    with _connect(client, info.id) as ws:
        ws.receive_text()
        assert ws.receive_bytes() == b"old"
        kind, payload = reply
        if kind == "text":
            ws.send_text(payload)
        else:
            # A binary frame here used to escape as KeyError('text') and a 1011.
            ws.send_bytes(payload)
        assert _closed(ws)["code"] == 1002
    assert manager.writes == []


def test_a_client_that_leaves_mid_replay_ends_the_handler_quietly(client, manager):
    info = manager.add_session(scrollback=b"old")
    with contextlib.suppress(asyncio.CancelledError, concurrent.futures.CancelledError):
        with _connect(client, info.id) as ws:
            ws.receive_text()
            ws.receive_bytes()
    for _ in range(300):
        if manager.last_attachment is not None and manager.last_attachment.detached:
            break
        time.sleep(0.01)
    assert manager.last_attachment.detached is True


def test_input_over_256_kib_closes_1009(client, manager):
    info = manager.add_session()
    with _connect(client, info.id) as ws:
        _replay(ws)
        ws.send_bytes(b"x" * (256 * 1024))
        ws.send_bytes(b"x" * (256 * 1024 + 1))
        assert _closed(ws)["code"] == 1009
    assert [len(data) for _sid, data in manager.writes] == [256 * 1024]


def test_a_full_input_queue_closes_1013(client, manager, monkeypatch):
    def full(_sid, _data):
        raise BufferError("terminal input queue is full")

    monkeypatch.setattr(manager, "write", full)
    info = manager.add_session()
    with _connect(client, info.id) as ws:
        _replay(ws)
        ws.send_bytes(b"ls\r")
        assert _closed(ws)["code"] == 1013


def test_only_the_touch_frame_marks_a_session_touched(client, manager):
    info = manager.add_session()
    with _connect(client, info.id) as ws:
        _replay(ws)
        # xterm's automatic reply to a cursor-position query: input, not a person.
        ws.send_bytes(b"\x1b[12;1R")
        ws.send_text(json.dumps({"type": "unknown"}))
        ws.send_text(json.dumps({"type": "touch"}))
        ws.send_text(json.dumps({"type": "resize", "cols": 100, "rows": 40}))
        deadline = 300
        while not manager.resizes and deadline:

            time.sleep(0.01)
            deadline -= 1
    assert manager.touched == [info.id]
    assert manager.writes == [(info.id, b"\x1b[12;1R")]


def test_a_session_that_vanishes_before_attach_closes_4404(client, manager, monkeypatch):
    info = manager.add_session()

    def gone(sid):
        raise KeyError(sid)

    # The reaper can drop it between get() and attach(): ws.accept() awaits.
    monkeypatch.setattr(manager, "attach", gone)
    with _connect(client, info.id) as ws:
        assert _closed(ws)["code"] == 4404


def test_replaying_an_exited_session_acknowledges_its_output(client, manager):
    info = manager.add_session(alive=False, exit_code=3, scrollback=b"final output")
    with _connect(client, info.id) as ws:
        assert _replay(ws) == b"final output"
        assert json.loads(ws.receive_text()) == {"type": "exit", "code": 3}
        _closed(ws)
    # This path never calls attach(), so it must mark the output read itself.
    assert manager.acknowledged == [info.id]


def test_a_failed_replay_of_an_exited_session_acknowledges_nothing(client, manager):
    info = manager.add_session(alive=False, exit_code=3, scrollback=b"final output")
    with _connect(client, info.id) as ws:
        ws.receive_text()
        ws.receive_bytes()
        ws.send_text("nope")
        assert _closed(ws)["code"] == 1002
    assert manager.acknowledged == []
