"""Session registry: lifecycle, scrollback ring buffer, subscriber fan-out."""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass

from .pty_session import PtySession

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
        self._ring = bytearray()
        self._ring_cols = info.cols
        self._ring_rows = info.rows
        self._attachments: set[Attachment] = set()

    def scrollback(self) -> tuple[bytes, int, int]:
        return bytes(self._ring), self._ring_cols, self._ring_rows

    def _record(self, data: bytes) -> None:
        self._ring += data
        if len(self._ring) > self._cap:
            del self._ring[: len(self._ring) - self._cap]
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
        )
        session = Session(info, self._cap)
        session.pty = PtySession(
            cmd,
            list(args or []),
            cwd,
            dict(env or {}),
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
            s.pty.write(data)

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

    # loop-thread callbacks from PtySession

    def _on_output(self, session: Session, data: bytes) -> None:
        session._record(data)
        session._fanout(data)

    def _on_exit(self, session: Session, code: int) -> None:
        session.info.alive = False
        session.info.exit_code = code
        session._fanout(None)
