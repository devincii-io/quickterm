"""Keep the computer from sleeping while agents work.

``keep_awake`` in the config: "agents" (the default) holds the system awake
while any agent session is working, "always" while the backend runs, "off"
never. The display may still turn off; only system sleep is held off.

``SetThreadExecutionState`` with ``ES_CONTINUOUS`` belongs to the calling
thread: it lasts until that thread calls again or ends. Every call therefore
comes from the event loop's thread (the session manager's agent events, its
timer and its shutdown), and a thread that ends releases what it held.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Callable

log = logging.getLogger(__name__)

MODES = ("agents", "always", "off")
DEFAULT_MODE = "agents"

ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001
HOLD = ES_CONTINUOUS | ES_SYSTEM_REQUIRED
RELEASE = ES_CONTINUOUS


def wanted(mode: str, working: bool) -> bool:
    """Whether the system should be held awake. An unknown mode is the default."""
    if mode not in MODES:
        mode = DEFAULT_MODE
    return mode == "always" or (mode == "agents" and working)


def _set_execution_state(flags: int) -> bool:
    if os.name != "nt":
        return False
    import ctypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.SetThreadExecutionState.argtypes = [ctypes.c_uint32]
    kernel32.SetThreadExecutionState.restype = ctypes.c_uint32
    return kernel32.SetThreadExecutionState(flags) != 0


class KeepAwake:
    """Holds or releases the system, calling Windows only on a change."""

    def __init__(self, set_state: Callable[[int], bool] | None = None) -> None:
        self._set_state = set_state
        self.held = False

    def update(self, mode: str, working: bool) -> None:
        self._apply(wanted(mode, working))

    def release(self) -> None:
        self._apply(False)

    def _apply(self, hold: bool) -> None:
        if hold == self.held:
            return
        set_state = self._set_state or _set_execution_state
        try:
            ok = set_state(HOLD if hold else RELEASE)
        except Exception:
            log.debug("SetThreadExecutionState failed", exc_info=True)
            ok = False
        # A failed hold is retried on the next update; a failed release has
        # nothing left to hold either way.
        self.held = hold and ok
        if hold and ok:
            log.info("holding off system sleep")
        elif not hold:
            log.info("system sleep allowed again")
