"""WebSocket attach: the replay handshake, then the live output and input pumps."""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI, HTTPException, WebSocket
from starlette.websockets import WebSocketDisconnect

from quickterm import auth
from quickterm.api.common import bounded_int
from quickterm.api.guard import ws_allowed

if TYPE_CHECKING:
    from quickterm.api.context import ApiContext
    from quickterm.session_manager import Attachment, SessionManager

# Max bytes merged into one live output frame. Bounds per-send loop time so the
# input pump interleaves; big enough to collapse bursts into few frames.
SEND_COALESCE_BYTES = 128 * 1024
INPUT_FRAME_MAX = 256 * 1024


def register(app: FastAPI, ctx: ApiContext) -> None:
    manager = ctx.manager
    token = ctx.token

    @app.websocket("/ws/session/{sid}")
    async def ws_session(ws: WebSocket, sid: str) -> None:
        if not ws_allowed(ctx, ws):
            await ws.close(code=4403)
            return
        session = manager.get(sid)
        # Echo the token subprotocol back to complete negotiation cleanly.
        await ws.accept(subprotocol=(auth.SUBPROTOCOL_PREFIX + token) if token else None)
        if session is None:
            await ws.close(code=4404)
            return
        if not session.info.alive:
            # Replay-only reattach. Refusing an exited session outright made
            # overflow permanently lossy: the client is told to reconnect and
            # replay the ring, and if the PTY died around the overflow that
            # replay could never happen, so the session's final output (the
            # build result, the error) was unreachable while still sitting in
            # the ring. Serve the scrollback, report the exit, accept no input.
            try:
                if await _send_replay(ws, session):
                    # This path never calls attach(), which is what normally
                    # marks background output as read. Without it the reaper
                    # keeps an exited session with "unread" output forever.
                    manager.acknowledge(sid)
                    await _send_exit(ws, session)
            except (WebSocketDisconnect, asyncio.CancelledError):
                pass
            return
        # Subscribe before taking the replay snapshot. Both calls are
        # synchronous on the event-loop thread, so output cannot slip between
        # the snapshot and the live queue (the old order permanently lost it).
        try:
            attachment = manager.attach(sid)
        except KeyError:
            # Reaped or killed during the accept above: same answer as a
            # session that was never there.
            await ws.close(code=4404)
            return
        # ...and start draining that subscription immediately: nothing consumed
        # the queue until the live phase began, so a busy session could fill
        # its bounded queue during the (multi-round-trip) handshake and be
        # closed 1013 the instant it went live, and the client then reconnected
        # into exactly the same trap, forever.
        buffer = _HandshakeBuffer(attachment)
        try:
            if not await _send_replay(ws, session):
                return
            # Hand the buffer over, not its contents: pump_output takes it as
            # its very first statement, so there is never a turn of the loop
            # with nobody draining the queue.
            await _live_phase(ws, attachment, manager, session, sid, buffer)
        except (WebSocketDisconnect, asyncio.CancelledError):
            pass
        finally:
            buffer.take()
            attachment.detach()


class _HandshakeBuffer:
    """Consume a fresh subscription while the replay handshake is in flight.

    The fan-out queue overflows once its pending bytes pass a cap (2 MiB), and
    the handshake is several round trips (one per 128 KiB replay frame, each
    awaiting an ack), which is ample time for a verbose build to get there;
    the reconnect then landed in the same window every time. Draining here
    keeps the subscription alive; everything collected is handed to the live
    pump in order.
    """

    # Bounded so this cannot become the unbounded buffer the queue cap exists
    # to prevent. Past the cap we stop and let the normal resync take over.
    MAX_BUFFERED_BYTES = 8 * SEND_COALESCE_BYTES

    def __init__(self, attachment: Attachment) -> None:
        self._attachment = attachment
        self._items: list = []
        self._taken = False
        # Set once a terminal item (exit or overflow) has been buffered: after
        # that nothing further in the queue can matter, and continuing to
        # collect it would defeat MAX_BUFFERED_BYTES.
        self._sealed = False
        self._task = asyncio.ensure_future(self._drain())

    async def _drain(self) -> None:
        buffered = 0
        while True:
            item = await self._attachment.queue.get()
            self._items.append(item)
            if item is None or item is self._attachment.overflow_sentinel:
                self._sealed = True
                return
            buffered += len(item)
            if buffered >= self.MAX_BUFFERED_BYTES:
                self._items.append(self._attachment.overflow_sentinel)
                self._sealed = True
                return

    def take(self) -> list:
        """Stop draining and return everything buffered, in arrival order."""
        if self._taken:
            return []
        self._taken = True
        self._task.cancel()
        while not self._sealed:
            try:
                self._items.append(self._attachment.queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        return self._items


async def _send_replay(ws: WebSocket, session: Any) -> bool:
    """Run the replay handshake. Returns False if the socket was closed."""
    replay_chunks, cols, rows = session.scrollback_chunks()
    await ws.send_text(json.dumps({"type": "replay_size", "cols": cols, "rows": rows}))
    sent_replay = False
    for frame in coalesce_replay(replay_chunks):
        sent_replay = True
        await ws.send_bytes(frame)
        # receive(), not receive_text(): the latter indexes message["text"] and
        # a binary frame here escaped as a KeyError and a 1011 close.
        try:
            message = await asyncio.wait_for(ws.receive(), timeout=30)
        except TimeoutError:
            message = None
        if message is not None and message["type"] == "websocket.disconnect":
            return False
        if message is None or not _is_replay_ack(message):
            await ws.close(code=1002, reason="invalid replay acknowledgement")
            return False
    # Keep the original wire shape for empty terminals.  The empty frame has
    # nothing for xterm to parse, so it intentionally does not participate in
    # replay acknowledgement flow control.
    if not sent_replay:
        await ws.send_bytes(b"")
    await ws.send_text(json.dumps({"type": "replay_done"}))
    return True


def _is_replay_ack(message: Any) -> bool:
    text = message.get("text")
    if not isinstance(text, str):
        return False
    try:
        ack = json.loads(text)
    except json.JSONDecodeError:
        return False
    return isinstance(ack, dict) and ack.get("type") == "replay_ack"


def coalesce_replay(chunks: Any, cap: int | None = None):
    """Yield non-empty replay frames no larger than the live-frame cap."""
    limit = SEND_COALESCE_BYTES if cap is None else cap
    pending = bytearray()
    for raw in chunks:
        if not raw:
            continue
        view = memoryview(raw)
        offset = 0
        while offset < len(view):
            take = min(limit - len(pending), len(view) - offset)
            pending.extend(view[offset:offset + take])
            offset += take
            if len(pending) == limit:
                yield bytes(pending)
                pending.clear()
    if pending:
        yield bytes(pending)


async def _live_phase(
    ws: WebSocket,
    attachment: Attachment,
    manager: SessionManager,
    session: Any,
    sid: str,
    buffer: _HandshakeBuffer | None = None,
) -> None:
    out = asyncio.ensure_future(pump_output(ws, attachment, session, buffer))
    inp = asyncio.ensure_future(_pump_input(ws, manager, sid))
    try:
        done, pending = await asyncio.wait({out, inp}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            if task.cancelled():
                continue
            exc = task.exception()
            if exc is not None and not isinstance(exc, WebSocketDisconnect):
                raise exc
    finally:
        for task in (out, inp):
            if not task.done():
                task.cancel()
        await asyncio.gather(out, inp, return_exceptions=True)


async def pump_output(
    ws: WebSocket,
    attachment: Attachment,
    session: Any,
    buffer: _HandshakeBuffer | None = None,
    *,
    cap: int | None = None,
) -> None:
    limit = SEND_COALESCE_BYTES if cap is None else cap
    # queue yields raw PTY bytes; None sentinel = session exited
    # Take over from the handshake buffer BEFORE the first await, so no turn of
    # the loop passes with the subscriber queue unconsumed. `pending` holds
    # what it collected and is drained, in order, ahead of the live queue.
    pending = buffer.take() if buffer is not None else []

    async def _next() -> Any:
        return pending.pop(0) if pending else await attachment.queue.get()

    def _next_nowait() -> Any:
        if pending:
            return pending.pop(0)
        return attachment.queue.get_nowait()

    carry: bytes | None = None
    while True:
        chunk = carry if carry is not None else await _next()
        carry = None
        if chunk is None:
            await _send_exit(ws, session)
            return
        if chunk is attachment.overflow_sentinel:
            await ws.send_text(json.dumps({"type": "overflow"}))
            await ws.close(code=1013, reason="viewer fell behind; reconnect to replay")
            return
        # Coalesce whatever else is already queued into a single frame (capped so
        # one send can't monopolize the loop and starve input). Raw bytes stay a
        # plain byte stream to the client, so this is wire-compatible.
        if len(chunk) > limit:
            carry = chunk[limit:]
            chunk = chunk[:limit]
        parts = [chunk]
        total = len(chunk)
        exited = False
        while total < limit:
            try:
                item = _next_nowait()
            except asyncio.QueueEmpty:
                break
            if item is None:
                exited = True
                break
            if item is attachment.overflow_sentinel:
                await ws.send_text(json.dumps({"type": "overflow"}))
                await ws.close(code=1013, reason="viewer fell behind; reconnect to replay")
                return
            remaining = limit - total
            parts.append(item[:remaining])
            total += min(len(item), remaining)
            if len(item) > remaining:
                carry = item[remaining:]
                break
        await ws.send_bytes(parts[0] if len(parts) == 1 else b"".join(parts))
        if exited:
            await _send_exit(ws, session)
            return


async def _send_exit(ws: WebSocket, session: Any) -> None:
    await ws.send_text(json.dumps({"type": "exit", "code": session.info.exit_code}))
    await ws.close()


async def _pump_input(ws: WebSocket, manager: SessionManager, sid: str) -> None:
    while True:
        msg = await ws.receive()
        if msg["type"] == "websocket.disconnect":
            return
        if msg.get("bytes") is not None:
            data = msg["bytes"]
            if len(data) > INPUT_FRAME_MAX:
                await ws.close(code=1009, reason="input frame too large")
                return
            try:
                manager.write(sid, data)
            except BufferError:
                await ws.close(code=1013, reason="terminal input queue is full")
                return
        elif msg.get("text"):
            try:
                ctrl = json.loads(msg["text"])
            except (TypeError, json.JSONDecodeError):
                continue
            if not isinstance(ctrl, dict):
                continue
            if ctrl.get("type") == "touch":
                # The client's word that a person typed or pasted. Input bytes
                # alone cannot say it: xterm answers DA/DSR/CPR queries and
                # focus reports through the same stream.
                manager.touch(sid)
            elif ctrl.get("type") == "resize":
                try:
                    cols = bounded_int(ctrl.get("cols"), "cols", 2, 1000)
                    rows = bounded_int(ctrl.get("rows"), "rows", 1, 1000)
                except HTTPException:
                    continue
                manager.resize(sid, cols, rows)
