"""Workspace routes: list, read, save and delete a workspace file, and its git facts.

Workspace names may contain `/`, so the name routes use the `path` converter:
Starlette decodes `%2F` before routing, and a plain `{name}` would never
match such a name.
"""

from __future__ import annotations

import asyncio
import importlib
from typing import TYPE_CHECKING

from fastapi import FastAPI, HTTPException, Request, Response

from quickterm import git_info, ws_exec
from quickterm import workspace as workspace_store
from quickterm.api.common import asdict, kill_each, read_json

if TYPE_CHECKING:
    from quickterm.api.context import ApiContext

MAX_GIT_INFO_PATHS = 256


def _folder(workspace: object, value: object, host: str | None) -> str | None:
    """A request's folder: a local path, or a POSIX path in WSL or on the host."""
    if host:
        return workspace_store.normalize_remote_root(value)
    return workspace.normalize_root(value)  # type: ignore[attr-defined]


def _host_field(host: str | None) -> dict:
    # Only a WSL or SSH workspace passes the field, so a local save reads
    # exactly as it did before hosts existed.
    return {"host": host} if host else {}


def _setup_fields(env: dict[str, str], startup: list[dict]) -> dict:
    # Like `host`: only a workspace with a setup passes them.
    fields: dict = {}
    if env:
        fields["env"] = env
    if startup:
        fields["startup"] = startup
    return fields


def _setup(body: dict, existing: object) -> tuple[dict[str, str], list[dict]]:
    """`env` and `startup` of a save: an absent key keeps the stored value, a
    value replaces it (null clears). HTTPException 400 for a bad value."""
    try:
        env = (
            workspace_store.validate_env(body["env"]) if "env" in body
            else dict(getattr(existing, "env", None) or {})
        )
        startup = (
            workspace_store.validate_startup(body["startup"]) if "startup" in body
            else list(getattr(existing, "startup", None) or [])
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return env, startup


def _check_ssh_setup(env: dict[str, str], startup: list[dict], host: str | None) -> None:
    """Over SSH every value is exported in one remote command line, where a
    line break cannot be quoted; refuse it at save, not at every launch."""
    if workspace_store.location_kind(host) != "ssh":
        return
    values = [*env.values(), *(v for item in startup for v in (item.get("env") or {}).values())]
    if any("\n" in value or "\r" in value for value in values):
        raise HTTPException(400, "Over SSH a variable cannot contain a line break.")


def register(app: FastAPI, ctx: ApiContext) -> None:
    manager = ctx.manager
    workspace_write_lock = ctx.workspace_write_lock

    @app.post("/api/git/info")
    async def post_git_info(request: Request) -> dict:
        body = await read_json(request)
        paths = body.get("paths") if isinstance(body, dict) else None
        if not isinstance(paths, list) or not all(isinstance(path, str) for path in paths):
            raise HTTPException(400, "body must be {'paths': [str, ...]}")
        if len(paths) > MAX_GIT_INFO_PATHS:
            raise HTTPException(400, f"at most {MAX_GIT_INFO_PATHS} paths per request")
        return await asyncio.to_thread(git_info.git_info_many, paths)

    def checked_host(value: object) -> str | None:
        """A workspace location from a request: None (this PC), "wsl:<distro>"
        or an SSH destination."""
        try:
            return workspace_store.normalize_host(value)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    # Before the `{name:path}` routes; they answer other methods anyway.
    @app.post("/api/workspaces/remote-check")
    async def remote_check(request: Request) -> dict:
        """Is `path` a folder at `host` (WSL or SSH)? `{"ok": bool, "message":
        str}` with what wsl or ssh printed; a failed check does not stop the
        workspace saving."""
        body = await read_json(request)
        if not isinstance(body, dict):
            raise HTTPException(400, "body must be {'host': ..., 'path': ...}")
        host = checked_host(body.get("host"))
        if host is None:
            raise HTTPException(400, "host is required")
        try:
            path = workspace_store.normalize_remote_root(body.get("path"))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if path is None:
            raise HTTPException(400, "path is required")
        try:
            ok, message = await asyncio.to_thread(ws_exec.check_folder, host, path)
        except FileNotFoundError as exc:
            return {"ok": False, "message": str(exc)}
        return {"ok": ok, "message": message}

    @app.get("/api/workspaces")
    def list_workspaces() -> list[str]:
        workspace = importlib.import_module("quickterm.workspace")  # via sys.modules so tests can stub it

        return workspace.list_workspaces()

    @app.get("/api/workspaces/{name:path}")
    def get_workspace(name: str) -> dict:
        workspace = importlib.import_module("quickterm.workspace")  # via sys.modules so tests can stub it

        ws = workspace.load_workspace(name)
        if ws is None:
            raise HTTPException(404, "no such workspace")
        out = asdict(ws)
        host = getattr(ws, "host", None)
        out["host"] = host
        # Decrypted: only the token-holding frontend reads this route.
        out.setdefault("env", {})
        out.setdefault("startup", [])
        if host:
            # Nothing here may wait for ssh or wsl.exe: the folder check and
            # git answer from what the background calls last found.
            out["path_exists"] = ws_exec.cached_exists(ws)
            out["git"] = git_info.remote_git_info(ws)
            return out
        # A workspace folder can be renamed, unmounted or deleted behind our
        # back. Report it instead of letting every spawn silently land in the
        # home directory with no explanation.
        out["path_exists"] = workspace.root_exists(getattr(ws, "path", None))
        # A sync handler runs in the threadpool, so these file reads stay off the loop.
        out["git"] = git_info.git_info(getattr(ws, "path", None))
        return out

    @app.put("/api/workspaces/{name:path}")
    async def put_workspace(name: str, request: Request) -> Response:
        workspace = importlib.import_module("quickterm.workspace")  # via sys.modules so tests can stub it

        # Dot names are reserved (the right panel's `.scratch` among them);
        # the frontend says the same in validateWorkspaceName.
        if name.strip().startswith("."):
            raise HTTPException(400, "Names starting with a dot are reserved.")
        body = await read_json(request)
        if not isinstance(body, dict) or "layout" not in body:
            raise HTTPException(400, "body must be {'layout': ...}")
        if body.get("logo") is not None and not isinstance(body["logo"], str):
            raise HTTPException(400, "logo must be a string or null")
        raw_session_ids = body.get("session_ids")
        if "temporary" in body and not isinstance(body["temporary"], bool):
            raise HTTPException(400, "temporary must be true or false")
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
            if any(
                key not in body
                for key in ("path", "logo", "session_ids", "temporary", "host", "env", "startup")
            ):
                existing = await asyncio.to_thread(workspace.load_workspace, name)
            env, startup = _setup(body, existing)
            # `host` is three-valued like `path`; the folder is read as a
            # path on whichever host the workspace ends up on.
            host = checked_host(body["host"]) if "host" in body else getattr(existing, "host", None)
            _check_ssh_setup(env, startup, host)
            if "path" in body or ("host" in body and host != getattr(existing, "host", None)):
                try:
                    path = _folder(workspace, body.get("path", getattr(existing, "path", None)), host)
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
                    temporary=body.get("temporary", getattr(existing, "temporary", False)),
                    **_host_field(host),
                    **_setup_fields(env, startup),
                ),
            )
            manager.sync_workspace(name, set(session_ids))
        return Response(status_code=204)

    @app.patch("/api/workspaces/{name:path}")
    async def patch_workspace(name: str, request: Request) -> Response:
        workspace = importlib.import_module("quickterm.workspace")
        body = await read_json(request)
        if (
            not isinstance(body, dict) or not body
            or set(body) - {"path", "logo", "host", "env", "startup"}
        ):
            raise HTTPException(400, "body must contain path, logo, host, env or startup only")
        if body.get("logo") is not None and not isinstance(body["logo"], str):
            raise HTTPException(400, "logo must be a string or null")
        async with workspace_write_lock:
            saved = await asyncio.to_thread(workspace.load_workspace, name)
            if saved is None:
                raise HTTPException(404, "no such workspace")
            old_host = getattr(saved, "host", None)
            host = checked_host(body["host"]) if "host" in body else old_host
            try:
                if "path" in body or host != old_host:
                    path = _folder(workspace, body.get("path", saved.path), host)
                else:
                    path = saved.path
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
            env, startup = _setup(body, saved)
            _check_ssh_setup(env, startup, host)
            # Metadata edits must not submit a stale layout from another viewer.
            await asyncio.to_thread(workspace.save_workspace, workspace.Workspace(
                name=name, layout=saved.layout, path=path,
                logo=body.get("logo", saved.logo), session_ids=saved.session_ids,
                temporary=getattr(saved, "temporary", False),
                **_host_field(host),
                **_setup_fields(env, startup),
            ))
        return Response(status_code=204)

    @app.delete("/api/workspaces/{name:path}")
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
