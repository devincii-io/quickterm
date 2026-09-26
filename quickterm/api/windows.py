"""Window registry routes, and asking the desktop shell for another window."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from quickterm.api.common import checked_dir, read_json
from quickterm.windows import (
    KEEP,
    WindowError,
    WorkspaceClaimed,
    as_payload,
    normalize_workspace,
)

if TYPE_CHECKING:
    from quickterm.api.context import ApiContext


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


def register(app: FastAPI, ctx: ApiContext) -> None:
    registry = ctx.windows
    open_window = ctx.open_window

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
        body = await read_json(request)
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
        body = await read_json(request)
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
        body = await read_json(request)
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
