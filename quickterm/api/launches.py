"""Launch handoffs from outside the window: a queue and the long-poll the
primary window waits on.

Explorer's "Open QuickTerm here" queues a folder; the `quickterm` command line
also queues a profile, a workspace, or both. Everything is checked here, so
the window only ever receives a launch that could start.
"""

from __future__ import annotations

import asyncio
import importlib
from collections import deque
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI, HTTPException, Request, Response

from quickterm import launch
from quickterm.api.common import checked_dir, read_json
from quickterm.windows import normalize_workspace

if TYPE_CHECKING:
    from quickterm.api.context import ApiContext

# A long-poll re-checks its client this often. Starlette does not cancel a
# plain HTTP endpoint when the client goes away, so the waiter has to ask.
_LAUNCH_POLL_S = 0.5
_LAUNCH_WAIT_S = 20.0


class LaunchQueue:
    """Launch handoffs waiting for the primary window to claim one.

    An asyncio.Queue hands an item to its oldest getter even when that getter's
    client has gone (a reload, a closed window), and the item then vanished
    into a closed socket. Here a waiter takes an item only while its client is
    still there, and puts it back at the front if the client left meanwhile.
    """

    MAX_ITEMS = 32

    def __init__(self) -> None:
        self._items: deque[dict] = deque()
        # Replaced on every change, so a waiter holds the event for the state
        # it last looked at and a change during its own checks still wakes it.
        self.arrived = asyncio.Event()

    def put(self, item: dict) -> None:
        if len(self._items) >= self.MAX_ITEMS:
            self._items.popleft()
        self._items.append(item)
        self._wake()

    def requeue(self, item: dict) -> None:
        self._items.appendleft(item)
        self._wake()

    def pop(self) -> dict | None:
        return self._items.popleft() if self._items else None

    def _wake(self) -> None:
        event, self.arrived = self.arrived, asyncio.Event()
        event.set()


async def _wait_event(event: asyncio.Event, timeout: float) -> None:
    try:
        await asyncio.wait_for(event.wait(), timeout)
    except TimeoutError:
        pass


async def checked_launch(ctx: ApiContext, body: Any) -> dict:
    """The queue item for one handoff body: only the fields it named, each checked.

    Unknown keys are ignored, so an older window never sees a field it does
    not understand as the reason a launch failed.
    """
    if not isinstance(body, dict):
        raise HTTPException(400, "request body must be a JSON object")
    item: dict[str, str] = {}
    if body.get("cwd") is not None:
        cwd = body["cwd"]
        if not isinstance(cwd, str) or not cwd.strip():
            raise HTTPException(400, "cwd must be a non-empty string")
        item["cwd"] = await checked_dir(cwd)
    if body.get("profile") is not None:
        try:
            item["profile"] = launch.find_profile(ctx.cfg, body["profile"]).name
        except launch.LaunchError as exc:
            raise HTTPException(exc.status, str(exc)) from exc
    if body.get("workspace") is not None:
        try:
            name = normalize_workspace(body["workspace"])
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if name is None:
            raise HTTPException(400, "workspace must be a non-empty string")
        # Through sys.modules so tests can stub the store; reading a workspace
        # file blocks, so it stays off the event loop.
        workspace = importlib.import_module("quickterm.workspace")
        if await asyncio.to_thread(workspace.load_workspace, name) is None:
            raise HTTPException(404, f"no such workspace: {name}")
        item["workspace"] = name
    if not item:
        raise HTTPException(400, "a launch needs cwd, profile or workspace")
    return item


def register(app: FastAPI, ctx: ApiContext) -> None:
    pending_launches = ctx.launches

    @app.post("/api/launches")
    async def queue_launch(request: Request) -> dict:
        item = await checked_launch(ctx, await read_json(request))
        pending_launches.put(item)
        return item

    @app.get("/api/launches/next", response_model=None)
    async def next_launch(request: Request, wait: bool = True) -> Any:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + (_LAUNCH_WAIT_S if wait else 0.0)
        while True:
            # Taken before looking, so an item queued while this waiter is
            # busy checking its client still wakes it.
            arrived = pending_launches.arrived
            item = pending_launches.pop()
            if item is not None:
                if await request.is_disconnected():
                    # The window that asked is gone (reload, close). Its 200
                    # would land in a closed socket and the folder would be
                    # lost, so the next live poll gets it instead.
                    pending_launches.requeue(item)
                    return Response(status_code=204)
                return item
            remaining = deadline - loop.time()
            if remaining <= 0 or await request.is_disconnected():
                return Response(status_code=204)
            await _wait_event(arrived, min(_LAUNCH_POLL_S, remaining))
