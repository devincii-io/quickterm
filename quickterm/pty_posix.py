"""One POSIX pty: fork/exec, reader thread -> loop callbacks, write, resize, kill.

Mirrors the PtySession interface of pty_session.py (the ConPTY backend) so
SessionManager can use either one unchanged. The child runs in its own
session/process group (pty.fork calls setsid), so kill() can reap the whole
tree with killpg.
"""

from __future__ import annotations

import asyncio
import fcntl
import os
import pty
import shutil
import signal
import struct
import termios
import threading
from typing import Callable

_READ_CHUNK = 65536


class PtySession:
    def __init__(
        self,
        cmd: str,
        args: list[str],
        cwd: str | None,
        env: dict[str, str],
        cols: int,
        rows: int,
        loop: asyncio.AbstractEventLoop,
        on_output: Callable[[bytes], None],
        on_exit: Callable[[int], None],
    ) -> None:
        self._loop = loop
        self._on_output = on_output
        self._on_exit = on_exit
        self._exit_code: int | None = None
        self._dead = threading.Event()

        merged = dict(os.environ)
        merged.update(env or {})
        merged.setdefault("TERM", "xterm-256color")
        exe = shutil.which(cmd, path=merged.get("PATH", os.defpath))
        if exe is None:
            raise FileNotFoundError(f"command not found: {cmd}")
        workdir = cwd or os.getcwd()

        pid, fd = pty.fork()
        if pid == 0:  # child: never returns
            try:
                os.chdir(workdir)
            except OSError:
                pass
            try:
                os.execve(exe, [exe, *args], merged)
            except OSError:
                os._exit(127)
        self._pid = pid
        self._fd = fd
        self.resize(cols, rows)

        self._reader = threading.Thread(
            target=self._read_loop, name=f"pty-reader-{pid}", daemon=True
        )
        self._reader.start()

    def write(self, data: bytes) -> None:
        if not self._dead.is_set():
            try:
                os.write(self._fd, data)
            except OSError:
                pass

    def resize(self, cols: int, rows: int) -> None:
        try:
            fcntl.ioctl(self._fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        except OSError:
            pass  # dead pty

    @property
    def alive(self) -> bool:
        return not self._dead.is_set()

    @property
    def exit_code(self) -> int | None:
        return self._exit_code

    @property
    def pid(self) -> int:
        return self._pid

    def kill(self) -> None:
        if self._dead.is_set():
            return
        try:
            os.killpg(self._pid, signal.SIGKILL)  # child is its own group leader
        except (OSError, ProcessLookupError):
            try:
                os.kill(self._pid, signal.SIGKILL)
            except (OSError, ProcessLookupError):
                pass
        # reader sees EOF/EIO and finishes exit handling

    def _read_loop(self) -> None:
        while True:
            try:
                chunk = os.read(self._fd, _READ_CHUNK)
            except OSError:  # EIO when the child side closes
                break
            if not chunk:
                break
            self._post(self._on_output, chunk)
        try:
            _, status = os.waitpid(self._pid, 0)
            if os.WIFEXITED(status):
                self._exit_code = os.WEXITSTATUS(status)
            elif os.WIFSIGNALED(status):
                self._exit_code = 128 + os.WTERMSIG(status)
        except ChildProcessError:
            pass
        if self._exit_code is None:
            self._exit_code = 1
        self._dead.set()
        try:
            os.close(self._fd)
        except OSError:
            pass
        self._post(self._on_exit, self._exit_code)

    def _post(self, cb: Callable, arg) -> None:
        try:
            self._loop.call_soon_threadsafe(cb, arg)
        except RuntimeError:
            pass  # loop already closed
