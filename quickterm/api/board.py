"""Workspace board routes: the column each saved workspace sits in."""

from __future__ import annotations

import asyncio
import importlib
from typing import TYPE_CHECKING

from fastapi import FastAPI, HTTPException, Request, Response

from quickterm import board, ws_pr
from quickterm.api.common import read_json

if TYPE_CHECKING:
    from quickterm.api.context import ApiContext


def register(app: FastAPI, ctx: ApiContext) -> None:
    workspace_write_lock = ctx.workspace_write_lock

    @app.get("/api/board")
    async def get_board() -> dict:
        workspace = importlib.import_module("quickterm.workspace")  # via sys.modules so tests can stub it

        names = set(await asyncio.to_thread(workspace.list_workspaces))
        status = await asyncio.to_thread(board.load_status)
        # The PR the right panel last saw for each workspace (memory only).
        prs = ws_pr.known_prs()
        return {
            "status": {name: value for name, value in status.items() if name in names},
            "pr": {name: value for name, value in prs.items() if name in names},
        }

    @app.put("/api/board/{name:path}")
    async def put_board(name: str, request: Request) -> Response:
        workspace = importlib.import_module("quickterm.workspace")

        body = await read_json(request)
        status = body.get("status") if isinstance(body, dict) else None
        if status not in board.STATUSES:
            raise HTTPException(400, f"status must be one of {', '.join(board.STATUSES)}")
        # Under the workspace lock: a DELETE that already forgot this name must
        # not see its entry written back a moment later.
        async with workspace_write_lock:
            if await asyncio.to_thread(workspace.load_workspace, name) is None:
                raise HTTPException(404, "no such workspace")
            await asyncio.to_thread(board.set_status, name, status)
        return Response(status_code=204)
