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
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from quickterm import putty_tools
from quickterm.config import validate_environment

CLAUDE_MODES = ("new", "continue", "resume", "agents")
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

    def spawn_kwargs(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "profile": self.profile,
            "cmd": self.cmd,
            "args": list(self.args),
            "cwd": self.cwd,
            "env": dict(self.env),
        }


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
    if saved is None:
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


def resolve_profile(prof: Any, cwd: str | None = None) -> tuple[str, list[str], str | None]:
    """Command, arguments and process folder for one profile.

    `cwd` is what the caller resolved from the request or the workspace root;
    a profile has no folder of its own. Raises ValueError only when nothing
    can resolve (a Claude Code profile without a folder, missing PuTTY tools).
    """
    terminal_type = getattr(prof, "terminal_type", None)
    start = (getattr(prof, "start_command", None) or "").strip()
    configured = (getattr(prof, "cmd", None) or "").strip()
    existing_args = list(getattr(prof, "args", []) or [])

    if terminal_type == "claude-code":
        executable = configured
        if not executable:
            executable = shutil.which("claude") or ("claude.exe" if os.name == "nt" else "claude")
        mode = getattr(prof, "claude_mode", None) or "continue"
        if not isinstance(cwd, str) or not cwd.strip():
            raise ValueError("Claude Code profile requires a project folder")
        mode_args = {
            "new": [], "continue": ["--continue"], "resume": ["--resume"],
            "agents": ["agents", "--cwd", cwd],
        }
        return executable, mode_args.get(mode, ["--continue"]) + existing_args, cwd
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
        if start:
            args += ["--", "bash", "-lc", f"{start}; exec bash -l"]
        return "wsl.exe", args, None
    if terminal_type in ("bash", "zsh", "fish"):
        shell = prof.cmd or terminal_type
        if start:
            return shell, ["-lc", f"{start}; exec {shell} -l"], cwd
        return shell, ["-l"], cwd
    if terminal_type == "git-bash":
        # `cmd` is a Windows path such as C:\Program Files\Git\bin\bash.exe;
        # inside the login shell plain `bash` is the same program, and it has
        # no space to quote.
        shell = configured or "bash"
        if start:
            return shell, ["-lc", f"{start}; exec bash -l"], cwd
        return shell, ["-l"], cwd
    if terminal_type == "nushell":
        # `nu -e` runs the command and then stays interactive.
        args = existing_args + (["-e", start] if start else [])
        return configured or "nu", args, cwd
    if terminal_type in ("ssh", "sftp"):
        tool = putty_tools.plink_path() if terminal_type == "ssh" else putty_tools.psftp_path()
        if tool is None:
            raise ValueError("PuTTY tools are not installed (run scripts/fetch_putty.py)")
        host = (getattr(prof, "ssh_host", None) or "").strip()
        user = (getattr(prof, "ssh_user", None) or "").strip()
        port = getattr(prof, "ssh_port", None)
        key = (getattr(prof, "ssh_key", None) or "").strip()
        args = ["-ssh"] if terminal_type == "ssh" else []
        if port:
            args += ["-P", str(port)]
        if key:
            args += ["-i", key]
        args.append(f"{user}@{host}" if user else host)
        # plink runs a trailing command on the remote host instead of a shell.
        if terminal_type == "ssh" and start:
            args.append(start)
        return str(tool), args, cwd
    return prof.cmd, existing_args, cwd


def find_profile(cfg: Any, name: Any) -> Any:
    if not isinstance(name, str) or not name.strip():
        raise LaunchError("profile must be a non-empty string")
    prof = next((p for p in cfg.profiles if p.name == name), None)
    if prof is None:
        raise LaunchError(f"unknown profile: {name}", status=404)
    return prof


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
    request_cwd: str | None = None,
    workspace_root: str | None = None,
    append_tools: bool = True,
) -> LaunchSpec:
    """Resolve one launch request. Blocking: call it off the event loop.

    `profile` is a profile name (a request) or a profile object (autostart,
    hotkeys). An explicit `cmd`, `args` or `env` overrides the profile's own.
    Folder precedence: `request_cwd`, else `workspace_root`, else None (the
    session manager then uses the home folder). `append_tools=False` leaves
    the PuTTY tools off PATH, for a spec that another instance resolves again.
    """
    prof = None
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
        if claude_mode is not None:
            if getattr(prof, "terminal_type", None) != "claude-code":
                raise LaunchError("claude_mode requires a Claude Code profile")
            if claude_mode not in CLAUDE_MODES:
                raise LaunchError("claude_mode must be new, continue, resume, or agents")
            prof = dataclasses.replace(prof, claude_mode=claude_mode)
    elif start_command is not None or claude_mode is not None:
        raise LaunchError("start_command and claude_mode require a profile")
    if name is not None and not isinstance(name, str):
        raise LaunchError("name must be a string")
    requested_name = name.strip()[:NAME_MAX_CHARS] if name and name.strip() else None

    folder = request_cwd or workspace_root
    if prof is not None:
        try:
            resolved_cmd, resolved_args, cwd = resolve_profile(prof, folder)
        except ValueError as exc:
            raise LaunchError(str(exc), label=prof.name) from exc
        cmd = cmd or resolved_cmd
        args = args if args is not None else resolved_args
        env = env if env is not None else dict(prof.env)
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
    )
