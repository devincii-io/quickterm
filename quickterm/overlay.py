"""Quake-style drop-down for the primary window. ctypes and stdlib only.

Everything here works in Win32 physical pixels (the monitor work area and
SetWindowPos share that space), never in pywebview's logical units. Callers
run it on the hotkey thread or a worker, never on the asyncio loop: SetWindowPos
on a window another thread owns waits for that thread.

Off Windows every entry point is a no-op.
"""

from __future__ import annotations

import ctypes
import logging
import os
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

log = logging.getLogger(__name__)

_IS_WINDOWS = os.name == "nt"
EDGES = ("top", "bottom")
WIDTH_PCT = (30, 100)
HEIGHT_PCT = (20, 100)
DEFAULT_WIDTH_PCT = 100
DEFAULT_HEIGHT_PCT = 50
SLIDE_S = 0.12
SLIDE_STEPS = 6
HOLD_S = 3.0

_GWL_STYLE = -16
_WS_CAPTION = 0x00C00000
_WS_THICKFRAME = 0x00040000
_HWND_TOPMOST = -1
_HWND_NOTOPMOST = -2
_SWP_NOSIZE = 0x0001
_SWP_NOMOVE = 0x0002
_SWP_NOZORDER = 0x0004
_SWP_NOACTIVATE = 0x0010
_SWP_FRAMECHANGED = 0x0020
_SWP_SHOWWINDOW = 0x0040
_SW_HIDE = 0
_SW_SHOWNORMAL = 1
_SW_SHOWMINIMIZED = 2
_SW_SHOWMAXIMIZED = 3
_SW_SHOW = 5
_SW_RESTORE = 9
_WPF_RESTORETOMAXIMIZED = 0x0002
_MONITOR_DEFAULTTOPRIMARY = 1
_MONITOR_DEFAULTTONEAREST = 2
_SPI_GETCLIENTAREAANIMATION = 0x1042
_EVENT_SYSTEM_FOREGROUND = 0x0003
_WINEVENT_OUTOFCONTEXT = 0x0000
_WINEVENT_SKIPOWNPROCESS = 0x0002


def _clamp_pct(value: Any, bounds: tuple[int, int], default: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    low, high = bounds
    return max(low, min(high, number))


def overlay_rect(
    work_area: tuple[int, int, int, int], edge: str, width_pct: Any, height_pct: Any
) -> tuple[int, int, int, int]:
    """The drop-down's `(x, y, width, height)` inside `work_area`.

    `work_area` is a RECT `(left, top, right, bottom)`. The window is centred
    horizontally and touches the top edge, or the bottom one for "bottom".
    Percentages are clamped to WIDTH_PCT and HEIGHT_PCT.
    """
    left, top, right, bottom = (int(v) for v in work_area)
    area_w = max(0, right - left)
    area_h = max(0, bottom - top)
    width = area_w * _clamp_pct(width_pct, WIDTH_PCT, DEFAULT_WIDTH_PCT) // 100
    height = area_h * _clamp_pct(height_pct, HEIGHT_PCT, DEFAULT_HEIGHT_PCT) // 100
    x = left + (area_w - width) // 2
    y = bottom - height if edge == "bottom" else top
    return x, y, width, height


def _setting(cfg: Any, name: str, default: Any) -> Any:
    return getattr(cfg, name, default) if cfg is not None else default


def enabled(cfg: Any) -> bool:
    return bool(_setting(cfg, "enabled", False))


# ---- held open while QuickTerm itself hands the foreground away -------------

_hold_lock = threading.Lock()
_hold_until = 0.0


def hold_open(seconds: float = HOLD_S) -> None:
    """Ignore foreground changes for `seconds`.

    QuickTerm launching Explorer, VS Code or a UAC prompt moves the
    foreground to another process on purpose; hiding the drop-down then
    would take the user's context away exactly when they asked for more.
    """
    global _hold_until
    with _hold_lock:
        _hold_until = max(_hold_until, time.monotonic() + max(0.0, float(seconds)))


def _held() -> bool:
    with _hold_lock:
        return time.monotonic() < _hold_until


# ---- Win32 -------------------------------------------------------------------


@dataclass
class _Saved:
    style: int
    placement: Any


class _Win32:
    """The handful of user32 calls the overlay needs, typed for 64-bit."""

    def __init__(self) -> None:
        from ctypes import wintypes

        self.wintypes = wintypes
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        HWND = wintypes.HWND

        class MONITORINFO(ctypes.Structure):
            _fields_ = [
                ("cbSize", wintypes.DWORD),
                ("rcMonitor", wintypes.RECT),
                ("rcWork", wintypes.RECT),
                ("dwFlags", wintypes.DWORD),
            ]

        class WINDOWPLACEMENT(ctypes.Structure):
            _fields_ = [
                ("length", wintypes.UINT),
                ("flags", wintypes.UINT),
                ("showCmd", wintypes.UINT),
                ("ptMinPosition", wintypes.POINT),
                ("ptMaxPosition", wintypes.POINT),
                ("rcNormalPosition", wintypes.RECT),
            ]

        self.MONITORINFO = MONITORINFO
        self.WINDOWPLACEMENT = WINDOWPLACEMENT
        get_style = getattr(user32, "GetWindowLongPtrW", None) or user32.GetWindowLongW
        set_style = getattr(user32, "SetWindowLongPtrW", None) or user32.SetWindowLongW
        get_style.argtypes = [HWND, ctypes.c_int]
        get_style.restype = ctypes.c_ssize_t
        set_style.argtypes = [HWND, ctypes.c_int, ctypes.c_ssize_t]
        set_style.restype = ctypes.c_ssize_t
        user32.SetWindowPos.argtypes = [
            HWND, HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT,
        ]
        user32.SetWindowPos.restype = wintypes.BOOL
        user32.ShowWindow.argtypes = [HWND, ctypes.c_int]
        user32.IsWindowVisible.argtypes = [HWND]
        user32.IsIconic.argtypes = [HWND]
        user32.IsZoomed.argtypes = [HWND]
        user32.SetForegroundWindow.argtypes = [HWND]
        user32.GetForegroundWindow.restype = HWND
        user32.GetWindowPlacement.argtypes = [HWND, ctypes.POINTER(WINDOWPLACEMENT)]
        user32.SetWindowPlacement.argtypes = [HWND, ctypes.POINTER(WINDOWPLACEMENT)]
        user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
        user32.MonitorFromPoint.argtypes = [wintypes.POINT, wintypes.DWORD]
        user32.MonitorFromPoint.restype = wintypes.HMONITOR
        user32.GetMonitorInfoW.argtypes = [wintypes.HMONITOR, ctypes.POINTER(MONITORINFO)]
        user32.GetWindowRect.argtypes = [HWND, ctypes.POINTER(wintypes.RECT)]
        user32.SystemParametersInfoW.argtypes = [
            wintypes.UINT, wintypes.UINT, ctypes.c_void_p, wintypes.UINT,
        ]
        self.user32 = user32
        self._get_style = get_style
        self._set_style = set_style

    def work_area(self, monitor: str) -> tuple[int, int, int, int]:
        wintypes = self.wintypes
        point = wintypes.POINT(0, 0)
        flag = _MONITOR_DEFAULTTOPRIMARY
        if monitor != "primary" and self.user32.GetCursorPos(ctypes.byref(point)):
            flag = _MONITOR_DEFAULTTONEAREST
        handle = self.user32.MonitorFromPoint(point, flag)
        info = self.MONITORINFO()
        info.cbSize = ctypes.sizeof(self.MONITORINFO)
        if not handle or not self.user32.GetMonitorInfoW(handle, ctypes.byref(info)):
            raise OSError("no monitor information")
        work = info.rcWork
        return work.left, work.top, work.right, work.bottom

    def get_style(self, hwnd: int) -> int:
        return int(self._get_style(hwnd, _GWL_STYLE))

    def set_style(self, hwnd: int, style: int) -> None:
        self._set_style(hwnd, _GWL_STYLE, style)

    def get_placement(self, hwnd: int) -> Any:
        placement = self.WINDOWPLACEMENT()
        placement.length = ctypes.sizeof(self.WINDOWPLACEMENT)
        self.user32.GetWindowPlacement(hwnd, ctypes.byref(placement))
        return placement

    def set_placement(self, hwnd: int, placement: Any) -> None:
        if placement.showCmd == _SW_SHOWMINIMIZED:
            restore_max = placement.flags & _WPF_RESTORETOMAXIMIZED
            placement.showCmd = _SW_SHOWMAXIMIZED if restore_max else _SW_SHOWNORMAL
        self.user32.SetWindowPlacement(hwnd, ctypes.byref(placement))

    def set_pos(self, hwnd: int, after: int, x: int, y: int, w: int, h: int, flags: int) -> None:
        self.user32.SetWindowPos(hwnd, after, x, y, w, h, flags)

    def show(self, hwnd: int, command: int) -> None:
        self.user32.ShowWindow(hwnd, command)

    def visible(self, hwnd: int) -> bool:
        return bool(self.user32.IsWindowVisible(hwnd))

    def minimized_or_maximized(self, hwnd: int) -> bool:
        return bool(self.user32.IsIconic(hwnd) or self.user32.IsZoomed(hwnd))

    def foreground(self) -> int:
        return int(self.user32.GetForegroundWindow() or 0)

    def set_foreground(self, hwnd: int) -> None:
        self.user32.SetForegroundWindow(hwnd)

    def rect(self, hwnd: int) -> tuple[int, int, int, int]:
        box = self.wintypes.RECT()
        self.user32.GetWindowRect(hwnd, ctypes.byref(box))
        return box.left, box.top, box.right, box.bottom

    def pid_of(self, hwnd: int) -> int:
        from quickterm import tray

        return tray._pid_of(hwnd)

    def animations_on(self) -> bool:
        flag = self.wintypes.BOOL(True)
        if not self.user32.SystemParametersInfoW(
            _SPI_GETCLIENTAREAANIMATION, 0, ctypes.byref(flag), 0
        ):
            return True
        return bool(flag.value)


_win: Any = None
_win_lock = threading.Lock()
_state_lock = threading.RLock()
_saved: dict[int, _Saved] = {}


def _api() -> Any | None:
    global _win
    if not _IS_WINDOWS:
        return None
    with _win_lock:
        if _win is None:
            _win = _Win32()
        return _win


def is_applied(hwnd: int | None = None) -> bool:
    """Whether `hwnd` (or, for None, any window) is in overlay style."""
    with _state_lock:
        return bool(_saved) if hwnd is None else hwnd in _saved


def applied_windows() -> list[int]:
    with _state_lock:
        return list(_saved)


def _sleep_step() -> None:
    time.sleep(SLIDE_S / SLIDE_STEPS)


def _animate(cfg: Any, win: Any) -> bool:
    return bool(_setting(cfg, "animate", True)) and win.animations_on()


def show_overlay(hwnd: int, cfg: Any) -> None:
    """Drop `hwnd` down from its edge, in front, and remember how it was."""
    win = _api()
    if win is None or not hwnd:
        return
    # First, while the hotkey press still grants this process foreground rights.
    win.set_foreground(hwnd)
    edge = _setting(cfg, "edge", "top")
    work = win.work_area(_setting(cfg, "monitor", "cursor"))
    x, y, width, height = overlay_rect(
        work,
        edge,
        _setting(cfg, "width_pct", DEFAULT_WIDTH_PCT),
        _setting(cfg, "height_pct", DEFAULT_HEIGHT_PCT),
    )
    was_visible = win.visible(hwnd)
    with _state_lock:
        if hwnd not in _saved:
            _saved[hwnd] = _Saved(style=win.get_style(hwnd), placement=win.get_placement(hwnd))
        style = _saved[hwnd].style
    if win.minimized_or_maximized(hwnd):
        win.show(hwnd, _SW_RESTORE)
    win.set_style(hwnd, style & ~(_WS_CAPTION | _WS_THICKFRAME))
    after = _HWND_TOPMOST if _setting(cfg, "always_on_top", True) else _HWND_NOTOPMOST
    flags = _SWP_SHOWWINDOW | _SWP_FRAMECHANGED
    if not was_visible and _animate(cfg, win):
        start = work[1] - height if edge != "bottom" else work[3]
        for step in range(1, SLIDE_STEPS):
            frame_y = start + (y - start) * step // SLIDE_STEPS
            win.set_pos(hwnd, after, x, frame_y, width, height, flags)
            flags = _SWP_SHOWWINDOW
            _sleep_step()
    win.set_pos(hwnd, after, x, y, width, height, flags)
    win.set_foreground(hwnd)


def hide_overlay(hwnd: int, cfg: Any) -> None:
    """Slide the drop-down back out of its edge, then hide it."""
    win = _api()
    if win is None or not hwnd:
        return
    if win.visible(hwnd) and is_applied(hwnd) and _animate(cfg, win):
        left, top, right, bottom = win.rect(hwnd)
        height = bottom - top
        end = top - height if _setting(cfg, "edge", "top") != "bottom" else bottom
        flags = _SWP_NOZORDER | _SWP_NOACTIVATE | _SWP_NOSIZE
        for step in range(1, SLIDE_STEPS + 1):
            frame_y = top + (end - top) * step // SLIDE_STEPS
            win.set_pos(hwnd, 0, left, frame_y, right - left, height, flags)
            _sleep_step()
    win.show(hwnd, _SW_HIDE)


def restore_normal(hwnd: int) -> None:
    """Put the saved style and placement back and drop always-on-top.

    The window ends up shown, as its saved placement says (normal or
    maximized).
    """
    win = _api()
    with _state_lock:
        saved = _saved.pop(hwnd, None)
    if win is None or saved is None:
        return
    win.set_style(hwnd, saved.style)
    win.set_placement(hwnd, saved.placement)
    win.set_pos(
        hwnd, _HWND_NOTOPMOST, 0, 0, 0, 0,
        _SWP_NOMOVE | _SWP_NOSIZE | _SWP_FRAMECHANGED | _SWP_NOACTIVATE,
    )


def show_normal(hwnd: int) -> None:
    """Restore a window left in overlay style, then show and focus it."""
    win = _api()
    if win is None or not hwnd:
        return
    restore_normal(hwnd)
    if not win.visible(hwnd):
        win.show(hwnd, _SW_SHOW)
    win.set_foreground(hwnd)


# ---- hide on focus loss --------------------------------------------------------

_hook: Any = None
_hook_proc: Any = None


def _on_foreground(get_cfg: Callable[[], Any], hwnd: int) -> None:
    cfg = get_cfg()
    if not enabled(cfg) or not _setting(cfg, "hide_on_blur", True) or _held():
        return
    win = _api()
    if win is None or not hwnd or win.pid_of(hwnd) == os.getpid():
        return
    for target in applied_windows():
        if win.visible(target):
            hide_overlay(target, cfg)


def install_foreground_watcher(get_cfg: Callable[[], Any]) -> bool:
    """Hook EVENT_SYSTEM_FOREGROUND. Call it on a thread that pumps messages
    (the hotkey thread): out-of-context WinEvents arrive through that loop."""
    global _hook, _hook_proc
    win = _api()
    if win is None or _hook is not None:
        return False
    from ctypes import wintypes

    proc_type = ctypes.WINFUNCTYPE(
        None, wintypes.HANDLE, wintypes.DWORD, wintypes.HWND, wintypes.LONG,
        wintypes.LONG, wintypes.DWORD, wintypes.DWORD,
    )

    def callback(_hook_handle, _event, hwnd, _object, _child, _thread, _time) -> None:
        try:
            _on_foreground(get_cfg, int(hwnd or 0))
        except Exception:
            log.debug("overlay focus-loss check failed", exc_info=True)

    user32 = win.user32
    user32.SetWinEventHook.restype = wintypes.HANDLE
    user32.SetWinEventHook.argtypes = [
        wintypes.DWORD, wintypes.DWORD, wintypes.HMODULE, proc_type,
        wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
    ]
    # Kept on the module: a collected callback crashes the process.
    _hook_proc = proc_type(callback)
    _hook = user32.SetWinEventHook(
        _EVENT_SYSTEM_FOREGROUND, _EVENT_SYSTEM_FOREGROUND, None, _hook_proc,
        0, 0, _WINEVENT_OUTOFCONTEXT | _WINEVENT_SKIPOWNPROCESS,
    )
    if not _hook:
        _hook_proc = None
        log.warning("overlay focus-loss hook unavailable")
        return False
    return True


def remove_foreground_watcher() -> None:
    """Undo install_foreground_watcher, on the thread that installed it."""
    global _hook, _hook_proc
    win = _api()
    if win is None or _hook is None:
        return
    from ctypes import wintypes

    win.user32.UnhookWinEvent.argtypes = [wintypes.HANDLE]
    win.user32.UnhookWinEvent(_hook)
    _hook = None
    _hook_proc = None
