"""Session registry: lifecycle, scrollback ring buffer, subscriber fan-out."""

from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from collections import deque
from dataclasses import dataclass

from .config import default_cwd, validate_environment
from .process_usage import snapshot_processes, summarize_trees

log = logging.getLogger(__name__)

if os.name == "nt":
    from .pty_session import PtySession, pids_with_children
else:
    from .pty_posix import PtySession, pids_with_children

# Keep slow-viewer memory bounded. If a viewer falls behind this window it is
# explicitly told to reconnect and replay the current scrollback; arbitrary VT
# bytes are never silently discarded because that corrupts terminal state.
QUEUE_MAXSIZE = 8
_KILL_REMOVE_GRACE_S = 1.0


class SessionLimitError(RuntimeError):
    """A new spawn would exceed the configured live-session limit."""


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
    retained: bool = False  # Explicit detach: keep even if untouched and idle
    workspace: str | None = None  # workspace this session belongs to
    cwd: str | None = None  # directory the shell was started in


class Attachment:
    """Per-subscriber bounded queue; None = exit, overflow_sentinel = resync."""

    def __init__(self, session: "Session") -> None:
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAXSIZE)
        self.overflow_sentinel = object()
        self.overflowed = False
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
        self.started_at = self.last_activity
        self.ended_at: float | None = None
        self.resource_scope = "host-process-tree"
        # Background output is a deliberately simple, deterministic attention
        # signal: bytes produced after a viewer has detached remain unread until
        # the next attach.  This is useful for long-running builds and coding
        # agents without trying to infer semantic "working/waiting" state from
        # terminal escape sequences.
        self.ever_attached = False
        self.background_output_bytes = 0
        self.background_output_at: float | None = None

    def scrollback(self) -> tuple[bytes, int, int]:
        # Joined only here, at attach time (rare) — not on the hot output path.
        return b"".join(self._chunks), self._ring_cols, self._ring_rows

    def scrollback_chunks(self) -> tuple[tuple[bytes, ...], int, int]:
        """Snapshot replay without joining the entire ring into one allocation."""
        return tuple(self._chunks), self._ring_cols, self._ring_rows

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

    def set_scrollback_cap(self, cap: int) -> None:
        self._cap = cap
        while self._ring_bytes > self._cap and self._chunks:
            oldest = self._chunks[0]
            overflow = self._ring_bytes - self._cap
            if len(oldest) <= overflow:
                self._chunks.popleft()
                self._ring_bytes -= len(oldest)
            else:
                self._chunks[0] = oldest[overflow:]
                self._ring_bytes -= overflow

    def _fanout(self, item: bytes | None) -> None:
        for att in tuple(self._attachments):
            if att.overflowed:
                continue
            q = att.queue
            try:
                q.put_nowait(item)
            except asyncio.QueueFull:
                att.overflowed = True
                try:
                    while True:
                        q.get_nowait()
                except asyncio.QueueEmpty:
                    q.put_nowait(att.overflow_sentinel)


class SessionManager:
    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        scrollback_bytes: int = 512 * 1024,
        max_sessions: int = 0,
    ) -> None:
        self._loop = loop
        self._cap = scrollback_bytes
        self._sessions: dict[str, Session] = {}
        self._max_sessions = max_sessions
        self._cpu_samples: dict[str, tuple[float, float]] = {}

    def set_max_sessions(self, limit: int) -> None:
        self._max_sessions = limit

    def set_scrollback_bytes(self, cap: int) -> None:
        self._cap = cap
        for session in list(self._sessions.values()):
            session.set_scrollback_cap(cap)

    def live_count(self) -> int:
        return sum(1 for session in list(self._sessions.values()) if session.info.alive)

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
    ) -> SessionInfo:
        if self._max_sessions and self.live_count() >= self._max_sessions:
            raise SessionLimitError(
                f"terminal limit reached ({self._max_sessions}); stop a terminal or raise the limit"
            )
        sid = uuid.uuid4().hex
        start_dir = cwd or default_cwd()
        info = SessionInfo(
            id=sid,
            name=name or profile or cmd,
            profile=profile,
            alive=True,
            exit_code=None,
            cols=cols,
            rows=rows,
            workspace=workspace,
            cwd=start_dir,
        )
        session = Session(info, self._cap)
        if os.path.basename(cmd).casefold() in {"wsl", "wsl.exe"}:
            session.resource_scope = "host-process-tree-partial-wsl"
        child_env = dict(validate_environment(env or {}))
        session.pty = PtySession(
            cmd,
            list(args or []),
            start_dir,
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
        # The registry is mutated on the event-loop thread but iterated from
        # the anyio threadpool (sync REST handlers) and the pywebview GUI
        # thread (the close policy). Every iteration here snapshots first, so a
        # spawn or reap mid-scan can never raise "dictionary changed size".
        return [s.info for s in list(self._sessions.values())]

    def sync_workspace(self, name: str, session_ids: set[str]) -> None:
        """Mirror one saved workspace's membership into live session metadata.

        Workspace JSON remains the durable authority. This lightweight live
        label makes global/session views accurate immediately after a Scratch
        promotion or an explicit move without scanning every workspace on each
        sidebar poll.
        """
        for sid, session in list(self._sessions.items()):
            if sid in session_ids:
                session.info.workspace = name
            elif session.info.workspace == name:
                session.info.workspace = None

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
            log.debug("process child snapshot failed; busy state unavailable", exc_info=True)
            return set()
        return {
            sid
            for sid, s in list(self._sessions.items())
            if s.info.alive and s.pty is not None and s.pty.pid in parents
        }

    def session_metrics(self) -> tuple[set[str], dict[str, dict]]:
        """Resource usage and busy state for every session from one OS snapshot.

        CPU is the process-tree CPU time consumed between API samples divided by
        wall time, so 100% represents one logical CPU and multi-process workloads
        may exceed 100%.
        """
        now = time.monotonic()
        roots = {
            session.pty.pid
            for session in list(self._sessions.values())
            if session.info.alive and session.pty is not None and session.pty.pid
        }
        # Sample only the session trees. Opening a handle and reading counters
        # for every PID on the machine was the expensive half of the snapshot,
        # and summarize_trees discarded all of it anyway.
        processes = snapshot_processes(roots)
        totals = summarize_trees(processes, roots)
        metrics: dict[str, dict] = {}
        busy: set[str] = set()
        active_ids: set[str] = set()
        for sid, session in list(self._sessions.items()):
            active_ids.add(sid)
            root = session.pty.pid if session.pty is not None else 0
            total = totals.get(root)
            measured = bool(session.info.alive and total and total.process_count)
            cpu_percent: float | None = None
            if measured and total is not None:
                previous = self._cpu_samples.get(sid)
                if previous is not None and now > previous[0]:
                    cpu_percent = max(0.0, (total.cpu_time_s - previous[1]) / (now - previous[0]) * 100)
                self._cpu_samples[sid] = (now, total.cpu_time_s)
                if total.process_count > 1:
                    busy.add(sid)
            else:
                self._cpu_samples.pop(sid, None)
            stopped_at = session.ended_at or now
            metrics[sid] = {
                "available": measured,
                "working_set_bytes": total.working_set_bytes if measured and total else None,
                "cpu_percent": round(cpu_percent, 1) if cpu_percent is not None else None,
                "process_count": total.process_count if measured and total else 0,
                "uptime_seconds": max(0, int(stopped_at - session.started_at)),
                "scope": session.resource_scope,
            }
        for sid in set(self._cpu_samples) - active_ids:
            self._cpu_samples.pop(sid, None)
        return busy, metrics

    def session_activity(self, sid: str) -> dict[str, int | None]:
        """Return lightweight attention metadata for one session."""
        session = self._sessions.get(sid)
        if session is None:
            return {
                "idle_seconds": 0,
                "background_output_bytes": 0,
                "background_output_age_seconds": None,
            }
        now = time.monotonic()
        return {
            "idle_seconds": max(0, int(now - session.last_activity)),
            "background_output_bytes": session.background_output_bytes,
            "background_output_age_seconds": (
                max(0, int(now - session.background_output_at))
                if session.background_output_at is not None
                else None
            ),
        }

    def has_attachments(self, sid: str) -> bool:
        s = self._sessions.get(sid)
        return bool(s and s._attachments)

    def attachment_count(self, sid: str) -> int:
        s = self._sessions.get(sid)
        return len(s._attachments) if s else 0

    def resize(self, sid: str, cols: int, rows: int) -> None:
        s = self._sessions.get(sid)
        if s and s.pty and s.info.alive:
            s.info.cols, s.info.rows = cols, rows
            # Reconnect geometry must stay current even while the PTY is silent.
            s._ring_cols, s._ring_rows = cols, rows
            s.pty.resize(cols, rows)

    def kill(self, sid: str) -> bool:
        """Stop a session, returning only after the backend confirms the kill.

        REST sync handlers run in a worker thread, so all asyncio queue and
        timer mutation is marshalled back to the owning loop.  Previously the
        grace-period timer was installed directly from that worker and the
        session stayed visibly alive until the PTY reader eventually reported
        EOF, which made dashboard kills look ineffective.
        """
        s = self._sessions.get(sid)
        if not s:
            return False
        stopped = True
        if s.pty:
            result = s.pty.kill()
            # Compatibility with small test/plugin PTY implementations whose
            # historical kill method returned None.
            stopped = result is not False
        if not stopped:
            return False
        try:
            self._loop.call_soon_threadsafe(self._finish_kill, sid, s)
        except RuntimeError:
            # The app is already shutting down; the OS process is nevertheless
            # confirmed stopped, and there is no live registry to notify.
            pass
        return True

    def _finish_kill(self, sid: str, session: Session) -> None:
        if self._sessions.get(sid) is not session:
            return
        if session.info.alive:
            session.info.alive = False
            session.info.exit_code = session.pty.exit_code if session.pty else 1
            if session.info.exit_code is None:
                session.info.exit_code = 1
            session.ended_at = time.monotonic()
            session._fanout(None)
        self._loop.call_later(_KILL_REMOVE_GRACE_S, self._remove_if_same, sid, session)

    def _remove_if_same(self, sid: str, session: Session) -> None:
        if self._sessions.get(sid) is session:
            self._sessions.pop(sid, None)
            self._cpu_samples.pop(sid, None)

    def attach(self, sid: str) -> Attachment:
        s = self._sessions[sid]
        # Opening the terminal acknowledges output accumulated while it was in
        # the background. Do this before registering the viewer so the state is
        # consistent for concurrent session-list requests.
        s.ever_attached = True
        s.background_output_bytes = 0
        s.background_output_at = None
        att = Attachment(s)
        s._attachments.add(att)
        if not s.info.alive:
            att.queue.put_nowait(None)
        return att

    def shutdown(self) -> None:
        for s in list(self._sessions.values()):
            if s.pty:
                s.pty.kill()
        self._sessions.clear()

    def reap_idle(self, timeout_s: int, protected: set[str] | None = None) -> list[str]:
        """Clean stopped sessions and untouched background shells.

        A silent session that the user typed into may be an SSH connection,
        server, or WSL job, so it is never expired automatically. Exited sessions
        are cleaned even when a stale workspace file still references them.
        """
        protected = protected or set()
        now = time.monotonic()
        busy = self.busy_ids()
        doomed: list[str] = []
        for sid, s in list(self._sessions.items()):
            if s._attachments:
                continue
            if not s.info.alive:
                doomed.append(sid)
            elif sid in protected or s.info.touched or s.info.retained or sid in busy:
                continue
            elif timeout_s > 0 and now - s.last_activity > timeout_s:
                doomed.append(sid)
        return [sid for sid in doomed if self.kill(sid)]

    # loop-thread callbacks from PtySession

    def _on_output(self, session: Session, data: bytes) -> None:
        session.last_activity = time.monotonic()
        if data and session.ever_attached and not session._attachments:
            session.background_output_bytes += len(data)
            session.background_output_at = session.last_activity
        session._record(data)
        session._fanout(data)

    def _on_exit(self, session: Session, code: int) -> None:
        was_alive = session.info.alive
        session.info.alive = False
        session.info.exit_code = code
        session.ended_at = time.monotonic()
        if was_alive:
            session._fanout(None)
