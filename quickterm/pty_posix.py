"""One POSIX pty: fork/exec, reader, writer and watcher threads, resize, session kill.

Mirrors the PtySession interface of pty_session.py (the ConPTY backend) so
SessionManager can use either one unchanged. pty.fork calls setsid, so the
child leads its own session, and kill() takes down every process group in it.

Who owns what:

- The reader waits on the master and a wake pipe, drains everything already
  available (up to READ_COALESCE_BYTES) and posts it as one callback. Posting
  every read(2) on its own flooded the viewers' fan-out queues under any fast
  output.
- The writer (pty_base) writes without blocking and holds the fd lock for one
  write(2) at a time. A child that stops reading its input therefore can never
  freeze resize() on the event loop or keep the exit from being reported.
- The watcher owns reaping. Exit is the child's exit, not EOF on the master: a
  background job that inherited the terminal keeps the slave open long after
  the shell is gone. After a short drain it wakes the reader, waits for reader
  and writer, closes the master (the only place that does, so a recycled
  descriptor number is never read, written or resized) and posts on_exit once,
  after the final output.
"""

from __future__ import annotations

import asyncio
import fcntl
import logging
import os
import pty
import select
import shutil
import signal
import struct
import sys
import termios
import threading
import time
from typing import Callable

from . import process_usage
from .pty_base import (
    DRAIN_IDLE_S,
    DRAIN_MAX_S,
    READ_COALESCE_BYTES,
    PtyBase,
    merge_environment,
    path_value,
)

log = logging.getLogger(__name__)

_KILL_VERIFY_S = 2.0
# How long a writer facing a full input buffer waits for room before it
# rechecks whether the session has ended or been killed.
_WRITE_WAIT_S = 0.1
_WRITER_JOIN_S = 1.0
# pty.fork returns an inheritable master, and a fork in another thread between
# pty.fork and set_inheritable would hand this master to that child. Spawns run
# in worker threads (SessionManager.spawn_async), so the two steps are atomic
# with respect to each other.
_FORK_LOCK = threading.Lock()
# poll() has no FD_SETSIZE ceiling, which a backend with many terminals can
# reach, but macOS poll() does not support character devices such as a pty.
_USE_POLL = hasattr(select, "poll") and sys.platform != "darwin"


def _wait(read_fds: tuple[int, ...], write_fds: tuple[int, ...], timeout: float | None) -> set[int]:
    """The descriptors that are ready (hangup and error count as ready)."""
    if _USE_POLL:
        poller = select.poll()
        for fd in read_fds:
            poller.register(fd, select.POLLIN)
        for fd in write_fds:
            poller.register(fd, select.POLLOUT)
        ms = None if timeout is None else int(timeout * 1000)
        return {fd for fd, _events in poller.poll(ms)}
    readable, writable, _ = select.select(read_fds, write_fds, [], timeout)
    return set(readable) | set(writable)


class PtySession(PtyBase):
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
        super().__init__(loop, on_output, on_exit)
        self._exit_code: int | None = None
        # Set by the watcher once it has reaped the child: the process is gone
        # even while trailing output is still being drained.
        self._proc_dead = threading.Event()
        self._last_read = time.monotonic()

        merged = merge_environment(env)
        exe = shutil.which(cmd, path=path_value(merged))
        if exe is None:
            raise FileNotFoundError(f"command not found: {cmd}")
        workdir = cwd or os.getcwd()

        # Created before the fork so a failure leaves no orphaned child.
        # os.pipe descriptors are non-inheritable.
        self._wake_r, self._wake_w = os.pipe()
        try:
            with _FORK_LOCK:
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
                os.set_inheritable(fd, False)
        except BaseException:
            os.close(self._wake_r)
            os.close(self._wake_w)
            raise
        fcntl.fcntl(fd, fcntl.F_SETFL, fcntl.fcntl(fd, fcntl.F_GETFL) | os.O_NONBLOCK)
        self._pid = pid
        self._fd = fd
        # Serializes every use of _fd against the watcher closing it. It is
        # only ever held for one non-blocking call.
        self._fd_lock = threading.Lock()
        self.resize(cols, rows)

        self._reader = threading.Thread(
            target=self._read_loop, name=f"pty-reader-{pid}", daemon=True
        )
        self._watcher = threading.Thread(
            target=self._watch_exit, name=f"pty-watch-{pid}", daemon=True
        )
        self._reader.start()
        self._start_writer(f"pty-writer-{pid}")
        self._watcher.start()

    def _do_write(self, data: bytes) -> bool:
        view = memoryview(data)
        while view:
            if self._proc_dead.is_set() or self._input_closed.is_set():
                return False
            with self._fd_lock:
                fd = self._fd
                if fd < 0:
                    return False
                try:
                    written = os.write(fd, view)
                except BlockingIOError:
                    written = 0
                except OSError:
                    return False
            if written:
                view = view[written:]
                continue
            # The child's input buffer is full. Wait for room without the
            # lock, so resize() and the watcher never queue behind a child
            # that stopped reading. Polling a number the watcher has closed
            # meanwhile is harmless: the next write takes the lock and sees -1.
            try:
                _wait((), (fd,), _WRITE_WAIT_S)
            except (OSError, ValueError):
                return False
        return True

    def resize(self, cols: int, rows: int) -> None:
        # The lock is never held across a call that can block, so this returns
        # at once even while the writer waits on a child that does not read.
        with self._fd_lock:
            if self._fd < 0:
                return  # closed; the number may already belong to someone else
            try:
                fcntl.ioctl(self._fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            except OSError:
                pass  # dead pty

    @property
    def alive(self) -> bool:
        return not self._proc_dead.is_set()

    @property
    def exit_code(self) -> int | None:
        return self._exit_code

    @property
    def pid(self) -> int:
        return self._pid

    def kill(self) -> bool:
        """Kill every process in the child's session and verify it.

        Interactive shells put each job in its own process group, so killing
        only the leader's group left background jobs and HUP-ignoring
        foreground jobs running with the terminal open; the leader then stayed
        an unreaped zombie and every retry failed the same way. Verified means
        the watcher reaped the leader and no process of the session is left
        that has not exited. EPERM is not treated as success: the process it
        protects is still found by the scan, and kill() returns False.
        """
        if self._proc_dead.is_set():
            self._stop_writer()
            return True
        deadline = time.monotonic() + _KILL_VERIFY_S
        denied = False
        while True:
            # None: no /proc (macOS, BSD). Then the leader's group is all that
            # can be reached, and the reaped leader is the whole verification.
            members = process_usage.session_process_groups(self._pid)
            if self._proc_dead.is_set() and not members:
                self._stop_writer()
                return True
            if time.monotonic() >= deadline:
                log.warning(
                    "session %s could not be stopped (%s)",
                    self._pid,
                    "permission denied" if denied else f"survivors: {sorted(members or ())}",
                )
                return False
            groups = set(members.values()) if members else set()
            if not self._proc_dead.is_set():
                groups.add(self._pid)
            for group in groups:
                try:
                    os.killpg(group, signal.SIGKILL)
                except ProcessLookupError:
                    pass  # the group emptied since the scan
                except PermissionError:
                    denied = True
            if self._proc_dead.is_set():
                time.sleep(0.02)  # the rest of the session is still dying
            else:
                self._proc_dead.wait(0.02)

    def _read_loop(self) -> None:
        fd, wake = self._fd, self._wake_r
        while True:
            try:
                ready = _wait((fd, wake), (), None)
            except (OSError, ValueError):
                break
            data, eof = self._drain(fd)
            if data:
                self._last_read = time.monotonic()
                self._post(self._on_output, data)
            if eof or wake in ready:
                break

    def _drain(self, fd: int) -> tuple[bytes, bool]:
        """Everything already readable, up to READ_COALESCE_BYTES, and whether EOF."""
        parts: list[bytes] = []
        total = 0
        eof = False
        while total < READ_COALESCE_BYTES:
            try:
                chunk = os.read(fd, READ_COALESCE_BYTES - total)
            except BlockingIOError:
                break
            except OSError:  # EIO: every holder of the slave has closed it
                eof = True
                break
            if not chunk:
                eof = True
                break
            parts.append(chunk)
            total += len(chunk)
        return b"".join(parts), eof

    def _watch_exit(self) -> None:
        code: int | None = None
        try:
            _pid, status = os.waitpid(self._pid, 0)
            if os.WIFEXITED(status):
                code = os.WEXITSTATUS(status)
            elif os.WIFSIGNALED(status):
                code = 128 + os.WTERMSIG(status)
        except ChildProcessError:
            pass  # reaped elsewhere; the status is lost
        self._exit_code = code if code is not None else 1
        self._proc_dead.set()

        # Let output still in flight arrive before the reader is stopped. A
        # reader that already saw EOF needs no grace at all.
        deadline = time.monotonic() + DRAIN_MAX_S
        while (
            self._reader.is_alive()
            and time.monotonic() < deadline
            and time.monotonic() - self._last_read < DRAIN_IDLE_S
        ):
            time.sleep(0.03)
        try:
            os.write(self._wake_w, b"\0")
        except OSError:
            pass
        self._reader.join()
        self._stop_writer()
        if self._writer is not None:
            # The writer rechecks the dead flag every _WRITE_WAIT_S, so this
            # returns promptly. Were it ever late, the lock and the cleared
            # number below would still keep it off the closed descriptor.
            self._writer.join(timeout=_WRITER_JOIN_S)

        with self._fd_lock:
            fd, self._fd = self._fd, -1
        for descriptor in (fd, self._wake_r, self._wake_w):
            try:
                os.close(descriptor)
            except OSError:
                pass
        # Closing the master hangs up whatever still holds the slave.
        self._post(self._on_exit, self._exit_code)
