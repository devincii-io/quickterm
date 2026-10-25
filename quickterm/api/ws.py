"""The right panel's routes: files, the file view, changes and the pull
request of one saved workspace, addressed by name."""

from __future__ import annotations

import asyncio
import functools
import importlib
import secrets
import subprocess
import time
from collections import OrderedDict
from types import SimpleNamespace
from typing import Any, Callable, TypeVar

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse

from quickterm import ws_exec, ws_files, ws_git, ws_pr
from quickterm.api.common import read_json

T = TypeVar("T")

# A file view image is served without the token (an <img> cannot send it),
# under a random key that names that one file for a while.
IMAGE_KEY_TTL = 3600.0
IMAGE_KEYS_CAP = 256
IMAGE_ROUTE = "/api/assets/ws-file/"


class _ImageKeys:
    def __init__(self) -> None:
        self._keys: OrderedDict[str, tuple[str, str, float]] = OrderedDict()

    def issue(self, name: str, rel: str) -> str:
        now = time.monotonic()
        self._drop_expired(now)
        for key, (each_name, each_rel, _) in self._keys.items():
            if each_name == name and each_rel == rel:
                self._keys[key] = (name, rel, now + IMAGE_KEY_TTL)
                self._keys.move_to_end(key)
                return key
        key = secrets.token_urlsafe(32)
        self._keys[key] = (name, rel, now + IMAGE_KEY_TTL)
        while len(self._keys) > IMAGE_KEYS_CAP:
            self._keys.popitem(last=False)
        return key

    def lookup(self, key: str) -> tuple[str, str] | None:
        self._drop_expired(time.monotonic())
        found = self._keys.get(key)
        return (found[0], found[1]) if found else None

    def _drop_expired(self, now: float) -> None:
        for key in [key for key, (_, _, until) in self._keys.items() if until < now]:
            del self._keys[key]


def _rel(value: Any, *, allow_root: bool = True) -> str:
    try:
        return ws_files.clean_rel(value, allow_root=allow_root)
    except ws_files.PathError as exc:
        raise HTTPException(400, str(exc)) from exc


async def _off_loop(func: Callable[..., T], *args: Any) -> T:
    """Run a blocking panel call off the loop and turn its errors into
    answers."""
    try:
        return await asyncio.to_thread(functools.partial(func, *args))
    except ws_git.GitError as exc:
        raise HTTPException(exc.status, exc.message) from exc
    except ws_pr.PrError as exc:
        raise HTTPException(exc.status, exc.message) from exc
    except ws_files.PathError as exc:
        raise HTTPException(400, str(exc)) from exc
    except ws_files.RemoteFolder as exc:
        raise HTTPException(501, "not available for a workspace on another host") from exc
    except ws_exec.RemoteUnavailable as exc:
        raise HTTPException(502, str(exc)) from exc
    except (FileNotFoundError, NotADirectoryError):
        raise HTTPException(404, "no such file or folder") from None
    except IsADirectoryError:
        raise HTTPException(400, "path is a folder") from None
    except PermissionError as exc:
        raise HTTPException(403, f"cannot read: {exc.strerror or exc}") from exc
    except OSError as exc:
        raise HTTPException(400, f"cannot read: {exc.strerror or exc}") from exc


# The window's scratch view has a folder but no saved workspace; the panel
# addresses it by this name, which no saved workspace can take (names that
# start with a dot are refused).
SCRATCH_NAME = ".scratch"


async def _workspace(name: str, cfg: Any = None) -> Any:
    if name == SCRATCH_NAME:
        config = importlib.import_module("quickterm.config")
        folder = await asyncio.to_thread(config.scratch_root, getattr(cfg, "scratch_dir", "") or "")
        return SimpleNamespace(name=SCRATCH_NAME, path=folder, host=None)
    workspace = importlib.import_module("quickterm.workspace")  # via sys.modules so tests can stub it
    ws = await asyncio.to_thread(workspace.load_workspace, name)
    if ws is None:
        raise HTTPException(404, "no such workspace")
    if not getattr(ws, "path", None):
        raise HTTPException(400, "workspace has no folder")
    if getattr(ws, "host", None) is None and not await asyncio.to_thread(ws_exec.exists, ws):
        raise HTTPException(404, "workspace folder not found")
    return ws


def _list(ws: Any, rel: str) -> dict:
    listed = ws_files.folder_for(ws).list_dir(rel)
    entries = listed[:ws_files.LIST_CAP]
    marks = ws_git.tree_marks(ws, rel)
    out = []
    for entry in entries:
        path = f"{rel}/{entry.name}" if rel else entry.name
        ignored, letter = ws_git.entry_mark(marks, path, entry.dir)
        out.append({"name": entry.name, "dir": entry.dir, "ignored": ignored, "git": letter})
    return {"entries": out, "truncated": len(listed) > ws_files.LIST_CAP}


def _search(ws: Any, query: Any, contents: bool) -> dict:
    return ws_git.search_contents(ws, query) if contents else ws_git.search_names(ws, query)


def _file(ws: Any, rel: str, image_url: Callable[[], str]) -> dict:
    folder = ws_files.folder_for(ws)
    language = ws_files.language_for(rel)
    kind = ws_files.image_type(rel)
    # An image on a host has no local file to serve; it reads as binary.
    if kind is not None and isinstance(folder, ws_files.LocalFolder):
        path = folder.resolve(rel)
        if path.is_dir():
            raise IsADirectoryError(rel)
        size = path.stat().st_size
        return {"text": None, "binary": True, "size": size, "image_url": image_url(),
                "language": None}
    read = folder.read_file(rel)
    if read.data is None:
        return {"text": None, "binary": False, "size": read.size, "language": language}
    if ws_files.is_binary(read.data):
        return {"text": None, "binary": True, "size": read.size, "language": None}
    return {"text": ws_files.decode(read.data), "binary": False, "size": read.size,
            "language": language}


OPEN_APPS = ("editor", "explorer")


def _open(ws: Any, rel: str, app: str) -> dict:
    """Open a workspace file in VS Code (else its default program), or show
    its folder in Explorer. Local workspaces only."""
    opener = importlib.import_module("quickterm.opener")  # stubbable in tests
    path = ws_files.folder_for(ws).resolve(rel)
    if not path.exists():
        raise FileNotFoundError(rel)
    if app == "explorer":
        return opener.open_folder(str(path if path.is_dir() else path.parent), "explorer")
    code = opener.find_vscode()
    if code is None:
        return opener.open_target(str(path))
    importlib.import_module("quickterm.overlay").hold_open()
    # Absolute program and an explicit folder, as opener.open_folder does.
    subprocess.Popen([code, str(path)], cwd=str(path if path.is_dir() else path.parent))
    return {"action": "vscode"}


def _paths(body: dict) -> list[str]:
    paths = body.get("paths")
    if not isinstance(paths, list) or not paths:
        raise HTTPException(400, "paths must be a non-empty list")
    if len(paths) > ws_git.PATHS_CAP:
        raise HTTPException(400, f"paths must hold at most {ws_git.PATHS_CAP} entries")
    return [_rel(path, allow_root=False) for path in paths]


def register(app: FastAPI, ctx: Any) -> None:
    images = _ImageKeys()

    @app.get("/api/ws/{name:path}/files/search")
    async def search_files(name: str, q: str = "", contents: int = 0) -> dict:
        ws = await _workspace(name, ctx.cfg)
        return await _off_loop(_search, ws, q, bool(contents))

    @app.get("/api/ws/{name:path}/files")
    async def list_files(name: str, dir: str = "") -> dict:
        ws = await _workspace(name, ctx.cfg)
        return await _off_loop(_list, ws, _rel(dir))

    @app.get("/api/ws/{name:path}/file")
    async def read_file(name: str, path: str = "") -> dict:
        rel = _rel(path, allow_root=False)
        ws = await _workspace(name, ctx.cfg)
        return await _off_loop(_file, ws, rel, lambda: IMAGE_ROUTE + images.issue(name, rel))

    @app.get(IMAGE_ROUTE + "{key}")
    async def image(key: str) -> FileResponse:
        found = images.lookup(key)
        if found is None:
            raise HTTPException(404, "no such image")
        name, rel = found
        kind = ws_files.image_type(rel)
        ws = await _workspace(name, ctx.cfg)
        path = await _off_loop(lambda: ws_files.folder_for(ws).resolve(rel))
        if kind is None or not await asyncio.to_thread(path.is_file):
            raise HTTPException(404, "no such image")
        # An SVG opened on its own must not run script on this origin.
        return FileResponse(path, media_type=kind, headers={
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
        })

    @app.post("/api/ws/{name:path}/open")
    async def open_file(name: str, request: Request) -> dict:
        body = await read_json(request)
        if not isinstance(body, dict) or body.get("app") not in OPEN_APPS:
            raise HTTPException(400, f"app must be one of {', '.join(OPEN_APPS)}")
        rel = _rel(body.get("path"))
        ws = await _workspace(name, ctx.cfg)
        try:
            return await _off_loop(_open, ws, rel, body["app"])
        except HTTPException:
            raise
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.get("/api/ws/{name:path}/changes")
    async def get_changes(name: str) -> dict:
        ws = await _workspace(name, ctx.cfg)
        return await _off_loop(ws_git.changes, ws)

    @app.post("/api/ws/{name:path}/changes")
    async def post_changes(name: str, request: Request) -> dict:
        body = await read_json(request)
        if not isinstance(body, dict):
            raise HTTPException(400, "body must be an object")
        action = body.get("action")
        if action not in ws_git.CHANGE_ACTIONS:
            raise HTTPException(400, f"action must be one of {', '.join(ws_git.CHANGE_ACTIONS)}")
        paths = _paths(body)
        ws = await _workspace(name, ctx.cfg)
        return await _off_loop(ws_git.change_files, ws, action, paths)

    @app.get("/api/ws/{name:path}/diff")
    async def get_diff(name: str, path: str = "", group: str = "changes") -> dict:
        rel = _rel(path, allow_root=False)
        ws = await _workspace(name, ctx.cfg)
        return await _off_loop(ws_git.diff, ws, rel, group)

    @app.post("/api/ws/{name:path}/git")
    async def post_git(name: str, request: Request) -> dict:
        body = await read_json(request)
        if not isinstance(body, dict):
            raise HTTPException(400, "body must be an object")
        ws = await _workspace(name, ctx.cfg)
        return await _off_loop(ws_git.git_action, ws, body.get("action"), body.get("message"))

    @app.get("/api/ws/{name:path}/pr/log")
    async def pr_log(name: str, run: str = "", job: str | None = None) -> dict:
        ws = await _workspace(name, ctx.cfg)
        return await _off_loop(ws_pr.log, ws, run, job)

    @app.post("/api/ws/{name:path}/pr/merge")
    async def pr_merge(name: str, request: Request) -> dict:
        body = await read_json(request)
        if not isinstance(body, dict):
            raise HTTPException(400, "body must be an object")
        ws = await _workspace(name, ctx.cfg)
        return await _off_loop(ws_pr.merge, ws, body.get("method"), body.get("number"), body.get("head_sha"))

    @app.get("/api/ws/{name:path}/pr")
    async def pr_status(name: str) -> dict:
        ws = await _workspace(name, ctx.cfg)
        return await _off_loop(ws_pr.status, ws)
