"""One ConPTY: spawn, reader thread -> loop callbacks, write, resize, tree kill.

Bytes path: low-level winpty.PTY only exposes str reads (decoded from ConPTY's
UTF-8 stream), so we re-encode to UTF-8 — a lossless round-trip here.

Exit detection: winpty's blocking read reports EOF ~8s late and isalive() lags
~3s, so a watcher thread waits on the real process handle, then unblocks the
reader via cancel_io() once trailing output has drained.
"""

from __future__ import annotations

import asyncio
import ctypes
import os
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

_k32 = ctypes.WinDLL("kernel32", use_last_error=True)


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

        self._reader = threading.Thread(
            target=self._read_loop, name=f"pty-reader-{self._pid}", daemon=True
        )
        self._watcher = threading.Thread(
            target=self._watch_exit, name=f"pty-watch-{self._pid}", daemon=True
        )
        self._reader.start()
        self._watcher.start()

    def write(self, data: bytes) -> None:
        # winpty write() takes str; input is UTF-8 keyboard bytes
        self._pty.write(data.decode("utf-8", errors="replace"))

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
                self._post(self._on_output, chunk.encode("utf-8"))
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
        self._post(self._on_exit, self._exit_code)

    def _post(self, cb: Callable, arg) -> None:
        try:
            self._loop.call_soon_threadsafe(cb, arg)
        except RuntimeError:
            pass  # loop already closed
