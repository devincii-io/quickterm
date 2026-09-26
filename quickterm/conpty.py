"""The Win32 ConPTY binding: one pseudoconsole and the process attached to it.

Bytes in, bytes out, over two anonymous pipes. pywinpty, which QuickTerm used
before, only exposes str: it decoded each read on its own, so a UTF-8
character split across two reads became U+FFFD, and it dropped NULs. Input
now reaches the console host byte for byte; the host decodes it as UTF-8
itself. Owning the pipes does not make bulk output faster: the console host
is the ceiling (about 6 MB/s for Python's own stdout, 1 MB/s for ``type``)
with either binding.

The pseudoconsole comes from the conpty.dll that the pywinpty wheel ships
beside OpenConsole.exe (1.24 today). That copy is newer than the one in
Windows, and the frontend's reflow settings assume it. Without it the inbox
kernel32 functions are the fallback. The dependency stays only for these two
files; nothing here imports pywinpty.
"""

from __future__ import annotations

import ctypes
import importlib.util
import subprocess
import sys
import threading
from ctypes import wintypes
from pathlib import Path

_k32 = ctypes.WinDLL("kernel32", use_last_error=True)

_ERROR_BROKEN_PIPE = 109
_ERROR_OPERATION_ABORTED = 995
_EXTENDED_STARTUPINFO_PRESENT = 0x00080000
_CREATE_UNICODE_ENVIRONMENT = 0x00000400
_STARTF_USESTDHANDLES = 0x00000100
_PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016
_THREAD_TERMINATE = 0x0001
_READ_BUFFER = 64 * 1024
# The default pipe buffer is a few KiB, and the console host blocks in every
# write that fills it: output then crawled across in 13 KiB callbacks, 20 %
# slower than pywinpty's larger pipes.
_PIPE_BUFFER = 128 * 1024

HPCON = ctypes.c_void_p


class _Coord(ctypes.Structure):
    _fields_ = [("X", wintypes.SHORT), ("Y", wintypes.SHORT)]


class _StartupInfo(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("lpReserved", wintypes.LPWSTR),
        ("lpDesktop", wintypes.LPWSTR),
        ("lpTitle", wintypes.LPWSTR),
        ("dwX", wintypes.DWORD),
        ("dwY", wintypes.DWORD),
        ("dwXSize", wintypes.DWORD),
        ("dwYSize", wintypes.DWORD),
        ("dwXCountChars", wintypes.DWORD),
        ("dwYCountChars", wintypes.DWORD),
        ("dwFillAttribute", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("wShowWindow", wintypes.WORD),
        ("cbReserved2", wintypes.WORD),
        ("lpReserved2", ctypes.c_void_p),
        ("hStdInput", wintypes.HANDLE),
        ("hStdOutput", wintypes.HANDLE),
        ("hStdError", wintypes.HANDLE),
    ]


class _StartupInfoEx(ctypes.Structure):
    _fields_ = [("StartupInfo", _StartupInfo), ("lpAttributeList", ctypes.c_void_p)]


class _ProcessInformation(ctypes.Structure):
    _fields_ = [
        ("hProcess", wintypes.HANDLE),
        ("hThread", wintypes.HANDLE),
        ("dwProcessId", wintypes.DWORD),
        ("dwThreadId", wintypes.DWORD),
    ]


_DWORD_P = ctypes.POINTER(wintypes.DWORD)
_k32.CreatePipe.restype = wintypes.BOOL
_k32.CreatePipe.argtypes = (
    ctypes.POINTER(wintypes.HANDLE), ctypes.POINTER(wintypes.HANDLE), ctypes.c_void_p,
    wintypes.DWORD,
)
_k32.ReadFile.restype = wintypes.BOOL
_k32.ReadFile.argtypes = (
    wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, _DWORD_P, ctypes.c_void_p,
)
_k32.WriteFile.restype = wintypes.BOOL
_k32.WriteFile.argtypes = (
    wintypes.HANDLE, ctypes.c_char_p, wintypes.DWORD, _DWORD_P, ctypes.c_void_p,
)
_k32.PeekNamedPipe.restype = wintypes.BOOL
_k32.PeekNamedPipe.argtypes = (
    wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, _DWORD_P, _DWORD_P, _DWORD_P,
)
_k32.CloseHandle.restype = wintypes.BOOL
_k32.CloseHandle.argtypes = (wintypes.HANDLE,)
_k32.InitializeProcThreadAttributeList.restype = wintypes.BOOL
_k32.InitializeProcThreadAttributeList.argtypes = (
    ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.c_size_t),
)
_k32.UpdateProcThreadAttribute.restype = wintypes.BOOL
_k32.UpdateProcThreadAttribute.argtypes = (
    ctypes.c_void_p, wintypes.DWORD, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t,
    ctypes.c_void_p, ctypes.c_void_p,
)
_k32.DeleteProcThreadAttributeList.restype = None
_k32.DeleteProcThreadAttributeList.argtypes = (ctypes.c_void_p,)
_k32.CreateProcessW.restype = wintypes.BOOL
_k32.CreateProcessW.argtypes = (
    wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, wintypes.BOOL,
    wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR, ctypes.c_void_p,
    ctypes.POINTER(_ProcessInformation),
)
_k32.OpenThread.restype = wintypes.HANDLE
_k32.OpenThread.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
_k32.CancelSynchronousIo.restype = wintypes.BOOL
_k32.CancelSynchronousIo.argtypes = (wintypes.HANDLE,)


class _Api:
    """The pseudoconsole functions of one DLL; ``release`` is None for the inbox one."""

    def __init__(self, dll: ctypes.WinDLL, prefix: str, path: str) -> None:
        self.path = path
        self.create = getattr(dll, prefix + "CreatePseudoConsole")
        self.create.restype = ctypes.c_long
        self.create.argtypes = (
            _Coord, wintypes.HANDLE, wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(HPCON),
        )
        self.resize = getattr(dll, prefix + "ResizePseudoConsole")
        self.resize.restype = ctypes.c_long
        self.resize.argtypes = (HPCON, _Coord)
        self.close = getattr(dll, prefix + "ClosePseudoConsole")
        self.close.restype = None
        self.close.argtypes = (HPCON,)
        self.release = getattr(dll, "ConptyReleasePseudoConsole", None) if prefix else None
        if self.release is not None:
            self.release.restype = ctypes.c_long
            self.release.argtypes = (HPCON,)


_API: _Api | None = None
_API_LOCK = threading.Lock()


def _bundled_dll() -> Path | None:
    """The conpty.dll shipped with pywinpty: in the frozen app's ``conpty``
    folder, else in the installed pywinpty package (found without importing it)."""
    if getattr(sys, "frozen", False):
        candidate = Path(getattr(sys, "_MEIPASS", "")) / "conpty" / "conpty.dll"
        return candidate if candidate.is_file() else None
    spec = importlib.util.find_spec("winpty")
    for folder in (spec.submodule_search_locations or []) if spec else []:
        candidate = Path(folder) / "conpty.dll"
        if candidate.is_file():
            return candidate
    return None


def api() -> _Api:
    global _API
    with _API_LOCK:
        if _API is None:
            path = _bundled_dll()
            # OpenConsole.exe must sit beside conpty.dll, which starts it from
            # its own folder; without it every terminal dies at once.
            if path is not None and (path.parent / "OpenConsole.exe").is_file():
                _API = _Api(ctypes.WinDLL(str(path)), "Conpty", str(path))
            else:
                _API = _Api(_k32, "", "kernel32")
        return _API


def _pipe(size: int) -> tuple[wintypes.HANDLE, wintypes.HANDLE]:
    read, write = wintypes.HANDLE(), wintypes.HANDLE()
    if not _k32.CreatePipe(ctypes.byref(read), ctypes.byref(write), None, size):
        raise ctypes.WinError(ctypes.get_last_error())
    return read, write


def _close(handle: wintypes.HANDLE | int | None) -> None:
    if handle:
        _k32.CloseHandle(handle)


class PseudoConsole:
    """One pseudoconsole with its process. Raises OSError when either cannot start.

    ``read`` belongs to one reader thread and ``write`` to one writer thread.
    ``close`` ends the console host, which ends a blocked ``read`` with EOF.
    """

    def __init__(self, cmdline: str, cwd: str, env_block: str, cols: int, rows: int) -> None:
        self._api = api()
        self._hpc = HPCON()
        self._closed = False
        self._close_lock = threading.Lock()
        self._reader_tid: int | None = None
        self._buffer = ctypes.create_string_buffer(_READ_BUFFER)
        in_read, self._in = _pipe(_PIPE_BUFFER)
        try:
            self._out, out_write = _pipe(_PIPE_BUFFER)
        except OSError:
            _close(in_read)
            _close(self._in)
            raise
        try:
            hr = self._api.create(
                _Coord(cols, rows), in_read, out_write, 0, ctypes.byref(self._hpc)
            )
        finally:
            # The console host holds its own duplicates of these two.
            _close(in_read)
            _close(out_write)
        if hr != 0:
            _close(self._in)
            _close(self._out)
            raise OSError(f"could not create a pseudoconsole (HRESULT {hr & 0xFFFFFFFF:#010x})")
        try:
            self.process, self.pid = self._spawn(cmdline, cwd, env_block)
        except OSError:
            self.close()
            _close(self._in)
            _close(self._out)
            raise
        if self._api.release is not None:
            # From here the host ends by itself once its last client is gone,
            # after writing out everything, so the reader sees a real EOF
            # instead of waiting for a quiet period.
            self._api.release(self._hpc)

    def _spawn(self, cmdline: str, cwd: str, env_block: str) -> tuple[int, int]:
        size = ctypes.c_size_t()
        _k32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
        attributes = ctypes.create_string_buffer(size.value)
        if not _k32.InitializeProcThreadAttributeList(attributes, 1, 0, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            if not _k32.UpdateProcThreadAttribute(
                attributes, 0, _PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, self._hpc,
                ctypes.sizeof(HPCON), None, None,
            ):
                raise ctypes.WinError(ctypes.get_last_error())
            startup = _StartupInfoEx()
            startup.StartupInfo.cb = ctypes.sizeof(_StartupInfoEx)
            # Null standard handles on purpose: without this flag a child
            # inherits QuickTerm's own redirected stdout (a log pipe, a test
            # runner) and writes there instead of into the terminal.
            startup.StartupInfo.dwFlags = _STARTF_USESTDHANDLES
            startup.lpAttributeList = ctypes.cast(attributes, ctypes.c_void_p)
            info = _ProcessInformation()
            command = ctypes.create_unicode_buffer(cmdline)
            environment = ctypes.create_unicode_buffer(env_block)
            if not _k32.CreateProcessW(
                None, command, None, None, False,
                _EXTENDED_STARTUPINFO_PRESENT | _CREATE_UNICODE_ENVIRONMENT,
                environment, cwd, ctypes.byref(startup), ctypes.byref(info),
            ):
                raise ctypes.WinError(ctypes.get_last_error())
        finally:
            _k32.DeleteProcThreadAttributeList(attributes)
        _close(info.hThread)
        return info.hProcess, int(info.dwProcessId)

    def read(self, limit: int) -> bytes:
        """Block for output, then take what is already waiting, up to ``limit``.

        b"" means the output has ended: the host exited, or ``close`` gave up
        waiting for it and cancelled the read.
        """
        self._reader_tid = threading.get_native_id()
        buffer = self._buffer
        count = wintypes.DWORD()
        if not _k32.ReadFile(self._out, buffer, _READ_BUFFER, ctypes.byref(count), None):
            return b""
        parts = [ctypes.string_at(buffer, count.value)]
        total = count.value
        waiting = wintypes.DWORD()
        while total < limit:
            if not _k32.PeekNamedPipe(self._out, None, 0, None, ctypes.byref(waiting), None):
                break
            if not waiting.value:
                break
            want = min(waiting.value, limit - total, _READ_BUFFER)
            if not _k32.ReadFile(self._out, buffer, want, ctypes.byref(count), None):
                break
            parts.append(ctypes.string_at(buffer, count.value))
            total += count.value
        return parts[0] if len(parts) == 1 else b"".join(parts)

    def write(self, data: bytes) -> bool:
        """Write all of ``data``; False once the host no longer reads input."""
        view = memoryview(data)
        written = wintypes.DWORD()
        while view:
            if not _k32.WriteFile(self._in, bytes(view), len(view), ctypes.byref(written), None):
                return False
            view = view[written.value :]
        return True

    def resize(self, cols: int, rows: int) -> None:
        with self._close_lock:
            if not self._closed:
                self._api.resize(self._hpc, _Coord(cols, rows))

    def close(self) -> None:
        """End the console host. The reader then reads EOF."""
        with self._close_lock:
            if self._closed:
                return
            self._closed = True
        self._api.close(self._hpc)

    def cancel_read(self) -> None:
        """Unblock the reader when the host is gone but its read never returned."""
        tid = self._reader_tid
        if tid is None:
            return
        thread = _k32.OpenThread(_THREAD_TERMINATE, False, tid)
        if thread:
            _k32.CancelSynchronousIo(thread)
            _k32.CloseHandle(thread)

    def release_pipes(self) -> None:
        """Close both pipe ends; only once the reader and the writer are done."""
        _close(self._in)
        _close(self._out)
        self._in, self._out = wintypes.HANDLE(), wintypes.HANDLE()


def command_line(executable: str, args: list[str]) -> str:
    """The CreateProcess command line: the program, then its arguments."""
    line = subprocess.list2cmdline([executable])
    return f"{line} {subprocess.list2cmdline(args)}" if args else line


def env_block(env: dict[str, str]) -> str:
    """A CreateProcess environment, sorted case-insensitively as documented.

    The buffer adds the final NUL that ends the block.
    """
    pairs = sorted(env.items(), key=lambda kv: kv[0].upper())
    return "".join(f"{k}={v}\0" for k, v in pairs) or "\0"
