"""Windows parts of the update hand-over: locked files and the Setup chain.

The installer and the hand-over script live in the user's %TEMP%, which the
user's own programs can write. Between the hash check and the moment Setup
runs, something could swap either file. ``open_locked`` opens a file for
reading with FILE_SHARE_READ only: while that handle is open nobody can write,
rename or delete the file, but cmd.exe can still read the script and the
loader can still map Setup.exe, since both only ask for read access. The
updater hashes through that handle and keeps it until Setup has finished.

``launch`` starts the hand-over script through ``cmd /c start`` so it has no
live ancestor (see update.py), then finds the script's process among the
intermediary's children and keeps a handle on it, so the updater learns when
Setup is over without being Setup's parent.
"""

from __future__ import annotations

import contextlib
import os
import subprocess
import threading
from pathlib import Path

if os.name == "nt":
    import ctypes
    import msvcrt
    from ctypes import wintypes

    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _k32.CreateFileW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    ]
    _k32.CreateFileW.restype = wintypes.HANDLE
    _k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    _k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    _k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _k32.OpenProcess.restype = wintypes.HANDLE
    _k32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    _k32.WaitForSingleObject.restype = wintypes.DWORD
    _k32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    _k32.GetExitCodeProcess.restype = wintypes.BOOL
    _k32.CloseHandle.argtypes = [wintypes.HANDLE]
    _k32.CloseHandle.restype = wintypes.BOOL

    class _ProcessEntry(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * 260),
        ]

    _k32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ProcessEntry)]
    _k32.Process32FirstW.restype = wintypes.BOOL
    _k32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ProcessEntry)]
    _k32.Process32NextW.restype = wintypes.BOOL
    _INVALID_HANDLE = ctypes.c_void_p(-1).value

_GENERIC_READ = 0x80000000
_FILE_SHARE_READ = 0x1
_OPEN_EXISTING = 3
_TH32CS_SNAPPROCESS = 0x2
_SYNCHRONIZE = 0x00100000
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_WAIT_OBJECT_0 = 0
_INFINITE = 0xFFFFFFFF


def open_locked(path: Path) -> int:
    """A read-only fd on ``path`` that keeps others from changing the file.

    Elsewhere than Windows a plain read-only fd: the update path is
    Windows-only, and the tests use this to read.
    """
    if os.name != "nt":
        return os.open(path, os.O_RDONLY)
    handle = _k32.CreateFileW(
        str(path), _GENERIC_READ, _FILE_SHARE_READ, None, _OPEN_EXISTING, 0, None
    )
    if handle in (None, _INVALID_HANDLE):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return msvcrt.open_osfhandle(handle, os.O_RDONLY | getattr(os, "O_BINARY", 0))
    except OSError:
        _k32.CloseHandle(handle)
        raise


def read_all(fd: int, chunk: int = 1024 * 1024) -> bytes:
    os.lseek(fd, 0, os.SEEK_SET)
    parts = []
    while data := os.read(fd, chunk):
        parts.append(data)
    return b"".join(parts)


def sha256_fd(fd: int) -> str:
    import hashlib

    os.lseek(fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    while data := os.read(fd, 1024 * 1024):
        digest.update(data)
    return digest.hexdigest()


class Handover:
    """The running hand-over: ``wait(timeout)`` gives its exit code.

    None when the wait timed out or the process could not be found (it
    already ended, or the plain fallback start has no process to watch).
    """

    def __init__(self, handle: int | None = None, fallback_wait: bool = False) -> None:
        self._handle = handle
        self._fallback = fallback_wait
        self._idle = threading.Event()

    def wait(self, timeout: float) -> int | None:
        if self._handle is None:
            if self._fallback:
                # Nothing to watch: wait out the timeout instead.
                self._idle.wait(timeout)
            return None
        ms = _INFINITE if timeout is None else max(0, int(timeout * 1000))
        try:
            if _k32.WaitForSingleObject(self._handle, ms) != _WAIT_OBJECT_0:
                return None
            code = wintypes.DWORD()
            if not _k32.GetExitCodeProcess(self._handle, ctypes.byref(code)):
                return None
            return int(code.value)
        finally:
            self.close()

    def close(self) -> None:
        handle, self._handle = self._handle, None
        if handle is not None:
            _k32.CloseHandle(handle)


def _child_of(parent_pid: int, image: str) -> int | None:
    snapshot = _k32.CreateToolhelp32Snapshot(_TH32CS_SNAPPROCESS, 0)
    if snapshot in (None, _INVALID_HANDLE):
        return None
    try:
        entry = _ProcessEntry()
        entry.dwSize = ctypes.sizeof(_ProcessEntry)
        ok = _k32.Process32FirstW(snapshot, ctypes.byref(entry))
        while ok:
            if entry.th32ParentProcessID == parent_pid and entry.szExeFile.lower() == image:
                return int(entry.th32ProcessID)
            ok = _k32.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        _k32.CloseHandle(snapshot)
    return None


def launch(command: str, flags: int) -> Handover:
    """Run ``cmd /c start ... cmd /c <script>`` and hold the script's process."""
    try:
        outer = subprocess.Popen(command, close_fds=True, creationflags=flags)  # noqa: S603
    except OSError:
        # A job object that forbids breakaway rejects the flag outright.
        flags &= ~getattr(subprocess, "CREATE_BREAKAWAY_FROM_JOB", 0)
        outer = subprocess.Popen(command, close_fds=True, creationflags=flags)  # noqa: S603
    with contextlib.suppress(subprocess.TimeoutExpired):
        # start returns as soon as the script's cmd.exe exists.
        outer.wait(10)
    pid = _child_of(outer.pid, "cmd.exe")
    if pid is None:
        return Handover(None)
    handle = _k32.OpenProcess(_SYNCHRONIZE | _PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    return Handover(handle or None)
