"""Global Windows hotkeys via ctypes RegisterHotKey. No third-party deps.

RegisterHotKey is thread-affine: all (un)registration happens on one dedicated
thread running a GetMessageW loop. Every change (register, rebind, suspend,
resume) is a job handed to that thread through a queue plus a
PostThreadMessageW(WM_APP) wake-up. The same loop delivers the overlay's
out-of-context WinEvent hook, so `run_on_thread` installs that too.
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
from typing import Any, Callable, Iterable

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

SUSPEND_S = 20.0
_JOB_TIMEOUT_S = 5.0

_MODIFIERS = {
    "ctrl": MOD_CONTROL,
    "control": MOD_CONTROL,
    "alt": MOD_ALT,
    "shift": MOD_SHIFT,
    "win": MOD_WIN,
}

_NAMED_KEYS = {
    "space": 0x20,
    "tab": 0x09,
    "esc": 0x1B,
    "escape": 0x1B,
    "enter": 0x0D,
    "return": 0x0D,
    "left": 0x25,
    "up": 0x26,
    "right": 0x27,
    "down": 0x28,
    "home": 0x24,
    "end": 0x23,
    "pageup": 0x21,
    "pagedown": 0x22,
    "insert": 0x2D,
    "delete": 0x2E,
    **{f"numpad{n}": 0x60 + n for n in range(10)},
}

# Named OEM keys are physical positions (Settings records them from the
# browser's `e.code`), so they resolve through the set-1 scan code under the
# current layout: VK_OEM_MINUS is the "-" key on QWERTZ, not the ß key that
# sits where US "-" is. The second value is the US virtual key, used off
# Windows and when the layout does not map the scan code.
_PHYSICAL_KEYS = {
    "grave": (0x29, 0xC0),
    "backtick": (0x29, 0xC0),
    "minus": (0x0C, 0xBD),
    "equal": (0x0D, 0xBB),
    "comma": (0x33, 0xBC),
    "period": (0x34, 0xBE),
    "slash": (0x35, 0xBF),
    "semicolon": (0x27, 0xBA),
    "quote": (0x28, 0xDE),
    "bracketleft": (0x1A, 0xDB),
    "bracketright": (0x1B, 0xDD),
    "backslash": (0x2B, 0xDC),
}

_MAPVK_VSC_TO_VK_EX = 3

_F_KEY = re.compile(r"^f([1-9]|1[0-9]|2[0-4])$")


def _vk_for_scan(scan: int, fallback: int) -> int:
    if os.name != "nt":
        return fallback
    try:
        vk = int(ctypes.windll.user32.MapVirtualKeyW(scan, _MAPVK_VSC_TO_VK_EX))
    except (AttributeError, OSError):
        return fallback
    return vk or fallback


def _vk_for_key(key: str) -> int:
    if key in _NAMED_KEYS:
        return _NAMED_KEYS[key]
    if key in _PHYSICAL_KEYS:
        return _vk_for_scan(*_PHYSICAL_KEYS[key])
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
class HotkeyEntry:
    """One global hotkey. `on_hotkey_thread` runs the callback on the hotkey
    thread itself instead of the asyncio loop; Win32 window work uses it."""

    binding: str
    callback: Callable[[], None]
    on_hotkey_thread: bool = False


@dataclass
class _Registered:
    entry: HotkeyEntry
    mods: int
    vk: int


@dataclass
class _Job:
    run: Callable[[Any], Any]
    done: threading.Event = field(default_factory=threading.Event)
    result: Any = None


class HotkeyManager:
    """Owns the hotkey thread. Callbacks run on the asyncio loop unless they
    were registered with `on_hotkey_thread=True`."""

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self._thread: threading.Thread | None = None
        self._thread_id: int = 0
        self._ready = threading.Event()
        self._jobs: queue.SimpleQueue[_Job] = queue.SimpleQueue()
        # Touched only on the hotkey thread.
        self._active: dict[int, _Registered] = {}
        self._parked: list[_Registered] = []
        self._exit_hooks: list[Callable[[], None]] = []
        self._ids = itertools.count(1)
        self._resume_timer: threading.Timer | None = None
        self._timer_lock = threading.Lock()

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
        self._cancel_resume()
        t = self._thread
        if t is None or not t.is_alive():
            self._thread = None
            return
        ctypes.windll.user32.PostThreadMessageW(self._thread_id, _WM_QUIT, 0, 0)
        t.join(timeout=5)
        if t.is_alive():
            log.warning("hotkey thread did not exit")
        self._thread = None

    # ---- public operations, each one a job on the hotkey thread ------------

    def register(
        self, binding: str, callback: Callable[[], None], *, on_hotkey_thread: bool = False
    ) -> bool:
        entry = HotkeyEntry(binding, callback, on_hotkey_thread)
        parsed = self._parse(entry)
        if parsed is None or os.name != "nt":
            return False
        result = self._submit(lambda user32: self._register(user32, parsed))
        return result is True

    def rebind(self, entries: Iterable[HotkeyEntry | tuple]) -> list[bool]:
        """Replace every registration with `entries`; one result per entry.

        Ends a suspension: the new set is live at once.
        """
        wanted = [_entry(item) for item in entries]
        parsed = [self._parse(entry) for entry in wanted]
        if os.name != "nt":
            return [False] * len(wanted)
        self._cancel_resume()

        def job(user32: Any) -> list[bool]:
            self._unregister_all(user32)
            self._parked = []
            return [
                False if item is None else self._register(user32, item) for item in parsed
            ]

        result = self._submit(job)
        return result if isinstance(result, list) else [False] * len(wanted)

    def unregister_all(self) -> None:
        self._cancel_resume()
        if os.name != "nt":
            return

        def job(user32: Any) -> None:
            self._unregister_all(user32)
            self._parked = []

        self._submit(job)

    def suspend(self, seconds: float = SUSPEND_S) -> None:
        """Release every hotkey so a key capture can record it, and take them
        back after `seconds` even when nobody calls resume()."""
        if os.name != "nt":
            return

        def job(user32: Any) -> None:
            if self._parked:
                return
            self._parked = list(self._active.values())
            self._unregister_all(user32)

        self._submit(job)
        timer = threading.Timer(max(0.0, seconds), self.resume)
        timer.daemon = True
        with self._timer_lock:
            if self._resume_timer is not None:
                self._resume_timer.cancel()
            self._resume_timer = timer
        timer.start()

    def resume(self) -> None:
        self._cancel_resume()
        if os.name != "nt":
            return

        def job(user32: Any) -> None:
            parked, self._parked = self._parked, []
            for item in parked:
                self._register(user32, item)

        self._submit(job)

    def run_on_thread(
        self, fn: Callable[[], Any], *, on_exit: Callable[[], None] | None = None
    ) -> Any:
        """Run `fn` on the hotkey thread and return its result. `on_exit` runs
        there too, when the thread ends."""
        if os.name != "nt":
            return None

        def job(_user32: Any) -> Any:
            if on_exit is not None:
                self._exit_hooks.append(on_exit)
            return fn()

        return self._submit(job)

    # ---- plumbing -----------------------------------------------------------

    def _parse(self, entry: HotkeyEntry) -> _Registered | None:
        try:
            mods, vk = parse_binding(entry.binding)
        except ValueError as e:
            log.warning("hotkey %r not registered: %s", entry.binding, e)
            return None
        return _Registered(entry, mods, vk)

    def _cancel_resume(self) -> None:
        with self._timer_lock:
            timer, self._resume_timer = self._resume_timer, None
        if timer is not None:
            timer.cancel()

    def _submit(self, run: Callable[[Any], Any]) -> Any:
        if self._thread is None or not self._thread.is_alive():
            self.start()
        if not self._ready.wait(timeout=_JOB_TIMEOUT_S):
            log.warning("hotkey thread not ready")
            return None
        if threading.get_ident() == getattr(self._thread, "ident", None):
            # Already on the hotkey thread (a hotkey callback rebinding):
            # queueing and waiting would deadlock.
            return run(ctypes.windll.user32)
        job = _Job(run)
        self._jobs.put(job)
        if not ctypes.windll.user32.PostThreadMessageW(self._thread_id, _WM_APP, 0, 0):
            log.warning("hotkey thread unreachable")
            return None
        if not job.done.wait(timeout=_JOB_TIMEOUT_S):
            log.warning("hotkey job timed out")
            return None
        return job.result

    def _register(self, user32: Any, item: _Registered) -> bool:
        hotkey_id = next(self._ids)
        ok = bool(user32.RegisterHotKey(None, hotkey_id, item.mods, item.vk))
        if ok:
            self._active[hotkey_id] = item
        else:
            windll = getattr(ctypes, "windll", None)
            error = windll.kernel32.GetLastError() if windll is not None else 0
            log.warning("RegisterHotKey failed for %r (err=%d); already taken?",
                        item.entry.binding, error)
        return ok

    def _unregister_all(self, user32: Any) -> None:
        for hotkey_id in list(self._active):
            user32.UnregisterHotKey(None, hotkey_id)
        self._active.clear()

    def _dispatch(self, hotkey_id: int) -> None:
        item = self._active.get(hotkey_id)
        if item is None:
            return
        if item.entry.on_hotkey_thread:
            try:
                item.entry.callback()
            except Exception:
                log.exception("hotkey callback failed")
            return
        try:
            self.loop.call_soon_threadsafe(item.entry.callback)
        except RuntimeError:
            log.debug("event loop closed; hotkey dropped")

    def _run(self) -> None:
        user32 = ctypes.windll.user32
        self._thread_id = ctypes.windll.kernel32.GetCurrentThreadId()
        msg = wintypes.MSG()
        # force message queue creation so PostThreadMessageW can reach us
        user32.PeekMessageW(ctypes.byref(msg), None, _WM_APP, _WM_APP, _PM_NOREMOVE)
        self._ready.set()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            if msg.message == _WM_HOTKEY:
                self._dispatch(msg.wParam)
            elif msg.message == _WM_APP:
                self._drain_jobs(user32)
        self._unregister_all(user32)
        self._parked = []
        for hook in self._exit_hooks:
            try:
                hook()
            except Exception:
                log.debug("hotkey thread exit hook failed", exc_info=True)
        self._exit_hooks.clear()

    def _drain_jobs(self, user32: Any) -> None:
        while True:
            try:
                job = self._jobs.get_nowait()
            except queue.Empty:
                return
            try:
                job.result = job.run(user32)
            except Exception:
                log.exception("hotkey job failed")
            finally:
                job.done.set()


def _entry(item: HotkeyEntry | tuple) -> HotkeyEntry:
    return item if isinstance(item, HotkeyEntry) else HotkeyEntry(*item)


def _title_matches(candidate: str, requested: str) -> bool:
    return candidate == requested


def _quickterm_windows(title: str) -> tuple[Any, list[int], list[int]]:
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
            # The administrator viewer is a different backend. A normal
            # Explorer handoff must summon exactly "QuickTerm", never the
            # first "QuickTerm - Administrator" window in enumeration order.
            if _title_matches(buf.value, title):
                (visible if user32.IsWindowVisible(hwnd) else hidden).append(hwnd)
                if visible:
                    return False
        return True

    user32.EnumWindows(_enum, 0)
    return user32, visible, hidden


def summon_window(title: str = "QuickTerm") -> None:
    """Restore and focus the one QuickTerm window; never toggle it away."""
    try:
        user32, visible, hidden = _quickterm_windows(title)
        matches = visible or hidden
        if matches:
            user32.ShowWindow(matches[0], _SW_RESTORE)
            user32.SetForegroundWindow(matches[0])
    except Exception:
        log.debug("summon_window failed", exc_info=True)


def toggle_window(title: str = "QuickTerm", overlay: Any = None) -> None:
    """The summon hotkey. Runs on the hotkey thread.

    With `overlay.enabled` the window is a drop-down: hide it when it is
    showing and in front, else drop it down. Otherwise minimize it when it is
    in front, else restore and focus it; a window still in overlay style from
    before the overlay was turned off is put back to normal first.
    """
    from quickterm import overlay as overlay_mod

    try:
        user32, visible, hidden = _quickterm_windows(title)
        if not (visible or hidden):
            return
        hwnd = (visible or hidden)[0]
        in_front = bool(visible) and user32.GetForegroundWindow() == hwnd
        if overlay_mod.enabled(overlay):
            if in_front and overlay_mod.is_applied(hwnd):
                overlay_mod.hide_overlay(hwnd, overlay)
            else:
                overlay_mod.show_overlay(hwnd, overlay)
            return
        if overlay_mod.is_applied(hwnd):
            overlay_mod.show_normal(hwnd)
            return
        if in_front:
            user32.ShowWindow(hwnd, _SW_MINIMIZE)
        else:
            # Covers a tray-hidden window too: summon it back.
            user32.ShowWindow(hwnd, _SW_RESTORE)
            user32.SetForegroundWindow(hwnd)
    except Exception:
        log.debug("toggle_window failed", exc_info=True)
