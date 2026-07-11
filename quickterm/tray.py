"""Windows system-tray icon via ctypes Shell_NotifyIcon. No third-party deps.

The primary desktop window hides to this tray instead of quitting when closing
would kill live terminals the user typed into (policy in app.py). Left-click or
"Open" re-shows the window; "Quit" exits the app for real. Survives an
explorer.exe restart by re-adding the icon on TaskbarCreated.

All Win32 calls stay on one dedicated thread (message loop), mirroring
hotkeys.py. Callbacks fire on that thread; callers pass thread-safe functions.
"""

from __future__ import annotations

import ctypes
import logging
import sys
import threading
from ctypes import wintypes
from pathlib import Path
from typing import Callable

log = logging.getLogger(__name__)

_WM_DESTROY = 0x0002
_WM_CLOSE = 0x0010
_WM_COMMAND = 0x0111
_WM_LBUTTONUP = 0x0202
_WM_LBUTTONDBLCLK = 0x0203
_WM_RBUTTONUP = 0x0205
_WM_CONTEXTMENU = 0x007B
_WM_TRAY = 0x8001  # WM_APP + 1: our NIF_MESSAGE callback

_NIM_ADD = 0x0
_NIM_MODIFY = 0x1
_NIM_DELETE = 0x2
_NIF_MESSAGE = 0x1
_NIF_ICON = 0x2
_NIF_TIP = 0x4
_NIF_INFO = 0x10
_NIIF_INFO = 0x1

_MF_STRING = 0x0
_MF_SEPARATOR = 0x800
_TPM_RIGHTBUTTON = 0x2
_TPM_RETURNCMD = 0x100
_TPM_NONOTIFY = 0x80

_IDI_APPLICATION = 32512
_IMAGE_ICON = 1
_LR_LOADFROMFILE = 0x10
_LR_DEFAULTSIZE = 0x40
_SW_RESTORE = 9

_CMD_OPEN = 1
_CMD_QUIT = 2

_user32 = ctypes.WinDLL("user32", use_last_error=True)
_shell32 = ctypes.WinDLL("shell32", use_last_error=True)
_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

_WNDPROC = ctypes.WINFUNCTYPE(
    ctypes.c_longlong, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
)

_user32.DefWindowProcW.restype = ctypes.c_longlong
_user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
_user32.CreateWindowExW.restype = wintypes.HWND
_user32.CreatePopupMenu.restype = wintypes.HMENU
_user32.TrackPopupMenu.restype = wintypes.UINT
_user32.TrackPopupMenu.argtypes = [
    wintypes.HMENU, wintypes.UINT, ctypes.c_int, ctypes.c_int,
    ctypes.c_int, wintypes.HWND, ctypes.c_void_p,
]
_user32.LoadImageW.restype = wintypes.HANDLE
_user32.LoadIconW.restype = wintypes.HICON
_user32.RegisterWindowMessageW.restype = wintypes.UINT


class _WNDCLASSW(ctypes.Structure):
    _fields_ = [
        ("style", wintypes.UINT),
        ("lpfnWndProc", _WNDPROC),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", wintypes.HINSTANCE),
        ("hIcon", wintypes.HICON),
        ("hCursor", ctypes.c_void_p),
        ("hbrBackground", ctypes.c_void_p),
        ("lpszMenuName", wintypes.LPCWSTR),
        ("lpszClassName", wintypes.LPCWSTR),
    ]


class _NOTIFYICONDATAW(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("hWnd", wintypes.HWND),
        ("uID", wintypes.UINT),
        ("uFlags", wintypes.UINT),
        ("uCallbackMessage", wintypes.UINT),
        ("hIcon", wintypes.HICON),
        ("szTip", wintypes.WCHAR * 128),
        ("dwState", wintypes.DWORD),
        ("dwStateMask", wintypes.DWORD),
        ("szInfo", wintypes.WCHAR * 256),
        ("uTimeoutOrVersion", wintypes.UINT),
        ("szInfoTitle", wintypes.WCHAR * 64),
        ("dwInfoFlags", wintypes.DWORD),
    ]


def _load_icon() -> int:
    """Best icon available: the exe's own (frozen), the repo .ico (dev), stock."""
    if getattr(sys, "frozen", False):
        hicon = _shell32.ExtractIconW(0, sys.executable, 0)
        if hicon and hicon > 1:  # 0/1 mean no icon / error
            return hicon
    ico = Path(__file__).resolve().parent / "resources" / "quickterm.ico"
    if ico.is_file():
        hicon = _user32.LoadImageW(
            None, str(ico), _IMAGE_ICON, 0, 0, _LR_LOADFROMFILE | _LR_DEFAULTSIZE
        )
        if hicon:
            return hicon
    return _user32.LoadIconW(None, _IDI_APPLICATION)


class TrayIcon:
    """Owns the tray thread. on_open/on_quit are invoked from that thread."""

    def __init__(
        self,
        on_open: Callable[[], None],
        on_quit: Callable[[], None],
        tip: str = "QuickTerm",
    ) -> None:
        self._on_open = on_open
        self._on_quit = on_quit
        self._tip = tip
        self._hwnd: int | None = None
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._balloon_shown = False
        self._taskbar_created = 0
        self._wndproc = _WNDPROC(self._wnd_proc)  # keep alive: GC'd proc = crash

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="tray", daemon=True)
        self._thread.start()
        self._ready.wait(timeout=5)

    def dispose(self) -> None:
        hwnd = self._hwnd
        if hwnd:
            _user32.PostMessageW(hwnd, _WM_CLOSE, 0, 0)
        t = self._thread
        if t is not None:
            t.join(timeout=3)
        self._thread = None

    def balloon_once(self, title: str, text: str) -> None:
        """One-time notification (first hide): tell the user the app lives on."""
        if self._balloon_shown or not self._hwnd:
            return
        self._balloon_shown = True
        nid = self._nid()
        nid.uFlags = _NIF_INFO
        nid.szInfo = text[:255]
        nid.szInfoTitle = title[:63]
        nid.dwInfoFlags = _NIIF_INFO
        _shell32.Shell_NotifyIconW(_NIM_MODIFY, ctypes.byref(nid))

    # ---- tray thread ----

    def _run(self) -> None:
        try:
            hinst = _kernel32.GetModuleHandleW(None)
            wc = _WNDCLASSW()
            wc.lpfnWndProc = self._wndproc
            wc.hInstance = hinst
            # class/title must NOT contain "QuickTerm": hotkeys.toggle_window
            # matches window titles by that substring and must never grab this.
            wc.lpszClassName = "qt-tray-host"
            if not _user32.RegisterClassW(ctypes.byref(wc)):
                self._ready.set()
                return
            self._hwnd = _user32.CreateWindowExW(
                0, wc.lpszClassName, "qt-tray-host", 0, 0, 0, 0, 0, None, None, hinst, None
            )
            if not self._hwnd:
                self._ready.set()
                return
            self._hicon = _load_icon()
            self._taskbar_created = _user32.RegisterWindowMessageW("TaskbarCreated")
            self._add_icon()
            self._ready.set()
            msg = wintypes.MSG()
            while _user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                _user32.TranslateMessage(ctypes.byref(msg))
                _user32.DispatchMessageW(ctypes.byref(msg))
        except Exception:
            log.exception("tray thread failed")
            self._ready.set()

    def _nid(self) -> _NOTIFYICONDATAW:
        nid = _NOTIFYICONDATAW()
        nid.cbSize = ctypes.sizeof(_NOTIFYICONDATAW)
        nid.hWnd = self._hwnd
        nid.uID = 1
        return nid

    def _add_icon(self) -> None:
        nid = self._nid()
        nid.uFlags = _NIF_MESSAGE | _NIF_ICON | _NIF_TIP
        nid.uCallbackMessage = _WM_TRAY
        nid.hIcon = self._hicon
        nid.szTip = self._tip[:127]
        _shell32.Shell_NotifyIconW(_NIM_ADD, ctypes.byref(nid))

    def _menu(self) -> None:
        menu = _user32.CreatePopupMenu()
        _user32.AppendMenuW(menu, _MF_STRING, _CMD_OPEN, "Open QuickTerm")
        _user32.AppendMenuW(menu, _MF_SEPARATOR, 0, None)
        _user32.AppendMenuW(menu, _MF_STRING, _CMD_QUIT, "Quit QuickTerm")
        pt = wintypes.POINT()
        _user32.GetCursorPos(ctypes.byref(pt))
        # Required quirk: the menu only dismisses on outside-click if our
        # (invisible) window is foreground while it tracks.
        _user32.SetForegroundWindow(self._hwnd)
        cmd = _user32.TrackPopupMenu(
            menu,
            _TPM_RIGHTBUTTON | _TPM_RETURNCMD | _TPM_NONOTIFY,
            pt.x, pt.y, 0, self._hwnd, None,
        )
        _user32.DestroyMenu(menu)
        if cmd == _CMD_OPEN:
            self._safe(self._on_open)
        elif cmd == _CMD_QUIT:
            self._safe(self._on_quit)

    def _safe(self, cb: Callable[[], None]) -> None:
        try:
            cb()
        except Exception:
            log.exception("tray callback failed")

    def _wnd_proc(self, hwnd, msg, wparam, lparam) -> int:
        if msg == _WM_TRAY:
            event = lparam & 0xFFFF
            if event in (_WM_LBUTTONUP, _WM_LBUTTONDBLCLK):
                self._safe(self._on_open)
            elif event in (_WM_RBUTTONUP, _WM_CONTEXTMENU):
                self._menu()
            return 0
        if self._taskbar_created and msg == self._taskbar_created:
            self._add_icon()  # explorer restarted: the icon vanished, re-add
            return 0
        if msg == _WM_DESTROY:
            nid = self._nid()
            _shell32.Shell_NotifyIconW(_NIM_DELETE, ctypes.byref(nid))
            _user32.PostQuitMessage(0)
            return 0
        return _user32.DefWindowProcW(hwnd, msg, wparam, lparam)
