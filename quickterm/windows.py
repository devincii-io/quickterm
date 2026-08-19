"""Which viewer windows are open, and which workspace each one owns.

One backend process serves every window (AGENTS.md: "windows are just
viewers"), so the thing that must not happen is two windows on one workspace:
the frontend autosaves the layout on every pane change, so both would write the
same workspace file and the loser's panes would vanish without a word. A
workspace therefore has at most one live owner here, and a colliding claim
fails loudly instead of being merged or silently stolen.

Liveness is a heartbeat, not a process handle. A window can be a native
pywebview shell, but it can equally be a browser tab that dies without telling
anyone, so an entry that stops heartbeating expires; otherwise one crashed
window would lock its workspace out of the app forever.

Nothing in here imports pywebview or touches a native window. The native side
lives in `app.py`; this module stays pure so the ownership rules are unit
testable without a GUI, which is the only way they get tested at all.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, replace
from typing import Any, Callable
from uuid import uuid4

# A window heartbeats far more often than this (the frontend picks the
# interval). The TTL only has to outlive one slow page load plus a missed beat,
# because its whole job is releasing a workspace held by a window that is gone.
DEFAULT_TTL_S = 45.0
# Windows are cheap but not free (one WebView2 each). A ceiling keeps a runaway
# caller from opening them until the machine gives up.
DEFAULT_MAX_WINDOWS = 12
MAX_ID_CHARS = 64
MAX_TITLE_CHARS = 120
MAX_WORKSPACE_CHARS = 200

# Sentinel for "this call is not about the workspace claim". Registering is
# also how a reloaded page says hello, and an omitted key there must preserve
# the claim rather than release it, exactly like `path` on PUT /api/workspaces.
KEEP: Any = object()


class WindowError(Exception):
    """Registry refusal. `status` is the HTTP code server.py answers with."""

    status = 400


class UnknownWindow(WindowError):
    status = 404


class WorkspaceClaimed(WindowError):
    """Another live window already owns this workspace."""

    status = 409

    def __init__(self, workspace: str, owner: "WindowInfo") -> None:
        super().__init__(f"workspace {workspace!r} is already open in another window")
        self.workspace = workspace
        self.owner = owner


class TooManyWindows(WindowError):
    status = 409


@dataclass
class WindowInfo:
    id: str
    workspace: str | None = None
    title: str = ""
    primary: bool = False
    created: float = 0.0
    last_seen: float = 0.0


def new_window_id() -> str:
    return uuid4().hex[:12]


def as_payload(info: WindowInfo) -> dict:
    """Client-facing view of one window. Timestamps are deliberately absent:
    they are monotonic and mean nothing on the far side of the wire."""
    return {
        "id": info.id,
        "workspace": info.workspace,
        "title": info.title,
        "primary": info.primary,
    }


def normalize_workspace(value: object) -> str | None:
    """Normalize a claimed workspace name. Blank/None means "claims nothing"."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("workspace must be a string or null")
    text = value.strip()
    if not text:
        return None
    if len(text) > MAX_WORKSPACE_CHARS:
        raise ValueError("workspace name is too long")
    if any(ord(char) < 32 for char in text):
        raise ValueError("workspace name contains control characters")
    # Compared exactly, never case-folded: workspace.py stores "dev" and "Dev"
    # in separate files, so they are separate workspaces and separate claims.
    return text


def window_title(base: str, workspace: str | None, *, primary: bool) -> str:
    """Title for one viewer window.

    The primary window keeps the bare base title because `hotkeys.py` matches
    it by exact string: the Explorer handoff and the summon hotkey must land on
    one predictable window, not on whichever secondary happened to enumerate
    first. Secondary windows are named after what they hold instead.
    """
    if primary or not workspace:
        return base
    return f"{base} - {workspace}"


def _clean(value: object, maximum: int) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()[:maximum]


class WindowRegistry:
    """Live windows and their workspace claims. Safe to touch from any thread.

    Routes mutate this from the event loop while the GUI thread reads it when a
    native window closes, so every public method takes the lock. The work under
    it is dict-sized, never I/O, so it cannot stall the loop.
    """

    def __init__(
        self,
        *,
        ttl_s: float = DEFAULT_TTL_S,
        max_windows: int = DEFAULT_MAX_WINDOWS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        # monotonic by default: a wall-clock jump (DST, NTP step) must not
        # expire every open window at once.
        self._ttl = float(ttl_s)
        self._max = int(max_windows)
        self._clock = clock
        self._lock = threading.RLock()
        self._windows: dict[str, WindowInfo] = {}

    @property
    def ttl_s(self) -> float:
        return self._ttl

    # --- queries ------------------------------------------------------------

    def list(self, *, now: float | None = None) -> list[WindowInfo]:
        with self._lock:
            now = self._prune_locked(now)
            return [replace(info) for info in self._ordered_locked()]

    def get(self, window_id: str, *, now: float | None = None) -> WindowInfo | None:
        with self._lock:
            self._prune_locked(now)
            info = self._windows.get(_clean(window_id, MAX_ID_CHARS))
            return replace(info) if info is not None else None

    def owner_of(self, workspace: object, *, now: float | None = None) -> WindowInfo | None:
        name = normalize_workspace(workspace)
        if name is None:
            return None
        with self._lock:
            self._prune_locked(now)
            owner = self._owner_locked(name)
            return replace(owner) if owner is not None else None

    def count(self, *, now: float | None = None) -> int:
        with self._lock:
            self._prune_locked(now)
            return len(self._windows)

    def snapshot(self, *, now: float | None = None) -> list[dict]:
        """Client-facing list, oldest window first, with ages instead of clocks."""
        with self._lock:
            stamp = self._prune_locked(now)
            return [
                {
                    **as_payload(info),
                    "idle_seconds": round(max(0.0, stamp - info.last_seen), 3),
                    "age_seconds": round(max(0.0, stamp - info.created), 3),
                }
                for info in self._ordered_locked()
            ]

    # --- mutations ----------------------------------------------------------

    def register(
        self,
        *,
        window_id: str | None = None,
        workspace: Any = KEEP,
        title: object = "",
        primary: bool = False,
        now: float | None = None,
    ) -> WindowInfo:
        """Add a window, or refresh one that reloaded under the same id.

        Re-registering is deliberately idempotent: a page reload must not 409
        against its own claim, and must not be counted twice against the cap.
        """
        name = KEEP if workspace is KEEP else normalize_workspace(workspace)
        clean_title = _clean(title, MAX_TITLE_CHARS)
        with self._lock:
            stamp = self._prune_locked(now)
            wid = _clean(window_id, MAX_ID_CHARS) or new_window_id()
            info = self._windows.get(wid)
            if info is None and len(self._windows) >= self._max:
                raise TooManyWindows(f"too many open windows (limit {self._max})")
            if name is not KEEP and name is not None:
                self._refuse_conflict_locked(name, wid)
            if info is None:
                info = WindowInfo(id=wid, created=stamp)
                self._windows[wid] = info
            if name is not KEEP:
                info.workspace = name
            if clean_title:
                info.title = clean_title
            info.last_seen = stamp
            if primary:
                self._set_primary_locked(wid)
            self._ensure_primary_locked()
            return replace(info)

    def heartbeat(self, window_id: str, *, now: float | None = None) -> WindowInfo:
        """Keep a window alive. An unknown or already-expired id is a 404 so the
        client re-registers instead of silently running without a claim."""
        with self._lock:
            stamp = self._prune_locked(now)
            info = self._require_locked(window_id)
            info.last_seen = stamp
            return replace(info)

    def claim(self, window_id: str, workspace: object, *, now: float | None = None) -> WindowInfo:
        """Take (or, with None, drop) exclusive ownership of a workspace."""
        name = normalize_workspace(workspace)
        with self._lock:
            stamp = self._prune_locked(now)
            info = self._require_locked(window_id)
            if name is not None:
                self._refuse_conflict_locked(name, info.id)
            # A new claim replaces the old one in the same step; a window can
            # never hold two workspaces, because it only ever shows one.
            info.workspace = name
            info.last_seen = stamp
            return replace(info)

    def release(self, window_id: str, *, now: float | None = None) -> WindowInfo:
        return self.claim(window_id, None, now=now)

    def forget(self, window_id: str, *, now: float | None = None) -> bool:
        """Drop a window that is definitely gone (its native shell closed, or
        the page said goodbye). Frees the claim without waiting out the TTL."""
        with self._lock:
            self._prune_locked(now)
            dropped = self._windows.pop(_clean(window_id, MAX_ID_CHARS), None) is not None
            self._ensure_primary_locked()
            return dropped

    def prune(self, *, now: float | None = None) -> list[WindowInfo]:
        with self._lock:
            expired: list[WindowInfo] = []
            self._prune_locked(now, expired)
            return expired

    # --- internals ----------------------------------------------------------

    def _prune_locked(self, now: float | None, expired: list[WindowInfo] | None = None) -> float:
        stamp = self._clock() if now is None else float(now)
        for wid, info in list(self._windows.items()):
            if stamp - info.last_seen > self._ttl:
                del self._windows[wid]
                if expired is not None:
                    expired.append(info)
        self._ensure_primary_locked()
        return stamp

    def _require_locked(self, window_id: str) -> WindowInfo:
        info = self._windows.get(_clean(window_id, MAX_ID_CHARS))
        if info is None:
            raise UnknownWindow("no such window")
        return info

    def _owner_locked(self, name: str) -> WindowInfo | None:
        for info in self._ordered_locked():
            if info.workspace == name:
                return info
        return None

    def _refuse_conflict_locked(self, name: str, window_id: str) -> None:
        owner = self._owner_locked(name)
        if owner is not None and owner.id != window_id:
            raise WorkspaceClaimed(name, replace(owner))

    def _ordered_locked(self) -> list[WindowInfo]:
        # Oldest first: creation order is what "the primary window" and any
        # promotion after a close both mean.
        return sorted(self._windows.values(), key=lambda info: (info.created, info.id))

    def _set_primary_locked(self, window_id: str) -> None:
        for info in self._windows.values():
            info.primary = info.id == window_id

    def _ensure_primary_locked(self) -> None:
        """Exactly one live window is primary while any window exists.

        The primary window is the one the Explorer handoff and the summon
        hotkey aim at, so losing it to a close would strand those paths; the
        oldest survivor inherits the role.
        """
        live = self._ordered_locked()
        if not live:
            return
        if any(info.primary for info in live):
            return
        live[0].primary = True
