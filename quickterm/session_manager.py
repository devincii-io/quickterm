"""Session registry: lifecycle, scrollback ring buffer, subscriber fan-out."""

from __future__ import annotations

import asyncio
import os
import time
import uuid
from collections import deque
from dataclasses import dataclass

from .config import default_cwd

if os.name == "nt":
    from .pty_session import PtySession, pids_with_children
else:
    from .pty_posix import PtySession, pids_with_children

QUEUE_MAXSIZE = 256
_KILL_REMOVE_GRACE_S = 1.0


@dataclass
class SessionInfo:
    id: str
    name: str
    profile: str | None
    alive: bool
    exit_code: int | None
    cols: int
    rows: int
    touched: bool = False  # True once the user has written any input
    workspace: str | None = None  # workspace this session was spawned into (MCP scope hint)
    mcp_touched: bool = False  # True once an MCP client has written into it


class Attachment:
    """Per-subscriber bounded queue of bytes chunks; None = session exited."""

    def __init__(self, session: "Session") -> None:
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAXSIZE)
        self._session = session

    def detach(self) -> None:
        self._session._attachments.discard(self)


class Session:
    def __init__(self, info: SessionInfo, cap: int) -> None:
        self.info = info
        self.pty: PtySession | None = None
        self._cap = cap
        # Scrollback ring as a deque of chunks + running byte count: appending
        # and trimming cost O(chunk), not O(cap) — the old bytearray slice
        # memmoved up to `cap` bytes on every write under sustained output.
        self._chunks: deque[bytes] = deque()
        self._ring_bytes = 0
        self._ring_cols = info.cols
        self._ring_rows = info.rows
        self._attachments: set[Attachment] = set()
        self.last_activity = time.monotonic()  # updated on output and input

    def scrollback(self) -> tuple[bytes, int, int]:
        # Joined only here, at attach time (rare) — not on the hot output path.
        return b"".join(self._chunks), self._ring_cols, self._ring_rows

    def _record(self, data: bytes) -> None:
        if data:
            self._chunks.append(data)
            self._ring_bytes += len(data)
            while self._ring_bytes > self._cap:
                oldest = self._chunks[0]
                overflow = self._ring_bytes - self._cap
                if len(oldest) <= overflow:
                    self._chunks.popleft()
                    self._ring_bytes -= len(oldest)
                else:
                    self._chunks[0] = oldest[overflow:]  # trim front of oldest
                    self._ring_bytes -= overflow
        self._ring_cols, self._ring_rows = self.info.cols, self.info.rows

    def _fanout(self, item: bytes | None) -> None:
        for att in tuple(self._attachments):
            q = att.queue
            try:
                q.put_nowait(item)
            except asyncio.QueueFull:
                # drop oldest for this slow subscriber only; others unaffected
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    q.put_nowait(item)
                except asyncio.QueueFull:
                    pass


class SessionManager:
    def __init__(
        self, loop: asyncio.AbstractEventLoop, scrollback_bytes: int = 512 * 1024
    ) -> None:
        self._loop = loop
        self._cap = scrollback_bytes
        self._sessions: dict[str, Session] = {}
        self.focused_session_id: str | None = None
        # Static discovery env injected into every spawned terminal (port, token)
        # so an MCP client launched inside a pane finds the backend. The server
        # sets this at app build; each spawn adds the per-session id/workspace.
        self.env_context: dict[str, str] = {}

    def spawn(
        self,
        *,
        name: str | None = None,
        profile: str | None = None,
        cmd: str,
        args: list[str] | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        cols: int = 120,
        rows: int = 30,
        workspace: str | None = None,
        inject_env: bool = False,
    ) -> SessionInfo:
        sid = uuid.uuid4().hex[:8]
        info = SessionInfo(
            id=sid,
            name=name or profile or cmd,
            profile=profile,
            alive=True,
            exit_code=None,
            cols=cols,
            rows=rows,
            workspace=workspace,
        )
        session = Session(info, self._cap)
        # The discovery env (incl. the auth token) is injected ONLY when the
        # caller opts in — so the token is not handed to every shell. The
        # workspace tag above is set regardless: it is server-side metadata for
        # scoping, not a secret. Discovery vars win over the profile's env so a
        # caller cannot spoof the session's own identity.
        child_env = dict(env or {})
        if inject_env:
            child_env.update(self.env_context)
            child_env["QUICKTERM_SESSION_ID"] = sid
            if workspace:
                child_env["QUICKTERM_WORKSPACE"] = workspace
        session.pty = PtySession(
            cmd,
            list(args or []),
            cwd or default_cwd(),
            child_env,
            cols,
            rows,
            self._loop,
            on_output=lambda data, s=session: self._on_output(s, data),
            on_exit=lambda code, s=session: self._on_exit(s, code),
        )
        self._sessions[sid] = session
        return info

    def list(self) -> list[SessionInfo]:
        return [s.info for s in self._sessions.values()]

    def get(self, sid: str) -> Session | None:
        return self._sessions.get(sid)

    def write(self, sid: str, data: bytes) -> None:
        s = self._sessions.get(sid)
        if s and s.pty and s.info.alive:
            s.info.touched = True
            s.last_activity = time.monotonic()
            s.pty.write(data)

    def busy_ids(self) -> set[str]:
        """Sessions whose shell has a child process right now (ssh, a build,
        an editor, ...). One process snapshot for all sessions; used by the UI
        to guard close actions that would lose running work. WSL in-VM
        processes are invisible to the snapshot — a known blind spot.
        """
        try:
            parents = pids_with_children()
        except Exception:
            return set()
        return {
            sid
            for sid, s in self._sessions.items()
            if s.info.alive and s.pty is not None and s.pty.pid in parents
        }

    def has_attachments(self, sid: str) -> bool:
        s = self._sessions.get(sid)
        return bool(s and s._attachments)

    def attachment_count(self, sid: str) -> int:
        s = self._sessions.get(sid)
        return len(s._attachments) if s else 0

    def resize(self, sid: str, cols: int, rows: int) -> None:
        s = self._sessions.get(sid)
        if s and s.pty:
            s.info.cols, s.info.rows = cols, rows
            s.pty.resize(cols, rows)

    def kill(self, sid: str) -> None:
        s = self._sessions.get(sid)
        if not s:
            return
        if s.pty:
            s.pty.kill()
        self._loop.call_later(_KILL_REMOVE_GRACE_S, self._sessions.pop, sid, None)

    def attach(self, sid: str) -> Attachment:
        s = self._sessions[sid]
        att = Attachment(s)
        s._attachments.add(att)
        if not s.info.alive:
            att.queue.put_nowait(None)
        return att

    def shutdown(self) -> None:
        for s in self._sessions.values():
            if s.pty:
                s.pty.kill()
        self._sessions.clear()

    def reap_idle(self, timeout_s: int, protected: set[str] | None = None) -> list[str]:
        """Kill background clutter: sessions nobody is attached to that a saved
        workspace does not reference. A live session is only reaped once it has
        been silent (no output, no input) for `timeout_s`; an already-exited one
        goes immediately. Attached and workspace-persisted sessions are safe.
        """
        protected = protected or set()
        now = time.monotonic()
        doomed: list[str] = []
        for sid, s in self._sessions.items():
            if s._attachments or sid in protected:
                continue
            if not s.info.alive:
                doomed.append(sid)
            elif timeout_s > 0 and now - s.last_activity > timeout_s:
                doomed.append(sid)
        for sid in doomed:
            self.kill(sid)
        return doomed

    # loop-thread callbacks from PtySession

    def _on_output(self, session: Session, data: bytes) -> None:
        session.last_activity = time.monotonic()
        session._record(data)
        session._fanout(data)

    def _on_exit(self, session: Session, code: int) -> None:
        session.info.alive = False
        session.info.exit_code = code
        session._fanout(None)
