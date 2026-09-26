"""Transcript routes: search every terminal's scrollback, export one to a file."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI, HTTPException

from quickterm import transcript

if TYPE_CHECKING:
    from quickterm.api.context import ApiContext

SEARCH_LIMIT_DEFAULT = 200
SEARCH_LIMIT_MAX = 1000


def _search(snapshots: list[tuple[Any, ...]], query: str, limit: int) -> list[dict]:
    pattern = transcript.query_pattern(query)
    out: list[dict] = []
    for sid, name, workspace, alive, (chunks, cols, rows) in snapshots:
        lines = transcript.plain_lines(chunks, cols, rows)
        for hit in transcript.search_lines(lines, pattern):
            out.append(
                {
                    "session_id": sid,
                    "name": name,
                    "workspace": workspace,
                    "alive": alive,
                    "line": hit.line,
                    "text": hit.text,
                    "start": hit.start,
                }
            )
            if len(out) >= limit:
                return out
    return out


def register(app: FastAPI, ctx: ApiContext) -> None:
    manager = ctx.manager

    @app.get("/api/search")
    async def search_terminals(q: str = "", limit: int = SEARCH_LIMIT_DEFAULT) -> list[dict]:
        if not q.strip():
            raise HTTPException(400, "q must not be empty")
        if len(q.encode("utf-8")) > transcript.MAX_QUERY_BYTES:
            raise HTTPException(400, f"q cannot exceed {transcript.MAX_QUERY_BYTES} bytes")
        limit = max(1, min(limit, SEARCH_LIMIT_MAX))
        # The snapshot is taken here, on the loop thread that mutates the
        # registry and the rings; the chunks are immutable bytes, so decoding
        # and matching several MiB can then run in a worker without a lock.
        snapshots = []
        for info in manager.list():
            session = manager.get(info.id)
            if session is None:
                continue
            snapshot = session.scrollback_chunks()
            snapshots.append((info.id, info.name, info.workspace, info.alive, snapshot))
        return await asyncio.to_thread(_search, snapshots, q, limit)

    @app.post("/api/sessions/{sid}/export")
    async def export_session(sid: str) -> dict:
        session = manager.get(sid)
        if session is None:
            raise HTTPException(404, "no such session")
        chunks, cols, rows = session.scrollback_chunks()
        try:
            path = await asyncio.to_thread(
                transcript.export_transcript, session.info.name, chunks, cols, rows
            )
        except OSError as exc:
            raise HTTPException(500, f"could not save the output: {exc}") from exc
        return {"path": str(path)}
