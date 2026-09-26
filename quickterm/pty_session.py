"""One ConPTY: spawn, reader thread -> loop callbacks, write, resize, tree kill.

Bytes path: the pipes are QuickTerm's own (conpty.py), so output and input
pass through untouched. pywinpty's str API used to turn a UTF-8 character
split across two reads into U+FFFD and drop NULs.

Throughput: the reader coalesces every chunk immediately available into a single
callback (one thread-hop / ring edit / WS frame per burst instead of per read),
and writes go through a dedicated writer thread (pty_base) so a full stdin pipe
(a big paste, a slow consumer) can never block the asyncio loop.

Exit detection: a watcher thread waits on the process handle. The console host
ends by itself once its last client is gone, which the reader sees as EOF
after the final output; a background job that inherited the console keeps it
open, so after a short drain the watcher closes the host itself.
"""

from __future__ import annotations

import asyncio
import ctypes
import logging
import os
import shutil
import subprocess
import threading
import time
from ctypes import wintypes
from typing import Callable

from . import conpty, process_usage
from .pty_base import (
    DRAIN_IDLE_S,
    DRAIN_MAX_S,
    READ_COALESCE_BYTES,
    PtyBase,
    merge_environment,
    path_value,
)

_CREATE_NO_WINDOW = 0x08000000
_SYNCHRONIZE = 0x00100000
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_PROCESS_TERMINATE = 0x0001
_INFINITE = 0xFFFFFFFF
_WAIT_OBJECT_0 = 0
_EXIT_WAIT_S = 10.0
# How long a closed console host may take to end the reader's read.
_CLOSE_WAIT_S = 2.0
_KILL_WAIT_S = 2.0
_TERMINATE_WAIT_S = 1.0

# One hidden, process-wide console for the frozen GUI. The pseudoconsole does
# not need it (conpty.dll starts OpenConsole.exe without a window), but the
# console programs QuickTerm itself starts do: ``code`` is code.cmd, and a
# GUI process without a console gives such a child a visible console window
# of its own. With this one they inherit a hidden console instead. It used to
# exist for pywinpty, which allocated and freed a console per PTY and could
# panic on a valid ShowWindow return.
_HOST_CONSOLE_LOCK = threading.Lock()
_HOST_CONSOLE_READY = False
_SW_HIDE = 0


def _ensure_host_console() -> None:
    global _HOST_CONSOLE_READY
    if _HOST_CONSOLE_READY:
        return
    with _HOST_CONSOLE_LOCK:
        if _HOST_CONSOLE_READY:
            return
        get_console_window = ctypes.windll.kernel32.GetConsoleWindow
        get_console_window.restype = wintypes.HWND
        window = get_console_window()
        if not window and ctypes.windll.kernel32.AllocConsole():
            window = get_console_window()
        if window:
            ctypes.windll.user32.ShowWindow(window, _SW_HIDE)
        _HOST_CONSOLE_READY = True


log = logging.getLogger(__name__)
# Opt-in raw-I/O tracing to pin down "wrong key" reports: logs the exact bytes
# entering the PTY and the size of each output burst. Off unless the env var set.
def _debug_io_enabled() -> bool:
    return os.environ.get("QUICKTERM_DEBUG_IO") == "1"


_DEBUG_IO = _debug_io_enabled()

_k32 = ctypes.WinDLL("kernel32", use_last_error=True)

# ctypes defaults function results to 32-bit integers. Declare every HANDLE API
# used here explicitly so process handles are never truncated on 64-bit Windows.
_k32.OpenProcess.restype = wintypes.HANDLE
_k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
_k32.WaitForSingleObject.restype = wintypes.DWORD
_k32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
_k32.GetExitCodeProcess.restype = wintypes.BOOL
_k32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
_k32.TerminateProcess.restype = wintypes.BOOL
_k32.TerminateProcess.argtypes = (wintypes.HANDLE, wintypes.UINT)
_k32.CloseHandle.restype = wintypes.BOOL
_k32.CloseHandle.argtypes = (wintypes.HANDLE,)
_FILETIME_P = ctypes.POINTER(wintypes.FILETIME)
_k32.GetProcessTimes.restype = wintypes.BOOL
_k32.GetProcessTimes.argtypes = (wintypes.HANDLE, _FILETIME_P, _FILETIME_P, _FILETIME_P, _FILETIME_P)
_k32.GetSystemTimeAsFileTime.restype = None
_k32.GetSystemTimeAsFileTime.argtypes = (_FILETIME_P,)


def _system_root() -> str:
    return os.environ.get("SystemRoot") or r"C:\Windows"


def _taskkill_command(pid: int) -> list[str]:
    # By absolute path: a bare "taskkill" is looked up in the application
    # directory and the current directory before System32, and QuickTerm can
    # run with an untrusted folder as its current directory (the Explorer
    # "Open QuickTerm here" verb), possibly elevated.
    exe = os.path.join(_system_root(), "System32", "taskkill.exe")
    return [exe, "/T", "/F", "/PID", str(pid)]


def _open_for_kill(pid: int) -> int | None:
    """A handle that can wait on ``pid`` and, where allowed, terminate it."""
    handle = _k32.OpenProcess(
        _SYNCHRONIZE | _PROCESS_QUERY_LIMITED_INFORMATION | _PROCESS_TERMINATE, False, pid
    )
    if not handle:
        # An elevated child (sudo, gsudo) refuses PROCESS_TERMINATE to a normal
        # QuickTerm but still lets it wait, which is all verification needs.
        handle = _k32.OpenProcess(_SYNCHRONIZE | _PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    return handle or None


def _wait_until(handle: int, deadline: float) -> bool:
    remaining = max(0, int((deadline - time.monotonic()) * 1000))
    return _k32.WaitForSingleObject(handle, remaining) == _WAIT_OBJECT_0


def _is_dead(handle: int) -> bool:
    return _k32.WaitForSingleObject(handle, 0) == _WAIT_OBJECT_0


def _ticks(value: wintypes.FILETIME) -> int:
    return (int(value.dwHighDateTime) << 32) | int(value.dwLowDateTime)


def _now_ticks() -> int:
    now = wintypes.FILETIME()
    _k32.GetSystemTimeAsFileTime(ctypes.byref(now))
    return _ticks(now)


def _created_ticks(handle: int) -> int | None:
    times = [wintypes.FILETIME() for _ in range(4)]
    if not _k32.GetProcessTimes(handle, *(ctypes.byref(t) for t in times)):
        return None
    return _ticks(times[0])


def _open_captured(pid: int, captured_at: int) -> int | None:
    """A kill handle to ``pid``, only if it is the process that existed at ``captured_at``.

    A PID seen in a snapshot can exit and be reused before OpenProcess; the
    newcomer was created after the snapshot, which its creation time shows.
    """
    handle = _open_for_kill(pid)
    if handle is None:
        return None
    created = _created_ticks(handle)
    if created is not None and created > captured_at:
        _k32.CloseHandle(handle)
        return None
    return handle


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
        self._proc_exit_code: int | None = None
        self._proc_dead = threading.Event()
        self._exited = threading.Event()
        self._last_read = time.monotonic()
        self._eof = threading.Event()
        # kill() runs under this lock, and the watcher closes the root handle
        # only under it, so a kill never outlives the handle it relies on.
        self._kill_lock = threading.Lock()
        self._kill_failed = False
        # Survivors of the last failed kill: the handles still held to them,
        # and the PIDs no handle could be opened for (with the capture time).
        self._held: dict[int, int] = {}
        self._unheld: dict[int, int] = {}

        merged = merge_environment(env)
        exe = shutil.which(cmd, path=path_value(merged))
        if exe is None:
            raise FileNotFoundError(f"command not found: {cmd}")
        _ensure_host_console()
        try:
            self._console = conpty.PseudoConsole(
                conpty.command_line(exe, args), cwd or os.getcwd(),
                conpty.env_block(merged), cols, rows,
            )
        except OSError as exc:
            # Every failure to start is an OSError with the command in it, so
            # callers handle one exception type (a missing folder, a blocked
            # executable, ...).
            raise OSError(f"could not start {cmd}: {exc}") from exc
        self._pid: int = self._console.pid
        # The CreateProcess handle, held until the process is dead and no kill
        # can run: while it is open Windows cannot hand the root's PID to
        # another process, so taskkill /PID never reaches a stranger's tree.
        self._hproc: int | None = self._console.process

        self._reader = threading.Thread(
            target=self._read_loop, name=f"pty-reader-{self._pid}", daemon=True
        )
        self._watcher = threading.Thread(
            target=self._watch_exit, name=f"pty-watch-{self._pid}", daemon=True
        )
        self._reader.start()
        self._watcher.start()
        self._start_writer(f"pty-writer-{self._pid}")

    def _do_write(self, data: bytes) -> bool:
        if _DEBUG_IO:
            log.info("pty %s <- in %r", self._pid, data)
        if self._console.write(data):
            return True
        # The console host is gone; the error code tells a dead PTY from
        # anything stranger.
        log.debug("PTY write failed for process %s (error %s)", self._pid, ctypes.get_last_error())
        return False

    def resize(self, cols: int, rows: int) -> None:
        self._console.resize(cols, rows)  # a no-op once the host is closed

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
        """Force the process tree down and verify every captured process died.

        ``taskkill /T`` stays the primary path, but it can fail for part of
        the tree without saying so (an elevated child denies it), and checking
        only the root then reported a verified kill while a descendant ran on.
        So the tree is captured first, with a handle to each member whose
        creation time predates the snapshot: a handle pins its PID, and the
        creation time rules out a PID reused before it was opened. Every
        captured process is verified through its handle, including one whose
        parent died meanwhile and that taskkill /T can no longer reach.
        Survivors get TerminateProcess; any process still running makes this
        False.

        A root that exited on its own before any kill leaves what outlived it
        alone, and kill() returns True. After a failed kill the root is
        usually dead while a descendant runs on, so every later kill()
        terminates the survivors it still holds handles to and returns True
        only once they are gone. The root is pinned by ``_hproc`` and never
        addressed by PID number once it is known to be dead.

        Deliberately not a Job Object: a job would also take down GUI programs
        started from the terminal (``code .``, ``explorer .``) that detach from
        the tree and that taskkill has never touched.
        """
        with self._kill_lock:
            if not self._pid or (self._proc_dead.is_set() and not self._kill_failed):
                self._stop_writer()
                return True
            survivors = self._kill_once()
            if survivors:
                self._kill_failed = True
                log.warning("PTY process %s: kill left %s running", self._pid, survivors)
                return False
            self._kill_failed = False
            self._stop_writer()
            return True

    def _kill_once(self) -> list[int]:
        """One kill attempt under ``_kill_lock``; the PIDs still running afterwards."""
        root = self._pid
        root_handle = self._hproc  # None once the watcher has seen the root exit
        owned, self._held = self._held, {}
        unheld, self._unheld = self._unheld, {}
        # CreateProcess always hands over the root's handle, and the watcher
        # drops it only after the root died.
        root_alive = root_handle is not None and not _is_dead(root_handle)
        survivors: list[int] = []
        try:
            if root_alive:
                identities = process_usage.process_identities()
                captured_at = _now_ticks()
                for pid in process_usage.descendants(identities, root):
                    if pid in owned:
                        continue
                    handle = _open_captured(pid, captured_at)
                    if handle is None:
                        unheld.setdefault(pid, captured_at)
                    else:
                        owned[pid] = handle
                try:
                    subprocess.run(
                        _taskkill_command(root),
                        capture_output=True,
                        creationflags=_CREATE_NO_WINDOW,
                        cwd=_system_root(),
                        timeout=5,
                    )
                except (OSError, subprocess.TimeoutExpired):
                    log.warning("taskkill failed for PTY process %s", root, exc_info=True)
            for pid, captured_at in list(unheld.items()):
                handle = _open_captured(pid, captured_at)
                if handle is not None:
                    del unheld[pid]
                    owned[pid] = handle

            targets = dict(owned)
            if root_alive and root_handle is not None:
                targets[root] = root_handle
            deadline = time.monotonic() + _KILL_WAIT_S
            survivors = [pid for pid, h in targets.items() if not _wait_until(h, deadline)]
            if survivors:
                # Terminating the root also tears down its ConPTY.
                for pid in survivors:
                    _k32.TerminateProcess(targets[pid], 1)
                deadline = time.monotonic() + _TERMINATE_WAIT_S
                survivors = [pid for pid in survivors if not _wait_until(targets[pid], deadline)]
            if unheld:
                # No handle at all: fall back to the process table. A PID that
                # is still listed counts as a survivor; were it reused, the
                # error lands on the safe side.
                listed = {pid for pid, _parent in process_usage.process_identities()}
                self._unheld = {pid: t for pid, t in unheld.items() if pid in listed}
                survivors.extend(self._unheld)
        finally:
            # Handles to survivors are kept for the next attempt; a retry
            # verifies exactly these processes, whatever became of the root.
            for pid, handle in owned.items():
                if pid in survivors:
                    self._held[pid] = handle
                else:
                    _k32.CloseHandle(handle)
        return sorted(set(survivors))

    def _watch_exit(self) -> None:
        hproc = self._hproc
        _k32.WaitForSingleObject(hproc, _INFINITE)
        code = wintypes.DWORD()
        if _k32.GetExitCodeProcess(hproc, ctypes.byref(code)):
            self._proc_exit_code = int(code.value)
        # Before the handle is closed: from here on kill() treats the root as
        # dead and never addresses its PID again.
        self._proc_dead.set()
        # The released console host ends by itself once its last client is
        # gone and its output is written out, which the reader sees as EOF. A
        # background job that inherited the console keeps the host open, so
        # once the output has been quiet for a moment (never longer than
        # DRAIN_MAX_S) the host is closed, and the reader still reads what is
        # left in the pipe before its EOF.
        deadline = time.monotonic() + DRAIN_MAX_S
        if not self._eof.wait(DRAIN_IDLE_S):
            while not self._eof.wait(0.03):
                now = time.monotonic()
                if now >= deadline or now - self._last_read >= DRAIN_IDLE_S:
                    break
        self._console.close()
        if not self._eof.wait(_CLOSE_WAIT_S):
            self._console.cancel_read()
        with self._kill_lock:
            self._hproc = None
            _k32.CloseHandle(hproc)

    def _read_loop(self) -> None:
        console = self._console
        while True:
            # Everything already waiting comes back in one callback, so a
            # burst is one thread hop, ring edit and WS frame, not one per read.
            data = console.read(READ_COALESCE_BYTES)
            if not data:
                break
            self._last_read = time.monotonic()
            if _DEBUG_IO:
                log.info("pty %s -> out %d bytes", self._pid, len(data))
            self._post(self._on_output, data)
        self._eof.set()
        self._proc_dead.wait(timeout=_EXIT_WAIT_S)
        code = self._proc_exit_code
        self._exit_code = code if code is not None else 1
        self._exited.set()
        self._stop_writer()  # release the writer thread on natural exit
        self._post(self._on_exit, self._exit_code)
        # The writer fails its next write now that the host is gone. A writer
        # still stuck in a write keeps its pipe; closing it under the write
        # would be worse than the leak.
        writer = self._writer
        if writer is not None:
            writer.join(timeout=_CLOSE_WAIT_S)
        if writer is None or not writer.is_alive():
            console.release_pipes()
