"""Plumbing shared by the ConPTY (pty_session.py) and POSIX (pty_posix.py) backends.

Both backends used to carry their own copies of the write queue, the writer
loop and the loop posting, and the copies drifted apart: only Windows
coalesced reads and writes, and only Windows kept the writer running after a
kill that could not be verified. What is left in the backends is what really
differs between them: spawn, raw read, raw write, resize and kill.
"""

from __future__ import annotations

import asyncio
import os
import queue
import threading
from typing import Any, Callable

# Upper bound on how much immediately-available output one on_output callback
# carries. One callback per burst means one thread hop, one ring edit and one
# WS frame instead of one per read; the bound keeps a flood yielding to the
# loop so input stays responsive.
READ_COALESCE_BYTES = 128 * 1024
# Keystrokes and paste chunks that piled up while a write blocked go out as one
# write of at most this size.
WRITE_COALESCE_BYTES = 256 * 1024
WRITE_QUEUE_ITEMS = 64
# After the child exits, output still in flight is read until the PTY has been
# quiet this long, but never longer than DRAIN_MAX_S: a background job that
# inherited the terminal may keep writing forever.
DRAIN_IDLE_S = 0.15
DRAIN_MAX_S = 1.0


# Variables QuickTerm set on its own process that the user's environment did
# not have. They protect QuickTerm, not the shells it starts.
_PRIVATE_ENV: set[str] = set()


def set_private_env(name: str, value: str) -> None:
    """Set a variable for QuickTerm's own process, hidden from every terminal.

    NoDefaultCurrentDirectoryInExePath keeps a planted taskkill.exe or pwsh.exe
    in the launch folder from running in QuickTerm's place. Inherited, it
    would also stop cmd.exe in every terminal from running a program in the
    current folder without `.\\`, which is not QuickTerm's call to make. A
    value the user had already set is theirs and still reaches the children.
    """
    if name not in os.environ:
        _PRIVATE_ENV.add(name)
    os.environ[name] = value


def merge_environment(override: dict[str, str] | None) -> dict[str, str]:
    """The child's environment: QuickTerm's own, with the profile override on top.

    Windows names are case-insensitive, and CPython upper-cases the keys of
    ``os.environ`` there. A plain ``dict.update`` with a profile ``Path`` (the
    spelling the Windows dialog shows) therefore added a second entry behind
    ``PATH``, and every lookup returned the inherited value first.
    """
    merged = dict(os.environ)
    for name in _PRIVATE_ENV:
        merged.pop(name, None)
        merged.pop(name.upper(), None)
    if os.name == "nt":
        for key in override or {}:
            folded = key.casefold()
            for existing in [k for k in merged if k.casefold() == folded]:
                del merged[existing]
    else:
        # The emulator is always xterm.js, whatever terminal started the
        # backend (an IDE console exports TERM=dumb, tmux its own name).
        merged["TERM"] = "xterm-256color"
        merged["COLORTERM"] = "truecolor"
    merged.update(override or {})
    return merged


def path_value(env: dict[str, str]) -> str | None:
    """The PATH of a merged environment, whatever the spelling of its key.

    After a Windows merge the only PATH entry may be the profile's ``Path``;
    ``env.get("PATH")`` would miss it and resolve the command against nothing.
    ``None`` lets ``shutil.which`` apply its own default.
    """
    if os.name == "nt":
        for key, value in env.items():
            if key.casefold() == "path":
                return value
        return None
    return env.get("PATH")


class PtyBase:
    """Loop posting and the bounded, coalescing write queue of one PTY.

    ``write()`` only enqueues. A dedicated writer thread performs the raw
    write, which blocks when the child does not read its input, so a big paste
    into a busy program can never stall the event loop. Subclasses implement
    ``_do_write`` and call ``_start_writer`` once the child exists.
    """

    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        on_output: Callable[[bytes], None],
        on_exit: Callable[[int], None],
    ) -> None:
        self._loop = loop
        self._on_output = on_output
        self._on_exit = on_exit
        self._write_q: queue.Queue[bytes | None] = queue.Queue(maxsize=WRITE_QUEUE_ITEMS)
        # Set once input can no longer reach the child (verified kill, natural
        # exit, dead PTY). write() then drops data instead of filling the queue
        # and raising BufferError at a terminal that is gone.
        self._input_closed = threading.Event()
        self._writer: threading.Thread | None = None

    def write(self, data: bytes) -> None:
        if self._input_closed.is_set():
            return
        try:
            self._write_q.put_nowait(data)
        except queue.Full:
            raise BufferError("PTY input queue is full") from None

    def _do_write(self, data: bytes) -> bool:
        """Write all of ``data`` to the PTY; False once the PTY is gone."""
        raise NotImplementedError

    def _start_writer(self, name: str) -> None:
        self._writer = threading.Thread(target=self._write_loop, name=name, daemon=True)
        self._writer.start()

    def _write_loop(self) -> None:
        while True:
            item = self._write_q.get()
            if item is None or self._input_closed.is_set():
                return
            parts = [item]
            total = len(item)
            stop = False
            while total < WRITE_COALESCE_BYTES:
                try:
                    nxt = self._write_q.get_nowait()
                except queue.Empty:
                    break
                if nxt is None:
                    stop = True
                    break
                parts.append(nxt)
                total += len(nxt)
            if self._input_closed.is_set():
                return
            if not self._do_write(b"".join(parts)):
                self._input_closed.set()
                return
            if stop:
                return

    def _stop_writer(self) -> None:
        # The flag, not the token, is what stops the writer: a full queue has
        # no room for None, but the writer checks the flag on the next item it
        # takes, and write() adds nothing once the flag is set. The old
        # "drop one item, then enqueue None" dance could lose that race to a
        # concurrent write() and leave the writer running for good.
        self._input_closed.set()
        try:
            self._write_q.put_nowait(None)
        except queue.Full:
            pass

    def _post(self, cb: Callable[[Any], None], arg: Any) -> None:
        try:
            self._loop.call_soon_threadsafe(cb, arg)
        except RuntimeError:
            pass  # loop already closed
