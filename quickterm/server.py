"""FastAPI app: REST session/profile/workspace API, WS attach, static frontend."""

from __future__ import annotations

import asyncio
import dataclasses
import importlib
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocketDisconnect

from quickterm import putty_tools

if TYPE_CHECKING:
    from quickterm.config import AppConfig
    from quickterm.session_manager import Attachment, SessionManager

FILE_READ_CAP = 512 * 1024
JSON_BODY_CAP = 1024 * 1024
FRONTEND_DIR = Path(__file__).resolve().parent / "frontend"
# Max bytes merged into one live output frame. Bounds per-send loop time so the
# input pump interleaves; big enough to collapse bursts into few frames.
_SEND_COALESCE_BYTES = 128 * 1024
def _asdict(obj: Any) -> Any:
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return dataclasses.asdict(obj)
    return dict(vars(obj))


def _allowed_origins(cfg: "AppConfig") -> tuple[set[str], set[str]]:
    hosts = {f"127.0.0.1:{cfg.port}", f"localhost:{cfg.port}", f"[::1]:{cfg.port}"}
    if cfg.host not in ("127.0.0.1", "localhost", "0.0.0.0", "::"):
        hosts.add(f"{cfg.host}:{cfg.port}")
    return hosts, {f"http://{h}" for h in hosts}


def create_app(
    manager: "SessionManager", cfg: "AppConfig", token: str = "", elevated: bool = False
) -> FastAPI:
    from quickterm import auth

    app = FastAPI(title="QuickTerm", docs_url=None, redoc_url=None)
    pending_launches: asyncio.Queue[dict] = asyncio.Queue(maxsize=32)
    allowed_hosts, allowed_origins = _allowed_origins(cfg)

    def _token_required(request: Request) -> bool:
        # Sensitive surface = everything under /api that isn't a public probe or a
        # logo loaded by <img> (which can't send headers). Static frontend files
        # carry no secrets and stay open so the shell can bootstrap.
        path = request.url.path
        if not path.startswith("/api/") or path == "/api/health":
            return False
        return not (request.method == "GET" and path.startswith("/api/assets/"))

    # Local-only trust boundary: the API answers the QuickTerm window and
    # nothing else. The Host allowlist defeats DNS-rebinding (a hostile page
    # pointing its own domain at 127.0.0.1), and the Origin allowlist defeats
    # cross-origin requests from other sites in the same browser — including
    # WebSocket connections, which browsers allow cross-origin by default.
    @app.middleware("http")
    async def _local_guard(request: Request, call_next):
        if request.headers.get("host", "") not in allowed_hosts:
            return Response("forbidden: bad host", status_code=403)
        origin = request.headers.get("origin")
        if origin is not None and origin not in allowed_origins:
            return Response("forbidden: bad origin", status_code=403)
        if token and _token_required(request) and request.headers.get(auth.HEADER) != token:
            return Response("forbidden: bad token", status_code=403)
        path = request.url.path
        response = await call_next(request)
        if path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        # Frontend assets carry ETag/Last-Modified but no Cache-Control, so
        # browsers cache them heuristically and can serve a stale UI after the
        # app updates. Force revalidation for the shell (the immutable, hashed
        # /api/assets responses set their own long-lived caching).
        if not path.startswith("/api") and not path.startswith("/ws"):
            response.headers.setdefault("Cache-Control", "no-cache")
        return response

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

    @app.post("/api/sessions")
    async def spawn_session(request: Request) -> dict:
        body = await _read_json(request)
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        profile_name = body.get("profile")
        cmd = body.get("cmd")
        args = body.get("args")
        cwd = body.get("cwd")
        env = body.get("env")
        start_command = body.get("start_command")
        claude_mode = body.get("claude_mode")
        workspace_name = body.get("workspace")
        if workspace_name is not None and not isinstance(workspace_name, str):
            raise HTTPException(400, "workspace must be a string")
        workspace_name = (workspace_name or "").strip() or None
        # A workspace is a folder: every session it owns starts there unless
        # the request names a directory itself (Explorer handoff, or a split
        # inheriting the source pane's cwd). Profiles contribute only a
        # subfolder relative to that root.
        request_cwd = cwd if isinstance(cwd, str) and cwd.strip() else None

        async def workspace_cwd(subpath: object) -> str | None:
            if not workspace_name:
                return None
            workspace_mod = importlib.import_module("quickterm.workspace")

            def read() -> str | None:
                saved = workspace_mod.load_workspace(workspace_name)
                if saved is None:
                    return None
                return workspace_mod.resolve_start_dir(
                    getattr(saved, "path", None),
                    subpath if isinstance(subpath, str) else None,
                )

            return await asyncio.to_thread(read)

        prof = None
        if profile_name is not None:
            if not isinstance(profile_name, str) or not profile_name.strip():
                raise HTTPException(400, "profile must be a non-empty string")
            prof = next((p for p in cfg.profiles if p.name == profile_name), None)
            if prof is None:
                raise HTTPException(404, f"unknown profile: {profile_name}")
            if start_command is not None:
                if not isinstance(start_command, str) or len(start_command) > 8192:
                    raise HTTPException(400, "start_command must be a string of at most 8192 characters")
                prof = dataclasses.replace(prof, start_command=start_command)
            if claude_mode is not None:
                if getattr(prof, "terminal_type", None) != "claude-code":
                    raise HTTPException(400, "claude_mode requires a Claude Code profile")
                if claude_mode not in {"new", "continue", "resume", "agents"}:
                    raise HTTPException(400, "claude_mode must be new, continue, resume, or agents")
                prof = dataclasses.replace(prof, claude_mode=claude_mode)
            # A profile carrying its own `cwd` is pinned on purpose ("Always
            # this folder" in Settings) and opts out of the workspace root;
            # only an explicit request directory overrides it.
            pinned = isinstance(getattr(prof, "cwd", None), str) and prof.cwd.strip()
            effective_cwd = request_cwd
            if effective_cwd is None and not pinned:
                effective_cwd = await workspace_cwd(getattr(prof, "subpath", None))
            try:
                resolved_cmd, resolved_args, resolved_cwd = _resolve_profile(prof, effective_cwd)
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
            cmd = cmd or resolved_cmd
            args = args if args is not None else resolved_args
            # _resolve_profile incorporates the request override.  WSL embeds
            # it in `--cd` and deliberately returns no Windows process cwd.
            cwd = resolved_cwd
            env = env if env is not None else dict(prof.env)
        elif start_command is not None or claude_mode is not None:
            raise HTTPException(400, "start_command and claude_mode require a profile")
        else:
            # System shells carry no profile, so the workspace root is the only
            # thing that can place them.
            cwd = request_cwd or await workspace_cwd(None)
        if not isinstance(cmd, str) or not cmd.strip():
            raise HTTPException(400, "either 'profile' or 'cmd' is required")
        cmd = cmd.strip()
        if args is not None and (
            not isinstance(args, list) or len(args) > 1024
            or any(not isinstance(arg, str) for arg in args)
        ):
            raise HTTPException(400, "args must be a list of at most 1024 strings")
        if env is not None:
            config_mod = importlib.import_module("quickterm.config")
            try:
                env = config_mod.validate_environment(env)
            except ValueError as exc:
                raise HTTPException(400, f"invalid env: {exc}") from exc
        if cwd is not None and not isinstance(cwd, str):
            raise HTTPException(400, "cwd must be a string")
        if cwd:
            resolved_cwd = Path(os.path.expandvars(os.path.expanduser(str(cwd))))
            if not resolved_cwd.is_dir():
                label = profile_name or body.get("name") or cmd
                raise HTTPException(
                    400,
                    f'Terminal profile "{label}": starting folder does not exist: {cwd}',
                )
            cwd = str(resolved_cwd)
        name = body.get("name")
        if name is not None and not isinstance(name, str):
            raise HTTPException(400, "name must be a string")
        cols = _bounded_int(body.get("cols", 120), "cols", 2, 1000)
        rows = _bounded_int(body.get("rows", 30), "rows", 1, 1000)
        tools = putty_tools.tools_dir()
        if tools is not None:
            # Appended (not prepended) so a user-installed plink/pscp still wins.
            env = dict(env or {})
            path_key = next((k for k in env if k.upper() == "PATH"), "PATH")
            base_path = env.get(path_key) or os.environ.get("PATH", "")
            env[path_key] = f"{base_path}{os.pathsep}{tools}" if base_path else str(tools)
        try:
            info = manager.spawn(
                name=name.strip()[:80] if name and name.strip() else None,
                profile=profile_name,
                cmd=cmd,
                args=args or [],
                cwd=cwd,
                env=env or {},
                cols=cols,
                rows=rows,
                workspace=workspace_name,
            )
        except Exception as exc:
            from quickterm.session_manager import SessionLimitError

            if isinstance(exc, SessionLimitError):
                raise HTTPException(409, str(exc)) from exc
            raise
        return _asdict(info)

    @app.delete("/api/sessions/{sid}")
    def kill_session(sid: str) -> Response:
        if manager.get(sid) is None:
            raise HTTPException(404, "no such session")
        if manager.kill(sid) is False:
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
        resolved = Path(os.path.expandvars(os.path.expanduser(cwd)))
        if not resolved.is_dir():
            raise HTTPException(400, "launch folder does not exist")
        launch = {"cwd": str(resolved)}
        if pending_launches.full():
            try:
                pending_launches.get_nowait()
            except asyncio.QueueEmpty:
                pass
        pending_launches.put_nowait(launch)
        return launch

    @app.get("/api/launches/next", response_model=None)
    async def next_launch(wait: bool = True) -> Any:
        try:
            return await asyncio.wait_for(
                pending_launches.get(), timeout=20.0 if wait else 0.001
            )
        except TimeoutError:
            return Response(status_code=204)

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

        def _kill_all() -> list[str]:
            # manager.kill spawns taskkill and waits on process handles; on the
            # event loop that freezes every pane for the duration.
            missed: list[str] = []
            for sid in session_ids:
                if isinstance(sid, str) and manager.get(sid) is not None:
                    if manager.kill(sid) is False:
                        missed.append(sid)
            return missed

        failed = await asyncio.to_thread(_kill_all)
        if failed:
            raise HTTPException(500, f"could not stop {len(failed)} terminal process(es)")
        return Response(status_code=204)

    @app.post("/api/sessions/kill-all")
    def kill_all_sessions() -> dict:
        session_ids = [info.id for info in manager.list() if info.alive]
        killed: list[str] = []
        failed: list[str] = []
        for sid in session_ids:
            if manager.kill(sid) is False:
                failed.append(sid)
            else:
                killed.append(sid)
        # A partial result is still actionable: clients must remove only the
        # sessions the backend verified as stopped and keep failures visible
        # for retry. Returning a generic 500 previously discarded that detail
        # and made Kill all look as though it had done nothing.
        return {"killed": len(killed), "killed_ids": killed, "failed_ids": failed}

    @app.get("/api/profiles")
    def list_profiles() -> list[dict]:
        return [_asdict(p) for p in cfg.profiles]

    @app.get("/api/snippets")
    def list_snippets() -> list[dict]:
        return [_asdict(s) for s in cfg.snippets]

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
        logo = body.get("logo")
        raw_session_ids = body.get("session_ids")
        session_ids = (
            [sid for sid in raw_session_ids if isinstance(sid, str) and sid]
            if isinstance(raw_session_ids, list)
            else sorted(_layout_session_ids(body["layout"]))
        )
        # The workspace folder is edited from one place but autosaved from
        # several. An ABSENT "path" key preserves the stored folder; an
        # explicit null clears it. Without that rule every layout autosave
        # would silently drop the folder the user just chose.
        if "path" in body:
            try:
                path = workspace.normalize_root(body.get("path"))
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
        else:
            existing = await asyncio.to_thread(workspace.load_workspace, name)
            path = getattr(existing, "path", None) if existing is not None else None
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
    def remove_workspace(name: str) -> Response:
        workspace = importlib.import_module("quickterm.workspace")  # via sys.modules so tests can stub it

        saved = workspace.load_workspace(name)
        if saved is not None:
            # Reap the workspace's background sessions, but never one a client
            # is attached to right now — deleting a workspace must not kill
            # terminals that are open in someone's current layout.
            owned = set(getattr(saved, "session_ids", []) or [])
            owned.update(_layout_session_ids(saved.layout))
            failed: list[str] = []
            for sid in owned:
                session = manager.get(sid)
                # Workspace files can contain a stale duplicate after an old
                # client failure. The live owner is authoritative: deleting A
                # must never kill a terminal that has since moved to B.
                owns_live_session = session is not None and session.info.workspace == name
                if owns_live_session and not manager.has_attachments(sid):
                    if manager.kill(sid) is False:
                        failed.append(sid)
            if failed:
                raise HTTPException(500, f"could not stop {len(failed)} terminal process(es)")
        manager.sync_workspace(name, set())
        workspace.delete_workspace(name)
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
        }

    @app.get("/api/config/full")
    def get_full_config() -> dict:
        # Serve the PERSISTED config, not the live one. app.py overwrites
        # cfg.port at startup (--port 0, and unconditionally for an elevated
        # instance), and Settings PUTs this whole object straight back — which
        # wrote the ephemeral port into config.json and destroyed the
        # configured one for every later launch.
        config_mod = importlib.import_module("quickterm.config")
        try:
            return _asdict(config_mod.load_config())
        except Exception:
            return _asdict(cfg)

    @app.get("/api/system/terminals")
    def get_system_terminals() -> dict:
        return _terminal_inventory()

    @app.post("/api/elevate")
    async def elevate_terminal(request: Request) -> dict:
        if os.name != "nt":
            raise HTTPException(400, "administrator terminals are only available on Windows")
        body = await _read_json(request)
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        profile_name = body.get("profile")
        # An administrator terminal opened from a workspace belongs in that
        # workspace's folder, exactly like an ordinary one.
        requested_workspace = body.get("workspace")
        workspace_cwd = None
        if isinstance(requested_workspace, str) and requested_workspace.strip():
            workspace_mod = importlib.import_module("quickterm.workspace")

            def _elevated_cwd(name: str, subpath: object) -> str | None:
                saved = workspace_mod.load_workspace(name)
                if saved is None:
                    return None
                return workspace_mod.resolve_start_dir(
                    getattr(saved, "path", None),
                    subpath if isinstance(subpath, str) else None,
                )

        if profile_name is not None:
            prof = next((p for p in cfg.profiles if p.name == profile_name), None)
            if prof is None:
                raise HTTPException(404, f"unknown profile: {profile_name}")
            pinned = isinstance(getattr(prof, "cwd", None), str) and prof.cwd.strip()
            if not pinned and isinstance(requested_workspace, str) and requested_workspace.strip():
                workspace_cwd = await asyncio.to_thread(
                    _elevated_cwd, requested_workspace.strip(), getattr(prof, "subpath", None)
                )
            try:
                cmd, args, cwd = _resolve_profile(prof, workspace_cwd)
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
            spec = {
                "cmd": cmd,
                "args": args,
                "cwd": cwd,
                "env": dict(prof.env),
                "name": prof.name,
            }
        else:
            spec = dict(body)
            spec.pop("workspace", None)
            if not (isinstance(spec.get("cwd"), str) and spec["cwd"].strip()) and (
                isinstance(requested_workspace, str) and requested_workspace.strip()
            ):
                resolved = await asyncio.to_thread(
                    _elevated_cwd, requested_workspace.strip(), None
                )
                if resolved:
                    spec["cwd"] = resolved
        try:
            from quickterm.elevation import launch

            # ShellExecuteW(..., "runas", ...) does not return until the UAC
            # consent dialog is resolved — up to minutes if the user walks
            # away. On the event loop that parks every PTY pump long enough to
            # overflow the fan-out queues and force every pane to resync.
            await asyncio.to_thread(launch, spec)
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
        # Ctrl+click on a link/path in a terminal. Token-gated (under /api);
        # opener.py refuses non-http(s) URLs and reveals executables instead
        # of running them.
        opener = importlib.import_module("quickterm.opener")  # stubbable in tests
        body = await _read_json(request)
        target = body.get("target") if isinstance(body, dict) else None
        if not isinstance(target, str):
            raise HTTPException(400, "body must be {'target': <string>}")
        try:
            return await asyncio.to_thread(opener.open_target, target)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except FileNotFoundError:
            raise HTTPException(404, "no such path") from None

    @app.put("/api/config")
    async def put_config(request: Request) -> Response:
        config_mod = importlib.import_module("quickterm.config")

        try:
            new_cfg = config_mod.config_from_dict(await _read_json(request))
            # Belt to /api/config/full's braces: a client holding a page that
            # was rendered from the LIVE config (an older build, or a window
            # opened before this fix) would otherwise write the runtime port
            # back to disk. A value identical to the runtime one was not
            # edited by the user, so the persisted value wins.
            try:
                on_disk = config_mod.load_config()
            except Exception:
                on_disk = None
            if on_disk is not None:
                for name in ("port", "host", "summon_hotkey"):
                    if getattr(new_cfg, name, None) == getattr(cfg, name, None):
                        setattr(new_cfg, name, getattr(on_disk, name))
            config_mod.save_config(new_cfg)
        except (TypeError, ValueError) as exc:
            raise HTTPException(400, f"invalid config: {exc}") from exc
        # Apply live-updatable fields in place; port and global hotkeys need a restart.
        for name in (
            "font_family", "font_size", "theme", "custom_theme", "logo", "idle_timeout_s",
            "max_sessions", "scrollback_bytes", "default_profile", "profiles", "snippets", "voice", "update_check",
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
        p = Path(path)
        if p.is_dir():
            raise HTTPException(400, "path is a directory")
        if not p.is_file():
            raise HTTPException(404, "file not found")
        size = p.stat().st_size
        with p.open("rb") as f:
            data = f.read(FILE_READ_CAP)
        return {
            "path": str(p),
            "size": size,
            "truncated": size > FILE_READ_CAP,
            "text": data.decode("utf-8", errors="replace"),
        }

    @app.post("/api/assets")
    async def upload_asset(request: Request) -> dict:
        assets = importlib.import_module("quickterm.assets")
        content_type = request.headers.get("content-type", "")
        # Reject oversized uploads while streaming. ``request.body()`` would
        # first buffer the entire payload, defeating assets.save_asset's cap.
        maximum = int(getattr(assets, "MAX_ASSET_BYTES", 1024 * 1024))
        data = await _read_body(request, maximum)
        try:
            asset_id = assets.save_asset(data, content_type)
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
            # replay could never happen — so the session's final output (the
            # build result, the error) was unreachable while still sitting in
            # the ring. Serve the scrollback, report the exit, accept no input.
            try:
                if await _send_replay(ws, session):
                    await _send_exit(ws, session)
            except (WebSocketDisconnect, asyncio.CancelledError):
                pass
            return
        # Subscribe before taking the replay snapshot. Both calls are
        # synchronous on the event-loop thread, so output cannot slip between
        # the snapshot and the live queue (the old order permanently lost it).
        attachment = manager.attach(sid)
        # ...and start draining that subscription immediately: nothing consumed
        # the queue until the live phase began, so a busy session could fill
        # its 8-item queue during the (multi-round-trip) handshake and be
        # closed 1013 the instant it went live — the client then reconnected
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

    The fan-out queue counts items, not bytes, so eight PTY reader callbacks
    are enough to mark an attachment overflowed. The handshake is several
    round trips (one per 128 KiB replay frame, each awaiting an ack), which is
    ample time for a verbose build to produce them — and the reconnect landed
    in the same window every time. Draining here keeps the subscription alive;
    everything collected is handed to the live pump in order.
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
    chunks_fn = getattr(session, "scrollback_chunks", None)
    if chunks_fn is not None:
        replay_chunks, cols, rows = chunks_fn()
    else:  # test fakes and third-party managers implementing the old surface
        data, cols, rows = session.scrollback()
        replay_chunks = (data,) if data else ()
    await ws.send_text(json.dumps({"type": "replay_size", "cols": cols, "rows": rows}))
    sent_replay = False
    for frame in _coalesce_replay(replay_chunks):
        sent_replay = True
        await ws.send_bytes(frame)
        try:
            ack_text = await asyncio.wait_for(ws.receive_text(), timeout=30)
            ack = json.loads(ack_text)
        except (asyncio.TimeoutError, TypeError, json.JSONDecodeError):
            await ws.close(code=1002, reason="invalid replay acknowledgement")
            return False
        if not isinstance(ack, dict) or ack.get("type") != "replay_ack":
            await ws.close(code=1002, reason="invalid replay acknowledgement")
            return False
    # Keep the original wire shape for empty terminals.  The empty frame has
    # nothing for xterm to parse, so it intentionally does not participate in
    # replay acknowledgement flow control.
    if not sent_replay:
        await ws.send_bytes(b"")
    await ws.send_text(json.dumps({"type": "replay_done"}))
    return True


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


def _resolve_profile(prof: Any, cwd_override: str | None = None) -> tuple[str, list[str], str | None]:
    terminal_type = getattr(prof, "terminal_type", None)
    start = (getattr(prof, "start_command", None) or "").strip()
    cwd = cwd_override or getattr(prof, "cwd", None)
    existing_args = list(getattr(prof, "args", []) or [])

    if terminal_type == "claude-code":
        executable = (getattr(prof, "cmd", None) or "").strip()
        if not executable:
            executable = shutil.which("claude") or ("claude.exe" if os.name == "nt" else "claude")
        mode = getattr(prof, "claude_mode", None) or "continue"
        if not isinstance(cwd, str) or not cwd.strip():
            raise ValueError("Claude Code profile requires a project folder")
        mode_args = {
            "new": [], "continue": ["--continue"], "resume": ["--resume"],
            "agents": ["agents", "--cwd", cwd],
        }
        return executable, mode_args.get(mode, ["--continue"]) + existing_args, cwd
    if terminal_type == "powershell-core":
        args = ["-NoLogo"]
        if start:
            args += ["-NoExit", "-Command", start]
        return "pwsh.exe", args, cwd
    if terminal_type == "windows-powershell":
        args = ["-NoLogo"]
        if start:
            args += ["-NoExit", "-Command", start]
        return "powershell.exe", args, cwd
    if terminal_type == "command-prompt":
        return "cmd.exe", (["/K", start] if start else []), cwd
    if terminal_type == "wsl":
        args: list[str] = []
        distro = (getattr(prof, "wsl_distro", None) or "").strip()
        if distro:
            args += ["-d", distro]
        # wsl.exe otherwise inherits QuickTerm's Windows process directory and
        # opens under /mnt/c.  A blank profile belongs in the distro's own
        # home; explicit Linux and Windows paths are both accepted by --cd.
        args += ["--cd", cwd or "~"]
        if start:
            args += ["--", "bash", "-lc", f"{start}; exec bash -l"]
        return "wsl.exe", args, None
    if terminal_type in ("bash", "zsh", "fish"):
        shell = prof.cmd or terminal_type
        if start:
            return shell, ["-lc", f"{start}; exec {shell} -l"], cwd
        return shell, ["-l"], cwd
    if terminal_type in ("ssh", "sftp"):
        tool = putty_tools.plink_path() if terminal_type == "ssh" else putty_tools.psftp_path()
        if tool is None:
            raise HTTPException(
                400, "PuTTY tools are not installed (run scripts/fetch_putty.py)"
            )
        host = (getattr(prof, "ssh_host", None) or "").strip()
        user = (getattr(prof, "ssh_user", None) or "").strip()
        port = getattr(prof, "ssh_port", None)
        key = (getattr(prof, "ssh_key", None) or "").strip()
        args = ["-ssh"] if terminal_type == "ssh" else []
        if port:
            args += ["-P", str(port)]
        if key:
            args += ["-i", key]
        args.append(f"{user}@{host}" if user else host)
        # plink runs a trailing command on the remote host instead of a shell.
        if terminal_type == "ssh" and start:
            args.append(start)
        return str(tool), args, cwd
    return prof.cmd, existing_args, cwd


def _layout_session_ids(node: Any) -> set[str]:
    if not isinstance(node, dict):
        return set()
    if node.get("type") == "split":
        found: set[str] = set()
        for child in node.get("children", []):
            found.update(_layout_session_ids(child))
        return found
    sid = node.get("session_id")
    return {sid} if isinstance(sid, str) and sid else set()


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
            if len(data) > 256 * 1024:
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
            if isinstance(ctrl, dict) and ctrl.get("type") == "resize":
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
