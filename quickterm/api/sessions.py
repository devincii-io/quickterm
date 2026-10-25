"""Session routes: list, spawn, kill, retain, rename, seen, cleanup, kill-all."""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI, HTTPException, Request, Response

from quickterm import agent_hooks, launch, usage
from quickterm.api import usage as api_usage
from quickterm.api.common import (
    asdict,
    bounded_int,
    kill_each,
    read_json,
    request_workspace,
    resolve_request,
)

from quickterm.signals import NotifyThrottle

if TYPE_CHECKING:
    from quickterm.api.context import ApiContext

# One native notification per terminal per this many seconds. The sidebar
# state is not throttled; only the flash and the balloon are.
NOTIFY_INTERVAL_S = 30.0
AGENT_EVENT_MAX_BYTES = 256 * 1024
# When a finished turn's conversation has no title yet, look again after these
# pauses (seconds, one after the other).
TITLE_RETRY_S = (3.0, 10.0)


def notice_setting(cfg: Any, kind: str) -> tuple[str, bool]:
    """``(mode, sound)`` for an attention of ``kind`` from Settings >
    Notifications: an agent's finished turn ("done") follows "When an agent
    finishes", everything else "When an agent needs you"."""
    notifications = getattr(cfg, "notifications", None)
    if kind == "done":
        mode = getattr(notifications, "finished", "flash")
    else:
        mode = getattr(notifications, "needs_you", "notify")
    return str(mode), bool(getattr(notifications, "sound", False))


def _wire_notifier(ctx: ApiContext) -> None:
    """Pass each session's new attention to the desktop shell, rate-limited."""
    notify = ctx.notify
    listen = getattr(ctx.manager, "set_attention_listener", None)
    if notify is None or listen is None:
        return
    throttle = NotifyThrottle(NOTIFY_INTERVAL_S)

    def on_attention(info: Any, record: Any) -> None:
        mode, sound = notice_setting(ctx.cfg, record.kind)
        if mode == "off":
            return
        # A finished turn and a question are throttled apart: "done" right
        # after "may I?" is a second piece of news.
        category = "done" if record.kind == "done" else "attention"
        if throttle.allow(f"{info.id}:{category}"):
            notify(info.id, info.name, record.kind, record.text, mode=mode, sound=sound)

    listen(on_attention)


def _wire_keep_awake(ctx: ApiContext) -> None:
    """Keep-awake reads the live config, so a Settings save applies at once."""
    configure = getattr(ctx.manager, "set_keep_awake", None)
    if configure is not None:
        configure(lambda: getattr(ctx.cfg, "keep_awake", "agents"))


def register(app: FastAPI, ctx: ApiContext) -> None:
    manager = ctx.manager
    _wire_notifier(ctx)
    _wire_keep_awake(ctx)

    @app.get("/api/sessions")
    def list_sessions(metrics: bool = True) -> list[dict]:
        # Sidebar polling skips usage sampling, the expensive half: one handle
        # and counter read per process in every session tree. Busy still comes
        # from one process-table snapshot, because returning null there left
        # the sidebar unable to ever show a busy terminal.
        if metrics:
            busy_set, usage = manager.session_metrics()
        else:
            busy_set, usage = manager.busy_ids(), {}
        out = []
        for info in manager.list():
            d = asdict(info)
            d["attachments"] = manager.attachment_count(info.id)
            d["busy"] = info.id in busy_set
            d["activity"] = manager.session_activity(info.id)
            d["attention"] = manager.session_attention(info.id)
            d["agent"] = manager.session_agent(info.id)
            if info.id in usage:
                d["usage"] = usage[info.id]
            out.append(d)
        return out

    @app.post("/api/sessions/{sid}/seen")
    def mark_session_seen(sid: str) -> Response:
        """The user looked at this terminal: clear its "needs you" state."""
        try:
            manager.mark_seen(sid)
        except KeyError:
            raise HTTPException(404, "no such session") from None
        return Response(status_code=204)

    @app.post("/api/sessions/{sid}/agent-event")
    async def agent_event(sid: str, request: Request, agent: str | None = None) -> Response:
        """One Claude Code or Codex hook event, from the curl the hook runs.

        The guard lets the hook token in here and nowhere else.
        """
        raw = bytearray()
        async for chunk in request.stream():
            raw += chunk
            if len(raw) > AGENT_EVENT_MAX_BYTES:
                raise HTTPException(400, "body too large")
        try:
            agent_name, event, payload = agent_hooks.parse_body(json.loads(raw), agent)
        except (ValueError, RecursionError) as exc:
            raise HTTPException(400, str(exc) if isinstance(exc, ValueError) else "bad body") from None
        if agent_name == "claude" and event == usage.CLAUDE_EVENT:
            # Rate limits from the status line: numbers for the footer, never
            # agent state.
            session = manager.get(sid)
            if session is None:
                raise HTTPException(404, "no such session")
            store = api_usage.claude_limits(request.app)
            if store.record(payload.get("rate_limits"), usage.report_origin(session.info, payload.get("config_dir"))) and store.needs_save():
                await asyncio.to_thread(store.save)
            return Response(status_code=204)
        title = None
        # An agent on an SSH host or in WSL has its files there: paths in its
        # hooks are never read here, only what the payload itself carries.
        local = not getattr(manager, "is_remote", lambda _sid: False)(sid)
        if local and event in ("Stop", agent_hooks.CODEX_TURN_COMPLETE):
            # The answer may only be in the transcript, and the title is in
            # the agent's own files: both are file reads, off the loop.
            payload, title = await asyncio.to_thread(
                agent_hooks.turn_details, agent_name, event, payload
            )
        try:
            manager.agent_event(sid, agent_name, event, payload)
        except KeyError:
            raise HTTPException(404, "no such session") from None
        set_title = getattr(manager, "set_agent_title", None)
        if title and set_title is not None:
            set_title(sid, title)
        elif local and set_title is not None and event in ("Stop", agent_hooks.CODEX_TURN_COMPLETE):
            # Claude writes a new conversation's title a moment after its
            # first turn ends, so the Stop hook usually arrives before it.
            task = asyncio.ensure_future(_title_later(sid, agent_name, event, payload))
            title_tasks.add(task)
            task.add_done_callback(title_tasks.discard)
        return Response(status_code=204)

    title_tasks: set[asyncio.Future[None]] = set()

    async def _title_later(sid: str, agent_name: str, event: str, payload: dict) -> None:
        for delay in TITLE_RETRY_S:
            await asyncio.sleep(delay)
            if manager.get(sid) is None:
                return
            _, title = await asyncio.to_thread(agent_hooks.turn_details, agent_name, event, payload)
            if title:
                manager.set_agent_title(sid, title)
                return

    @app.post("/api/sessions")
    async def spawn_session(request: Request) -> dict:
        body = await read_json(request)
        if not isinstance(body, dict):
            raise HTTPException(400, "request body must be a JSON object")
        cols = bounded_int(body.get("cols", 120), "cols", 2, 1000)
        rows = bounded_int(body.get("rows", 30), "rows", 1, 1000)
        spec = await resolve_request(ctx, body)
        from quickterm.session_manager import SessionLimitError, SpawnError

        try:
            # spawn_async builds the PTY in a worker thread: PATHEXT scan,
            # CreatePseudoConsole and CreateProcess all block.
            info = await manager.spawn_async(
                **spec.spawn_kwargs(),
                cols=cols,
                rows=rows,
                workspace=request_workspace(body),
            )
        except SessionLimitError as exc:
            raise HTTPException(409, str(exc)) from exc
        except SpawnError as exc:
            raise HTTPException(400, launch.describe_failure(spec.label, exc)) from exc
        return asdict(info)

    @app.delete("/api/sessions/{sid}")
    def kill_session(sid: str) -> Response:
        try:
            stopped = manager.kill(sid)
        except KeyError:
            # Gone already (the reaper or a grace timer dropped it): there is
            # nothing left running, so the pane may close.
            raise HTTPException(404, "no such session") from None
        if not stopped:
            raise HTTPException(500, "terminal process could not be stopped")
        return Response(status_code=204)

    @app.post("/api/sessions/{sid}/retain")
    def retain_session(sid: str) -> dict:
        """Keep an explicitly detached terminal out of the untouched-shell reaper."""
        session = manager.get(sid)
        if session is None:
            raise HTTPException(404, "no such session")
        session.info.retained = True
        return asdict(session.info)

    @app.patch("/api/sessions/{sid}")
    async def rename_session(sid: str, request: Request) -> dict:
        session = manager.get(sid)
        if session is None:
            raise HTTPException(404, "no such session")
        body = await read_json(request)
        name = str(body.get("name") or "").strip() if isinstance(body, dict) else ""
        if not name:
            raise HTTPException(400, "body must be {'name': <non-empty string>}")
        session.info.name = name[:80]
        # A name a person gave wins over the agent's conversation title.
        mark_named = getattr(manager, "mark_named", None)
        if mark_named is not None:
            mark_named(sid)
        return asdict(session.info)

    @app.post("/api/sessions/cleanup")
    async def cleanup_sessions(request: Request) -> Response:
        body = await read_json(request)
        session_ids = body.get("session_ids", []) if isinstance(body, dict) else []
        if not isinstance(session_ids, list):
            session_ids = []
        # manager.kill spawns taskkill and waits on process handles; on the
        # event loop that freezes every pane for the duration.
        _killed, failed = await asyncio.to_thread(
            kill_each, manager, [sid for sid in session_ids if isinstance(sid, str)]
        )
        if failed:
            raise HTTPException(500, f"could not stop {len(failed)} terminal process(es)")
        return Response(status_code=204)

    @app.post("/api/sessions/kill-all")
    def kill_all_sessions() -> dict:
        session_ids = [info.id for info in manager.list() if info.alive]
        killed, failed = kill_each(manager, session_ids)
        # A partial result is still actionable: clients must remove only the
        # sessions the backend verified as stopped and keep failures visible
        # for retry. Returning a generic 500 previously discarded that detail
        # and made Kill all look as though it had done nothing.
        return {"killed": len(killed), "killed_ids": killed, "failed_ids": failed}
