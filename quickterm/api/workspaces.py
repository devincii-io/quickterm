"""Workspace routes: list, read, save and delete a workspace file."""

from __future__ import annotations

import asyncio
import importlib
from typing import TYPE_CHECKING

from fastapi import FastAPI, HTTPException, Request, Response

from quickterm.api.common import asdict, kill_each, read_json

if TYPE_CHECKING:
    from quickterm.api.context import ApiContext


def register(app: FastAPI, ctx: ApiContext) -> None:
    manager = ctx.manager
    workspace_write_lock = ctx.workspace_write_lock

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
        out = asdict(ws)
        # A workspace folder can be renamed, unmounted or deleted behind our
        # back. Report it instead of letting every spawn silently land in the
        # home directory with no explanation.
        out["path_exists"] = workspace.root_exists(getattr(ws, "path", None))
        return out

    @app.put("/api/workspaces/{name}")
    async def put_workspace(name: str, request: Request) -> Response:
        workspace = importlib.import_module("quickterm.workspace")  # via sys.modules so tests can stub it

        body = await read_json(request)
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
                _killed, failed = await asyncio.to_thread(kill_each, manager, doomed)
                if failed:
                    raise HTTPException(500, f"could not stop {len(failed)} terminal process(es)")
            await asyncio.to_thread(workspace.delete_workspace, name)
            manager.sync_workspace(name, set())
        return Response(status_code=204)
