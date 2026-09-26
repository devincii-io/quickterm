"""Idle cleanup: which sessions may be stopped, and the pass that stops them.

Owns the keep/reap policy (attached, protected, touched, retained, busy,
unread exit output) and the claim/kill/release sequence around it. The pass
runs in a worker thread (app._reap_loop) or on the loop thread; the registry
belongs to the loop thread, so every claim and release is made there.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, TypeVar

if TYPE_CHECKING:
    from .session_manager import Session

_T = TypeVar("_T")

# An exited session that the user retained or typed into, and that printed
# output nobody has seen, is kept this long after it ended (unless a viewer
# acknowledges it first). A day covers a build or agent left running
# overnight; memory stays bounded by the scrollback cap per session.
# Untouched, never-attached exited sessions go on the next pass unless they
# asked for the user: a Claude session started by autostart or `quickterm
# new` is never attached, and its "needs you" is exactly what must survive
# until someone opens it from the sidebar.
EXITED_UNREAD_RETENTION_S = 24 * 60 * 60
# A reaper claim that the loop does not run within this time (the app is
# shutting down) is treated as "not reaped".
_LOOP_CALL_TIMEOUT_S = 5.0


def keeps_unread_exit(s: Session, now: float) -> bool:
    # A retained or typed-into session was something the user cared
    # about; its last output (the build result, the agent's reply) exists
    # only in this ring, so it stays until someone has seen it.
    # A terminal that asked for the user (a bell, a notification, its own
    # exit) and was not answered is kept on the same terms: the sidebar
    # offers it as a finished row until someone opens it.
    unread = (s.info.retained or s.info.touched) and s.background_output_bytes > 0
    if not unread and s.attention is None:
        return False
    ended = s.ended_at if s.ended_at is not None else now
    return now - ended < EXITED_UNREAD_RETENTION_S


def reapable(
    s: Session,
    sid: str,
    now: float,
    timeout_s: int,
    protected: set[str],
    busy: set[str],
) -> bool:
    if s._attachments or s.reaping:
        return False
    if not s.info.alive:
        return not keeps_unread_exit(s, now)
    if sid in protected or s.info.touched or s.info.retained or sid in busy:
        return False
    if s.attention is not None:
        return False  # it is waiting for the user; idle is the point
    return timeout_s > 0 and now - s.last_activity > timeout_s


class Reaper:
    """Runs reap passes over a SessionManager's registry.

    Holds the registry dict itself (the manager only ever mutates it in
    place) and the manager's verified ``kill`` and ``busy_ids``.
    """

    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        sessions: dict[str, Session],
        kill: Callable[[str], bool],
        busy_ids: Callable[[], set[str]],
    ) -> None:
        self._loop = loop
        self._sessions = sessions
        self._kill = kill
        self._busy_ids = busy_ids

    def reap_idle(self, timeout_s: int, protected: set[str] | None = None) -> list[str]:
        """Clean stopped sessions and untouched background shells.

        A silent session that the user typed into may be an SSH connection,
        server, or WSL job, so it is never expired automatically. Exited sessions
        are cleaned even when a stale workspace file still references them,
        unless they hold final output the user has not seen (see
        EXITED_UNREAD_RETENTION_S).

        Runs in a worker thread (app._reap_loop) or on the loop thread. Each
        candidate is rechecked and claimed on the loop thread right before its
        kill: one kill can take seconds on Windows, and a session the user
        picked up meanwhile must survive the pass.
        """
        protected = protected or set()
        busy = self._busy_ids()
        now = time.monotonic()
        candidates = [
            sid
            for sid, s in list(self._sessions.items())
            if reapable(s, sid, now, timeout_s, protected, busy)
        ]
        reaped: list[str] = []
        for sid in candidates:
            session = self._on_loop(self._claim, sid, timeout_s, protected, busy)
            if session is None:
                continue
            try:
                stopped = self._kill(sid)
            except KeyError:
                continue  # removed meanwhile; nothing left to stop
            except Exception:
                self._release_soon(session)
                raise
            if stopped:
                reaped.append(sid)
            else:
                self._release_soon(session)
        return reaped

    def _release_soon(self, session: Session) -> None:
        # Fire and forget, never through _on_loop: its timeout cancels the
        # call, and a release lost to a stalled loop would leave the session
        # claimed for good, answering every attach with 4404.
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self._loop:
            _release(session)
            return
        try:
            self._loop.call_soon_threadsafe(_release, session)
        except RuntimeError:
            pass  # loop closed: no attach can come any more

    def _claim(
        self, sid: str, timeout_s: int, protected: set[str], busy: set[str]
    ) -> Session | None:
        """Loop thread: recheck one candidate and mark it for killing."""
        s = self._sessions.get(sid)
        if s is None or not reapable(s, sid, time.monotonic(), timeout_s, protected, busy):
            return None
        s.reaping = True
        return s

    def _on_loop(self, fn: Callable[..., _T], *args: Any) -> _T | None:
        """Run ``fn`` on the loop thread and return its result.

        Called directly when already on that thread (tests call reap_idle
        there, and blocking on our own loop would deadlock). Returns None when
        the loop does not run it in time, which callers read as "leave it".
        """
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self._loop:
            return fn(*args)
        result: concurrent.futures.Future[_T] = concurrent.futures.Future()

        def run() -> None:
            if result.set_running_or_notify_cancel():
                try:
                    result.set_result(fn(*args))
                except BaseException as exc:
                    result.set_exception(exc)

        try:
            self._loop.call_soon_threadsafe(run)
        except RuntimeError:
            return None  # loop closed
        try:
            return result.result(timeout=_LOOP_CALL_TIMEOUT_S)
        except concurrent.futures.TimeoutError:
            if result.cancel():
                return None
        # It started just as the wait ran out. It is short, and its effect (a
        # claim) must not be left behind with nobody to act on it.
        return result.result()


def _release(s: Session) -> None:
    s.reaping = False
