"""FastAPI app: the composition root for the routes in `quickterm.api`."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from quickterm.api import (
    assets,
    attach,
    config,
    launches,
    remote,
    sessions,
    system,
    transcripts,
    windows as window_routes,
    workspaces,
)
from quickterm.api.context import ApiContext
from quickterm.api.guard import LocalGuard
from quickterm.windows import WindowRegistry

if TYPE_CHECKING:
    from quickterm.config import AppConfig
    from quickterm.session_manager import Attachment, SessionManager

FRONTEND_DIR = Path(__file__).resolve().parent / "frontend"

# tests/test_coalescing.py patches this cap on this module and calls the two
# wrappers below through it, so they pass the value on to quickterm.api.attach.
# Once that test patches quickterm.api.attach directly, all three can go.
_SEND_COALESCE_BYTES = attach.SEND_COALESCE_BYTES


def _coalesce_replay(chunks: Any):
    return attach.coalesce_replay(chunks, _SEND_COALESCE_BYTES)


async def _pump_output(
    ws: Any, attachment: Attachment, session: Any, buffer: Any = None
) -> None:
    await attach.pump_output(ws, attachment, session, buffer, cap=_SEND_COALESCE_BYTES)


def client_host(host: str) -> str:
    """The host part of a URL that reaches a server bound to `host`.

    An IPv6 literal needs brackets in a URL and a Host header, and a wildcard
    bind is reached through loopback.
    """
    if host in ("", "0.0.0.0"):
        return "127.0.0.1"
    if host == "::":
        return "[::1]"
    if ":" in host and not host.startswith("["):
        return f"[{host}]"
    return host


def _allowed_origins(cfg: AppConfig) -> tuple[set[str], set[str]]:
    hosts = {f"127.0.0.1:{cfg.port}", f"localhost:{cfg.port}", f"[::1]:{cfg.port}"}
    if cfg.host not in ("127.0.0.1", "localhost", "0.0.0.0", "::"):
        hosts.add(f"{client_host(cfg.host)}:{cfg.port}")
    return hosts, {f"http://{h}" for h in hosts}


def create_app(
    manager: SessionManager,
    cfg: AppConfig,
    token: str = "",
    elevated: bool = False,
    *,
    windows: WindowRegistry | None = None,
    open_window: Callable[[str | None, str | None], str] | None = None,
    notify: Callable[[str, str, str, str | None], None] | None = None,
) -> FastAPI:
    # No docs and no schema: /openapi.json listed every route without asking
    # for the token, the only non-static answer besides /api/health that did.
    app = FastAPI(title="QuickTerm", docs_url=None, redoc_url=None, openapi_url=None)
    allowed_hosts, allowed_origins = _allowed_origins(cfg)
    ctx = ApiContext(
        manager=manager,
        cfg=cfg,
        token=token,
        elevated=elevated,
        windows=windows if windows is not None else WindowRegistry(),
        open_window=open_window,
        allowed_hosts=allowed_hosts,
        allowed_origins=allowed_origins,
        launches=launches.LaunchQueue(),
        notify=notify,
    )
    app.add_middleware(LocalGuard, ctx=ctx)
    for routes in (
        system, sessions, remote, launches, window_routes, workspaces, config, assets, attach
    ):
        routes.register(app, ctx)
    transcripts.register(app, ctx)
    _mount_frontend(app)
    return app


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
