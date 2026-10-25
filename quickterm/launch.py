"""Turn a launch request into the exact command a terminal starts with.

Every way of starting a terminal resolves it here: POST /api/sessions, POST
/api/elevate, autostart, global hotkeys, and the first terminal of an elevated
instance. They used to carry their own copies of this logic and drifted apart:
a Claude Code profile on a hotkey always failed because nothing gave it a
folder, and the bundled PuTTY tools were on PATH only for REST launches.

Nothing here touches the session registry. Resolving does block on the file
system (a folder check, a PATH scan, the PuTTY tools stat, a workspace file),
so async callers run it in a worker thread.
"""

from __future__ import annotations

import dataclasses
import importlib
import os
import re
import shlex
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from quickterm import putty_tools, shells
from quickterm.config import AGENT_KINDS, AGENT_LABELS, agent_profile, validate_environment

CLAUDE_MODES = ("new", "continue", "resume", "agents")
OPENSSH_MISSING = (
    "OpenSSH client not found. Install it under Settings > Apps > Optional features > OpenSSH Client."
)
START_COMMAND_MAX_CHARS = 8192
ARGS_MAX = 1024
NAME_MAX_CHARS = 80


class LaunchError(ValueError):
    """A launch that cannot start. `status` is the HTTP status that reports it.

    `label` is set when the failure belongs to one terminal (its folder, its
    profile, its tools) rather than to the shape of the request, so every
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
    cwd: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    # Display name the caller asked for, if any. SessionManager falls back to
    # the profile name, then the command.
    name: str | None = None
    profile: str | None = None
    # What errors call this terminal: profile name, else requested name, else cmd.
    label: str = ""
    # "claude" or "codex" when this starts an agent profile's own command:
    # the session manager then adds QuickTerm's hooks to the launch.
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
    """The folder a workspace's terminals start in, or None.

    A workspace whose folder has gone missing yields None, so the spawn falls
    back to the home folder instead of failing.
    """
    if not name:
        return None
    # Through sys.modules so tests can stub the workspace store.
    workspace = importlib.import_module("quickterm.workspace")
    saved = workspace.load_workspace(name)
    if saved is None or getattr(saved, "host", None):
        # A remote workspace's folder is a path on its host (workspace_target).
        return None
    return workspace.resolve_start_dir(getattr(saved, "path", None))


def append_tools_path(env: dict[str, str]) -> dict[str, str]:
    """Put the bundled PuTTY tools on the child's PATH, after everything else.

    Appended rather than prepended so a user-installed plink or pscp still
    wins. The key is matched case-insensitively because a Windows profile
    usually spells it ``Path``; a second ``PATH`` entry would shadow it.
    """
    tools = putty_tools.tools_dir()
    if tools is None:
        return env
    merged = dict(env)
    path_key = next((key for key in merged if key.casefold() == "path"), "PATH")
    base_path = merged.get(path_key) or os.environ.get("PATH", "")
    merged[path_key] = f"{base_path}{os.pathsep}{tools}" if base_path else str(tools)
    return merged


def _posix_word(program: str) -> str:
    """`program` as one word of a POSIX shell command line.

    The shell reads the `exec` after a start command itself, so an msys
    C:\\msys64\\usr\\bin\\bash.exe lost its backslashes there and the terminal
    exited once the start command finished. msys and Cygwin shells accept the
    same path with forward slashes, and quoting keeps a space in one word.
    """
    if "\\" in program or re.match(r"[A-Za-z]:", program):
        program = program.replace("\\", "/")
    return shlex.quote(program)


def _without_login_flags(args: list[str]) -> list[str]:
    return [arg for arg in args if arg not in ("-l", "--login")]


def resolve_profile(
    prof: Any,
    cwd: str | None = None,
    *,
    agent_mode: str | None = None,
    agent_session: str | None = None,
    prompt: str | None = None,
) -> tuple[str, list[str], str | None]:
    """Command, arguments and process folder for one profile.

    `cwd` is what the caller resolved from the request or the workspace root;
    a profile has no folder of its own. `agent_mode` and `agent_session`
    override an agent profile's launch for this one start, and `prompt` is its
    first message. Raises ValueError
    only when nothing can resolve (an agent profile without a folder, a
    missing SSH client).
    """
    terminal_type = getattr(prof, "terminal_type", None)
    start = (getattr(prof, "start_command", None) or "").strip()
    configured = (getattr(prof, "cmd", None) or "").strip()
    existing_args = list(getattr(prof, "args", []) or [])
    from .agents import AGENT_TYPES, resolve as resolve_agent
    from .connections import CONNECTION_TYPES, DESKTOP_TYPES, resolve as resolve_connection

    if terminal_type in DESKTOP_TYPES:
        raise ValueError("Desktop connections open in a separate client window from Connections")
    if terminal_type in CONNECTION_TYPES:
        return resolve_connection(prof, cwd)
    if terminal_type in AGENT_TYPES:
        return resolve_agent(prof, cwd, mode=agent_mode, session=agent_session, prompt=prompt)
    if terminal_type in ("powershell-core", "windows-powershell"):
        # The inventory resolves an absolute path on purpose (PATH is stale in
        # a tray-resident app) and Settings stores it in `cmd`; the bare name
        # is only the fallback for a profile that has none.
        default = "pwsh.exe" if terminal_type == "powershell-core" else "powershell.exe"
        # The profile's own arguments go BEFORE -Command: PowerShell reads
        # everything after -Command as the command text, so an argument placed
        # after it would run as part of the start command.
        args = ["-NoLogo"] + [arg for arg in existing_args if arg.casefold() != "-nologo"]
        if start:
            args += ["-NoExit", "-Command", start]
        return configured or default, args, cwd
    if terminal_type == "command-prompt":
        # Same ordering reason as PowerShell: cmd reads the rest of the line
        # after /K as the command.
        args = existing_args + (["/K", start] if start else [])
        return configured or "cmd.exe", args, cwd
    if terminal_type == "wsl":
        args = []
        distro = (getattr(prof, "wsl_distro", None) or "").strip()
        if distro:
            args += ["-d", distro]
        # wsl.exe otherwise inherits QuickTerm's Windows process directory and
        # opens under /mnt/c.  A blank profile belongs in the distro's own
        # home; explicit Linux and Windows paths are both accepted by --cd.
        args += ["--cd", cwd or "~"]
        args += existing_args
        if start:
            args += ["--", "bash", "-lc", f"{start}; exec bash -l"]
        return configured or "wsl.exe", args, None
    if terminal_type in ("bash", "zsh", "fish"):
        shell = configured or terminal_type
        # Same rule as Git Bash below: the profile's own arguments go first,
        # because the shell reads the operand after -c as the command, and the
        # login flag is ours, so a profile that repeats it does not get two.
        extra = _without_login_flags(existing_args)
        if start:
            return shell, extra + ["-lc", f"{start}; exec {_posix_word(shell)} -l"], cwd
        return shell, extra + ["-l"], cwd
    if terminal_type == "git-bash":
        # `cmd` is a Windows path such as C:\Program Files\Git\bin\bash.exe;
        # inside the login shell plain `bash` is the same program, and it has
        # no space to quote.
        shell = configured or "bash"
        # The profile's own arguments first, as for cmd and nushell: bash
        # reads the operand after -c as the command. The login flag is ours.
        extra = _without_login_flags(existing_args)
        if start:
            return shell, extra + ["-lc", f"{start}; exec bash -l"], cwd
        return shell, extra + ["-l"], cwd
    if terminal_type == "nushell":
        # `nu -e` runs the command and then stays interactive.
        args = existing_args + (["-e", start] if start else [])
        return configured or "nu", args, cwd
    if terminal_type in ("ssh", "sftp"):
        host = (getattr(prof, "ssh_host", None) or "").strip()
        user = (getattr(prof, "ssh_user", None) or "").strip()
        port = getattr(prof, "ssh_port", None)
        key = (getattr(prof, "ssh_key", None) or "").strip()
        if host.startswith("-") or user.startswith("-"):
            raise ValueError("SSH host and user must not start with -")
        if getattr(prof, "ssh_client", None) == "openssh":
            return _openssh(terminal_type, prof, host, user, port, key, start, existing_args, cwd)
        tool = putty_tools.plink_path() if terminal_type == "ssh" else putty_tools.psftp_path()
        if tool is None:
            raise ValueError("PuTTY tools are not installed (run scripts/fetch_putty.py)")
        args = ["-ssh"] if terminal_type == "ssh" else []
        if port:
            args += ["-P", str(port)]
        if key:
            args += ["-i", key]
        args += existing_args
        args.append(f"{user}@{host}" if user else host)
        # plink runs a trailing command on the remote host instead of a shell.
        if terminal_type == "ssh" and start:
            args.append(start)
        return str(tool), args, cwd
    return prof.cmd, existing_args, cwd


def _openssh(
    kind: str, prof: Any, host: str, user: str, port: Any, key: str, start: str,
    extra: list[str], cwd: str | None,
) -> tuple[str, list[str], str | None]:
    # Through sys.modules so tests can stub the client lookup.
    ssh_config = importlib.import_module("quickterm.ssh_config")
    tool = ssh_config.openssh_path(kind)
    if tool is None:
        raise ValueError(OPENSSH_MISSING)
    args: list[str] = []
    if port:
        # sftp spells the port flag in capitals, like scp.
        args += ["-p" if kind == "ssh" else "-P", str(port)]
    if key:
        args += ["-i", key]
    jump = (getattr(prof, "ssh_proxy_jump", None) or "").strip()
    if jump.startswith("-"):
        raise ValueError("ProxyJump must not start with -")
    if jump:
        args += ["-J", jump]
    args += extra
    # An alias in `host` lets ssh apply its own ssh_config entry; the fields
    # set here override it.
    args.append(f"{user}@{host}" if user else host)
    if kind == "ssh" and start:
        args.append(start)
    return str(tool), args, cwd


def openssh_args(prof: Any, options: list[str]) -> tuple[str, list[str]]:
    """ssh and its arguments up to the target for an OpenSSH profile, with
    `options` before the profile's own arguments. ValueError when the client
    is missing or a field could pass as an option."""
    host = (getattr(prof, "ssh_host", None) or "").strip()
    user = (getattr(prof, "ssh_user", None) or "").strip()
    if host.startswith("-") or user.startswith("-"):
        raise ValueError("SSH host and user must not start with -")
    extra = [*options, *list(getattr(prof, "args", []) or [])]
    tool, args, _cwd = _openssh(
        "ssh", prof, host, user, getattr(prof, "ssh_port", None),
        (getattr(prof, "ssh_key", None) or "").strip(), "", extra, None,
    )
    return tool, args


# --- terminals of a workspace on an SSH host -----------------------------------


@dataclass(frozen=True)
class RemoteTarget:
    """Where a remote workspace lives: an SSH profile's name and a folder there."""

    host: str
    path: str | None


@dataclass(frozen=True)
class RemoteLaunch:
    """A terminal of a remote workspace, before the session id exists.

    `program` and `options` are ssh up to and including the target. `agent`
    ("claude" | "codex") with `command` is an agent run; `command` alone is a
    start command; neither is the plain remote shell. The session manager
    calls `remote_args` again with the hook pieces once it has an id.
    """

    host: str
    program: str
    options: tuple[str, ...]
    target: str
    folder: str | None
    command: tuple[str, ...] | None = None
    start: str | None = None
    agent: str | None = None


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
    if remote.command is None:
        if remote.start:
            return f'{cd}{remote.start}; exec "$SHELL" -l'
        return f'{cd}exec "$SHELL" -l'
    agent = " ".join(ws_exec.posix_quote(word) for word in remote.command)
    # The login shell runs the agent, so its PATH (~/.local/bin, nvm, ...)
    # applies even though ssh starts the command without a login.
    run_agent = f"{_LOGIN_SHELL} -lc {ws_exec.posix_quote(agent)}"
    if hooks is None:
        return f'{cd}{run_agent}; exec "$SHELL" -l'
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
    """The host and folder of a remote workspace, or None for a local one."""
    if not name:
        return None
    workspace = importlib.import_module("quickterm.workspace")
    saved = workspace.load_workspace(name)
    host = getattr(saved, "host", None) if saved is not None else None
    if not host:
        return None
    return RemoteTarget(host=host, path=getattr(saved, "path", None))


_WINDOWS_PATH = re.compile(r"^[A-Za-z]:|\\|\.exe$|\.cmd$|\.bat$", re.IGNORECASE)
REMOTE_SHELL_TYPES = frozenset({"bash", "zsh", "fish", "git-bash"})


def remote_start(prof: Any) -> str | None:
    """The POSIX command a saved profile runs on a host, or None when it only
    makes sense on this computer (a Windows shell, WSL, a Windows program).

    A POSIX shell profile with a start command runs that command; a custom
    command whose program is not a Windows path runs with its arguments.
    """
    kind = getattr(prof, "terminal_type", None)
    start = (getattr(prof, "start_command", None) or "").strip()
    if kind in REMOTE_SHELL_TYPES:
        return start or None
    if kind == "custom":
        program = (getattr(prof, "cmd", None) or "").strip()
        if not program or _WINDOWS_PATH.search(program):
            return None
        from quickterm import ws_exec

        try:
            return " ".join(ws_exec.posix_quote(w) for w in [program, *(getattr(prof, "args", []) or [])])
        except ValueError:
            return None
    return None


def _remote_agent_command(
    prof: Any, folder: str, mode: str | None, session: str | None, prompt: str | None = None,
) -> list[str]:
    """The agent's argv on the host: the CLI name (or a POSIX `cmd` from the
    settings) and the same arguments a local launch gets, the first prompt
    last."""
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
        args.append(flat_prompt(prompt))
    return [program, *args]


def flat_prompt(prompt: str) -> str:
    """A prompt on one line, for the remote command: a line break cannot be
    POSIX-quoted safely through every remote shell (ws_exec.posix_quote)."""
    lines = [line.strip() for line in prompt.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    return " | ".join(line for line in lines if line)


def _resolve_remote(
    cfg: Any,
    target: RemoteTarget,
    prof: Any,
    *,
    mode: str | None,
    agent_session: str | None,
    requested_name: str | None,
    request_cwd: str | None,
    prompt: str | None = None,
) -> LaunchSpec | None:
    """The spec of a terminal in a remote workspace, or None when the profile
    is one that runs on this computer anyway (a connection)."""
    from quickterm import workspace as workspace_mod
    from quickterm import ws_exec

    from .agents import AGENT_TYPES

    kind = getattr(prof, "terminal_type", None) if prof is not None else None
    start = None
    if prof is not None and kind not in AGENT_TYPES:
        start = remote_start(prof)
        if start is None:
            return None
    folder = target.path
    if request_cwd:
        # A split from a remote pane hands in where that shell is now.
        try:
            folder = workspace_mod.normalize_remote_root(request_cwd) or folder
        except ValueError:
            pass
    label = prof.name if prof is not None else (requested_name or target.host)
    try:
        ssh_profile = ws_exec.find_profile(target.host, list(getattr(cfg, "profiles", []) or []))
        program, options = openssh_args(ssh_profile, ["-t"])
    except (FileNotFoundError, ValueError) as exc:
        raise LaunchError(str(exc), label=label) from exc
    command = None
    agent = None
    name = requested_name
    if kind in AGENT_TYPES:
        try:
            command = tuple(_remote_agent_command(prof, folder or "~", mode, agent_session, prompt))
        except ValueError as exc:
            raise LaunchError(str(exc), label=prof.name) from exc
        agent = _HOOK_AGENTS[kind]
        if prof.name == kind and name is None:
            name = AGENT_LABELS[kind]
    elif prof is None:
        name = name or target.host
    remote = RemoteLaunch(
        host=target.host, program=program, options=tuple(options), target=options[-1],
        folder=folder, command=command, start=start, agent=agent,
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


AGENT_MODE_PROFILE = "agent_mode requires a Claude Code or Codex profile"
_HOOK_AGENTS = {"claude-code": "claude", "codex": "codex"}


def _agent_mode(prof: Any, claude_mode: Any, agent_mode: Any, agent_session: Any) -> str | None:
    """The launch-mode override of one request, or None for the profile's own.

    `claude_mode` keeps its pre-4.0 checks and messages word for word, since
    older clients match on them.
    """
    from .agents import AGENT_TYPES, MODES, SESSION_ID

    kind = getattr(prof, "terminal_type", None)
    if agent_mode is not None and claude_mode is not None and agent_mode != claude_mode:
        raise LaunchError("agent_mode and claude_mode disagree")
    if agent_mode is None and claude_mode is not None:
        if kind != "claude-code":
            raise LaunchError("claude_mode requires a Claude Code profile")
        if claude_mode not in CLAUDE_MODES:
            raise LaunchError("claude_mode must be new, continue, resume, or agents")
        agent_mode = claude_mode
    elif agent_mode is not None:
        if kind not in AGENT_TYPES:
            raise LaunchError(AGENT_MODE_PROFILE)
        if not isinstance(agent_mode, str) or agent_mode not in MODES[kind]:
            names = ", ".join(MODES[kind][:-1]) + f", or {MODES[kind][-1]}"
            raise LaunchError(f"agent_mode must be {names}")
    if agent_session is not None:
        if kind not in AGENT_TYPES:
            raise LaunchError(AGENT_MODE_PROFILE)
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
    if prof is None or getattr(prof, "terminal_type", None) not in AGENT_KINDS:
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
    if not isinstance(name, str) or not name.strip():
        raise LaunchError("profile must be a non-empty string")
    prof = next((p for p in cfg.profiles if p.name == name), None)
    if prof is None and name in AGENT_KINDS and hasattr(cfg, "agents"):
        # "claude-code" and "codex" name the agents from Settings; a saved
        # profile of that exact name still wins, as it did before 4.3.
        return agent_profile(cfg, name)
    if prof is None:
        raise LaunchError(f"unknown profile: {name}", status=404)
    return prof


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
    start_command: Any = None,
    claude_mode: Any = None,
    agent_mode: Any = None,
    agent_session: Any = None,
    request_cwd: str | None = None,
    workspace_root: str | None = None,
    append_tools: bool = True,
    shell: Any = None,
    prompt: Any = None,
    remote: RemoteTarget | None = None,
) -> LaunchSpec:
    """Resolve one launch request. Blocking: call it off the event loop.

    `profile` is a profile name (a request) or a profile object (autostart,
    hotkeys). An explicit `cmd`, `args` or `env` overrides the profile's own.
    `agent_mode` overrides an agent profile's launch mode (`claude_mode` is
    its pre-4.0 name); `agent_session` resumes one session by id; `prompt`
    is an agent's first message (Fix with Claude).
    Folder precedence: `request_cwd`, else `workspace_root`, else None (the
    session manager then uses the home folder). `remote` (a workspace on an
    SSH host) turns a shell, agent or remote-capable profile into ssh. `append_tools=False` leaves
    the PuTTY tools off PATH, for a spec that another instance resolves again.
    """
    prof = None
    mode = None
    if profile is not None:
        # A request carries a name (or garbage, which find_profile refuses).
        is_object = hasattr(profile, "name") and hasattr(profile, "cmd")
        prof = profile if is_object else find_profile(cfg, profile)
        if start_command is not None:
            if not isinstance(start_command, str) or len(start_command) > START_COMMAND_MAX_CHARS:
                raise LaunchError(
                    f"start_command must be a string of at most {START_COMMAND_MAX_CHARS} characters"
                )
            prof = dataclasses.replace(prof, start_command=start_command)
        mode = _agent_mode(prof, claude_mode, agent_mode, agent_session)
    elif start_command is not None or claude_mode is not None:
        raise LaunchError("start_command and claude_mode require a profile")
    elif agent_mode is not None or agent_session is not None:
        raise LaunchError(AGENT_MODE_PROFILE)
    if name is not None and not isinstance(name, str):
        raise LaunchError("name must be a string")
    requested_name = name.strip()[:NAME_MAX_CHARS] if name and name.strip() else None

    if shell is not None and (profile is not None or cmd is not None):
        raise LaunchError("shell starts a plain shell and takes no profile or cmd")
    prompt = _prompt(prompt, prof, cmd, args)
    if remote is not None and cmd is None and (prof is not None or args is None):
        # The workspace is on an SSH host: the shell setting does not apply
        # there, so a requested local shell starts the remote one.
        spec = _resolve_remote(
            cfg, remote, prof, mode=mode, agent_session=agent_session,
            requested_name=requested_name, request_cwd=request_cwd, prompt=prompt,
        )
        if spec is not None:
            return spec
    folder = request_cwd or workspace_root
    hook_agent = None
    wrap = None
    terminal_type = None
    plain_shell = None
    if prof is not None:
        kind = getattr(prof, "terminal_type", None)
        if kind in AGENT_KINDS and prof.name == kind and requested_name is None:
            requested_name = AGENT_LABELS[kind]
        if cmd is None and args is None:
            hook_agent = _HOOK_AGENTS.get(kind)
        try:
            resolved_cmd, resolved_args, cwd = resolve_profile(
                prof, folder, agent_mode=mode, agent_session=agent_session, prompt=prompt
            )
        except ValueError as exc:
            raise LaunchError(str(exc), label=prof.name) from exc
        if kind in AGENT_KINDS:
            value = shell_value(cfg)
            wrap = shells.Wrap(value, shell_program(value, prof.name), _HOOK_AGENTS[kind])
            _check_cmd_length(prompt, value, resolved_cmd, prof.name)
        cmd = cmd or resolved_cmd
        args = args if args is not None else resolved_args
        env = env if env is not None else dict(prof.env)
        if getattr(prof, "terminal_type", None) == "codex" and isinstance(cmd, str):
            # The native exe replaces npm's shim; keep what the shim sets.
            from .agents import codex_launch_env

            env = {**codex_launch_env(cmd), **(env or {})}
    elif cmd is None and args is None:
        # No profile and no command: the configured shell (or the one the
        # request names) in the workspace folder.
        value = shell_value(cfg, shell)
        cmd, args, cwd = shells.interactive(value, shell_program(value), folder)
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
    label = prof.name if prof is not None else (requested_name or cmd)
    if cwd:
        cwd = validate_dir(cwd, label)
    env = dict(env or {})
    if append_tools:
        env = append_tools_path(env)
    return LaunchSpec(
        cmd=cmd,
        args=list(args or []),
        cwd=cwd or None,
        env=env,
        name=requested_name,
        profile=prof.name if prof is not None else None,
        label=label,
        agent=hook_agent,
        wrap=wrap,
        terminal_type=terminal_type,
        shell=plain_shell,
    )
