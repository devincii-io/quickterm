"""Browser close and backend shutdown can overlap in the native viewer."""

import asyncio
from unittest.mock import Mock

import pytest
from websockets.protocol import State
from websockets.server import ServerProtocol

from quickterm.ws_protocol import WebSocketProtocol


@pytest.mark.parametrize("state", [State.CLOSING, State.CLOSED])
def test_shutdown_during_close_does_not_send_another_close(state):
    protocol = WebSocketProtocol.__new__(WebSocketProtocol)
    protocol.handshake_complete = True
    protocol.conn = ServerProtocol(state=state)
    protocol.transport = Mock()
    protocol.queue = asyncio.Queue()
    protocol.stop_keepalive = Mock()

    protocol.shutdown()

    protocol.stop_keepalive.assert_called_once()
    protocol.transport.close.assert_called_once()
    protocol.transport.write.assert_not_called()
    assert protocol.queue.get_nowait() == {"type": "websocket.disconnect", "code": 1012}


def test_shutdown_of_open_connection_still_sends_close_frame():
    protocol = WebSocketProtocol.__new__(WebSocketProtocol)
    protocol.handshake_complete = True
    protocol.conn = ServerProtocol(state=State.OPEN)
    protocol.transport = Mock()
    protocol.queue = asyncio.Queue()
    protocol.stop_keepalive = Mock()

    protocol.shutdown()

    assert protocol.conn.state is State.CLOSING
    protocol.transport.write.assert_called_once()
    assert protocol.transport.write.call_args.args[0].startswith(b"\x88")
    protocol.transport.close.assert_called_once()
    assert protocol.queue.get_nowait()["code"] == 1012
