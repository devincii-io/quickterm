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
    def list_sessions() -> list[dict]:
        count = getattr(manager, "attachment_count", None)
        metrics_fn = getattr(manager, "session_metrics", None)
        if metrics_fn:
            busy_set, metrics = metrics_fn()
        else:
            busy = getattr(manager, "busy_ids", None)  # test fakes may lack it
            busy_set = busy() if busy else set()
            metrics = {}
        out = []
        for info in manager.list():
            d = _asdict(info)
            d["attachments"] = count(info.id) if count else 0
            d["busy"] = info.id in busy_set
            if info.id in metrics:
                d["usage"] = metrics[info.id]
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
        prof = None
        if profile_name is not None:
            if not isinstance(profile_name, str) or not profile_name.strip():
                raise HTTPException(400, "profile must be a non-empty string")
            prof = next((p for p in cfg.profiles if p.name == profile_name), None)
            if prof is None:
                raise HTTPException(404, f"unknown profile: {profile_name}")
            resolved_cmd, resolved_args, resolved_cwd = _resolve_profile(prof, cwd)
            cmd = cmd or resolved_cmd
            args = args if args is not None else resolved_args
            # _resolve_profile incorporates the request override.  WSL embeds
            # it in `--cd` and deliberately returns no Windows process cwd.
            cwd = resolved_cwd
            env = env if env is not None else dict(prof.env)
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
        workspace = body.get("workspace")
        if workspace is not None and not isinstance(workspace, str):
            raise HTTPException(400, "workspace must be a string")
        cols = _bounded_int(body.get("cols", 120), "cols", 2, 1000)
        rows = _bounded_int(body.get("rows", 30), "rows", 1, 1000)
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
                workspace=workspace if isinstance(workspace, str) and workspace else None,
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
        manager.kill(sid)
        return Response(status_code=204)

    @app.patch("/api/sessions/{sid}")
    async def rename_session(sid: str, request: Request) -> dict:
        session = manager.get(sid)
        if session is None:
            raise HTTPException(404, "no such session")
        body = await request.json()
        name = str(body.get("name") or "").strip() if isinstance(body, dict) else ""
        if not name:
            raise HTTPException(400, "body must be {'name': <non-empty string>}")
        session.info.name = name[:80]
        return _asdict(session.info)

    @app.post("/api/sessions/cleanup")
    async def cleanup_sessions(request: Request) -> Response:
        body = await request.json()
        session_ids = body.get("session_ids", []) if isinstance(body, dict) else []
        for sid in session_ids:
            if isinstance(sid, str) and manager.get(sid) is not None:
                manager.kill(sid)
        return Response(status_code=204)

    @app.post("/api/sessions/kill-all")
    def kill_all_sessions() -> dict:
        session_ids = [info.id for info in manager.list() if info.alive]
        for sid in session_ids:
            manager.kill(sid)
        return {"killed": len(session_ids)}

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
        return _asdict(ws)

    @app.put("/api/workspaces/{name}")
    async def put_workspace(name: str, request: Request) -> Response:
        workspace = importlib.import_module("quickterm.workspace")  # via sys.modules so tests can stub it

        body = await request.json()
        if not isinstance(body, dict) or "layout" not in body:
            raise HTTPException(400, "body must be {'layout': ...}")
        logo = body.get("logo")
        raw_session_ids = body.get("session_ids")
        session_ids = (
            [sid for sid in raw_session_ids if isinstance(sid, str) and sid]
            if isinstance(raw_session_ids, list)
            else sorted(_layout_session_ids(body["layout"]))
        )
        workspace.save_workspace(
            workspace.Workspace(
                name=name,
                layout=body["layout"],
                logo=logo,
                session_ids=session_ids,
            )
        )
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
            for sid in owned:
                if manager.get(sid) is not None and not manager.has_attachments(sid):
                    manager.kill(sid)
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
            "elevated": elevated,
            "version": __version__,
            "update_check": cfg.update_check,
            "idle_timeout_s": cfg.idle_timeout_s,
            "max_sessions": cfg.max_sessions,
        }

    @app.get("/api/config/full")
    def get_full_config() -> dict:
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
        if profile_name is not None:
            prof = next((p for p in cfg.profiles if p.name == profile_name), None)
            if prof is None:
                raise HTTPException(404, f"unknown profile: {profile_name}")
            cmd, args, cwd = _resolve_profile(prof)
            spec = {
                "cmd": cmd,
                "args": args,
                "cwd": cwd,
                "env": dict(prof.env),
                "name": prof.name,
            }
        else:
            spec = body
        try:
            from quickterm.elevation import launch

            launch(spec)
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
        body = await request.json()
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
            config_mod.save_config(new_cfg)
        except (TypeError, ValueError) as exc:
            raise HTTPException(400, f"invalid config: {exc}") from exc
        # Apply live-updatable fields in place; port and global hotkeys need a restart.
        for name in (
            "font_family", "font_size", "theme", "custom_theme", "logo", "idle_timeout_s",
            "max_sessions", "default_profile", "profiles", "snippets", "voice", "update_check",
        ):
            if hasattr(new_cfg, name):
                setattr(cfg, name, getattr(new_cfg, name))
        set_limit = getattr(manager, "set_max_sessions", None)
        if set_limit:
            set_limit(cfg.max_sessions)
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
        data = await request.body()
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
        # Subscribe before taking the replay snapshot. Both calls are
        # synchronous on the event-loop thread, so output cannot slip between
        # the snapshot and the live queue (the old order permanently lost it).
        attachment = manager.attach(sid)
        chunks_fn = getattr(session, "scrollback_chunks", None)
        if chunks_fn is not None:
            replay_chunks, cols, rows = chunks_fn()
        else:  # test fakes and third-party managers implementing the old surface
            data, cols, rows = session.scrollback()
            replay_chunks = (data,) if data else ()
        try:
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
                    return
                if not isinstance(ack, dict) or ack.get("type") != "replay_ack":
                    await ws.close(code=1002, reason="invalid replay acknowledgement")
                    return
            # Keep the original wire shape for empty terminals.  The empty
            # frame has nothing for xterm to parse, so it intentionally does
            # not participate in replay acknowledgement flow control.
            if not sent_replay:
                await ws.send_bytes(b"")
            await ws.send_text(json.dumps({"type": "replay_done"}))
            await _live_phase(ws, attachment, manager, session, sid)
        except (WebSocketDisconnect, asyncio.CancelledError):
            pass
        finally:
            attachment.detach()

    _mount_frontend(app)
    return app


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


def _resolve_profile(prof: Any, cwd_override: str | None = None) -> tuple[str, list[str], str | None]:
    terminal_type = getattr(prof, "terminal_type", None)
    start = (getattr(prof, "start_command", None) or "").strip()
    cwd = cwd_override or getattr(prof, "cwd", None)
    existing_args = list(getattr(prof, "args", []) or [])

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
    ws: WebSocket, attachment: "Attachment", manager: "SessionManager", session: Any, sid: str
) -> None:
    out = asyncio.ensure_future(_pump_output(ws, attachment, session))
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


async def _pump_output(ws: WebSocket, attachment: "Attachment", session: Any) -> None:
    # queue yields raw PTY bytes; None sentinel = session exited
    while True:
        chunk = await attachment.queue.get()
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
        parts = [chunk]
        total = len(chunk)
        exited = False
        while total < _SEND_COALESCE_BYTES:
            try:
                item = attachment.queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if item is None:
                exited = True
                break
            if item is attachment.overflow_sentinel:
                await ws.send_text(json.dumps({"type": "overflow"}))
                await ws.close(code=1013, reason="viewer fell behind; reconnect to replay")
                return
            parts.append(item)
            total += len(item)
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
    raw = b"".join(chunks)
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(400, "request body must be valid JSON") from exc


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
