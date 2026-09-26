"""Request helpers shared by more than one route module."""

from __future__ import annotations

import asyncio
import dataclasses
import functools
import json
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException, Request

from quickterm import launch

if TYPE_CHECKING:
    from quickterm.api.context import ApiContext

JSON_BODY_CAP = 1024 * 1024


def asdict(obj: Any) -> Any:
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return dataclasses.asdict(obj)
    return dict(vars(obj))


def request_workspace(body: dict) -> str | None:
    name = body.get("workspace")
    if name is not None and not isinstance(name, str):
        raise HTTPException(400, "workspace must be a string")
    return (name or "").strip() or None


def bounded_int(value: Any, name: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool):
        raise HTTPException(400, f"{name} must be an integer")
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        raise HTTPException(400, f"{name} must be an integer") from None
    if number < minimum or number > maximum:
        raise HTTPException(400, f"{name} must be between {minimum} and {maximum}")
    return number


async def read_json(request: Request, maximum: int = JSON_BODY_CAP) -> Any:
    """Read a bounded JSON body without first buffering an unbounded request."""
    raw = await read_body(request, maximum)
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(400, "request body must be valid JSON") from exc


async def read_body(request: Request, maximum: int) -> bytes:
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


def kill_each(manager: Any, session_ids: list[str]) -> tuple[list[str], list[str]]:
    """Kill several sessions; returns (stopped, still running). Blocking.

    An id the registry no longer holds counts as stopped: the reaper or a kill
    grace timer got there first, and nothing of it is left running.
    """
    killed: list[str] = []
    failed: list[str] = []
    for sid in session_ids:
        try:
            stopped = manager.kill(sid)
        except KeyError:
            stopped = True
        (killed if stopped else failed).append(sid)
    return killed, failed


async def checked_dir(value: str, label: str | None = None) -> str:
    """launch.validate_dir off the loop: a cold network share can stall."""
    try:
        return await asyncio.to_thread(launch.validate_dir, value, label)
    except launch.LaunchError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


async def resolve_request(
    ctx: ApiContext, body: dict, *, append_tools: bool = True
) -> launch.LaunchSpec:
    """The one path from a request body to a LaunchSpec (spawn and elevate)."""
    workspace_name = request_workspace(body)
    cwd = body.get("cwd")
    if cwd is not None and not isinstance(cwd, str):
        raise HTTPException(400, "cwd must be a string")
    # A workspace is a folder: every session it owns starts there unless
    # the request names a directory itself (Explorer handoff, or a split
    # inheriting the source pane's cwd). Profiles contribute nothing here.
    request_cwd = cwd if cwd and cwd.strip() else None
    root = None
    if request_cwd is None:
        root = await asyncio.to_thread(launch.workspace_start, workspace_name)
    try:
        return await asyncio.to_thread(
            functools.partial(
                launch.resolve,
                ctx.cfg,
                profile=body.get("profile"),
                cmd=body.get("cmd"),
                args=body.get("args"),
                env=body.get("env"),
                name=body.get("name"),
                start_command=body.get("start_command"),
                claude_mode=body.get("claude_mode"),
                request_cwd=request_cwd,
                workspace_root=root,
                append_tools=append_tools,
            )
        )
    except launch.LaunchError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
