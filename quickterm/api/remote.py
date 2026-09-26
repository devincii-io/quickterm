"""Routes for driving a session from outside its pane (the `quickterm send` verb)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import FastAPI, HTTPException, Request, Response

from quickterm.api.common import read_json

if TYPE_CHECKING:
    from quickterm.api.context import ApiContext

# Counted in UTF-8 bytes, which is what reaches the PTY. The JSON body may be
# larger than this (escapes), so the body cap stays the shared one.
INPUT_MAX_BYTES = 64 * 1024


def register(app: FastAPI, ctx: ApiContext) -> None:
    manager = ctx.manager

    @app.post("/api/sessions/{sid}/input")
    async def send_input(sid: str, request: Request) -> Response:
        session = manager.get(sid)
        if session is None:
            raise HTTPException(404, "no such session")
        if not session.info.alive:
            raise HTTPException(409, "the terminal has exited")
        body = await read_json(request)
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        text = body.get("text")
        enter = body.get("enter", False)
        if not isinstance(text, str):
            raise HTTPException(400, "text must be a string")
        if not isinstance(enter, bool):
            raise HTTPException(400, "enter must be true or false")
        try:
            data = text.encode("utf-8")
        except UnicodeEncodeError:
            # A lone surrogate from a JSON escape has no UTF-8 form.
            raise HTTPException(400, "text must be valid Unicode") from None
        if len(data) > INPUT_MAX_BYTES:
            raise HTTPException(400, f"text cannot exceed {INPUT_MAX_BYTES} bytes")
        if enter:
            # What the Enter key sends; a bare "\n" is Ctrl+J to most shells.
            data += b"\r"
        if not data:
            raise HTTPException(400, "nothing to send")
        try:
            # Only enqueues: the PTY writer thread does the blocking write.
            manager.write(sid, data)
        except BufferError:
            raise HTTPException(503, "terminal input queue is full") from None
        # Unlike the automatic replies a pane forwards, this is input a person
        # asked for, so the shell now counts as used (reaper, close-to-tray).
        manager.touch(sid)
        return Response(status_code=204)
