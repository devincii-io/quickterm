"""The local trust boundary: Host and Origin allowlists plus the install token."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from fastapi import Response, WebSocket
from starlette.datastructures import Headers, MutableHeaders

from quickterm import auth

if TYPE_CHECKING:
    from quickterm.api.context import ApiContext


def _token_required(method: str, path: str) -> bool:
    # Sensitive routes = everything under /api that isn't a public probe or a
    # logo loaded by <img> (which can't send headers). Static frontend files
    # carry no secrets and stay open so the shell can bootstrap.
    if not path.startswith("/api/") or path == "/api/health":
        return False
    return not (method == "GET" and path.startswith("/api/assets/"))


def _refusal(ctx: ApiContext, headers: Headers, method: str, path: str) -> str | None:
    if headers.get("host", "") not in ctx.allowed_hosts:
        return "forbidden: bad host"
    origin = headers.get("origin")
    if origin is not None and origin not in ctx.allowed_origins:
        return "forbidden: bad origin"
    if ctx.token and _token_required(method, path) and headers.get(auth.HEADER) != ctx.token:
        return "forbidden: bad token"
    return None


# Local-only trust boundary: the API answers the QuickTerm window and
# nothing else. The Host allowlist defeats DNS-rebinding (a hostile page
# pointing its own domain at 127.0.0.1), and the Origin allowlist defeats
# cross-origin requests from other sites in the same browser, including
# WebSocket connections, which browsers allow cross-origin by default.
#
# A plain ASGI middleware, not @app.middleware("http"): Starlette's
# BaseHTTPMiddleware wraps `receive`, and through that wrapper
# request.is_disconnected() never reported a client that had gone, which
# the launch long-poll depends on.
class LocalGuard:
    def __init__(self, inner: Any, ctx: ApiContext) -> None:
        self.inner = inner
        self.ctx = ctx

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.inner(scope, receive, send)
            return
        path = scope["path"]
        refusal = _refusal(self.ctx, Headers(scope=scope), scope["method"], path)
        if refusal is not None:
            await Response(refusal, status_code=403)(scope, receive, send)
            return

        async def send_with_caching(message: Any) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                if path.startswith("/api/"):
                    headers.setdefault("Cache-Control", "no-store")
                # Frontend assets carry ETag/Last-Modified but no
                # Cache-Control, so browsers cache them heuristically and
                # can serve a stale UI after the app updates. Force
                # revalidation for the shell (the immutable /api/assets
                # responses set their own caching).
                if not path.startswith("/api") and not path.startswith("/ws"):
                    headers.setdefault("Cache-Control", "no-cache")
            await send(message)

        await self.inner(scope, receive, send_with_caching)


def ws_allowed(ctx: ApiContext, ws: WebSocket) -> bool:
    if ws.headers.get("host", "") not in ctx.allowed_hosts:
        return False
    origin = ws.headers.get("origin")
    # browsers always send Origin on WS; absent means a native local client
    if not (origin is None or origin in ctx.allowed_origins):
        return False
    if ctx.token:
        # Browsers cannot set headers on a WS; the token rides in as a
        # Sec-WebSocket-Protocol entry instead (see auth.SUBPROTOCOL_PREFIX).
        offered = ws.headers.get("sec-websocket-protocol", "")
        wanted = auth.SUBPROTOCOL_PREFIX + ctx.token
        if wanted not in [p.strip() for p in offered.split(",")]:
            return False
    return True
