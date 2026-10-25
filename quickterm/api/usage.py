"""Agent usage for the sidebar footer: GET /api/usage."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI

from quickterm import usage

if TYPE_CHECKING:
    from quickterm.api.context import ApiContext


def claude_limits(app: FastAPI) -> usage.ClaudeLimits:
    """The backend's one store of Claude's latest limits; the agent-event
    route writes it when a status line reports."""
    store = getattr(app.state, "claude_limits", None)
    if store is None:
        store = app.state.claude_limits = usage.ClaudeLimits()
    return store


def codex_reader(app: FastAPI) -> usage.CodexReader:
    reader = getattr(app.state, "codex_reader", None)
    if reader is None:
        reader = app.state.codex_reader = usage.CodexReader()
    return reader


def register(app: FastAPI, ctx: ApiContext) -> None:
    del ctx
    claude = claude_limits(app)
    codex = codex_reader(app)

    @app.get("/api/usage")
    async def get_usage() -> dict[str, Any]:
        # Walking the rollout folder and reading a file's tail block.
        return {"claude": claude.snapshot(), "codex": await asyncio.to_thread(codex.read)}
