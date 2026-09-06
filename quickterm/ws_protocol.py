"""Uvicorn's SansIO transport with idempotent shutdown for closing viewers."""

from uvicorn.protocols.websockets.websockets_sansio_impl import WebSocketsSansIOProtocol
from websockets.protocol import State


class WebSocketProtocol(WebSocketsSansIOProtocol):
    def shutdown(self) -> None:
        # WebView2 can start the close handshake just before server shutdown.
        # Uvicorn sends another close for every completed handshake, but
        # websockets rejects send_close once the connection is already closing.
        if self.handshake_complete and self.conn.state in (State.CLOSING, State.CLOSED):
            self.stop_keepalive()
            self.queue.put_nowait({"type": "websocket.disconnect", "code": 1012})
            self.transport.close()
            return
        super().shutdown()
