"""FastAPI app: REST session/profile/workspace API, WS attach, static frontend."""

from __future__ import annotations

import asyncio
import dataclasses
import functools
import importlib
import json
import os
import shutil
import subprocess
import time
from collections import deque
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import Headers, MutableHeaders
from starlette.websockets import WebSocketDisconnect

from quickterm import browse, launch, putty_tools
from quickterm.windows import (
    KEEP,
    WindowError,
    WindowRegistry,
    WorkspaceClaimed,
    as_payload,
    normalize_workspace,
)

if TYPE_CHECKING:
    from quickterm.config import AppConfig
    from quickterm.session_manager import Attachment, SessionManager

FILE_READ_CAP = 512 * 1024
JSON_BODY_CAP = 1024 * 1024
FRONTEND_DIR = Path(__file__).resolve().parent / "frontend"
# Max bytes merged into one live output frame. Bounds per-send loop time so the
# input pump interleaves; big enough to collapse bursts into few frames.
_SEND_COALESCE_BYTES = 128 * 1024
INPUT_FRAME_MAX = 256 * 1024
# A long-poll re-checks its client this often. Starlette does not cancel a
# plain HTTP endpoint when the client goes away, so the waiter has to ask.
_LAUNCH_POLL_S = 0.5
_LAUNCH_WAIT_S = 20.0


def client_host(host: str) -> str:
    """The host part of a URL that reaches a server bound to `host`.

    An IPv6 literal needs brackets in a URL and a Host header, and a wildcard
    bind is reached through loopback.
    """
    if host in ("", "0.0.0.0"):
        return "127.0.0.1"
    if host == "::":
        return "[::1]"
    if ":" in host and not host.startswith("["):
        return f"[{host}]"
    return host


def _request_workspace(body: dict) -> str | None:
    name = body.get("workspace")
    if name is not None and not isinstance(name, str):
        raise HTTPException(400, "workspace must be a string")
    return (name or "").strip() or None


def _asdict(obj: Any) -> Any:
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return dataclasses.asdict(obj)
    return dict(vars(obj))


def _claim_conflict(exc: WorkspaceClaimed) -> JSONResponse:
    """409 for a workspace another window already owns.

    Loud on purpose: two windows autosaving one layout silently destroy each
    other's panes, so this is never merged or force-taken. `detail` stays a
    plain string like every other error in this API, and the structured fields
    ride alongside so the UI can name the window that holds it instead of only
    refusing.
    """
    return JSONResponse(
        {
            "detail": str(exc),
            "error": "workspace_claimed",
            "workspace": exc.workspace,
            "owner": as_payload(exc.owner),
        },
        status_code=409,
    )


def _allowed_origins(cfg: "AppConfig") -> tuple[set[str], set[str]]:
    hosts = {f"127.0.0.1:{cfg.port}", f"localhost:{cfg.port}", f"[::1]:{cfg.port}"}
    if cfg.host not in ("127.0.0.1", "localhost", "0.0.0.0", "::"):
        hosts.add(f"{client_host(cfg.host)}:{cfg.port}")
    return hosts, {f"http://{h}" for h in hosts}


class _LaunchQueue:
    """Explorer folder handoffs waiting for the primary window to claim one.

    An asyncio.Queue hands an item to its oldest getter even when that getter's
    client has gone (a reload, a closed window), and the item then vanished
    into a closed socket. Here a waiter takes an item only while its client is
    still there, and puts it back at the front if the client left meanwhile.
    """

    MAX_ITEMS = 32

    def __init__(self) -> None:
        self._items: deque[dict] = deque()
        # Replaced on every change, so a waiter holds the event for the state
        # it last looked at and a change during its own checks still wakes it.
        self.arrived = asyncio.Event()

    def put(self, item: dict) -> None:
        if len(self._items) >= self.MAX_ITEMS:
            self._items.popleft()
        self._items.append(item)
        self._wake()

    def requeue(self, item: dict) -> None:
        self._items.appendleft(item)
        self._wake()

    def pop(self) -> dict | None:
        return self._items.popleft() if self._items else None

    def _wake(self) -> None:
        event, self.arrived = self.arrived, asyncio.Event()
        event.set()


async def _wait_event(event: asyncio.Event, timeout: float) -> None:
    try:
        await asyncio.wait_for(event.wait(), timeout)
    except TimeoutError:
        pass


def create_app(
    manager: "SessionManager",
    cfg: "AppConfig",
    token: str = "",
    elevated: bool = False,
    *,
    windows: WindowRegistry | None = None,
    open_window: Callable[[str | None, str | None], str] | None = None,
) -> FastAPI:
    inventory_cache: dict[str, Any] = {}
    workspace_write_lock = asyncio.Lock()
    from quickterm import auth

    # No docs and no schema: /openapi.json listed every route without asking
    # for the token, the only non-static answer besides /api/health that did.
    app = FastAPI(title="QuickTerm", docs_url=None, redoc_url=None, openapi_url=None)
    pending_launches = _LaunchQueue()
    # Several viewer windows share this one backend, so somebody has to say
    # which window owns which workspace; quickterm/windows.py holds that rule
    # and these routes are only its wire. `open_window` exists only in the
    # pywebview shell: a plain browser opens its own window and never needs it.
    registry = windows if windows is not None else WindowRegistry()
    allowed_hosts, allowed_origins = _allowed_origins(cfg)

    def _token_required(method: str, path: str) -> bool:
        # Sensitive routes = everything under /api that isn't a public probe or a
        # logo loaded by <img> (which can't send headers). Static frontend files
        # carry no secrets and stay open so the shell can bootstrap.
        if not path.startswith("/api/") or path == "/api/health":
            return False
        return not (method == "GET" and path.startswith("/api/assets/"))

    def _refusal(headers: Headers, method: str, path: str) -> str | None:
        if headers.get("host", "") not in allowed_hosts:
            return "forbidden: bad host"
        origin = headers.get("origin")
        if origin is not None and origin not in allowed_origins:
            return "forbidden: bad origin"
        if token and _token_required(method, path) and headers.get(auth.HEADER) != token:
            return "forbidden: bad token"
        return None

    # Local-only trust boundary: the API answers the QuickTerm window and
    # nothing else. The Host allowlist defeats DNS-rebinding (a hostile page
    # pointing its own domain at 127.0.0.1), and the Origin allowlist defeats
    # cross-origin requests from other sites in the same browser, including
    # WebSocket connections, which browsers allow cross-origin by default.
    #
    # A plain ASGI middleware, not @app.middleware("http"): Starlette's
    # BaseHTTPMiddleware wraps `receive`, and through that wrapper
    # request.is_disconnected() never reported a client that had gone, which
    # the launch long-poll depends on.
    class LocalGuard:
        def __init__(self, inner: Any) -> None:
            self.inner = inner

        async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
            if scope["type"] != "http":
                await self.inner(scope, receive, send)
                return
            path = scope["path"]
            refusal = _refusal(Headers(scope=scope), scope["method"], path)
            if refusal is not None:
                await Response(refusal, status_code=403)(scope, receive, send)
                return

            async def send_with_caching(message: Any) -> None:
                if message["type"] == "http.response.start":
                    headers = MutableHeaders(scope=message)
                    if path.startswith("/api/"):
                        headers.setdefault("Cache-Control", "no-store")
                    # Frontend assets carry ETag/Last-Modified but no
                    # Cache-Control, so browsers cache them heuristically and
                    # can serve a stale UI after the app updates. Force
                    # revalidation for the shell (the immutable /api/assets
                    # responses set their own caching).
                    if not path.startswith("/api") and not path.startswith("/ws"):
                        headers.setdefault("Cache-Control", "no-cache")
                await send(message)

            await self.inner(scope, receive, send_with_caching)

    app.add_middleware(LocalGuard)

    def _ws_allowed(ws: WebSocket) -> bool:
        if ws.headers.get("host", "") not in allowed_hosts:
            return False
        origin = ws.headers.get("origin")
        # browsers always send Origin on WS; absent means a native local client
        if not (origin is None or origin in allowed_origins):
            return False
        if token:
            # Browsers cannot set headers on a WS; the token rides in as a
            # Sec-WebSocket-Protocol entry instead (see auth.SUBPROTOCOL_PREFIX).
            offered = ws.headers.get("sec-websocket-protocol", "")
            wanted = auth.SUBPROTOCOL_PREFIX + token
            if wanted not in [p.strip() for p in offered.split(",")]:
                return False
        return True

    @app.get("/api/health")
    def health() -> dict:
        from quickterm import __version__

        return {"app": "quickterm", "version": __version__}

    @app.get("/api/sessions")
    def list_sessions(metrics: bool = True) -> list[dict]:
        # Sidebar/status polling needs lifecycle and attention state, not an
        # expensive full OS process snapshot. Dashboard callers retain the
        # detailed default for backwards compatibility.
        busy_set, usage = manager.session_metrics() if metrics else (set(), {})
        out = []
        for info in manager.list():
            d = _asdict(info)
            d["attachments"] = manager.attachment_count(info.id)
            d["busy"] = info.id in busy_set if metrics else None
            d["activity"] = manager.session_activity(info.id)
            if info.id in usage:
                d["usage"] = usage[info.id]
            out.append(d)
        return out

    async def checked_dir(value: str, label: str | None = None) -> str:
        """launch.validate_dir off the loop: a cold network share can stall."""
        try:
            return await asyncio.to_thread(launch.validate_dir, value, label)
        except launch.LaunchError as exc:
            raise HTTPException(exc.status, str(exc)) from exc

    async def resolve_request(body: dict, *, append_tools: bool = True) -> launch.LaunchSpec:
        """The one path from a request body to a LaunchSpec (spawn and elevate)."""
        workspace_name = _request_workspace(body)
        cwd = body.get("cwd")
        if cwd is not None and not isinstance(cwd, str):
            raise HTTPException(400, "cwd must be a string")
        # A workspace is a folder: every session it owns starts there unless
        # the request names a directory itself (Explorer handoff, or a split
        # inheriting the source pane's cwd). Profiles contribute nothing here.
        request_cwd = cwd if cwd and cwd.strip() else None
        root = None
        if request_cwd is None:
            root = await asyncio.to_thread(launch.workspace_start, workspace_name)
        try:
            return await asyncio.to_thread(
                functools.partial(
                    launch.resolve,
                    cfg,
                    profile=body.get("profile"),
                    cmd=body.get("cmd"),
                    args=body.get("args"),
                    env=body.get("env"),
                    name=body.get("name"),
                    start_command=body.get("start_command"),
                    claude_mode=body.get("claude_mode"),
                    request_cwd=request_cwd,
                    workspace_root=root,
                    append_tools=append_tools,
                )
            )
        except launch.LaunchError as exc:
            raise HTTPException(exc.status, str(exc)) from exc

    @app.post("/api/sessions")
    async def spawn_session(request: Request) -> dict:
        body = await _read_json(request)
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        cols = _bounded_int(body.get("cols", 120), "cols", 2, 1000)
        rows = _bounded_int(body.get("rows", 30), "rows", 1, 1000)
        spec = await resolve_request(body)
        from quickterm.session_manager import SessionLimitError, SpawnError

        try:
            # spawn_async builds the PTY in a worker thread: PATHEXT scan,
            # CreatePseudoConsole and CreateProcess all block.
            info = await manager.spawn_async(
                **spec.spawn_kwargs(),
                cols=cols,
                rows=rows,
                workspace=_request_workspace(body),
            )
        except SessionLimitError as exc:
            raise HTTPException(409, str(exc)) from exc
        except SpawnError as exc:
            raise HTTPException(400, launch.describe_failure(spec.label, exc)) from exc
        return _asdict(info)

    @app.delete("/api/sessions/{sid}")
    def kill_session(sid: str) -> Response:
        try:
            stopped = manager.kill(sid)
        except KeyError:
            # Gone already (the reaper or a grace timer dropped it): there is
            # nothing left running, so the pane may close.
            raise HTTPException(404, "no such session") from None
        if not stopped:
            raise HTTPException(500, "terminal process could not be stopped")
        return Response(status_code=204)

    @app.post("/api/sessions/{sid}/retain")
    def retain_session(sid: str) -> dict:
        """Keep an explicitly detached terminal out of the untouched-shell reaper."""
        session = manager.get(sid)
        if session is None:
            raise HTTPException(404, "no such session")
        session.info.retained = True
        return _asdict(session.info)

    @app.post("/api/launches")
    async def queue_launch(request: Request) -> dict:
        body = await _read_json(request)
        cwd = body.get("cwd") if isinstance(body, dict) else None
        if not isinstance(cwd, str) or not cwd.strip():
            raise HTTPException(400, "cwd must be a non-empty string")
        item = {"cwd": await checked_dir(cwd)}
        pending_launches.put(item)
        return item

    @app.get("/api/launches/next", response_model=None)
    async def next_launch(request: Request, wait: bool = True) -> Any:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + (_LAUNCH_WAIT_S if wait else 0.0)
        while True:
            # Taken before looking, so an item queued while this waiter is
            # busy checking its client still wakes it.
            arrived = pending_launches.arrived
            item = pending_launches.pop()
            if item is not None:
                if await request.is_disconnected():
                    # The window that asked is gone (reload, close). Its 200
                    # would land in a closed socket and the folder would be
                    # lost, so the next live poll gets it instead.
                    pending_launches.requeue(item)
                    return Response(status_code=204)
                return item
            remaining = deadline - loop.time()
            if remaining <= 0 or await request.is_disconnected():
                return Response(status_code=204)
            await _wait_event(arrived, min(_LAUNCH_POLL_S, remaining))

    @app.get("/api/windows")
    def list_windows() -> dict:
        return {"ttl_seconds": registry.ttl_s, "windows": registry.snapshot()}

    @app.post("/api/windows", response_model=None)
    async def register_window(request: Request) -> Any:
        """Announce a window and, optionally, claim its workspace in one step.

        Idempotent for a known id: a page reload must not collide with its own
        claim, and must not be counted twice against the window limit. An
        absent "workspace" key preserves the current claim; an explicit null
        drops it (same three-valued rule as `path` on PUT /api/workspaces).
        """
        body = await _read_json(request)
        if not isinstance(body, dict):
            raise HTTPException(400, "body must be an object")
        try:
            info = registry.register(
                window_id=body.get("id"),
                workspace=body["workspace"] if "workspace" in body else KEEP,
                title=body.get("title", ""),
                primary=bool(body.get("primary")),
            )
        except WorkspaceClaimed as exc:
            return _claim_conflict(exc)
        except WindowError as exc:
            raise HTTPException(exc.status, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return as_payload(info)

    @app.post("/api/windows/{window_id}/heartbeat")
    def beat_window(window_id: str) -> dict:
        # 404 rather than a silent re-register: a window whose entry expired
        # has lost its claim, and it must learn that and claim again instead of
        # carrying on autosaving a workspace someone else may now own.
        try:
            return as_payload(registry.heartbeat(window_id))
        except WindowError as exc:
            raise HTTPException(exc.status, str(exc)) from exc

    @app.put("/api/windows/{window_id}/workspace", response_model=None)
    async def claim_window_workspace(window_id: str, request: Request) -> Any:
        body = await _read_json(request)
        if not isinstance(body, dict) or "workspace" not in body:
            raise HTTPException(400, "body must be {'workspace': <name or null>}")
        try:
            info = registry.claim(window_id, body["workspace"])
        except WorkspaceClaimed as exc:
            return _claim_conflict(exc)
        except WindowError as exc:
            raise HTTPException(exc.status, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return as_payload(info)

    @app.delete("/api/windows/{window_id}")
    def forget_window(window_id: str) -> Response:
        # Idempotent on purpose: this is the goodbye a closing page sends, and
        # it may well arrive twice or after the entry already expired.
        registry.forget(window_id)
        return Response(status_code=204)

    @app.post("/api/windows/open", response_model=None)
    async def open_window_route(request: Request) -> Any:
        """Ask the desktop shell for another window.

        The frontend's primary route is the pywebview bridge
        (`_DesktopApi.open_window`), and in a plain browser it is just
        `window.open`. This exists for the callers that have neither: another
        QuickTerm process handing work to the resident one, which cannot create
        a window itself because the native shells live in this process.
        """
        body = await _read_json(request)
        if not isinstance(body, dict):
            raise HTTPException(400, "body must be an object")
        try:
            name = normalize_workspace(body.get("workspace"))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        cwd = body.get("cwd")
        if cwd is not None:
            if not isinstance(cwd, str) or not cwd.strip():
                raise HTTPException(400, "cwd must be a non-empty string")
            cwd = await checked_dir(cwd)
        if name is not None:
            owner = registry.owner_of(name)
            if owner is not None:
                return _claim_conflict(WorkspaceClaimed(name, owner))
        if open_window is None:
            # No native shell here (plain browser, POSIX, tests). Answering 200
            # with opened=false lets the caller degrade to opening the same URL
            # itself, which is all a browser window ever needed.
            return {"opened": False, "target": "unavailable"}
        try:
            # Creating a window marshals onto the GUI thread and waits for it;
            # that is hundreds of milliseconds of blocking, never on the loop.
            window_id = await asyncio.to_thread(open_window, name, cwd)
        except Exception as exc:
            raise HTTPException(500, f"could not open a window: {exc}") from exc
        return {"opened": True, "target": "native", "window_id": window_id}

    @app.patch("/api/sessions/{sid}")
    async def rename_session(sid: str, request: Request) -> dict:
        session = manager.get(sid)
        if session is None:
            raise HTTPException(404, "no such session")
        body = await _read_json(request)
        name = str(body.get("name") or "").strip() if isinstance(body, dict) else ""
        if not name:
            raise HTTPException(400, "body must be {'name': <non-empty string>}")
        session.info.name = name[:80]
        return _asdict(session.info)

    @app.post("/api/sessions/cleanup")
    async def cleanup_sessions(request: Request) -> Response:
        body = await _read_json(request)
        session_ids = body.get("session_ids", []) if isinstance(body, dict) else []
        if not isinstance(session_ids, list):
            session_ids = []
        # manager.kill spawns taskkill and waits on process handles; on the
        # event loop that freezes every pane for the duration.
        _killed, failed = await asyncio.to_thread(
            _kill_each, manager, [sid for sid in session_ids if isinstance(sid, str)]
        )
        if failed:
            raise HTTPException(500, f"could not stop {len(failed)} terminal process(es)")
        return Response(status_code=204)

    @app.post("/api/sessions/kill-all")
    def kill_all_sessions() -> dict:
        session_ids = [info.id for info in manager.list() if info.alive]
        killed, failed = _kill_each(manager, session_ids)
        # A partial result is still actionable: clients must remove only the
        # sessions the backend verified as stopped and keep failures visible
        # for retry. Returning a generic 500 previously discarded that detail
        # and made Kill all look as though it had done nothing.
        return {"killed": len(killed), "killed_ids": killed, "failed_ids": failed}

    @app.get("/api/profiles")
    def list_profiles() -> list[dict]:
        return [_asdict(p) for p in cfg.profiles]

    @app.get("/api/workspaces")
    def list_workspaces() -> list[str]:
        workspace = importlib.import_module("quickterm.workspace")  # via sys.modules so tests can stub it

        return workspace.list_workspaces()

    @app.get("/api/workspaces/{name}")
    def get_workspace(name: str) -> dict:
        workspace = importlib.import_module("quickterm.workspace")  # via sys.modules so tests can stub it

        ws = workspace.load_workspace(name)
        if ws is None:
            raise HTTPException(404, "no such workspace")
        out = _asdict(ws)
        # A workspace folder can be renamed, unmounted or deleted behind our
        # back. Report it instead of letting every spawn silently land in the
        # home directory with no explanation.
        out["path_exists"] = workspace.root_exists(getattr(ws, "path", None))
        return out

    @app.put("/api/workspaces/{name}")
    async def put_workspace(name: str, request: Request) -> Response:
        workspace = importlib.import_module("quickterm.workspace")  # via sys.modules so tests can stub it

        body = await _read_json(request)
        if not isinstance(body, dict) or "layout" not in body:
            raise HTTPException(400, "body must be {'layout': ...}")
        if body.get("logo") is not None and not isinstance(body["logo"], str):
            raise HTTPException(400, "logo must be a string or null")
        raw_session_ids = body.get("session_ids")
        if raw_session_ids is not None and not isinstance(raw_session_ids, list):
            raise HTTPException(400, "session_ids must be a list or null")
        async with workspace_write_lock:
            # A workspace is edited from one place but autosaved from several,
            # so `path`, `logo` and `session_ids` are three-valued: an ABSENT
            # key preserves the stored value, an explicit null clears it, a
            # value sets it. Without that rule a layout autosave silently
            # dropped the folder, the logo, and the detached sessions the
            # workspace owns (which the reaper then took).
            existing = None
            if any(key not in body for key in ("path", "logo", "session_ids")):
                existing = await asyncio.to_thread(workspace.load_workspace, name)
            if "path" in body:
                try:
                    path = workspace.normalize_root(body.get("path"))
                except ValueError as exc:
                    raise HTTPException(400, str(exc)) from exc
            else:
                path = getattr(existing, "path", None)
            logo = body["logo"] if "logo" in body else getattr(existing, "logo", None)
            if "session_ids" in body:
                session_ids = sorted(
                    {sid for sid in raw_session_ids or [] if isinstance(sid, str) and sid}
                )
            else:
                # The panes in the layout are owned by definition; the stored
                # list adds the detached ones the layout no longer shows.
                owned = workspace.layout_session_ids(body["layout"])
                owned.update(getattr(existing, "session_ids", None) or [])
                session_ids = sorted(owned)
            # The layout autosaves on every pane change, and save_workspace fsyncs.
            # Left on the event loop that stalls every PTY pump for the duration of
            # a durable write.
            await asyncio.to_thread(
                workspace.save_workspace,
                workspace.Workspace(
                    name=name,
                    layout=body["layout"],
                    logo=logo,
                    path=path,
                    session_ids=session_ids,
                ),
            )
            manager.sync_workspace(name, set(session_ids))
        return Response(status_code=204)

    @app.delete("/api/workspaces/{name}")
    async def remove_workspace(name: str) -> Response:
        workspace = importlib.import_module("quickterm.workspace")  # via sys.modules so tests can stub it

        # Under the same lock as PUT: an autosave already inside save_workspace
        # would otherwise write the file back after the unlink, and the deleted
        # workspace reappeared on the next list, folder included.
        async with workspace_write_lock:
            saved = await asyncio.to_thread(workspace.load_workspace, name)
            if saved is not None:
                # Reap the workspace's background sessions, but never one a
                # client is attached to right now. Deleting a workspace must not
                # kill terminals that are open in someone's current layout.
                owned = set(getattr(saved, "session_ids", []) or [])
                owned.update(workspace.layout_session_ids(saved.layout))
                doomed: list[str] = []
                for sid in sorted(owned):
                    session = manager.get(sid)
                    # Workspace files can contain a stale duplicate after an old
                    # client failure. The live owner is authoritative: deleting
                    # A must never kill a terminal that has since moved to B.
                    owns_live_session = session is not None and session.info.workspace == name
                    if owns_live_session and not manager.has_attachments(sid):
                        doomed.append(sid)
                _killed, failed = await asyncio.to_thread(_kill_each, manager, doomed)
                if failed:
                    raise HTTPException(500, f"could not stop {len(failed)} terminal process(es)")
            await asyncio.to_thread(workspace.delete_workspace, name)
            manager.sync_workspace(name, set())
        return Response(status_code=204)

    @app.get("/api/config")
    def get_config() -> dict:
        from quickterm import __version__

        return {
            "font_family": cfg.font_family,
            "font_size": cfg.font_size,
            "theme": cfg.theme,
            "custom_theme": dict(cfg.custom_theme),
            "logo": cfg.logo,
            "default_profile": cfg.default_profile,
            "profiles": [_asdict(p) for p in cfg.profiles],
            "snippets": [_asdict(s) for s in cfg.snippets],
            "voice_available": _voice_available(),
            # Resolved root for the disposable scratch workspace, so the UI can
            # show it and open scratch terminals there.
            "scratch_dir": _scratch_dir(cfg),
            "elevated": elevated,
            "version": __version__,
            "update_check": cfg.update_check,
            "idle_timeout_s": cfg.idle_timeout_s,
            "max_sessions": cfg.max_sessions,
            # Startup hotkey registration failure (another program owns the
            # combination). Settings shows it next to the shortcut field
            # instead of leaving the user with a silently dead shortcut.
            "hotkey_error": getattr(cfg, "hotkey_error", None),
            # Latest autostart, hotkey or elevated first-terminal failure. Those
            # launches have no request to answer, so this is how they are heard.
            "launch_error": getattr(cfg, "launch_error", None),
        }

    @app.get("/api/config/full")
    def get_full_config() -> dict:
        # Serve the PERSISTED config, not the live one. app.py overwrites
        # cfg.port at startup (--port 0, and unconditionally for an elevated
        # instance), and Settings PUTs this whole object straight back, which
        # wrote the ephemeral port into config.json and destroyed the
        # configured one for every later launch. For the same reason a read
        # failure is a 500, never the live config as a fallback.
        config_mod = importlib.import_module("quickterm.config")
        try:
            return _asdict(config_mod.load_config())
        except Exception as exc:
            raise HTTPException(500, "could not read the saved configuration") from exc

    @app.get("/api/system/terminals")
    async def get_system_terminals() -> dict:
        # Probing every shell path and asking wsl.exe for its distributions
        # takes a third of a second, and installed shells do not change between
        # one sidebar rebuild and the next. Off the loop, and remembered for a
        # minute.
        now = time.monotonic()
        cached = inventory_cache.get("value")
        if cached is not None and now - inventory_cache.get("at", 0.0) < 60.0:
            return cached
        value = await asyncio.to_thread(_terminal_inventory)
        inventory_cache.update(value=value, at=time.monotonic())
        return value

    @app.post("/api/elevate")
    async def elevate_terminal(request: Request) -> dict:
        if os.name != "nt":
            raise HTTPException(400, "administrator terminals are only available on Windows")
        body = await _read_json(request)
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        # Resolved exactly like an ordinary terminal, so an administrator
        # terminal opened from a workspace starts in that workspace's folder.
        # The PuTTY tools stay off PATH here: the elevated instance resolves
        # the spec once more and appends them itself.
        resolved = await resolve_request(body, append_tools=False)
        spec = {
            "cmd": resolved.cmd,
            "args": resolved.args,
            "cwd": resolved.cwd,
            "env": resolved.env,
            "name": resolved.name or resolved.label,
        }
        try:
            from quickterm.elevation import launch as launch_elevated

            # ShellExecuteW(..., "runas", ...) does not return until the UAC
            # consent dialog is resolved, up to minutes if the user walks
            # away. On the event loop that parks every PTY pump long enough to
            # overflow the fan-out queues and force every pane to resync.
            await asyncio.to_thread(launch_elevated, spec)
        except (OSError, ValueError) as exc:
            raise HTTPException(500, str(exc)) from exc
        return {"launched": True}

    @app.get("/api/update")
    async def update_check(force: bool = False) -> dict:
        update = importlib.import_module("quickterm.update")  # stubbable in tests
        try:
            # network probe: keep it off the event loop
            return await asyncio.to_thread(update.check, force)
        except Exception as exc:
            raise HTTPException(502, f"update check failed: {exc}") from exc

    @app.post("/api/update/install")
    async def update_install() -> dict:
        update = importlib.import_module("quickterm.update")  # stubbable in tests
        try:
            return await asyncio.to_thread(update.download_and_run)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(502, f"update install failed: {exc}") from exc

    @app.post("/api/open")
    async def open_target(request: Request) -> dict:
        # Ctrl+click on a link/path in a terminal, or with `app` the sidebar's
        # "open this folder in Explorer / VS Code". Token-gated (under /api);
        # opener.py refuses non-http(s) URLs, reveals executables instead of
        # running them, and launches VS Code from Code.exe, never the batch
        # shim.
        opener = importlib.import_module("quickterm.opener")  # stubbable in tests
        body = await _read_json(request)
        target = body.get("target") if isinstance(body, dict) else None
        if not isinstance(target, str):
            raise HTTPException(400, "body must be {'target': <string>}")
        app_name = body.get("app")
        if app_name is not None and not isinstance(app_name, str):
            raise HTTPException(400, "app must be a string")
        try:
            if app_name is not None:
                return await asyncio.to_thread(opener.open_folder, target, app_name)
            return await asyncio.to_thread(opener.open_target, target)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except LookupError as exc:
            # VS Code is not installed: say so, the banner shows the detail.
            raise HTTPException(404, str(exc)) from exc
        except FileNotFoundError:
            raise HTTPException(404, "no such path") from None

    @app.put("/api/config")
    async def put_config(request: Request) -> Response:
        config_mod = importlib.import_module("quickterm.config")

        body = await _read_json(request)
        if not isinstance(body, dict):
            raise HTTPException(400, "invalid config: config must be a JSON object")
        # load_config and save_config fsync, and DPAPI runs once per protected
        # env value: all of it off the loop.
        try:
            on_disk = await asyncio.to_thread(config_mod.load_config)
        except Exception as exc:
            raise HTTPException(500, "could not read the saved configuration") from exc
        # Settings sends the whole object, but config_from_dict fills every
        # omitted key with its default, so a partial body from any other
        # client wiped the profiles (and their protected env) and snippets.
        # Omitted top-level keys keep their saved value instead.
        merged = {**_asdict(on_disk), **body}
        try:
            new_cfg = config_mod.config_from_dict(merged)
            # A client holding a page rendered from the LIVE config (an older
            # build, or a window opened before /api/config/full served the
            # saved one) would write a runtime-only value back to disk. Only
            # the names app.py really overrode at runtime are guarded, and only
            # when the submitted value is that runtime value; everything else
            # is the user's edit, including a revert to the running port.
            for name in sorted(getattr(cfg, "runtime_overrides", None) or ()):
                if getattr(new_cfg, name, None) == getattr(cfg, name, None):
                    setattr(new_cfg, name, getattr(on_disk, name))
            await asyncio.to_thread(config_mod.save_config, new_cfg)
        except (TypeError, ValueError) as exc:
            raise HTTPException(400, f"invalid config: {exc}") from exc
        # Apply live-updatable fields in place; port and global hotkeys need a restart.
        for name in (
            "font_family", "font_size", "theme", "custom_theme", "logo", "idle_timeout_s",
            "max_sessions", "scrollback_bytes", "default_profile", "profiles", "snippets", "voice",
            "update_check", "scratch_dir",
        ):
            if hasattr(new_cfg, name):
                setattr(cfg, name, getattr(new_cfg, name))
        set_limit = getattr(manager, "set_max_sessions", None)
        if set_limit:
            set_limit(cfg.max_sessions)
        set_scrollback = getattr(manager, "set_scrollback_bytes", None)
        if set_scrollback:
            set_scrollback(cfg.scrollback_bytes)
        return Response(status_code=204)

    @app.get("/api/file")
    def read_file(path: str) -> dict:
        # Same cleanup as opener.open_target, so a Ctrl+clicked path behaves
        # the same whether it opens in the viewer or in Explorer.
        p = Path(os.path.expanduser(path.strip().strip('"').strip("'")))
        try:
            if p.is_dir():
                raise HTTPException(400, "path is a directory")
            if not p.is_file():
                raise HTTPException(404, "file not found")
            size = p.stat().st_size
            with p.open("rb") as f:
                data = f.read(FILE_READ_CAP)
        except OSError as exc:
            # An ACL-denied folder, a file another program holds exclusively,
            # a dead share: a sentence for the viewer, not a 500 traceback.
            raise HTTPException(400, f"cannot read {p}: {exc.strerror or exc}") from exc
        return {
            "path": str(p),
            "size": size,
            "truncated": size > FILE_READ_CAP,
            "text": data.decode("utf-8", errors="replace"),
        }

    @app.get("/api/fs/dirs")
    async def list_dirs(path: str | None = None) -> dict:
        # Backs the in-app folder browser, which replaced the native pywebview
        # dialog: that one existed only in the installed app and dropped focus
        # out of the page while it was open.
        #
        # This does widen what a frontend can learn about the host, and
        # `_DesktopApi`'s docstring in app.py used to claim the browser
        # frontend could not learn arbitrary host paths. That claim is no
        # longer true, so it is worth being plain about the size of the change:
        # it is small, because the boundary was never the file system. The
        # server binds 127.0.0.1, every /api route requires the per-install
        # token from auth.py, and behind that token `GET /api/file` already
        # reads any file on the host while `POST /api/sessions` already spawns
        # arbitrary processes. Anything that can call this endpoint can already
        # run `dir` in a PTY and read the output back over the WebSocket. The
        # token and the Host/Origin guard are the real boundary; do not weaken
        # either to make this route more convenient.
        #
        # A directory scan is blocking I/O (a cold network share can take
        # seconds), so it goes to a thread like every other filesystem call
        # here. See the "blocking work never runs on the event loop" rule.
        try:
            return await asyncio.to_thread(browse.list_dirs, path)
        except browse.BrowseError as exc:
            raise HTTPException(404 if exc.missing else 400, str(exc)) from exc

    @app.post("/api/assets")
    async def upload_asset(request: Request) -> dict:
        assets = importlib.import_module("quickterm.assets")
        content_type = request.headers.get("content-type", "")
        # Reject oversized uploads while streaming. ``request.body()`` would
        # first buffer the entire payload, defeating assets.save_asset's cap.
        maximum = int(getattr(assets, "MAX_ASSET_BYTES", 1024 * 1024))
        data = await _read_body(request, maximum)
        try:
            asset_id = await asyncio.to_thread(assets.save_asset, data, content_type)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return {"id": asset_id, "url": f"/api/assets/{asset_id}"}

    @app.get("/api/assets/{asset_id}")
    def get_asset(asset_id: str) -> FileResponse:
        assets = importlib.import_module("quickterm.assets")
        path = assets.asset_path(asset_id)
        if path is None:
            raise HTTPException(404, "no such asset")
        return FileResponse(
            path,
            media_type=assets.content_type_for(asset_id),
            headers={
                "Cache-Control": "private, max-age=31536000, immutable",
                "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.delete("/api/assets/{asset_id}")
    def remove_asset(asset_id: str) -> Response:
        assets = importlib.import_module("quickterm.assets")
        assets.delete_asset(asset_id)
        return Response(status_code=204)

    @app.websocket("/ws/session/{sid}")
    async def ws_session(ws: WebSocket, sid: str) -> None:
        if not _ws_allowed(ws):
            await ws.close(code=4403)
            return
        session = manager.get(sid)
        # Echo the token subprotocol back to complete negotiation cleanly.
        await ws.accept(subprotocol=(auth.SUBPROTOCOL_PREFIX + token) if token else None)
        if session is None:
            await ws.close(code=4404)
            return
        if not session.info.alive:
            # Replay-only reattach. Refusing an exited session outright made
            # overflow permanently lossy: the client is told to reconnect and
            # replay the ring, and if the PTY died around the overflow that
            # replay could never happen, so the session's final output (the
            # build result, the error) was unreachable while still sitting in
            # the ring. Serve the scrollback, report the exit, accept no input.
            try:
                if await _send_replay(ws, session):
                    # This path never calls attach(), which is what normally
                    # marks background output as read. Without it the reaper
                    # keeps an exited session with "unread" output forever.
                    manager.acknowledge(sid)
                    await _send_exit(ws, session)
            except (WebSocketDisconnect, asyncio.CancelledError):
                pass
            return
        # Subscribe before taking the replay snapshot. Both calls are
        # synchronous on the event-loop thread, so output cannot slip between
        # the snapshot and the live queue (the old order permanently lost it).
        try:
            attachment = manager.attach(sid)
        except KeyError:
            # Reaped or killed during the accept above: same answer as a
            # session that was never there.
            await ws.close(code=4404)
            return
        # ...and start draining that subscription immediately: nothing consumed
        # the queue until the live phase began, so a busy session could fill
        # its bounded queue during the (multi-round-trip) handshake and be
        # closed 1013 the instant it went live, and the client then reconnected
        # into exactly the same trap, forever.
        buffer = _HandshakeBuffer(attachment)
        try:
            if not await _send_replay(ws, session):
                return
            # Hand the buffer over, not its contents: _pump_output takes it as
            # its very first statement, so there is never a turn of the loop
            # with nobody draining the queue.
            await _live_phase(ws, attachment, manager, session, sid, buffer)
        except (WebSocketDisconnect, asyncio.CancelledError):
            pass
        finally:
            buffer.take()
            attachment.detach()

    _mount_frontend(app)
    return app


class _HandshakeBuffer:
    """Consume a fresh subscription while the replay handshake is in flight.

    The fan-out queue overflows once its pending bytes pass a cap (2 MiB), and
    the handshake is several round trips (one per 128 KiB replay frame, each
    awaiting an ack), which is ample time for a verbose build to get there;
    the reconnect then landed in the same window every time. Draining here
    keeps the subscription alive; everything collected is handed to the live
    pump in order.
    """

    # Bounded so this cannot become the unbounded buffer the queue cap exists
    # to prevent. Past the cap we stop and let the normal resync take over.
    MAX_BUFFERED_BYTES = 8 * _SEND_COALESCE_BYTES

    def __init__(self, attachment: "Attachment") -> None:
        self._attachment = attachment
        self._items: list = []
        self._taken = False
        # Set once a terminal item (exit or overflow) has been buffered: after
        # that nothing further in the queue can matter, and continuing to
        # collect it would defeat MAX_BUFFERED_BYTES.
        self._sealed = False
        self._task = asyncio.ensure_future(self._drain())

    async def _drain(self) -> None:
        buffered = 0
        while True:
            item = await self._attachment.queue.get()
            self._items.append(item)
            if item is None or item is self._attachment.overflow_sentinel:
                self._sealed = True
                return
            buffered += len(item)
            if buffered >= self.MAX_BUFFERED_BYTES:
                self._items.append(self._attachment.overflow_sentinel)
                self._sealed = True
                return

    def take(self) -> list:
        """Stop draining and return everything buffered, in arrival order."""
        if self._taken:
            return []
        self._taken = True
        self._task.cancel()
        while not self._sealed:
            try:
                self._items.append(self._attachment.queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        return self._items


async def _send_replay(ws: WebSocket, session: Any) -> bool:
    """Run the replay handshake. Returns False if the socket was closed."""
    replay_chunks, cols, rows = session.scrollback_chunks()
    await ws.send_text(json.dumps({"type": "replay_size", "cols": cols, "rows": rows}))
    sent_replay = False
    for frame in _coalesce_replay(replay_chunks):
        sent_replay = True
        await ws.send_bytes(frame)
        # receive(), not receive_text(): the latter indexes message["text"] and
        # a binary frame here escaped as a KeyError and a 1011 close.
        try:
            message = await asyncio.wait_for(ws.receive(), timeout=30)
        except TimeoutError:
            message = None
        if message is not None and message["type"] == "websocket.disconnect":
            return False
        if message is None or not _is_replay_ack(message):
            await ws.close(code=1002, reason="invalid replay acknowledgement")
            return False
    # Keep the original wire shape for empty terminals.  The empty frame has
    # nothing for xterm to parse, so it intentionally does not participate in
    # replay acknowledgement flow control.
    if not sent_replay:
        await ws.send_bytes(b"")
    await ws.send_text(json.dumps({"type": "replay_done"}))
    return True


def _is_replay_ack(message: Any) -> bool:
    text = message.get("text")
    if not isinstance(text, str):
        return False
    try:
        ack = json.loads(text)
    except json.JSONDecodeError:
        return False
    return isinstance(ack, dict) and ack.get("type") == "replay_ack"


def _kill_each(manager: Any, session_ids: list[str]) -> tuple[list[str], list[str]]:
    """Kill several sessions; returns (stopped, still running). Blocking.

    An id the registry no longer holds counts as stopped: the reaper or a kill
    grace timer got there first, and nothing of it is left running.
    """
    killed: list[str] = []
    failed: list[str] = []
    for sid in session_ids:
        try:
            stopped = manager.kill(sid)
        except KeyError:
            stopped = True
        (killed if stopped else failed).append(sid)
    return killed, failed


def _coalesce_replay(chunks: Any):
    """Yield non-empty replay frames no larger than the live-frame cap."""
    pending = bytearray()
    for raw in chunks:
        if not raw:
            continue
        view = memoryview(raw)
        offset = 0
        while offset < len(view):
            take = min(_SEND_COALESCE_BYTES - len(pending), len(view) - offset)
            pending.extend(view[offset:offset + take])
            offset += take
            if len(pending) == _SEND_COALESCE_BYTES:
                yield bytes(pending)
                pending.clear()
    if pending:
        yield bytes(pending)


def _voice_available() -> bool:
    try:
        import quickterm.voice as voice

        return bool(voice.voice_available())
    except Exception:
        return False


def _scratch_dir(cfg: Any) -> str:
    """Resolved scratch root, or "" if the folder cannot be created."""
    config_mod = importlib.import_module("quickterm.config")  # stubbable in tests
    try:
        return config_mod.scratch_root(getattr(cfg, "scratch_dir", "") or "")
    except (OSError, AttributeError):
        return ""


def _terminal_inventory() -> dict:
    if os.name != "nt":
        return _posix_inventory()
    system_root = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    program_files = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
    program_files_x86 = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))
    pwsh_candidates = [program_files / "PowerShell" / "7" / "pwsh.exe"]
    pwsh_candidates.extend(sorted((program_files / "PowerShell").glob("*/pwsh.exe"), reverse=True))
    shells = [
        (
            "claude-code",
            "Claude Code",
            _first_executable("claude"),
        ),
        (
            "powershell-core",
            "PowerShell 7",
            _first_executable("pwsh.exe", *pwsh_candidates),
        ),
        (
            "windows-powershell",
            "Windows PowerShell",
            _first_executable(
                "powershell.exe",
                system_root / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe",
            ),
        ),
        (
            "command-prompt",
            "Command Prompt",
            _first_executable("cmd.exe", system_root / "System32" / "cmd.exe"),
        ),
        (
            "wsl",
            "WSL",
            _first_executable("wsl.exe", system_root / "System32" / "wsl.exe"),
        ),
        (
            "git-bash",
            "Git Bash",
            _first_executable(
                None,
                program_files / "Git" / "bin" / "bash.exe",
                program_files_x86 / "Git" / "bin" / "bash.exe",
            ),
        ),
        ("nushell", "Nushell", _first_executable("nu.exe")),
        ("ssh", "SSH (PuTTY plink)", _optional_str(putty_tools.plink_path())),
        ("sftp", "SFTP (PuTTY psftp)", _optional_str(putty_tools.psftp_path())),
    ]
    distributions: list[str] = []
    wsl = next((exe for type_id, _label, exe in shells if type_id == "wsl"), None)
    if wsl:
        try:
            result = subprocess.run(
                [wsl, "--list", "--quiet"],
                capture_output=True,
                timeout=3,
                check=False,
                # no-console GUI build: without this a console window flashes
                # open every time the launcher refreshes the shell inventory
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            raw = result.stdout
            encoding = "utf-16-le" if b"\x00" in raw else "utf-8"
            distributions = [
                line.strip().replace("\x00", "")
                for line in raw.decode(encoding, errors="replace").splitlines()
                if line.strip().replace("\x00", "")
            ]
        except (OSError, subprocess.SubprocessError):
            pass
    return {
        "types": [
            {
                "id": type_id,
                "label": label,
                "executable": executable,
                "available": executable is not None,
            }
            for type_id, label, executable in shells
        ] + [{"id": "custom", "label": "Custom command", "executable": None, "available": True}],
        "wsl_distributions": distributions,
    }


def _optional_str(path: Path | None) -> str | None:
    return str(path) if path is not None else None


def _first_executable(command: str | None, *candidates: Path) -> str | None:
    """Resolve GUI-app-safe shell paths; PATH alone is not reliable when packaged."""
    if command:
        found = shutil.which(command)
        if found:
            return str(Path(found))
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None


def _posix_inventory() -> dict:
    # user's login shell first, then other common shells found on PATH
    login = os.environ.get("SHELL") or ""
    login_name = Path(login).name if login else ""
    order = [login_name] + [s for s in ("zsh", "bash", "fish") if s != login_name]
    types = []
    claude = shutil.which("claude")
    types.append({
        "id": "claude-code",
        "label": "Claude Code",
        "executable": claude,
        "available": claude is not None,
    })
    for shell in order:
        if not shell:
            continue
        exe = shutil.which(shell)
        types.append({
            "id": shell,
            "label": shell.capitalize() + (" (login shell)" if shell == login_name else ""),
            "executable": exe or shell,
            "available": exe is not None,
        })
    types.append({"id": "custom", "label": "Custom command", "executable": None, "available": True})
    return {"types": types, "wsl_distributions": []}


async def _live_phase(
    ws: WebSocket,
    attachment: "Attachment",
    manager: "SessionManager",
    session: Any,
    sid: str,
    buffer: "_HandshakeBuffer | None" = None,
) -> None:
    out = asyncio.ensure_future(_pump_output(ws, attachment, session, buffer))
    inp = asyncio.ensure_future(_pump_input(ws, manager, sid))
    try:
        done, pending = await asyncio.wait({out, inp}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            if task.cancelled():
                continue
            exc = task.exception()
            if exc is not None and not isinstance(exc, WebSocketDisconnect):
                raise exc
    finally:
        for task in (out, inp):
            if not task.done():
                task.cancel()
        await asyncio.gather(out, inp, return_exceptions=True)


async def _pump_output(
    ws: WebSocket,
    attachment: "Attachment",
    session: Any,
    buffer: "_HandshakeBuffer | None" = None,
) -> None:
    # queue yields raw PTY bytes; None sentinel = session exited
    # Take over from the handshake buffer BEFORE the first await, so no turn of
    # the loop passes with the subscriber queue unconsumed. `pending` holds
    # what it collected and is drained, in order, ahead of the live queue.
    pending = buffer.take() if buffer is not None else []

    async def _next() -> Any:
        return pending.pop(0) if pending else await attachment.queue.get()

    def _next_nowait() -> Any:
        if pending:
            return pending.pop(0)
        return attachment.queue.get_nowait()

    carry: bytes | None = None
    while True:
        chunk = carry if carry is not None else await _next()
        carry = None
        if chunk is None:
            await _send_exit(ws, session)
            return
        if chunk is attachment.overflow_sentinel:
            await ws.send_text(json.dumps({"type": "overflow"}))
            await ws.close(code=1013, reason="viewer fell behind; reconnect to replay")
            return
        # Coalesce whatever else is already queued into a single frame (capped so
        # one send can't monopolize the loop and starve input). Raw bytes stay a
        # plain byte stream to the client, so this is wire-compatible.
        if len(chunk) > _SEND_COALESCE_BYTES:
            carry = chunk[_SEND_COALESCE_BYTES:]
            chunk = chunk[:_SEND_COALESCE_BYTES]
        parts = [chunk]
        total = len(chunk)
        exited = False
        while total < _SEND_COALESCE_BYTES:
            try:
                item = _next_nowait()
            except asyncio.QueueEmpty:
                break
            if item is None:
                exited = True
                break
            if item is attachment.overflow_sentinel:
                await ws.send_text(json.dumps({"type": "overflow"}))
                await ws.close(code=1013, reason="viewer fell behind; reconnect to replay")
                return
            remaining = _SEND_COALESCE_BYTES - total
            parts.append(item[:remaining])
            total += min(len(item), remaining)
            if len(item) > remaining:
                carry = item[remaining:]
                break
        await ws.send_bytes(parts[0] if len(parts) == 1 else b"".join(parts))
        if exited:
            await _send_exit(ws, session)
            return


async def _send_exit(ws: WebSocket, session: Any) -> None:
    await ws.send_text(json.dumps({"type": "exit", "code": session.info.exit_code}))
    await ws.close()


async def _pump_input(ws: WebSocket, manager: "SessionManager", sid: str) -> None:
    while True:
        msg = await ws.receive()
        if msg["type"] == "websocket.disconnect":
            return
        if msg.get("bytes") is not None:
            data = msg["bytes"]
            if len(data) > INPUT_FRAME_MAX:
                await ws.close(code=1009, reason="input frame too large")
                return
            try:
                manager.write(sid, data)
            except BufferError:
                await ws.close(code=1013, reason="terminal input queue is full")
                return
        elif msg.get("text"):
            try:
                ctrl = json.loads(msg["text"])
            except (TypeError, json.JSONDecodeError):
                continue
            if not isinstance(ctrl, dict):
                continue
            if ctrl.get("type") == "touch":
                # The client's word that a person typed or pasted. Input bytes
                # alone cannot say it: xterm answers DA/DSR/CPR queries and
                # focus reports through the same stream.
                manager.touch(sid)
            elif ctrl.get("type") == "resize":
                try:
                    cols = _bounded_int(ctrl.get("cols"), "cols", 2, 1000)
                    rows = _bounded_int(ctrl.get("rows"), "rows", 1, 1000)
                except HTTPException:
                    continue
                manager.resize(sid, cols, rows)


def _bounded_int(value: Any, name: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool):
        raise HTTPException(400, f"{name} must be an integer")
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        raise HTTPException(400, f"{name} must be an integer") from None
    if number < minimum or number > maximum:
        raise HTTPException(400, f"{name} must be between {minimum} and {maximum}")
    return number


async def _read_json(request: Request, maximum: int = JSON_BODY_CAP) -> Any:
    """Read a bounded JSON body without first buffering an unbounded request."""
    raw = await _read_body(request, maximum)
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(400, "request body must be valid JSON") from exc


async def _read_body(request: Request, maximum: int) -> bytes:
    """Read at most ``maximum`` bytes, including chunked request bodies."""
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > maximum:
                raise HTTPException(413, f"request body cannot exceed {maximum} bytes")
        except ValueError:
            raise HTTPException(400, "invalid Content-Length header") from None
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > maximum:
            raise HTTPException(413, f"request body cannot exceed {maximum} bytes")
        chunks.append(chunk)
    return b"".join(chunks)


def _mount_frontend(app: FastAPI) -> None:
    # mounted last so /api and /ws routes win; skipped when frontend/ absent (tests)
    if not FRONTEND_DIR.is_dir():
        return
    viewer = FRONTEND_DIR / "viewer.html"
    if viewer.is_file():

        @app.get("/viewer")
        def viewer_page() -> FileResponse:
            return FileResponse(viewer)

    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
