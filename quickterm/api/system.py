"""Host-facing routes: health, profiles, shell inventory, elevation, updates,
opening targets, reading a file and browsing folders."""

from __future__ import annotations

import asyncio
import importlib
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import FastAPI, HTTPException, Request

from quickterm import browse, putty_tools
from quickterm.api.common import asdict, read_json, resolve_request

if TYPE_CHECKING:
    from quickterm.api.context import ApiContext

FILE_READ_CAP = 512 * 1024


def register(app: FastAPI, ctx: ApiContext) -> None:
    cfg = ctx.cfg
    inventory_cache = ctx.inventory_cache

    @app.get("/api/health")
    def health() -> dict:
        from quickterm import __version__

        return {"app": "quickterm", "version": __version__}

    @app.get("/api/profiles")
    def list_profiles() -> list[dict]:
        return [asdict(p) for p in cfg.profiles]

    @app.get("/api/system/terminals")
    async def get_system_terminals() -> dict:
        # Probing every shell path and asking wsl.exe for its distributions
        # takes a third of a second, and installed shells do not change between
        # one sidebar rebuild and the next. Off the loop, and remembered for a
        # minute.
        now = time.monotonic()
        cached = inventory_cache.get("value")
        if cached is not None and now - inventory_cache.get("at", 0.0) < 60.0:
            return cached
        value = await asyncio.to_thread(_terminal_inventory)
        inventory_cache.update(value=value, at=time.monotonic())
        return value

    @app.post("/api/elevate")
    async def elevate_terminal(request: Request) -> dict:
        if os.name != "nt":
            raise HTTPException(400, "administrator terminals are only available on Windows")
        body = await read_json(request)
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        # Resolved exactly like an ordinary terminal, so an administrator
        # terminal opened from a workspace starts in that workspace's folder.
        # The PuTTY tools stay off PATH here: the elevated instance resolves
        # the spec once more and appends them itself.
        resolved = await resolve_request(ctx, body, append_tools=False)
        spec = {
            "cmd": resolved.cmd,
            "args": resolved.args,
            "cwd": resolved.cwd,
            "env": resolved.env,
            "name": resolved.name or resolved.label,
        }
        try:
            from quickterm.elevation import launch as launch_elevated

            # ShellExecuteW(..., "runas", ...) does not return until the UAC
            # consent dialog is resolved, up to minutes if the user walks
            # away. On the event loop that parks every PTY pump long enough to
            # overflow the fan-out queues and force every pane to resync.
            await asyncio.to_thread(launch_elevated, spec)
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
        # Ctrl+click on a link/path in a terminal, or with `app` the sidebar's
        # "open this folder in Explorer / VS Code". Token-gated (under /api);
        # opener.py refuses non-http(s) URLs, reveals executables instead of
        # running them, and launches VS Code from Code.exe, never the batch
        # shim.
        opener = importlib.import_module("quickterm.opener")  # stubbable in tests
        body = await read_json(request)
        target = body.get("target") if isinstance(body, dict) else None
        if not isinstance(target, str):
            raise HTTPException(400, "body must be {'target': <string>}")
        app_name = body.get("app")
        if app_name is not None and not isinstance(app_name, str):
            raise HTTPException(400, "app must be a string")
        try:
            if app_name is not None:
                return await asyncio.to_thread(opener.open_folder, target, app_name)
            return await asyncio.to_thread(opener.open_target, target)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except LookupError as exc:
            # VS Code is not installed: say so, the banner shows the detail.
            raise HTTPException(404, str(exc)) from exc
        except FileNotFoundError:
            raise HTTPException(404, "no such path") from None

    @app.get("/api/file")
    def read_file(path: str) -> dict:
        # Same cleanup as opener.open_target, so a Ctrl+clicked path behaves
        # the same whether it opens in the viewer or in Explorer.
        p = Path(os.path.expanduser(path.strip().strip('"').strip("'")))
        try:
            if p.is_dir():
                raise HTTPException(400, "path is a directory")
            if not p.is_file():
                raise HTTPException(404, "file not found")
            size = p.stat().st_size
            with p.open("rb") as f:
                data = f.read(FILE_READ_CAP)
        except OSError as exc:
            # An ACL-denied folder, a file another program holds exclusively,
            # a dead share: a sentence for the viewer, not a 500 traceback.
            raise HTTPException(400, f"cannot read {p}: {exc.strerror or exc}") from exc
        return {
            "path": str(p),
            "size": size,
            "truncated": size > FILE_READ_CAP,
            "text": data.decode("utf-8", errors="replace"),
        }

    @app.get("/api/fs/dirs")
    async def list_dirs(path: str | None = None) -> dict:
        # Backs the in-app folder browser, which replaced the native pywebview
        # dialog: that one existed only in the installed app and dropped focus
        # out of the page while it was open.
        #
        # This does widen what a frontend can learn about the host, and
        # `_DesktopApi`'s docstring in app.py used to claim the browser
        # frontend could not learn arbitrary host paths. That claim is no
        # longer true, so it is worth being plain about the size of the change:
        # it is small, because the boundary was never the file system. The
        # server binds 127.0.0.1, every /api route requires the per-install
        # token from auth.py, and behind that token `GET /api/file` already
        # reads any file on the host while `POST /api/sessions` already spawns
        # arbitrary processes. Anything that can call this endpoint can already
        # run `dir` in a PTY and read the output back over the WebSocket. The
        # token and the Host/Origin guard are the real boundary; do not weaken
        # either to make this route more convenient.
        #
        # A directory scan is blocking I/O (a cold network share can take
        # seconds), so it goes to a thread like every other filesystem call
        # here. See the "blocking work never runs on the event loop" rule.
        try:
            return await asyncio.to_thread(browse.list_dirs, path)
        except browse.BrowseError as exc:
            raise HTTPException(404 if exc.missing else 400, str(exc)) from exc


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
