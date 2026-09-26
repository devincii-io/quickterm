"""Session routes: list, spawn, kill, retain, rename, cleanup, kill-all."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from fastapi import FastAPI, HTTPException, Request, Response

from quickterm import launch
from quickterm.api.common import (
    asdict,
    bounded_int,
    kill_each,
    read_json,
    request_workspace,
    resolve_request,
)

if TYPE_CHECKING:
    from quickterm.api.context import ApiContext


def register(app: FastAPI, ctx: ApiContext) -> None:
    manager = ctx.manager

    @app.get("/api/sessions")
    def list_sessions(metrics: bool = True) -> list[dict]:
        # Sidebar/status polling needs lifecycle and attention state, not an
        # expensive full OS process snapshot. Dashboard callers retain the
        # detailed default for backwards compatibility.
        busy_set, usage = manager.session_metrics() if metrics else (set(), {})
        out = []
        for info in manager.list():
            d = asdict(info)
            d["attachments"] = manager.attachment_count(info.id)
            d["busy"] = info.id in busy_set if metrics else None
            d["activity"] = manager.session_activity(info.id)
            if info.id in usage:
                d["usage"] = usage[info.id]
            out.append(d)
        return out

    @app.post("/api/sessions")
    async def spawn_session(request: Request) -> dict:
        body = await read_json(request)
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        cols = bounded_int(body.get("cols", 120), "cols", 2, 1000)
        rows = bounded_int(body.get("rows", 30), "rows", 1, 1000)
        spec = await resolve_request(ctx, body)
        from quickterm.session_manager import SessionLimitError, SpawnError

        try:
            # spawn_async builds the PTY in a worker thread: PATHEXT scan,
            # CreatePseudoConsole and CreateProcess all block.
            info = await manager.spawn_async(
                **spec.spawn_kwargs(),
                cols=cols,
                rows=rows,
                workspace=request_workspace(body),
            )
        except SessionLimitError as exc:
            raise HTTPException(409, str(exc)) from exc
        except SpawnError as exc:
            raise HTTPException(400, launch.describe_failure(spec.label, exc)) from exc
        return asdict(info)

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
        return asdict(session.info)

    @app.patch("/api/sessions/{sid}")
    async def rename_session(sid: str, request: Request) -> dict:
        session = manager.get(sid)
        if session is None:
            raise HTTPException(404, "no such session")
        body = await read_json(request)
        name = str(body.get("name") or "").strip() if isinstance(body, dict) else ""
        if not name:
            raise HTTPException(400, "body must be {'name': <non-empty string>}")
        session.info.name = name[:80]
        return asdict(session.info)

    @app.post("/api/sessions/cleanup")
    async def cleanup_sessions(request: Request) -> Response:
        body = await read_json(request)
        session_ids = body.get("session_ids", []) if isinstance(body, dict) else []
        if not isinstance(session_ids, list):
            session_ids = []
        # manager.kill spawns taskkill and waits on process handles; on the
        # event loop that freezes every pane for the duration.
        _killed, failed = await asyncio.to_thread(
            kill_each, manager, [sid for sid in session_ids if isinstance(sid, str)]
        )
        if failed:
            raise HTTPException(500, f"could not stop {len(failed)} terminal process(es)")
        return Response(status_code=204)

    @app.post("/api/sessions/kill-all")
    def kill_all_sessions() -> dict:
        session_ids = [info.id for info in manager.list() if info.alive]
        killed, failed = kill_each(manager, session_ids)
        # A partial result is still actionable: clients must remove only the
        # sessions the backend verified as stopped and keep failures visible
        # for retry. Returning a generic 500 previously discarded that detail
        # and made Kill all look as though it had done nothing.
        return {"killed": len(killed), "killed_ids": killed, "failed_ids": failed}
