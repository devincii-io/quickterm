"""FastAPI app: REST session/profile/workspace API, WS attach, static frontend."""

from __future__ import annotations

import asyncio
import dataclasses
import importlib
import json
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
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


def _asdict(obj: Any) -> Any:
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return dataclasses.asdict(obj)
    return dict(vars(obj))


def create_app(manager: "SessionManager", cfg: "AppConfig") -> FastAPI:
    app = FastAPI(title="QuickTerm")

    @app.get("/api/sessions")
    def list_sessions() -> list[dict]:
        return [_asdict(info) for info in manager.list()]

    @app.post("/api/sessions")
    async def spawn_session(request: Request) -> dict:
        body = await request.json() if await request.body() else {}
        profile_name = body.get("profile")
        cmd = body.get("cmd")
        args = body.get("args")
        cwd = body.get("cwd")
        env = body.get("env")
        if profile_name is not None:
            prof = next((p for p in cfg.profiles if p.name == profile_name), None)
            if prof is None:
                raise HTTPException(404, f"unknown profile: {profile_name}")
            resolved_cmd, resolved_args, resolved_cwd = _resolve_profile(prof)
            cmd = cmd or resolved_cmd
            args = args if args is not None else resolved_args
            cwd = cwd if cwd is not None else resolved_cwd
            env = env if env is not None else dict(prof.env)
        if not cmd:
            raise HTTPException(400, "either 'profile' or 'cmd' is required")
        info = manager.spawn(
            name=body.get("name"),
            profile=profile_name,
            cmd=cmd,
            args=args or [],
            cwd=cwd,
            env=env or {},
            cols=body.get("cols", 120),
            rows=body.get("rows", 30),
        )
        return _asdict(info)

    @app.delete("/api/sessions/{sid}")
    def kill_session(sid: str) -> Response:
        if manager.get(sid) is None:
            raise HTTPException(404, "no such session")
        manager.kill(sid)
        return Response(status_code=204)

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
        workspace.save_workspace(workspace.Workspace(name=name, layout=body["layout"]))
        return Response(status_code=204)

    @app.delete("/api/workspaces/{name}")
    def remove_workspace(name: str) -> Response:
        workspace = importlib.import_module("quickterm.workspace")  # via sys.modules so tests can stub it

        workspace.delete_workspace(name)
        return Response(status_code=204)

    @app.post("/api/focus")
    async def set_focus(request: Request) -> Response:
        body = await request.json()
        manager.focused_session_id = body.get("session_id")
        return Response(status_code=204)

    @app.get("/api/config")
    def get_config() -> dict:
        return {
            "font_family": cfg.font_family,
            "default_profile": cfg.default_profile,
            "profiles": [_asdict(p) for p in cfg.profiles],
            "snippets": [_asdict(s) for s in cfg.snippets],
            "voice_available": _voice_available(),
        }

    @app.get("/api/config/full")
    def get_full_config() -> dict:
        return _asdict(cfg)

    @app.get("/api/system/terminals")
    def get_system_terminals() -> dict:
        return _terminal_inventory()

    @app.put("/api/config")
    async def put_config(request: Request) -> Response:
        config_mod = importlib.import_module("quickterm.config")

        try:
            new_cfg = config_mod.config_from_dict(await request.json())
        except (TypeError, ValueError) as exc:
            raise HTTPException(400, f"invalid config: {exc}") from exc
        config_mod.save_config(new_cfg)
        # apply live-updatable fields in place; port/hotkeys need a restart
        for name in ("font_family", "default_profile", "profiles", "snippets", "voice"):
            setattr(cfg, name, getattr(new_cfg, name))
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

    @app.websocket("/ws/session/{sid}")
    async def ws_session(ws: WebSocket, sid: str) -> None:
        session = manager.get(sid)
        await ws.accept()
        if session is None:
            await ws.close(code=4404)
            return
        data, cols, rows = session.scrollback()
        await ws.send_text(json.dumps({"type": "replay_size", "cols": cols, "rows": rows}))
        await ws.send_bytes(data)
        await ws.send_text(json.dumps({"type": "replay_done"}))
        attachment = manager.attach(sid)
        try:
            await _live_phase(ws, attachment, manager, session, sid)
        except WebSocketDisconnect:
            pass
        finally:
            attachment.detach()

    _mount_frontend(app)
    return app


def _voice_available() -> bool:
    try:
        import quickterm.voice as voice

        return bool(voice.voice_available())
    except Exception:
        return False


def _resolve_profile(prof: Any) -> tuple[str, list[str], str | None]:
    terminal_type = getattr(prof, "terminal_type", None)
    start = (getattr(prof, "start_command", None) or "").strip()
    cwd = getattr(prof, "cwd", None)
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
        if cwd:
            args += ["--cd", cwd]
        if start:
            args += ["--", "bash", "-lc", f"{start}; exec bash -l"]
        return "wsl.exe", args, None
    return prof.cmd, existing_args, cwd


def _terminal_inventory() -> dict:
    types = [
        ("powershell-core", "PowerShell 7", "pwsh.exe"),
        ("windows-powershell", "Windows PowerShell", "powershell.exe"),
        ("command-prompt", "Command Prompt", "cmd.exe"),
        ("wsl", "WSL", "wsl.exe"),
        ("custom", "Custom command", None),
    ]
    distributions: list[str] = []
    wsl = shutil.which("wsl.exe") or shutil.which("wsl")
    if wsl:
        try:
            result = subprocess.run(
                [wsl, "--list", "--quiet"],
                capture_output=True,
                timeout=3,
                check=False,
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
                "available": executable is None or shutil.which(executable) is not None,
            }
            for type_id, label, executable in types
        ],
        "wsl_distributions": distributions,
    }


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
            exc = task.exception()
            if exc is not None and not isinstance(exc, WebSocketDisconnect):
                raise exc
    finally:
        for task in (out, inp):
            task.cancel()


async def _pump_output(ws: WebSocket, attachment: "Attachment", session: Any) -> None:
    # queue yields raw PTY bytes; None sentinel = session exited
    while True:
        chunk = await attachment.queue.get()
        if chunk is None:
            code = session.info.exit_code
            await ws.send_text(json.dumps({"type": "exit", "code": code}))
            await ws.close()
            return
        await ws.send_bytes(chunk)


async def _pump_input(ws: WebSocket, manager: "SessionManager", sid: str) -> None:
    while True:
        msg = await ws.receive()
        if msg["type"] == "websocket.disconnect":
            return
        if msg.get("bytes") is not None:
            manager.write(sid, msg["bytes"])
        elif msg.get("text"):
            ctrl = json.loads(msg["text"])
            if ctrl.get("type") == "resize":
                manager.resize(sid, int(ctrl["cols"]), int(ctrl["rows"]))


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
