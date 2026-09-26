"""The state every route module shares, built once per app by create_app."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    from quickterm.api.launches import LaunchQueue
    from quickterm.config import AppConfig
    from quickterm.session_manager import SessionManager
    from quickterm.windows import WindowRegistry


@dataclass
class ApiContext:
    manager: SessionManager
    cfg: AppConfig
    token: str
    elevated: bool
    # Several viewer windows share this one backend, so somebody has to say
    # which window owns which workspace; quickterm/windows.py holds that rule
    # and the window routes are only its wire. `open_window` exists only in the
    # pywebview shell: a plain browser opens its own window and never needs it.
    windows: WindowRegistry
    open_window: Callable[[str | None, str | None], str] | None
    allowed_hosts: set[str]
    allowed_origins: set[str]
    launches: LaunchQueue
    # `notify(session_id, name, kind, text)`: tell the desktop shell a session
    # wants the user (flash the taskbar, or a tray balloon while every window
    # is hidden). Called on the loop thread, so it must return at once. None
    # without a desktop shell; the sidebar still shows the state.
    notify: Callable[[str, str, str, str | None], None] | None = None
    inventory_cache: dict[str, Any] = field(default_factory=dict)
    workspace_write_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
