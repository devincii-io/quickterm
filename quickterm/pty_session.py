"""One ConPTY: spawn, reader thread -> loop callbacks, write, resize, tree kill.

Bytes path: low-level winpty.PTY only exposes str reads (decoded from ConPTY's
UTF-8 stream), so we re-encode to UTF-8 — a lossless round-trip here.

Throughput: the reader coalesces every chunk immediately available into a single
callback (one thread-hop / ring edit / WS frame per burst instead of per read),
and writes go through a dedicated writer thread so a full stdin pipe (a big
paste, a slow consumer) can never block the asyncio loop.

Exit detection: winpty's blocking read reports EOF ~8s late and isalive() lags
~3s, so a watcher thread waits on the real process handle, then unblocks the
reader via cancel_io() once trailing output has drained.
"""

from __future__ import annotations

import asyncio
import ctypes
import logging
import os
import queue
import shutil
import subprocess
import threading
import time
from ctypes import wintypes
from typing import Callable

import winpty

_CREATE_NO_WINDOW = 0x08000000
_SYNCHRONIZE = 0x00100000
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_INFINITE = 0xFFFFFFFF
_DRAIN_IDLE_S = 0.15
_DRAIN_MAX_S = 1.0
_EXIT_WAIT_S = 10.0
# Upper bound on how much immediately-available output one read callback carries.
# Bounded so a huge burst still yields to the loop (keeps input responsive).
_READ_COALESCE_BYTES = 128 * 1024

log = logging.getLogger("quickterm.pty")
# Opt-in raw-I/O tracing to pin down "wrong key" reports: logs the exact bytes
# entering the PTY and the size of each output burst. Off unless the env var set.
_DEBUG_IO = bool(os.environ.get("QUICKTERM_DEBUG_IO"))

_k32 = ctypes.WinDLL("kernel32", use_last_error=True)

_TH32CS_SNAPPROCESS = 0x00000002
_k32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
_k32.CreateToolhelp32Snapshot.argtypes = (wintypes.DWORD, wintypes.DWORD)
_INVALID_HANDLE = ctypes.c_void_p(-1).value


class _PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t),  # ULONG_PTR
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", ctypes.c_wchar * 260),
    ]


def pids_with_children() -> set[int]:
    """PIDs that have at least one direct child right now (one snapshot).

    Lets the UI treat a shell as "busy" when something is running inside it
    (ssh, a build, an editor). Limitation: processes inside a WSL VM are
    invisible here, so an idle-looking WSL shell may still be doing work.
    """
    snap = _k32.CreateToolhelp32Snapshot(_TH32CS_SNAPPROCESS, 0)
    if not snap or snap == _INVALID_HANDLE:
        return set()
    parents: set[int] = set()
    try:
        entry = _PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(_PROCESSENTRY32W)
        entry_ref = ctypes.byref(entry)
        if _k32.Process32FirstW(ctypes.c_void_p(snap), entry_ref):
            while True:
                if entry.th32ParentProcessID:
                    parents.add(int(entry.th32ParentProcessID))
                if not _k32.Process32NextW(ctypes.c_void_p(snap), entry_ref):
                    break
    finally:
        _k32.CloseHandle(ctypes.c_void_p(snap))
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
        self._proc_exit_code: int | None = None
        self._proc_dead = threading.Event()
        self._exited = threading.Event()
        self._last_read = time.monotonic()

        merged = dict(os.environ)
        merged.update(env or {})
        exe = shutil.which(cmd, path=merged.get("PATH", os.defpath))
        if exe is None:
            raise FileNotFoundError(f"command not found: {cmd}")
        env_block = "\0".join(f"{k}={v}" for k, v in merged.items()) + "\0"

        self._pty = winpty.PTY(cols, rows)
        cmdline = " " + subprocess.list2cmdline(args) if args else None
        self._pty.spawn(exe, cmdline=cmdline, cwd=cwd or os.getcwd(), env=env_block)
        self._pid: int = self._pty.pid or 0
        self._hproc = _k32.OpenProcess(
            _SYNCHRONIZE | _PROCESS_QUERY_LIMITED_INFORMATION, False, self._pid
        )

        # Writes are handed to a dedicated thread so a blocking winpty.write
        # (stdin pipe full) never stalls the event loop. None is the stop token.
        self._write_q: queue.Queue[bytes | None] = queue.Queue()
        self._reader = threading.Thread(
            target=self._read_loop, name=f"pty-reader-{self._pid}", daemon=True
        )
        self._watcher = threading.Thread(
            target=self._watch_exit, name=f"pty-watch-{self._pid}", daemon=True
        )
        self._writer = threading.Thread(
            target=self._write_loop, name=f"pty-writer-{self._pid}", daemon=True
        )
        self._reader.start()
        self._watcher.start()
        self._writer.start()

    def write(self, data: bytes) -> None:
        # Enqueue only — the writer thread does the (possibly blocking) PTY write.
        self._write_q.put(data)

    def _write_loop(self) -> None:
        while True:
            item = self._write_q.get()
            if item is None:
                return
            parts = [item]
            # Coalesce keystrokes/paste chunks that piled up into one PTY write.
            try:
                while True:
                    nxt = self._write_q.get_nowait()
                    if nxt is None:
                        self._do_write(b"".join(parts))
                        return
                    parts.append(nxt)
            except queue.Empty:
                pass
            self._do_write(b"".join(parts))

    def _do_write(self, data: bytes) -> None:
        if _DEBUG_IO:
            log.info("pty %s <- in %r", self._pid, data)
        # winpty.write takes str. Valid UTF-8 (all normal keyboard input) is
        # lossless via strict decode; rare 8-bit input (onBinary) survives as
        # surrogates instead of being mangled to U+FFFD by errors="replace".
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            text = data.decode("utf-8", errors="surrogateescape")
        try:
            self._pty.write(text)
        except Exception:
            try:
                self._pty.write(data.decode("utf-8", errors="replace"))
            except Exception:
                pass  # dead pty / unencodable: drop this write

    def _stop_writer(self) -> None:
        try:
            self._write_q.put_nowait(None)
        except Exception:
            pass

    def resize(self, cols: int, rows: int) -> None:
        try:
            self._pty.set_size(cols, rows)
        except winpty.WinptyError:
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

    def kill(self) -> None:
        if self._pid and not self._proc_dead.is_set():
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(self._pid)],
                capture_output=True,
                creationflags=_CREATE_NO_WINDOW,
            )
        self._stop_writer()
        # watcher notices death, drains, then cancel_io() closes out the reader

    def _watch_exit(self) -> None:
        if self._hproc:
            _k32.WaitForSingleObject(self._hproc, _INFINITE)
            code = wintypes.DWORD()
            if _k32.GetExitCodeProcess(self._hproc, ctypes.byref(code)):
                self._proc_exit_code = int(code.value)
            _k32.CloseHandle(self._hproc)
        else:  # no handle: fall back to polling winpty
            while True:
                try:
                    if not self._pty.isalive():
                        break
                except winpty.WinptyError:
                    break
                time.sleep(0.05)
        self._proc_dead.set()
        # let the reader drain trailing output before breaking its blocking read
        deadline = time.monotonic() + _DRAIN_MAX_S
        while (
            time.monotonic() < deadline
            and time.monotonic() - self._last_read < _DRAIN_IDLE_S
        ):
            time.sleep(0.03)
        try:
            self._pty.cancel_io()
        except winpty.WinptyError:
            pass

    def _read_loop(self) -> None:
        pty = self._pty
        while True:
            try:
                chunk = pty.read(blocking=True)  # raises WinptyError on EOF/cancel
            except Exception:
                break
            if chunk:
                self._last_read = time.monotonic()
                # Drain everything already buffered into one callback so a burst
                # is one thread-hop / ring edit / WS frame, not one per read.
                first = chunk.encode("utf-8")
                parts = [first]
                total = len(first)
                while total < _READ_COALESCE_BYTES:
                    try:
                        more = pty.read(blocking=False)  # "" when nothing ready
                    except Exception:
                        break
                    if not more:
                        break
                    encoded = more.encode("utf-8")
                    parts.append(encoded)
                    total += len(encoded)
                data = b"".join(parts)
                if _DEBUG_IO:
                    log.info("pty %s -> out %d bytes", self._pid, len(data))
                self._post(self._on_output, data)
            try:
                if pty.iseof():
                    break
            except Exception:
                break
        self._proc_dead.wait(timeout=_EXIT_WAIT_S)
        code = self._proc_exit_code
        if code is None:
            try:
                code = pty.get_exitstatus()
            except Exception:
                code = None
        self._exit_code = code if code is not None else 1
        self._exited.set()
        self._stop_writer()  # release the writer thread on natural exit
        self._post(self._on_exit, self._exit_code)

    def _post(self, cb: Callable, arg) -> None:
        try:
            self._loop.call_soon_threadsafe(cb, arg)
        except RuntimeError:
            pass  # loop already closed
