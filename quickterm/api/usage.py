"""Agent usage for the sidebar footer: GET /api/usage."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI

from quickterm import usage, usage_accounts

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


def _env_dirs(cfg: Any) -> dict[str, list[str]]:
    """Folders the agent settings point Claude Code and Codex at."""
    out: dict[str, list[str]] = {"claude": [], "codex": []}
    agents = getattr(cfg, "agents", None) or {}
    for kind, agent, name in (("claude-code", "claude", "CLAUDE_CONFIG_DIR"), ("codex", "codex", "CODEX_HOME")):
        env = getattr(agents.get(kind), "env", None) or {}
        value = env.get(name) if isinstance(env, dict) else None
        if isinstance(value, str) and value.strip():
            out[agent].append(value.strip())
    return out


def accounts(app: FastAPI, ctx: ApiContext | None = None) -> usage_accounts.Accounts:
    found = getattr(app.state, "usage_accounts", None)
    if found is None:
        cfg = (lambda: ctx.cfg) if ctx is not None else (lambda: None)
        found = app.state.usage_accounts = usage_accounts.Accounts(
            claude_limits=claude_limits(app),
            online=lambda: bool(getattr(cfg(), "usage_online", True)),
            env_dirs=lambda: _env_dirs(cfg()),
        )
    return found


def headline(entries: list[dict[str, Any]], agent: str) -> dict[str, Any] | None:
    """The footer's one number per agent: the account closest to a limit."""
    best = None
    for entry in entries:
        if entry["agent"] != agent or not entry["windows"]:
            continue
        top = max(window["used_percent"] for window in entry["windows"])
        if best is None or top > best[0]:
            best = (top, entry)
    if best is None:
        return None
    entry = best[1]
    return {"windows": entry["windows"], "updated_at": entry["updated_at"], "plan": entry.get("plan")}


def register(app: FastAPI, ctx: ApiContext) -> None:
    claude = claude_limits(app)
    codex = codex_reader(app)
    found = accounts(app, ctx)

    @app.get("/api/usage")
    async def get_usage() -> dict[str, Any]:
        # Never waits for the disk or the network: the accounts answer from
        # their last background refresh, Codex from a cached file tail.
        entries = found.snapshot()
        local_codex = await asyncio.to_thread(codex.read)
        return {
            "claude": headline(entries, "claude") or claude.snapshot(),
            "codex": headline(entries, "codex") or local_codex,
            "accounts": entries,
        }
