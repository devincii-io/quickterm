"""Uploaded images (workspace logos): upload, serve, delete."""

from __future__ import annotations

import asyncio
import importlib
from typing import TYPE_CHECKING

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse

from quickterm.api.common import read_body

if TYPE_CHECKING:
    from quickterm.api.context import ApiContext


def register(app: FastAPI, ctx: ApiContext) -> None:
    @app.post("/api/assets")
    async def upload_asset(request: Request) -> dict:
        assets = importlib.import_module("quickterm.assets")
        content_type = request.headers.get("content-type", "")
        # Reject oversized uploads while streaming. ``request.body()`` would
        # first buffer the entire payload, defeating assets.save_asset's cap.
        maximum = int(getattr(assets, "MAX_ASSET_BYTES", 1024 * 1024))
        data = await read_body(request, maximum)
        try:
            asset_id = await asyncio.to_thread(assets.save_asset, data, content_type)
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
