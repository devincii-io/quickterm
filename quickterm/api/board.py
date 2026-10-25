"""Workspace board route: where each saved workspace stands, derived."""

from __future__ import annotations

import asyncio
import importlib
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI

from quickterm import board

if TYPE_CHECKING:
    from quickterm.api.context import ApiContext

SCRATCH = "scratch"


def _workspaces() -> list[Any]:
    """Every saved workspace that is a card: no scratch, no temporary view,
    no reserved dot name. Blocking (the workspace files)."""
    # Through sys.modules so tests can stub the store.
    workspace = importlib.import_module("quickterm.workspace")
    board.forget_manual_board()
    out = []
    for name in workspace.list_workspaces():
        if name == SCRATCH or name.startswith("."):
            continue
        saved = workspace.load_workspace(name)
        if saved is None or getattr(saved, "temporary", False):
            continue
        out.append(saved)
    return out


def register(app: FastAPI, ctx: ApiContext) -> None:
    manager = ctx.manager
    cards = board.Board()
    app.state.board = cards

    def answer(saved: list[Any], terminals: dict[str, list[board.Terminal]]) -> dict:
        found = {ws.name: cards.card(ws.name, ws, terminals.get(ws.name, [])) for ws in saved}
        cards.keep_only(set(found))
        return {"workspaces": found}

    @app.get("/api/board")
    async def get_board() -> dict:
        saved = await asyncio.to_thread(_workspaces)
        # The registry is mutated on this loop, so it is read here; the rest
        # (cache, refresh kicks) runs in a worker.
        terminals: dict[str, list[board.Terminal]] = {}
        for info in list(manager.list()):
            name = getattr(info, "workspace", None)
            if not name:
                continue
            terminals.setdefault(name, []).append(board.terminal_from(
                info, manager.session_attention(info.id), manager.session_agent(info.id),
            ))
        return await asyncio.to_thread(answer, saved, terminals)
