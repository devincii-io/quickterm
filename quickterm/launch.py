"""Turn a launch request into the exact command a terminal starts with.

Every way of starting a terminal resolves it here: POST /api/sessions, POST
/api/elevate, and the first terminal of an elevated instance. They used to
carry their own copies of this logic and drifted apart.

A terminal is either the configured shell (no profile) or an agent (profile
"claude-code" or "codex", from Settings > Agents), and it runs where its
workspace lives: on this PC, in a WSL distribution, or on an SSH host.

Nothing here touches the session registry. Resolving does block on the file
system (a folder check, a PATH scan, a workspace file), so async callers run
it in a worker thread.
"""

from __future__ import annotations

import dataclasses
import importlib
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from quickterm import shells
from quickterm.config import AGENT_KINDS, AGENT_LABELS, agent_profile, validate_environment

CLAUDE_MODES = ("new", "continue", "resume", "agents")
ARGS_MAX = 1024
NAME_MAX_CHARS = 80


class LaunchError(ValueError):
    """A launch that cannot start. `status` is the HTTP status that reports it.

    `label` is set when the failure belongs to one terminal (its folder, its
    agent, its tools) rather than to the shape of the request, so every
    caller names the terminal the same way.
    """

    def __init__(self, message: str, *, status: int = 400, label: str | None = None) -> None:
        super().__init__(f"{terminal_label(label)}: {message}" if label else message)
        self.message = message
        self.status = status
        self.label = label


@dataclass(frozen=True)
class LaunchSpec:
    cmd: str
    args: list[str] = field(default_factory=list)
    # The folder the terminal starts in. In a WSL workspace (`wsl` set) a
    # path in that distribution, which the PTY itself never starts in.
    cwd: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    # Display name the caller asked for, if any. SessionManager falls back to
    # the profile name, then the command.
    name: str | None = None
    profile: str | None = None
    # What errors call this terminal: profile name, else requested name, else cmd.
    label: str = ""
    # "claude" or "codex" when this starts an agent's own command: the
    # session manager then adds QuickTerm's hooks to the launch.
    agent: str | None = None
    # The shell an agent runs inside. The session manager wraps the command
    # after the hooks are added, since those belong to the agent's argv.
    wrap: shells.Wrap | None = None
    # The pane type of a plain shell launch ("wsl", "git-bash", ...).
    terminal_type: str | None = None
    # A terminal of a workspace on an SSH host. `cmd` and `args` are already
    # the complete ssh command without agent hooks; the session manager adds
    # them from this once the session id exists.
    remote: RemoteLaunch | None = None
    # The effective shell value of a plain shell launch whose shell gets
    # QuickTerm's integration (shells.INTEGRATED); the session manager adds it.
    shell: str | None = None
    # The distribution of a terminal in a WSL workspace.
    wsl: str | None = None
    # What a plain local shell runs once before its prompt; the session
    # manager builds the argv again when it adds the shell integration.
    command: str | None = None

    def spawn_kwargs(self) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "name": self.name,
            "profile": self.profile,
            "cmd": self.cmd,
            "args": list(self.args),
            "cwd": self.cwd,
            "env": dict(self.env),
        }
        if self.agent is not None:
            kwargs["agent"] = self.agent
        if self.wrap is not None:
            kwargs["wrap"] = self.wrap
        if self.remote is not None:
            kwargs["remote"] = self.remote
        if self.shell is not None:
            kwargs["shell"] = self.shell
        if self.wsl is not None:
            kwargs["wsl"] = self.wsl
        if self.command is not None:
            kwargs["command"] = self.command
        return kwargs


def terminal_label(label: str | None) -> str:
    return f'Terminal "{label}"'


def describe_failure(label: str, exc: BaseException) -> str:
    """One sentence for a failed launch, naming the terminal exactly once."""
    if isinstance(exc, LaunchError) and exc.label:
        return str(exc)
    return f"{terminal_label(label)}: {exc}"


def validate_dir(value: str, label: str | None = None) -> str:
    """Expand ``~`` and environment variables and require an existing folder."""
    resolved = Path(os.path.expandvars(os.path.expanduser(value)))
    try:
        exists = resolved.is_dir()
    except OSError:
        exists = False
    if not exists:
        raise LaunchError(f"starting folder does not exist: {value}", label=label)
    return str(resolved)


def workspace_start(name: str | None) -> str | None:
    """The folder a local workspace's terminals start in, or None.

    A workspace whose folder has gone missing yields None, so the spawn falls
    back to the home folder instead of failing.
    """
    if not name:
        return None
    # Through sys.modules so tests can stub the workspace store.
    workspace = importlib.import_module("quickterm.workspace")
    saved = workspace.load_workspace(name)
    if saved is None or getattr(saved, "host", None):
        # A WSL or SSH workspace's folder is a path there (workspace_target).
        return None
    return workspace.resolve_start_dir(getattr(saved, "path", None))


# --- terminals of a workspace in WSL or on an SSH host ----------------------------


@dataclass(frozen=True)
class RemoteTarget:
    """Where a WSL or SSH workspace lives: its location (`Workspace.host`)
    and a folder there."""

    host: str
    path: str | None


@dataclass(frozen=True)
class RemoteLaunch:
    """A terminal of a workspace on an SSH host, before the session id exists.

    `program` and `options` are ssh up to and including the target. `agent`
    ("claude" | "codex") with `command` is an agent run; without them it is
    the plain remote shell. The session manager calls `remote_args` again
    with the hook pieces once it has an id.
    """

    host: str
    program: str
    options: tuple[str, ...]
    target: str
    folder: str | None
    command: tuple[str, ...] | None = None
    agent: str | None = None
    # The workspace's and the terminal's variables, exported by the remote
    # command (so visible in the host's process list), and what a plain shell
    # runs once before its prompt.
    env: tuple[tuple[str, str], ...] = ()
    shell_command: str | None = None


@dataclass(frozen=True)
class RemoteHooks:
    """What one agent session on a host needs for its state to come back:
    the reverse-forwarded socket, the session id, the backend port the socket
    reaches, and the nonce of the token handshake (see SessionManager)."""

    session_id: str
    socket: str
    port: int
    nonce: str


HOOK_MARKER_PREFIX = "\x1b]7770;quickterm-hook;"
READY_MARKER_PREFIX = "\x1b]7770;quickterm-ready;"
_LOGIN_SHELL = '"${SHELL:-/bin/sh}"'


def hook_marker(nonce: str) -> bytes:
    """The sequence a remote agent terminal prints when it waits for the hook
    token on its input. xterm ignores the unknown OSC."""
    return f"{HOOK_MARKER_PREFIX}{nonce}\x07".encode("ascii")


def ready_marker(nonce: str) -> bytes:
    """What a remote agent terminal prints first, once ssh has logged in."""
    return f"{READY_MARKER_PREFIX}{nonce}\x07".encode("ascii")


def hook_answer(nonce: str, token: str) -> bytes:
    """The line QuickTerm types in answer to `hook_marker(nonce)`."""
    return f"{nonce}:{token}\r".encode("ascii", "replace")


def remote_script(remote: RemoteLaunch, hooks: RemoteHooks | None = None) -> str:
    """The command ssh runs on the host. Every path and word is POSIX-quoted;
    the hook token never appears in it."""
    from quickterm import ws_exec

    cd = f"cd {ws_exec.folder_word(remote.folder)}; " if remote.folder else ""
    exports = "".join(
        f"export {name}={ws_exec.posix_quote(value)}; " for name, value in remote.env
    )
    if remote.command is None:
        if remote.shell_command is None:
            return f'{cd}{exports}exec "$SHELL" -l'
        # The login shell runs it, for the same PATH an agent gets.
        run = f"{_LOGIN_SHELL} -lc {ws_exec.posix_quote(remote.shell_command)}"
        return f'{cd}{exports}{run}; exec "$SHELL" -l'
    agent = " ".join(ws_exec.posix_quote(word) for word in remote.command)
    # The login shell runs the agent, so its PATH (~/.local/bin, nvm, ...)
    # applies even though ssh starts the command without a login.
    run_agent = f"{_LOGIN_SHELL} -lc {ws_exec.posix_quote(agent)}"
    if hooks is None:
        return f'{cd}{exports}{run_agent}; exec "$SHELL" -l'
    from quickterm import agent_hooks

    nonce = hooks.nonce
    marker = f"\\033]7770;quickterm-hook;{nonce}\\007"
    lines = [
        # First thing on the host: ssh has logged in, so typed input may now
        # wait for the token instead of going to a password prompt.
        f"printf '\\033]7770;quickterm-ready;{nonce}\\007'",
        f"cd {ws_exec.folder_word(remote.folder)} || true" if remote.folder else ":",
        # Echo goes off before the request, so the answer is never shown.
        "stty -echo 2>/dev/null",
        f"printf '{marker}'",
        # QuickTerm answers `<nonce>:<token>`. Anything typed before it is
        # read and dropped here, so it can never become the token, and the
        # token line can never reach the agent.
        "QUICKTERM_HOOK_TOKEN=",
        "while IFS= read -r line; do case \"$line\" in "
        f"*{nonce}:*) QUICKTERM_HOOK_TOKEN=${{line#*{nonce}:}}; break;; esac; done",
        "line=",
        "stty echo 2>/dev/null",
        "QUICKTERM_HOOK_TOKEN=$(printf %s \"$QUICKTERM_HOOK_TOKEN\" | tr -d '\\r')",
        f"QUICKTERM_SESSION_ID={ws_exec.posix_quote(hooks.session_id)}",
        f"QUICKTERM_HOOK_SOCKET={ws_exec.posix_quote(hooks.socket)}",
        "export QUICKTERM_HOOK_TOKEN QUICKTERM_SESSION_ID QUICKTERM_HOOK_SOCKET",
        *(f"export {name}={ws_exec.posix_quote(value)}" for name, value in remote.env),
        # Not INT: Ctrl+C in the agent must not take its state away.
        "trap 'rm -f \"$QUICKTERM_HOOK_SOCKET\"' EXIT HUP TERM",
        f"({agent_hooks.remote_lifecycle_command(remote.agent or 'claude', hooks.port, agent_hooks.AGENT_START)}) 2>/dev/null",
        run_agent,
        # The process check cannot see a process on the host, so the script
        # says itself that the agent has gone.
        f"({agent_hooks.remote_lifecycle_command(remote.agent or 'claude', hooks.port, agent_hooks.AGENT_EXIT)}) 2>/dev/null",
        # No exec: the trap has to run when this shell ends.
        f"{_LOGIN_SHELL} -l",
    ]
    return "exec sh -c " + ws_exec.posix_quote("; ".join(lines))


def remote_args(remote: RemoteLaunch, hooks: RemoteHooks | None = None) -> list[str]:
    """ssh's arguments after the program for one remote terminal."""
    forward: list[str] = []
    if hooks is not None:
        forward = [
            "-o", "ExitOnForwardFailure=no",
            "-R", f"{hooks.socket}:127.0.0.1:{hooks.port}",
        ]
    # The options end with the target; ssh options must come before it.
    *before, target = remote.options
    return [*before, *forward, target, remote_script(remote, hooks)]


def workspace_target(name: str | None) -> RemoteTarget | None:
    """The location and folder of a WSL or SSH workspace, or None on this PC."""
    if not name:
        return None
    workspace = importlib.import_module("quickterm.workspace")
    saved = workspace.load_workspace(name)
    host = getattr(saved, "host", None) if saved is not None else None
    if not host:
        return None
    return RemoteTarget(host=host, path=getattr(saved, "path", None))


_WINDOWS_PATH = re.compile(r"^[A-Za-z]:|\\|\.exe$|\.cmd$|\.bat$", re.IGNORECASE)


def _remote_agent_command(
    prof: Any, folder: str, mode: str | None, session: str | None, prompt: str | None = None,
) -> list[str]:
    """The agent's argv in WSL or on a host: the CLI name (or a POSIX `cmd`
    from the settings) and the same arguments a local launch gets, the first
    prompt last."""
    from quickterm import agents

    agents.validate(prof)
    kind = prof.terminal_type
    if mode is None:
        mode = "resume" if session else (agents._mode_of(prof) or agents.DEFAULT_MODE[kind])
    values = {key: value for key, value in (getattr(prof, "agent", None) or {}).items() if value}
    extra = list(getattr(prof, "args", None) or [])
    if kind == "claude-code":
        args = agents._claude_args(mode, session, folder, values) + extra
    else:
        args = agents._codex_args(mode, session, folder, values) + extra
    configured = (getattr(prof, "cmd", None) or "").strip()
    program = configured if configured and not _WINDOWS_PATH.search(configured) else _HOOK_AGENTS[kind]
    if prompt is not None:
        if mode == "agents":
            raise ValueError("prompt does not apply to the agents mode")
        args.append(prompt)
    return [program, *args]


def flat_prompt(prompt: str) -> str:
    """A prompt on one line, for the remote command: a line break cannot be
    POSIX-quoted safely through every remote shell (ws_exec.posix_quote)."""
    lines = [line.strip() for line in prompt.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    return " | ".join(line for line in lines if line)


def _location_folder(target: RemoteTarget, request_cwd: str | None) -> str | None:
    """The workspace folder, or where a split's source pane is now when the
    request names a POSIX folder there (a Windows path is no place there)."""
    workspace_mod = importlib.import_module("quickterm.workspace")
    if request_cwd:
        try:
            return workspace_mod.normalize_remote_root(request_cwd) or target.path
        except ValueError:
            pass
    return target.path


def _resolve_ssh(
    target: RemoteTarget,
    prof: Any,
    *,
    mode: str | None,
    agent_session: str | None,
    requested_name: str | None,
    request_cwd: str | None,
    prompt: str | None = None,
    env: dict[str, str] | None = None,
    command: str | None = None,
) -> LaunchSpec:
    """A terminal of a workspace on an SSH host: `ssh -t <destination>` and
    the remote script. Port, key and the rest come from ~/.ssh/config. `env`
    is exported by the remote command; the local ssh gets none of it."""
    from quickterm import ws_exec

    folder = _location_folder(target, request_cwd)
    label = prof.name if prof is not None else (requested_name or target.host)
    try:
        program = ws_exec.ssh_program()
    except FileNotFoundError as exc:
        raise LaunchError(str(exc), label=label) from exc
    options = ("-t", target.host)
    agent_command = None
    agent = None
    name = requested_name
    if prof is not None:
        kind = prof.terminal_type
        try:
            agent_command = tuple(_remote_agent_command(
                prof, folder or "~", mode, agent_session,
                flat_prompt(prompt) if prompt is not None else None,
            ))
        except ValueError as exc:
            raise LaunchError(str(exc), label=prof.name) from exc
        agent = _HOOK_AGENTS[kind]
        name = name or AGENT_LABELS[kind]
    else:
        name = name or target.host
    remote = RemoteLaunch(
        host=target.host, program=program, options=options, target=target.host,
        folder=folder, command=agent_command, agent=agent,
        env=tuple(_checked_env(env, label).items()), shell_command=command,
    )
    try:
        args = remote_args(remote)
    except ValueError as exc:
        raise LaunchError(str(exc), label=label) from exc
    return LaunchSpec(
        cmd=program,
        args=args,
        cwd=None,
        env={},
        name=name,
        profile=prof.name if prof is not None else None,
        label=label,
        agent=agent,
        remote=remote,
    )


def _resolve_wsl(
    target: RemoteTarget,
    prof: Any,
    *,
    mode: str | None,
    agent_session: str | None,
    requested_name: str | None,
    request_cwd: str | None,
    prompt: str | None = None,
    env: dict[str, str] | None = None,
    command: str | None = None,
) -> LaunchSpec:
    """A terminal of a workspace in a WSL distribution: the distribution's
    login shell (`wsl.exe -d <distro> --cd <folder>`), or an agent from the
    distribution's PATH inside the WSL wrap. `env` reaches Linux through
    WSLENV."""
    from quickterm import workspace as workspace_mod
    from quickterm import ws_exec

    distro = workspace_mod.wsl_distro(target.host) or ""
    value = f"wsl:{distro}"
    folder = _location_folder(target, request_cwd) or "~"
    label = prof.name if prof is not None else (requested_name or shells.label(value))
    own = _checked_env(env, label)
    try:
        program = ws_exec.wsl_program()
    except FileNotFoundError as exc:
        raise LaunchError(str(exc), label=label) from exc
    if prof is None:
        cmd, args, _cwd = shells.interactive(value, program, folder, command=command)
        return LaunchSpec(
            cmd=cmd,
            args=args,
            cwd=folder,
            env=shells.with_wslenv(own, list(own)) if own else {},
            name=requested_name or shells.label(value),
            label=label,
            terminal_type="wsl",
            wsl=distro,
        )
    kind = prof.terminal_type
    try:
        cli, *args = _remote_agent_command(prof, folder, mode, agent_session, prompt)
        env = validate_environment({**prof.env, **own})
    except ValueError as exc:
        raise LaunchError(str(exc), label=prof.name) from exc
    # The agent settings' variables are meant for the agent, which runs in
    # Linux; PATH stays Windows' own (WSL builds its PATH itself).
    names = [name for name in env if name in own or (name in prof.env and name.upper() != "PATH")]
    if names:
        env = shells.with_wslenv(env, names)
    return LaunchSpec(
        cmd=cli,
        args=args,
        cwd=folder,
        env=env,
        name=requested_name or AGENT_LABELS[kind],
        profile=prof.name,
        label=prof.name,
        agent=_HOOK_AGENTS[kind],
        wrap=shells.Wrap(value, program, cli),
        wsl=distro,
    )


def _checked_env(env: dict[str, str] | None, label: str) -> dict[str, str]:
    """The workspace's and the terminal's variables together, within the
    limits every launch environment has."""
    if not env:
        return {}
    try:
        return dict(validate_environment(dict(env)))
    except ValueError as exc:
        raise LaunchError(f"invalid env: {exc}", label=label) from exc


def workspace_env(name: str | None) -> dict[str, str]:
    """The variables every terminal of workspace `name` gets. Blocking (the
    workspace file, DPAPI)."""
    if not name:
        return {}
    workspace = importlib.import_module("quickterm.workspace")
    saved = workspace.load_workspace(name)
    return dict(getattr(saved, "env", None) or {}) if saved is not None else {}


def _terminal_env(workspace: Any, env: Any) -> dict[str, str] | None:
    """The workspace's variables with the request's own on top, or None when
    there are none. The API checks a request's names (workspace.validate_env);
    here they only have to be an environment at all."""
    if workspace is not None and not isinstance(workspace, dict):
        raise LaunchError("invalid env: the workspace environment is not an object")
    if env is not None and not isinstance(env, dict):
        raise LaunchError("invalid env: environment must be an object")
    if not workspace and env is None:
        return None
    return {**(workspace or {}), **(env or {})}


def _shell_command(command: Any, prof: Any, cmd: Any, args: Any) -> str | None:
    """A request's `command`, checked; only a plain shell takes one."""
    from quickterm import workspace as workspace_mod

    try:
        text = workspace_mod.validate_command(command)
    except ValueError as exc:
        raise LaunchError(str(exc)) from exc
    if text is not None and (prof is not None or cmd is not None or args is not None):
        raise LaunchError("command is for a plain shell and takes no profile, cmd or args")
    return text


def _agent_options(prof: Any, options: Any) -> Any:
    """`prof` with one launch's agent options over the saved ones."""
    if options is None:
        return prof
    if prof is None:
        raise LaunchError("agent requires a Claude Code or Codex profile")
    if not isinstance(options, dict):
        raise LaunchError("agent options must be an object")
    return dataclasses.replace(prof, agent={**prof.agent, **options})


AGENT_MODE_PROFILE = "agent_mode requires a Claude Code or Codex profile"
_HOOK_AGENTS = {"claude-code": "claude", "codex": "codex"}


def _agent_mode(prof: Any, claude_mode: Any, agent_mode: Any, agent_session: Any) -> str | None:
    """The launch-mode override of one request, or None for the agent's own.

    `claude_mode` keeps its pre-4.0 checks and messages word for word, since
    older clients match on them.
    """
    from .agents import MODES, SESSION_ID

    kind = prof.terminal_type
    if agent_mode is not None and claude_mode is not None and agent_mode != claude_mode:
        raise LaunchError("agent_mode and claude_mode disagree")
    if agent_mode is None and claude_mode is not None:
        if kind != "claude-code":
            raise LaunchError("claude_mode requires a Claude Code profile")
        if claude_mode not in CLAUDE_MODES:
            raise LaunchError("claude_mode must be new, continue, resume, or agents")
        agent_mode = claude_mode
    elif agent_mode is not None:
        if not isinstance(agent_mode, str) or agent_mode not in MODES[kind]:
            names = ", ".join(MODES[kind][:-1]) + f", or {MODES[kind][-1]}"
            raise LaunchError(f"agent_mode must be {names}")
    if agent_session is not None:
        if not isinstance(agent_session, str) or not SESSION_ID.fullmatch(agent_session):
            raise LaunchError("agent_session must be a session id")
        if agent_mode not in (None, "resume") and not (kind == "codex" and agent_mode == "fork"):
            raise LaunchError("agent_session needs resume or fork")
    return agent_mode


def _prompt(prompt: Any, prof: Any, cmd: Any, args: Any) -> str | None:
    """A request's agent prompt, checked; only an agent launch takes one."""
    from .agents import validate_prompt

    try:
        text = validate_prompt(prompt)
    except ValueError as exc:
        raise LaunchError(str(exc)) from exc
    if text is None:
        return None
    if prof is None:
        raise LaunchError("prompt requires a Claude Code or Codex profile")
    if cmd is not None or args is not None:
        raise LaunchError("prompt takes no cmd or args")
    return text


def _check_cmd_length(prompt: str | None, shell: str, executable: str, label: str) -> None:
    """cmd.exe ends a command line at 8191 characters: under the cmd shell or
    through a .cmd/.bat agent a longer prompt would fail inside the terminal."""
    from .agents import CMD_PROMPT_MAX_CHARS, is_batch

    if prompt is None or len(prompt) <= CMD_PROMPT_MAX_CHARS:
        return
    if shell == "cmd" or is_batch(executable):
        raise LaunchError(
            f"prompt is too long for cmd.exe: at most {CMD_PROMPT_MAX_CHARS} characters",
            label=label,
        )


def find_profile(cfg: Any, name: Any) -> Any:
    """The agent a request names: "claude-code" or "codex". Saved terminals
    are gone (4.5), so any other name is a 404."""
    if not isinstance(name, str) or not name.strip():
        raise LaunchError("profile must be a non-empty string")
    if name not in AGENT_KINDS:
        raise LaunchError(f"unknown profile: {name}", status=404)
    return agent_profile(cfg, name)


def shell_value(cfg: Any, requested: Any = None) -> str:
    """The effective shell of a launch: the request's, else the config's."""
    if requested is not None:
        try:
            shells.validate(requested)
        except ValueError as exc:
            raise LaunchError(str(exc)) from exc
        return shells.effective(requested)
    return shells.effective(getattr(cfg, "shell", "") or "")


def shell_program(value: str, label: str | None = None) -> str:
    try:
        return shells.program(value)
    except ValueError as exc:
        raise LaunchError(str(exc), label=label) from exc


def resolve(
    cfg: Any,
    *,
    profile: Any = None,
    cmd: Any = None,
    args: Any = None,
    env: Any = None,
    name: Any = None,
    claude_mode: Any = None,
    agent_mode: Any = None,
    agent_session: Any = None,
    request_cwd: str | None = None,
    workspace_root: str | None = None,
    shell: Any = None,
    prompt: Any = None,
    remote: RemoteTarget | None = None,
    command: Any = None,
    workspace_env: dict[str, str] | None = None,
    agent_options: Any = None,
) -> LaunchSpec:
    """Resolve one launch request. Blocking: call it off the event loop.

    `profile` names an agent ("claude-code" or "codex"); without one the
    terminal is the configured shell, or `cmd`. An explicit `cmd` or `args`
    overrides the agent's own. `agent_mode` overrides the agent's launch
    mode (`claude_mode` is its pre-4.0 name), `agent_options` its saved
    options; `agent_session` resumes one session by id; `prompt` is an
    agent's first message (Fix with Claude). `command` is what a plain shell
    runs once before its prompt.
    Environment, later wins: the agent's settings, `workspace_env`, the
    request's `env`; the session manager adds QuickTerm's variables last.
    Folder precedence: `request_cwd`, else `workspace_root`, else None (the
    session manager then uses the home folder). `remote` (a WSL or SSH
    workspace) starts the shell or agent there.
    """
    prof = None
    mode = None
    if profile is not None:
        prof = _agent_options(find_profile(cfg, profile), agent_options)
        mode = _agent_mode(prof, claude_mode, agent_mode, agent_session)
    elif claude_mode is not None:
        raise LaunchError("claude_mode requires a profile")
    elif agent_mode is not None or agent_session is not None:
        raise LaunchError(AGENT_MODE_PROFILE)
    else:
        _agent_options(None, agent_options)
    if name is not None and not isinstance(name, str):
        raise LaunchError("name must be a string")
    requested_name = name.strip()[:NAME_MAX_CHARS] if name and name.strip() else None

    if shell is not None and (profile is not None or cmd is not None):
        raise LaunchError("shell starts a plain shell and takes no profile or cmd")
    prompt = _prompt(prompt, prof, cmd, args)
    command = _shell_command(command, prof, cmd, args)
    env = _terminal_env(workspace_env, env)
    if remote is not None and cmd is None and (prof is not None or args is None):
        # The shell setting does not apply in WSL or on an SSH host, so a
        # requested local shell starts the location's own.
        location = importlib.import_module("quickterm.workspace").location_kind(remote.host)
        resolve_location = _resolve_wsl if location == "wsl" else _resolve_ssh
        return resolve_location(
            remote, prof, mode=mode, agent_session=agent_session,
            requested_name=requested_name, request_cwd=request_cwd, prompt=prompt,
            env=env, command=command,
        )
    # What wsl.exe has to hand to Linux: the workspace's and the request's names.
    own_names = list(env or {})
    in_wsl = False
    folder = request_cwd or workspace_root
    hook_agent = None
    wrap = None
    terminal_type = None
    plain_shell = None
    if prof is not None:
        kind = prof.terminal_type
        requested_name = requested_name or AGENT_LABELS[kind]
        if cmd is None and args is None:
            hook_agent = _HOOK_AGENTS[kind]
        from .agents import resolve as resolve_agent

        try:
            resolved_cmd, resolved_args, cwd = resolve_agent(
                prof, folder, mode=mode, session=agent_session, prompt=prompt
            )
        except ValueError as exc:
            raise LaunchError(str(exc), label=prof.name) from exc
        value = shell_value(cfg)
        wrap = shells.Wrap(value, shell_program(value, prof.name), _HOOK_AGENTS[kind])
        in_wsl = shells.is_wsl(value)
        _check_cmd_length(prompt, value, resolved_cmd, prof.name)
        cmd = cmd or resolved_cmd
        args = args if args is not None else resolved_args
        env = {**prof.env, **(env or {})}
        if in_wsl:
            # As in a WSL workspace: the agent runs in Linux (PATH stays).
            own_names += [name for name in prof.env if name not in own_names and name.upper() != "PATH"]
        if kind == "codex" and isinstance(cmd, str):
            # The native exe replaces npm's shim; keep what the shim sets.
            from .agents import codex_launch_env

            env = {**codex_launch_env(cmd), **(env or {})}
    elif cmd is None and args is None:
        # No profile and no command: the configured shell (or the one the
        # request names) in the workspace folder.
        value = shell_value(cfg, shell)
        try:
            cmd, args, cwd = shells.interactive(value, shell_program(value), folder, command=command)
        except ValueError as exc:
            raise LaunchError(str(exc), label=requested_name or shells.label(value)) from exc
        in_wsl = shells.is_wsl(value)
        terminal_type = shells.terminal_type(value)
        requested_name = requested_name or shells.label(value)
        if value in shells.INTEGRATED:
            plain_shell = value
    else:
        cwd = folder
    if not isinstance(cmd, str) or not cmd.strip():
        raise LaunchError("either 'profile' or 'cmd' is required")
    cmd = cmd.strip()
    if args is not None and (
        not isinstance(args, list) or len(args) > ARGS_MAX
        or any(not isinstance(arg, str) for arg in args)
    ):
        raise LaunchError(f"args must be a list of at most {ARGS_MAX} strings")
    if env is not None:
        try:
            env = validate_environment(env)
        except ValueError as exc:
            raise LaunchError(f"invalid env: {exc}") from exc
        if in_wsl and own_names:
            env = shells.with_wslenv(env, own_names)
    label = prof.name if prof is not None else (requested_name or cmd)
    if cwd:
        cwd = validate_dir(cwd, label)
    return LaunchSpec(
        cmd=cmd,
        args=list(args or []),
        cwd=cwd or None,
        env=dict(env or {}),
        name=requested_name,
        profile=prof.name if prof is not None else None,
        label=label,
        agent=hook_agent,
        wrap=wrap,
        terminal_type=terminal_type,
        shell=plain_shell,
        command=command if plain_shell is not None else None,
    )
