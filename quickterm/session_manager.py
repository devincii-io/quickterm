"""Session registry: lifecycle, input, busy state and metrics.

Owns SessionInfo, Session and SessionManager: spawning a PTY, the registry
the loop thread mutates, writes, resizes, verified kills, attach, and the
loop-thread callbacks from the PTY backends. The scrollback ring lives in
``scrollback``, per-viewer queues in ``fanout``, idle cleanup in ``reaper``;
their public names are re-exported here, which is the import path callers use.
"""

from __future__ import annotations

import asyncio
import dataclasses
import logging
import os
import re
import secrets
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from . import agent_hooks, keep_awake, launch, shells
from .agent_hooks import AgentState
from .config import default_cwd, validate_environment
from .fanout import QUEUE_MAX_BYTES, QUEUE_MERGE_BYTES, Attachment, AttachmentQueue, Viewers
from .process_usage import (
    pids_with_children,
    process_identities,
    process_names,
    shell_at_prompt,
    snapshot_processes,
    summarize_trees,
)
from .reaper import EXITED_UNREAD_RETENTION_S, Reaper
from .scrollback import ScrollbackRing
from .signals import SignalScanner, clean_text

log = logging.getLogger(__name__)

if os.name == "nt":
    from .pty_session import PtySession
else:
    from .pty_posix import PtySession

__all__ = [
    "EXITED_UNREAD_RETENTION_S",
    "Attention",
    "QUEUE_MAX_BYTES",
    "QUEUE_MERGE_BYTES",
    "Attachment",
    "AttachmentQueue",
    "PtySession",
    "Session",
    "SessionInfo",
    "SessionLimitError",
    "SessionManager",
    "SpawnError",
    "pids_with_children",
]

_KILL_REMOVE_GRACE_S = 1.0
# How long typed input to a remote agent terminal waits for the hook token to
# go out first, and how much of it is kept meanwhile.
HOOK_HOLD_S = 10.0
HOOK_HOLD_BYTES = 64 * 1024
# xterm's answers to the device-attributes and cursor-position queries.
_TERMINAL_REPLY = re.compile(rb"\x1b\[\?[0-9;]*c|\x1b\[[0-9]+;[0-9]+R")
# How often keep-awake looks again without an event (agents leaving the shell,
# a mode changed in Settings).
KEEP_AWAKE_TICK_S = 15.0


class SessionLimitError(RuntimeError):
    """A new spawn would exceed the configured live-session limit."""


class SpawnError(ValueError):
    """The PTY backend could not start the process (missing command, bad folder)."""


@dataclass
class SessionInfo:
    id: str
    name: str
    profile: str | None
    alive: bool
    exit_code: int | None
    cols: int
    rows: int
    touched: bool = False  # True once the user typed or pasted (the client's touch frame)
    retained: bool = False  # Explicit detach: keep even if untouched and idle
    workspace: str | None = None  # workspace this session belongs to
    cwd: str | None = None  # directory the shell was started in
    # Where the shell says it is now (OSC 7 or OSC 9;9), None until it says so.
    current_cwd: str | None = None
    # The SSH destination a remote workspace's terminal runs on; None
    # elsewhere (a WSL workspace's terminals included).
    host: str | None = None
    # The shell an agent runs inside ("powershell", "wsl:Ubuntu", ...), None
    # when the PTY runs no wrapped agent. A WSL agent's process is out of
    # sight, so the pane also takes the wrap's exit marker as its end.
    agent_shell: str | None = None


@dataclass
class Attention:
    """The latest reason a session wants the user: "bell", "notify" or "exit".

    The attention listener also hears "done", an agent's finished turn, which
    is never stored as a session's attention.

    Latest wins. Cleared by mark_seen (the client saw it) and by touch (the
    user typed), never by more output: a program that keeps printing after
    ringing still asked a question nobody has answered.
    """

    kind: str
    text: str | None
    at: float  # time.monotonic() when it was raised


class Session:
    def __init__(self, info: SessionInfo, cap: int) -> None:
        self.info = info
        self.pty: PtySession | None = None
        self._ring = ScrollbackRing(cap, info.cols, info.rows)
        self._attachments = Viewers()
        self.last_activity = time.monotonic()  # updated on output and input
        self.started_at = self.last_activity
        self.ended_at: float | None = None
        self.resource_scope = "host-process-tree"
        # Set on the loop thread while the reaper is between its final check
        # and the kill; attach() refuses such a session.
        self.reaping = False
        # Background output is a deliberately simple, deterministic attention
        # signal: bytes produced after a viewer has detached remain unread until
        # the next attach.  This is useful for long-running builds and coding
        # agents without trying to infer semantic "working/waiting" state from
        # terminal escape sequences.
        self.ever_attached = False
        self.background_output_bytes = 0
        self.background_output_at: float | None = None
        self.attention: Attention | None = None
        self._signals = SignalScanner()
        # Set before a kill is attempted, so the exit it causes is not
        # reported as the terminal asking for the user.
        self.stopping = False
        # What the agent's hooks last reported; None without an agent.
        self.agent: AgentState | None = None
        # The PTY runs a shell that runs the agent: the agent is gone once
        # the shell has no child process left.
        self.agent_shell = False
        self.msys_root = False
        # The name the session started with, and whether a person renamed
        # it since. Until then the name follows the agent's conversation title.
        self.base_name = info.name
        self.named = False
        # A remote agent terminal waits for the hook token until this marker
        # shows in its output (see SessionManager._answer_hook_marker).
        self.hook_marker: bytes | None = None
        self.hook_tail = b""
        self.hook_nonce = ""
        # Printed by the remote script once ssh has logged in; holding starts
        # there, so a password typed at ssh's prompt is never held.
        self.ready_marker: bytes | None = None
        # Input typed between the ready marker and the token answer waits
        # here (at most until hold_until), so it can neither become the token
        # nor push the token line through to the agent.
        self.held_input: list[bytes] = []
        self.hold_until = 0.0
        # Runs on an SSH host or in WSL: paths its hooks name are not this
        # computer's.
        self.remote = False

    def scrollback_chunks(self) -> tuple[tuple[bytes, ...], int, int]:
        """Replay snapshot: an optional mode preamble, then the ring's chunks.

        The ring is never joined into one allocation. Its first byte is never
        inside an escape sequence or a UTF-8 character, and the preamble
        re-establishes the DEC private modes that were in effect there.
        """
        return self._ring.snapshot()

    def replay_steps(self) -> tuple[tuple[bytes | tuple[int, int], ...], int, int]:
        """What a viewer replays: output chunks and ``(cols, rows)`` resizes in
        stream order, and the size the first step was written at."""
        return self._ring.replay()

    def set_scrollback_cap(self, cap: int) -> None:
        self._ring.set_cap(cap)


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
        # spawn_async calls between their limit check and their registry
        # insert; counted against the limit so parallel requests cannot all
        # pass the check while their PTYs are still being built.
        self._spawning = 0
        # Told on the loop thread whenever a session gains attention; the
        # server hands it to the desktop shell's notifier.
        self._attention_listener: Callable[[SessionInfo, Attention], None] | None = None
        # Shares the registry dict, so it must only ever be mutated in place.
        self._reaper = Reaper(loop, self._sessions, self.kill, self.busy_ids)
        # QUICKTERM_PORT and QUICKTERM_HOOK_TOKEN for every child, set by the
        # server; empty until then, and agent launches then get no hooks.
        self._hook_env: dict[str, str] = {}
        # Called on the loop thread only: the execution state belongs to the
        # thread that set it (keep_awake.py).
        self._keep_awake = keep_awake.KeepAwake()
        self._keep_awake_mode: Callable[[], str] = lambda: keep_awake.DEFAULT_MODE
        self._keep_awake_timer: asyncio.TimerHandle | None = None

    def set_agent_hooks(self, port: int, token: str) -> None:
        """Where agent hooks report to; every later spawn carries it."""
        self._hook_env = {"QUICKTERM_PORT": str(port), "QUICKTERM_HOOK_TOKEN": token}

    def set_keep_awake(self, mode: Callable[[], str]) -> None:
        """Where the keep-awake mode is read (the live config), and start
        looking. Call on the loop thread."""
        self._keep_awake_mode = mode
        self._keep_awake_tick()

    def _keep_awake_tick(self) -> None:
        self.check_keep_awake()
        if self._keep_awake_timer is not None:
            self._keep_awake_timer.cancel()
        try:
            self._keep_awake_timer = self._loop.call_later(KEEP_AWAKE_TICK_S, self._keep_awake_tick)
        except RuntimeError:
            self._keep_awake_timer = None

    def agents_working(self) -> bool:
        return any(
            s.info.alive and s.agent is not None and s.agent.state == "working"
            for s in list(self._sessions.values())
        )

    def check_keep_awake(self) -> None:
        """Hold or release the system for the current mode and agents (loop thread)."""
        try:
            mode = self._keep_awake_mode()
        except Exception:
            mode = keep_awake.DEFAULT_MODE
        self._keep_awake.update(mode, self.agents_working())

    def set_max_sessions(self, limit: int) -> None:
        self._max_sessions = limit

    def set_scrollback_bytes(self, cap: int) -> None:
        self._cap = cap
        for session in list(self._sessions.values()):
            session.set_scrollback_cap(cap)

    def live_count(self) -> int:
        return sum(1 for session in list(self._sessions.values()) if session.info.alive)

    def _check_limit(self) -> None:
        if self._max_sessions and self.live_count() + self._spawning >= self._max_sessions:
            raise SessionLimitError(
                f"terminal limit reached ({self._max_sessions}); stop a terminal or raise the limit"
            )

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
        agent: str | None = None,
        wrap: shells.Wrap | None = None,
        remote: launch.RemoteLaunch | None = None,
        shell: str | None = None,
        wsl: str | None = None,
        command: str | None = None,
    ) -> SessionInfo:
        """Start a session synchronously (loop thread: app startup, hotkeys).

        ``agent`` ("claude" or "codex") adds QuickTerm's hooks to the launch.
        ``wsl`` names the distribution of a terminal in a WSL workspace; its
        ``cwd`` is then a path there. ``command`` is what a plain ``shell``
        runs once before its prompt, kept when the integration rebuilds it.
        """
        self._check_limit()
        session = self._build(
            name=name,
            profile=profile,
            cmd=cmd,
            args=args,
            cwd=cwd,
            env=env,
            cols=cols,
            rows=rows,
            workspace=workspace,
            agent=agent,
            wrap=wrap,
            remote=remote,
            shell=shell,
            wsl=wsl,
            command=command,
        )
        self._sessions[session.info.id] = session
        return session.info

    async def spawn_async(
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
        agent: str | None = None,
        wrap: shells.Wrap | None = None,
        remote: launch.RemoteLaunch | None = None,
        shell: str | None = None,
        wsl: str | None = None,
        command: str | None = None,
    ) -> SessionInfo:
        """``spawn`` for request handlers: the PTY is built off the loop.

        Starting a child resolves the command on PATH, stats the folder and,
        on Windows, creates a pseudo console and a process: tens to hundreds
        of milliseconds during which every pane's output would otherwise
        stall and fill its fan-out queue.
        """
        self._check_limit()
        self._spawning += 1
        build = asyncio.ensure_future(
            asyncio.to_thread(
                self._build,
                name=name,
                profile=profile,
                cmd=cmd,
                args=args,
                cwd=cwd,
                env=env,
                cols=cols,
                rows=rows,
                workspace=workspace,
                agent=agent,
                wrap=wrap,
                remote=remote,
                shell=shell,
                wsl=wsl,
                command=command,
            )
        )
        build.add_done_callback(self._finish_async_spawn)
        # The worker thread cannot be interrupted, so a cancelled request
        # still gets its session registered by the done callback: an
        # unregistered PTY would be a process nobody can see or stop. The
        # reaper removes it later if nobody ever attaches.
        session = await asyncio.shield(build)
        return session.info

    def _finish_async_spawn(self, build: asyncio.Future[Session]) -> None:
        self._spawning -= 1
        if build.cancelled() or build.exception() is not None:
            return
        session = build.result()
        self._sessions[session.info.id] = session

    def _build(
        self,
        *,
        name: str | None,
        profile: str | None,
        cmd: str,
        args: list[str] | None,
        cwd: str | None,
        env: dict[str, str] | None,
        cols: int,
        rows: int,
        workspace: str | None,
        agent: str | None = None,
        wrap: shells.Wrap | None = None,
        remote: launch.RemoteLaunch | None = None,
        shell: str | None = None,
        wsl: str | None = None,
        command: str | None = None,
    ) -> Session:
        """Create the Session and start its PTY. Blocking; touches no registry."""
        sid = uuid.uuid4().hex
        child_env = dict(validate_environment(env or {}))
        hook_env = self._hook_env
        child_env.update(hook_env)
        child_env["QUICKTERM_SESSION_ID"] = sid
        start_dir = cwd or default_cwd()
        pty_dir: str | None = start_dir
        if wsl is not None:
            # The folder is a path in the distribution; wsl.exe --cd goes
            # there, the PTY itself starts in the home folder here.
            start_dir = cwd or "~"
            pty_dir = default_cwd()
        args = list(args or [])
        # An agent inside WSL reaches the backend through Windows' curl.exe
        # (WSL interop), with the variables carried in by WSLENV.
        wsl_agent = wrap is not None and shells.is_wsl(wrap.value)
        if agent in agent_hooks.AGENTS and hook_env:
            if wsl_agent:
                args, child_env = agent_hooks.wsl_launch(agent, args, child_env)
            elif remote is None:
                args = agent_hooks.launch_args(agent, cmd, args, start_dir)
        title = name or profile or cmd
        marker = None
        nonce = ""
        if remote is not None:
            # ssh starts in the home folder here; the folder that counts is
            # the one on the host.
            pty_dir = default_cwd()
            start_dir = remote.folder or "~"
            if remote.agent in agent_hooks.AGENTS and remote.command and hook_env:
                args, marker, nonce = self._remote_hooks(remote, sid, hook_env)
        # The configured Windows shell reports its folder at each prompt, and
        # in PowerShell the user's own claude and codex get the hooks.
        shell_value = wrap.value if wrap is not None else shell
        integration = None
        if os.name == "nt" and remote is None and shell_value in shells.INTEGRATED:
            integration = self._integration(shell_value)
            child_env = shells.integration_env(shell_value, integration, child_env)
        if wrap is not None:
            # The hooks belong to the agent's own argv; the shell runs it once
            # and stays, so the pane ends at a prompt when the agent exits.
            try:
                cmd, args, pty_dir = shells.wrap(wrap, cmd, args, start_dir, integration)
            except ValueError as exc:
                raise SpawnError(str(exc)) from exc
        elif shell_value is not None and integration is not None:
            try:
                cmd, args, pty_dir = shells.interactive(
                    shell_value, cmd, start_dir, integration, command=command,
                )
            except ValueError as exc:
                raise SpawnError(str(exc)) from exc
        info = SessionInfo(
            id=sid,
            name=title,
            profile=profile,
            alive=True,
            exit_code=None,
            cols=cols,
            rows=rows,
            workspace=workspace,
            cwd=start_dir,
            host=remote.host if remote is not None else None,
        )
        session = Session(info, self._cap)
        # A plain PowerShell with the agent functions runs the user's own
        # agent as its child, the same shape as a wrapped one.
        session.agent_shell = wrap is not None or bool(
            integration and (integration.claude or integration.codex)
        )
        info.agent_shell = wrap.value if wrap is not None else None
        # Git Bash's bin\bash.exe keeps usr\bin\bash.exe as its child for
        # good, so a wrapped agent's busy is judged from the shell at the end
        # of that chain. Only for the agent: a native program (the agent)
        # keeps its MSYS stub as parent, but an MSYS program (vim, sleep)
        # hangs off a fork that has exited, so a plain Git Bash shell keeps
        # the launcher's always-busy, which errs toward asking before a close.
        program = os.path.basename(cmd).casefold()
        session.msys_root = (
            os.name == "nt" and wrap is not None and program in {"bash.exe", "sh.exe"}
        )
        session.hook_marker = marker
        session.hook_nonce = nonce
        if marker is not None:
            session.ready_marker = launch.ready_marker(nonce)
        session.remote = remote is not None or wsl is not None or wsl_agent
        if os.path.basename(cmd).casefold() in {"wsl", "wsl.exe"}:
            session.resource_scope = "host-process-tree-partial-wsl"
        try:
            session.pty = PtySession(
                cmd,
                args,
                pty_dir or default_cwd(),
                child_env,
                cols,
                rows,
                self._loop,
                on_output=lambda data, s=session: self._on_output(s, data),
                on_exit=lambda code, s=session: self._on_exit(s, code),
            )
        except FileNotFoundError as exc:
            raise SpawnError(
                f"command not found: {cmd}. QuickTerm reads PATH when it starts; "
                "restart it after installing a program."
            ) from exc
        except OSError as exc:
            raise SpawnError(str(exc)) from exc
        return session

    def _integration(self, value: str) -> shells.Integration:
        """The shell integration of one local terminal. Blocking (hook files).

        The agent functions only where hooks are on: not in the elevated
        instance, which never gets a hook environment."""
        if value != "powershell" or not self._hook_env:
            return shells.Integration()
        hooks = agent_hooks.shell_hooks()

        def hook(agent: str) -> shells.AgentHook | None:
            found = hooks.get(agent)
            return shells.AgentHook(*found) if found is not None else None

        return shells.Integration(claude=hook("claude"), codex=hook("codex"))

    @staticmethod
    def _remote_hooks(
        remote: launch.RemoteLaunch, sid: str, hook_env: dict[str, str]
    ) -> tuple[list[str], bytes, str]:
        """ssh's arguments for an agent on a host with QuickTerm's hooks, the
        marker its terminal prints when it waits for the hook token, and the
        nonce that prefixes the answer."""
        port = int(hook_env["QUICKTERM_PORT"])
        hooks = launch.RemoteHooks(
            session_id=sid,
            socket=f"/tmp/quickterm-{secrets.token_hex(8)}.sock",
            port=port,
            nonce=secrets.token_hex(8),
        )
        program, *agent_args = remote.command or ()
        command = (program, *agent_hooks.remote_launch_args(remote.agent or "", agent_args, port))
        args = launch.remote_args(dataclasses.replace(remote, command=command), hooks)
        return args, launch.hook_marker(hooks.nonce), hooks.nonce

    def _answer_hook_marker(self, session: Session, data: bytes) -> None:
        """Watch a remote agent terminal for its two markers.

        The remote script first prints the ready marker: ssh has logged in
        and the script runs, so from here typed input waits (a password or a
        host-key answer typed earlier went to ssh at once). It then turns echo
        off, prints the request marker and reads lines until one carries
        `<nonce>:`, which is typed here once; the held input follows. Only the
        first markers count, and the script prints them before the agent or
        anything else runs, so no later output can ask again.
        """
        marker = session.hook_marker
        if marker is None:
            return
        window = session.hook_tail + data
        ready = session.ready_marker
        if ready is not None and ready in window:
            session.ready_marker = None
            self._start_hold(session)
        if marker not in window:
            session.hook_tail = window[-(max(len(marker), len(ready or b"")) - 1):]
            return
        session.hook_marker = None
        session.ready_marker = None
        session.hook_tail = b""
        token = self._hook_env.get("QUICKTERM_HOOK_TOKEN", "")
        if session.pty is not None and session.info.alive:
            answer = launch.hook_answer(session.hook_nonce, token)
            write_secret = getattr(session.pty, "write_secret", None)
            if write_secret is not None:
                write_secret(answer, token.encode("ascii", "replace"))
            else:
                session.pty.write(answer)
        self._release_held(session)

    @staticmethod
    def _release_held(session: Session) -> None:
        held, session.held_input = session.held_input, []
        session.hold_until = 0.0
        if held and session.pty is not None and session.info.alive:
            for chunk in held:
                session.pty.write(chunk)

    def _start_hold(self, session: Session) -> None:
        """From the ready marker on, typed input waits for the token answer,
        at most HOOK_HOLD_S from this fixed moment."""
        session.hold_until = time.monotonic() + HOOK_HOLD_S
        try:
            self._loop.call_later(HOOK_HOLD_S, self._release_held, session)
        except RuntimeError:
            pass

    def _hold_input(self, session: Session, data: bytes) -> bool:
        """Keep input back, in order, while a remote agent terminal waits for
        its hook token. Only the terminal's own replies (device attributes,
        cursor position) pass at once; everything else, escape sequences and
        paste included, queues behind what is already held."""
        if not session.hold_until:
            return False
        if time.monotonic() >= session.hold_until:
            self._release_held(session)
            return False
        if _TERMINAL_REPLY.fullmatch(data):
            return False
        session.held_input.append(data)
        if sum(map(len, session.held_input)) > HOOK_HOLD_BYTES:
            # More than anyone types while ssh logs in: give up holding and
            # send everything, still in order.
            self._release_held(session)
        return True

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
        # Deliberately not `touched`: WS input also carries xterm's automatic
        # replies (DA, CPR, focus reports), which must not make a shell look
        # typed into. The client says so explicitly through touch().
        s = self._sessions.get(sid)
        if s and s.pty and s.info.alive:
            s.last_activity = time.monotonic()
            if self._hold_input(s, data):
                return
            s.pty.write(data)

    def touch(self, sid: str) -> None:
        """Record real user input (the client's explicit touch frame).

        Typing answers whatever the terminal asked, so it clears attention.
        """
        s = self._sessions.get(sid)
        if s and s.info.alive:
            s.info.touched = True
            s.last_activity = time.monotonic()
            s.attention = None

    def mark_seen(self, sid: str) -> None:
        """The user has seen this session: clear its attention. KeyError when
        ``sid`` is unknown."""
        s = self._sessions.get(sid)
        if s is None:
            raise KeyError(sid)
        s.attention = None
        s.agent = agent_hooks.seen(s.agent, time.monotonic())

    def agent_event(self, sid: str, agent: str, event: str, payload: dict[str, Any]) -> None:
        """Fold one hook event into the session's agent state (loop thread).

        KeyError when ``sid`` is unknown. An exited session keeps no agent,
        so a late event for it changes nothing.
        """
        s = self._sessions.get(sid)
        if s is None:
            raise KeyError(sid)
        if not s.info.alive:
            return
        outcome = agent_hooks.apply(s.agent, agent, event, payload, time.monotonic())
        self._set_agent(s, outcome.state)
        if outcome.waiting is not None and s.attention is None:
            self._raise_attention(s, "notify", outcome.waiting)
        if outcome.finished is not None:
            # A finished turn is news for the desktop, not a "needs you": the
            # sidebar shows done on its own, so nothing is stored.
            self._tell(s, Attention("done", outcome.finished or None, time.monotonic()))
        self.check_keep_awake()

    def set_agent_title(self, sid: str, title: str | None) -> None:
        """The agent's conversation title: on its state, and as the session's
        name until a person renames it (loop thread)."""
        s = self._sessions.get(sid)
        if s is None or s.agent is None:
            return
        s.agent = agent_hooks.with_title(s.agent, title)
        if s.agent.title and not s.named:
            s.info.name = s.agent.title

    def is_remote(self, sid: str) -> bool:
        """Whether the session runs on an SSH host or in WSL. An unknown id
        counts as remote: nothing a hook names is read for it."""
        s = self._sessions.get(sid)
        return s is None or s.remote

    def mark_named(self, sid: str) -> None:
        """A person named this session; the agent's title no longer does."""
        s = self._sessions.get(sid)
        if s is not None:
            s.named = True

    def _set_agent(self, session: Session, state: AgentState | None) -> None:
        session.agent = state
        if state is None and not session.named:
            session.info.name = session.base_name

    def session_agent(self, sid: str) -> dict[str, Any] | None:
        """The ``agent`` field of the list route, or None."""
        s = self._sessions.get(sid)
        if s is None:
            return None
        return agent_hooks.describe(s.agent, time.monotonic())

    def session_attention(self, sid: str) -> dict[str, Any] | None:
        """``{kind, text, age_seconds}`` for the list route, or None."""
        s = self._sessions.get(sid)
        record = s.attention if s is not None else None
        if record is None:
            return None
        return {
            "kind": record.kind,
            "text": record.text,
            "age_seconds": max(0, int(time.monotonic() - record.at)),
        }

    def set_attention_listener(
        self, listener: Callable[[SessionInfo, Attention], None] | None
    ) -> None:
        self._attention_listener = listener

    def _raise_attention(self, session: Session, kind: str, text: str | None) -> None:
        record = Attention(kind, text, time.monotonic())
        session.attention = record
        self._tell(session, record)

    def _tell(self, session: Session, record: Attention) -> None:
        listener = self._attention_listener
        if listener is None:
            return
        try:
            listener(session.info, record)
        except Exception:
            # A notifier failure must never reach the PTY reader callback.
            log.debug("attention listener failed", exc_info=True)

    def _busy_from(self, identities: list[tuple[int, int]]) -> set[str]:
        """The one busy definition: alive, and the root PID has a direct child."""
        parents = pids_with_children(identities)
        sessions = list(self._sessions.items())
        names: dict[int, str] = {}
        if any(s.msys_root and s.info.alive for _sid, s in sessions):
            names = process_names()
        busy = set()
        for sid, s in sessions:
            if not s.info.alive or s.pty is None:
                continue
            root = shell_at_prompt(identities, names, s.pty.pid) if s.msys_root else s.pty.pid
            if root in parents:
                busy.add(sid)
            elif s.agent_shell and s.agent is not None:
                # The agent exited and left the shell at its prompt. Codex has
                # no end event, so the snapshot is what says it is gone.
                self._clear_agent_soon(s, s.agent)
        return busy

    def _clear_agent_soon(self, session: Session, seen: AgentState) -> None:
        def clear() -> None:
            # Only the state the snapshot saw: an event that arrived since
            # came from an agent that is still there.
            if session.agent is seen:
                self._set_agent(session, None)
                self.check_keep_awake()

        try:
            self._loop.call_soon_threadsafe(clear)
        except RuntimeError:
            pass

    def busy_ids(self) -> set[str]:
        """Sessions whose shell has a child process right now (ssh, a build,
        an editor, ...). One process snapshot for all sessions; used by the UI
        to guard close actions that would lose running work. WSL in-VM
        processes are invisible to the snapshot, a known blind spot.
        """
        try:
            return self._busy_from(process_identities())
        except Exception:
            log.debug("process child snapshot failed; busy state unavailable", exc_info=True)
            return set()

    def session_metrics(self) -> tuple[set[str], dict[str, dict[str, Any]]]:
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
        # One process table read feeds both busy and the samples, so the
        # dashboard and the reaper can never disagree about a session.
        try:
            identities = process_identities()
            busy = self._busy_from(identities)
        except Exception:
            log.debug("process snapshot failed; metrics unavailable", exc_info=True)
            identities, busy = [], set()
        # Sample only the session trees. Opening a handle and reading counters
        # for every PID on the machine was the expensive half of the snapshot,
        # and summarize_trees discarded all of it anyway.
        processes = snapshot_processes(roots, identities=identities)
        totals = summarize_trees(processes, roots)
        metrics: dict[str, dict[str, Any]] = {}
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
            # Recorded now, not with the next output: the resize belongs
            # before whatever ConPTY writes for the new size.
            s._ring.resize(cols, rows)
            s.pty.resize(cols, rows)

    def kill(self, sid: str) -> bool:
        """Stop a session, returning only after the backend confirms the kill.

        True means verified stopped, False that the process survived. Raises
        KeyError when ``sid`` is not in the registry: callers must be able to
        tell "already gone" (404, or success in a bulk path) from a failure.

        REST sync handlers run in a worker thread, so all asyncio queue and
        timer mutation is marshalled back to the owning loop.  Previously the
        grace-period timer was installed directly from that worker and the
        session stayed visibly alive until the PTY reader eventually reported
        EOF, which made dashboard kills look ineffective.
        """
        s = self._sessions.get(sid)
        if s is None:
            raise KeyError(sid)
        # Exactly True: a backend regression returning None must read as a
        # failure, never as a verified kill that hides a running process.
        s.stopping = True
        if s.pty is not None and s.pty.kill() is not True:
            s.stopping = False
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
            session.agent = None
            session._attachments.publish(None)
            self.check_keep_awake()
        self._loop.call_later(_KILL_REMOVE_GRACE_S, self._remove_if_same, sid, session)

    def _remove_if_same(self, sid: str, session: Session) -> None:
        if self._sessions.get(sid) is session:
            self._sessions.pop(sid, None)
            self._cpu_samples.pop(sid, None)

    def attach(self, sid: str) -> Attachment:
        """Subscribe a viewer. Raises KeyError for an unknown id, and also for
        a session the reaper has claimed: it is being killed, so the viewer is
        told it is gone (the WS answers 4404) instead of watching it die."""
        s = self._sessions[sid]
        if s.reaping:
            raise KeyError(sid)
        # Opening the terminal acknowledges output accumulated while it was in
        # the background. Do this before registering the viewer so the state is
        # consistent for concurrent session-list requests.
        self._acknowledge(s)
        att = Attachment(s._attachments)
        s._attachments.add(att)
        if not s.info.alive:
            att.queue.put_nowait(None)
        return att

    def acknowledge(self, sid: str) -> None:
        """Mark background output as read without subscribing (the server's
        replay-only reattach of an exited session)."""
        s = self._sessions.get(sid)
        if s is not None:
            self._acknowledge(s)

    @staticmethod
    def _acknowledge(s: Session) -> None:
        s.ever_attached = True
        s.background_output_bytes = 0
        s.background_output_at = None
        if not s.info.alive:
            # Opening an exited terminal replays everything up to its exit,
            # which answers whatever it asked. A live one is different: a
            # workspace restore attaches every pane, and that is nobody
            # looking at the one that rang.
            s.attention = None

    def shutdown(self) -> None:
        if self._keep_awake_timer is not None:
            self._keep_awake_timer.cancel()
            self._keep_awake_timer = None
        self._keep_awake.release()
        for s in list(self._sessions.values()):
            if s.pty:
                s.pty.kill()
        self._sessions.clear()

    def reap_idle(self, timeout_s: int, protected: set[str] | None = None) -> list[str]:
        """Clean stopped sessions and untouched background shells; returns the
        reaped ids. The policy and its threading are ``reaper.Reaper``'s."""
        return self._reaper.reap_idle(timeout_s, protected)

    # loop-thread callbacks from PtySession

    def _on_output(self, session: Session, data: bytes) -> None:
        session.last_activity = time.monotonic()
        if data and session.ever_attached and not session._attachments:
            session.background_output_bytes += len(data)
            session.background_output_at = session.last_activity
        # The ring, the viewers and the scanner are called directly, not
        # through Session wrappers: this runs once per reader burst. The
        # scanner answers plain output with two C-level finds and None.
        info = session.info
        session._ring.record(data, info.cols, info.rows)
        session._attachments.publish(data)
        if session.hook_marker is not None:
            self._answer_hook_marker(session, data)
        found = session._signals.feed(data)
        if found is not None:
            if found.cwd is not None:
                info.current_cwd = found.cwd
            if found.attention is not None:
                self._raise_attention(session, found.attention, found.text)

    def _on_exit(self, session: Session, code: int) -> None:
        was_alive = session.info.alive
        session.info.alive = False
        session.info.exit_code = code
        session.ended_at = time.monotonic()
        session.agent = None
        self.check_keep_awake()
        if was_alive:
            # Only a terminal the user had a stake in (opened and then typed
            # into or explicitly detached; the reaper's own "cared about"),
            # only when nobody is watching it end, and never for an exit
            # QuickTerm caused. An untouched shell ending is no news.
            info = session.info
            cared = session.ever_attached and (info.touched or info.retained)
            if cared and not session._attachments and not session.stopping:
                self._raise_attention(session, "exit", clean_text(f"exited with code {code}"))
            session._attachments.publish(None)
