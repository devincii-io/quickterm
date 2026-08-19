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
import queue
import shutil
import signal
import struct
import termios
import threading
from typing import Callable

_READ_CHUNK = 65536


def pids_with_children() -> set[int]:
    """PIDs that have at least one direct child right now (one /proc scan).

    Mirrors pty_session.pids_with_children so the UI can treat a shell as
    "busy" when something is running inside it. Returns empty on systems
    without /proc.
    """
    parents: set[int] = set()
    try:
        entries = os.listdir("/proc")
    except OSError:
        return parents
    for name in entries:
        if not name.isdigit():
            continue
        try:
            with open(f"/proc/{name}/stat", "rb") as f:
                stat = f.read()
        except OSError:
            continue  # process vanished mid-scan
        # pid (comm) state ppid ...; comm may contain spaces, so split after ')'
        tail = stat[stat.rfind(b")") + 2 :].split()
        if len(tail) >= 2:
            try:
                parents.add(int(tail[1]))
            except ValueError:
                pass
    return parents


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
        # Serializes every use of _fd against _read_loop closing it. A closed
        # descriptor number is immediately recyclable, so an unguarded write or
        # ioctl could land on whatever opened next.
        self._fd_lock = threading.Lock()
        self.resize(cols, rows)

        self._reader = threading.Thread(
            target=self._read_loop, name=f"pty-reader-{pid}", daemon=True
        )
        self._write_q: queue.Queue[bytes | None] = queue.Queue(maxsize=64)
        self._writer = threading.Thread(
            target=self._write_loop, name=f"pty-writer-{pid}", daemon=True
        )
        self._reader.start()
        self._writer.start()

    def write(self, data: bytes) -> None:
        if not self._dead.is_set():
            try:
                self._write_q.put_nowait(data)
            except queue.Full:
                raise BufferError("PTY input queue is full") from None

    def _write_loop(self) -> None:
        while True:
            data = self._write_q.get()
            if data is None:
                return
            view = memoryview(data)
            while view and not self._dead.is_set():
                try:
                    with self._fd_lock:
                        if self._fd < 0:
                            return  # _read_loop closed it; the number is recyclable
                        written = os.write(self._fd, view)
                except OSError:
                    return
                if written <= 0:
                    return
                view = view[written:]

    def _stop_writer(self) -> None:
        try:
            self._write_q.put_nowait(None)
        except queue.Full:
            try:
                self._write_q.get_nowait()
                self._write_q.put_nowait(None)
            except (queue.Empty, queue.Full):
                pass

    def resize(self, cols: int, rows: int) -> None:
        # Read once: _read_loop can close and clear the descriptor concurrently,
        # and the number is recyclable the moment it is closed:
        # resizing a stale fd would resize whatever inherited it.
        try:
            with self._fd_lock:
                if self._fd < 0:
                    return
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

    def kill(self) -> bool:
        if self._dead.is_set():
            return True
        try:
            os.killpg(self._pid, signal.SIGKILL)  # child is its own group leader
        except (OSError, ProcessLookupError):
            try:
                os.kill(self._pid, signal.SIGKILL)
            except ProcessLookupError:
                return True  # already gone
            except OSError:
                pass  # EPERM and friends: verified below
        self._stop_writer()
        # CONTRACTS.md requires kill() to report VERIFIED termination:
        # clients remove only what the backend confirms stopped. Returning True
        # unconditionally swallowed EPERM and made a surviving process
        # disappear from the UI while it kept running. The reader thread does
        # the exit bookkeeping; wait briefly for it, then probe the process.
        # Never waitpid() here: the reader thread owns reaping, and stealing
        # the status from it would lose the real exit code.
        if self._dead.wait(timeout=2.0):
            return True
        try:
            os.kill(self._pid, 0)
        except ProcessLookupError:
            return True  # gone; the reader simply has not finished bookkeeping
        except OSError:
            return False  # exists and we cannot signal it (EPERM)
        return False

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
        self._stop_writer()
        with self._fd_lock:
            fd, self._fd = self._fd, -1
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass
        self._post(self._on_exit, self._exit_code)

    def _post(self, cb: Callable, arg) -> None:
        try:
            self._loop.call_soon_threadsafe(cb, arg)
        except RuntimeError:
            pass  # loop already closed
