"""Global Windows hotkeys via ctypes RegisterHotKey. No third-party deps.

RegisterHotKey is thread-affine: all (un)registration happens on one dedicated
thread running a GetMessageW loop. register() hands work to that thread via a
pending queue + PostThreadMessageW(WM_APP) wake-up.
"""
from __future__ import annotations

import asyncio
import ctypes
import itertools
import logging
import os
import queue
import re
import threading
from ctypes import wintypes
from dataclasses import dataclass, field
from typing import Callable

log = logging.getLogger(__name__)

MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_SHIFT = 0x0004
MOD_WIN = 0x0008
MOD_NOREPEAT = 0x4000

_WM_HOTKEY = 0x0312
_WM_QUIT = 0x0012
_WM_APP = 0x8000
_PM_NOREMOVE = 0x0000

_SW_MINIMIZE = 6
_SW_RESTORE = 9

_MODIFIERS = {
    "ctrl": MOD_CONTROL,
    "control": MOD_CONTROL,
    "alt": MOD_ALT,
    "shift": MOD_SHIFT,
    "win": MOD_WIN,
}

_NAMED_KEYS = {
    "grave": 0xC0,       # VK_OEM_3
    "backtick": 0xC0,
    "space": 0x20,
    "tab": 0x09,
    "esc": 0x1B,
    "escape": 0x1B,
    "enter": 0x0D,
    "return": 0x0D,
}

_F_KEY = re.compile(r"^f([1-9]|1[0-9]|2[0-4])$")


def _vk_for_key(key: str) -> int:
    if key in _NAMED_KEYS:
        return _NAMED_KEYS[key]
    m = _F_KEY.match(key)
    if m:
        return 0x70 + int(m.group(1)) - 1  # VK_F1 .. VK_F24
    if len(key) == 1:
        if "a" <= key <= "z" or "0" <= key <= "9":
            return ord(key.upper())
        # punctuation: map char -> VK via current keyboard layout
        VkKeyScanW = ctypes.windll.user32.VkKeyScanW
        VkKeyScanW.restype = ctypes.c_short
        res = VkKeyScanW(ctypes.c_wchar(key))
        if res != -1 and (res & 0xFF) != 0xFF:
            return res & 0xFF
    raise ValueError(f"unknown key: {key!r}")


def parse_binding(binding: str) -> tuple[int, int]:
    """Parse "ctrl+alt+1" style binding -> (modifiers, vk). MOD_NOREPEAT always set."""
    tokens = [t.strip().lower() for t in binding.split("+")]
    if not tokens or any(not t for t in tokens):
        raise ValueError(f"unparseable binding: {binding!r}")
    *mod_tokens, key = tokens
    mods = MOD_NOREPEAT
    for t in mod_tokens:
        if t not in _MODIFIERS:
            raise ValueError(f"unknown modifier: {t!r} in {binding!r}")
        mods |= _MODIFIERS[t]
    if key in _MODIFIERS:
        raise ValueError(f"binding has no key: {binding!r}")
    return mods, _vk_for_key(key)


@dataclass
class _Pending:
    hotkey_id: int
    mods: int
    vk: int
    callback: Callable[[], None]
    binding: str
    done: threading.Event = field(default_factory=threading.Event)
    ok: bool = False


class HotkeyManager:
    """Owns the hotkey thread; callbacks run on the asyncio loop."""

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self._thread: threading.Thread | None = None
        self._thread_id: int = 0
        self._ready = threading.Event()
        self._pending: queue.SimpleQueue[_Pending] = queue.SimpleQueue()
        self._callbacks: dict[int, Callable[[], None]] = {}
        self._ids = itertools.count(1)

    def start(self) -> None:
        if os.name != "nt":
            return
        if self._thread is not None and self._thread.is_alive():
            return
        self._ready = threading.Event()
        self._thread = threading.Thread(target=self._run, name="hotkeys", daemon=True)
        self._thread.start()
        self._ready.wait(timeout=5)

    def stop(self) -> None:
        t = self._thread
        if t is None or not t.is_alive():
            self._thread = None
            return
        ctypes.windll.user32.PostThreadMessageW(self._thread_id, _WM_QUIT, 0, 0)
        t.join(timeout=5)
        if t.is_alive():
            log.warning("hotkey thread did not exit")
        self._thread = None

    def register(self, binding: str, callback: Callable[[], None]) -> bool:
        try:
            mods, vk = parse_binding(binding)
        except ValueError as e:
            log.warning("hotkey %r not registered: %s", binding, e)
            return False
        if os.name != "nt":
            return False
        if self._thread is None or not self._thread.is_alive():
            self.start()
        if not self._ready.wait(timeout=5):
            log.warning("hotkey thread not ready; %r not registered", binding)
            return False
        item = _Pending(next(self._ids), mods, vk, callback, binding)
        self._pending.put(item)
        if not ctypes.windll.user32.PostThreadMessageW(self._thread_id, _WM_APP, 0, 0):
            log.warning("hotkey thread unreachable; %r not registered", binding)
            return False
        if not item.done.wait(timeout=5):
            log.warning("hotkey registration timed out for %r", binding)
            return False
        return item.ok

    def _run(self) -> None:
        user32 = ctypes.windll.user32
        self._thread_id = ctypes.windll.kernel32.GetCurrentThreadId()
        msg = wintypes.MSG()
        # force message queue creation so PostThreadMessageW can reach us
        user32.PeekMessageW(ctypes.byref(msg), None, _WM_APP, _WM_APP, _PM_NOREMOVE)
        self._ready.set()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            if msg.message == _WM_HOTKEY:
                cb = self._callbacks.get(msg.wParam)
                if cb is not None:
                    self.loop.call_soon_threadsafe(cb)
            elif msg.message == _WM_APP:
                self._drain_pending(user32)
        for hid in list(self._callbacks):
            user32.UnregisterHotKey(None, hid)
        self._callbacks.clear()

    def _drain_pending(self, user32) -> None:
        while True:
            try:
                item = self._pending.get_nowait()
            except queue.Empty:
                return
            ok = bool(user32.RegisterHotKey(None, item.hotkey_id, item.mods, item.vk))
            if ok:
                self._callbacks[item.hotkey_id] = item.callback
            else:
                log.warning("RegisterHotKey failed for %r (err=%d) — already taken?",
                            item.binding, ctypes.get_last_error() or ctypes.windll.kernel32.GetLastError())
            item.ok = ok
            item.done.set()


def toggle_window(title_substring: str = "QuickTerm") -> None:
    """Quake-style summon/hide: minimize if foreground, else restore + focus.

    Also finds a window hidden to the tray (not just minimized), so the summon
    hotkey can bring QuickTerm back after its close-to-tray. Best-effort.
    """
    try:
        user32 = ctypes.windll.user32
        user32.GetForegroundWindow.restype = wintypes.HWND
        visible: list[int] = []
        hidden: list[int] = []

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def _enum(hwnd, _lparam):
            n = user32.GetWindowTextLengthW(hwnd)
            if n:
                buf = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(hwnd, buf, n + 1)
                if title_substring in buf.value:
                    (visible if user32.IsWindowVisible(hwnd) else hidden).append(hwnd)
                    if visible:
                        return False  # a visible match wins; stop enumeration
            return True

        user32.EnumWindows(_enum, 0)
        if visible:
            hwnd = visible[0]
            if user32.GetForegroundWindow() == hwnd:
                user32.ShowWindow(hwnd, _SW_MINIMIZE)
            else:
                user32.ShowWindow(hwnd, _SW_RESTORE)
                user32.SetForegroundWindow(hwnd)
        elif hidden:
            hwnd = hidden[0]  # tray-hidden: summon it back
            user32.ShowWindow(hwnd, _SW_RESTORE)
            user32.SetForegroundWindow(hwnd)
    except Exception:
        log.debug("toggle_window failed", exc_info=True)
