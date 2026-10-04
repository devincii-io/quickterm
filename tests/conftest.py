"""Setup shared by every test module."""

import os

import pytest

# ConPTY's console host asks its terminal for the primary device attributes
# (ESC [ c) when it starts and holds the client process up to 3 s for the
# answer. In the app xterm.js gives it; a test has no terminal, so every real
# PTY test waited those 3 s (`cmd /c exit 3` took 3.1 s, 0.08 s answered).
# This stands in for the emulator's reply and changes nothing else: the
# output the test sees is untouched.
DA1_QUERY = b"\x1b[c"
DA1_REPLY = b"\x1b[?61;4c"


@pytest.fixture(autouse=True)
def _terminal_answers_device_attributes(monkeypatch):
    if os.name != "nt":
        return
    from quickterm import pty_session

    original = pty_session.PtySession.__init__

    def init(self, cmd, args, cwd, env, cols, rows, loop, on_output, on_exit):
        def answering(data: bytes, _deliver=on_output) -> None:
            if DA1_QUERY in data:
                self.write(DA1_REPLY)
            _deliver(data)

        original(self, cmd, args, cwd, env, cols, rows, loop, answering, on_exit)

    monkeypatch.setattr(pty_session.PtySession, "__init__", init)
