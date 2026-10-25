"""Agent state from Claude Code and Codex hooks.

Two halves. The launch half adds QuickTerm's hooks to one agent launch,
without touching the user's own settings files: Claude Code gets a
``--settings`` file whose command hooks run ``curl -K <config>``, Codex gets a
``-c notify=[...]`` override. The curl configs read ``QUICKTERM_PORT``,
``QUICKTERM_SESSION_ID`` and ``QUICKTERM_HOOK_TOKEN`` from the environment,
so every file is static and one set serves every terminal. curl rather than
Python because PreToolUse fires on every tool call and a frozen GUI exe starts
slowly; Claude's own ``http`` hooks cannot be used because their URL takes no
environment variables, and the session id is part of the route.

The state half is pure: ``apply`` folds one event into an ``AgentState`` and
``describe`` renders it for ``GET /api/sessions``. ``SessionManager`` owns the
per-session state and the clock.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from quickterm.signals import clean_text

log = logging.getLogger(__name__)

AGENTS = ("claude", "codex")
TEXT_LIMIT = 200
# The board's card keeps more of the prompt and the answer than the tooltip.
LAST_TEXT_LIMIT = 300
# An agent with no event for this long is idle on the board, unless it waits.
IDLE_AFTER_S = 30 * 60
# How much of a transcript's end is read for the last answer.
TRANSCRIPT_TAIL = 256 * 1024
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
# Claude's session ids and Codex's thread ids are UUIDs; nothing else goes
# into a resume command.
_CONVERSATION_ID = re.compile(r"[0-9A-Za-z][0-9A-Za-z_-]{0,99}")
MAX_SUBAGENTS = 32
# Async hooks are separate curl processes, so two events fired a few
# milliseconds apart can arrive in either order. An event that would move the
# state back to a less final one (a tool call after waiting, anything after
# done) within this window is taken for such a straggler and dropped.
LATE_S = 1.0

CLAUDE_EVENTS = (
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Notification",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "SessionEnd",
)
CODEX_TURN_COMPLETE = "agent-turn-complete"
# Sent by the script that runs an agent on an SSH host, where no process
# check can tell whether the agent still runs: started (state idle unless the
# agent already reported) and gone (state none).
AGENT_START = "quickterm-agent-start"
AGENT_EXIT = "quickterm-agent-exit"
CLAUDE_SETTINGS_FILE = "claude-settings.json"
CODEX_CURL_FILE = "codex-notify.curl"
SETTINGS_MAX_BYTES = 2 * 1024 * 1024
# A path inside a hook command line is double quoted; these would still be
# read by bash or cmd.exe, so a folder containing one gets no hooks.
_SHELL_UNSAFE = re.compile(r'["$`%!\r\n]')
_BATCH_UNSAFE = re.compile(r'["&|<>^%!\r\n]')
# --variable and the --expand-* options arrived in curl 8.3.0. Windows 10 and
# 11 ship a curl that Windows Update keeps current (8.13 after mid 2024), but
# an unpatched build still has 7.x, which would refuse every config.
CURL_MIN = (8, 3)
# Merged settings files of the most recently launched user settings that are
# kept; a running Claude may still read one, older ones are deleted.
MERGED_KEEP = 8
# Spawns build in worker threads, so several agent panes restoring together
# write the same files at once.
_files_lock = threading.Lock()
_REPLACE_TRIES = 40
_curl_checked: dict[str, tuple[int, ...] | None] = {}


# --- launch -----------------------------------------------------------------


def hooks_dir() -> Path:
    from quickterm.config import config_dir

    return config_dir() / "hooks"


def curl_program() -> str:
    if os.name == "nt":
        root = os.environ.get("SystemRoot") or r"C:\Windows"
        return (Path(root) / "System32" / "curl.exe").as_posix()
    return shutil.which("curl") or "curl"


def _parse_curl_version(text: str) -> tuple[int, ...] | None:
    match = re.match(r"curl (\d+)\.(\d+)(?:\.(\d+))?", text)
    if match is None:
        return None
    return tuple(int(part) for part in match.groups(default="0"))


def curl_version(program: str) -> tuple[int, ...] | None:
    """``program``'s version, or None when it does not run. Asked once per
    program and backend. Blocking: starts curl."""
    if program in _curl_checked:
        return _curl_checked[program]
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        done = subprocess.run(
            [program, "--version"], capture_output=True, timeout=10, check=False,
            stdin=subprocess.DEVNULL, creationflags=flags,
        )
        version = _parse_curl_version(done.stdout.decode("ascii", "replace"))
    except (OSError, subprocess.SubprocessError):
        version = None
    if version is None or version < CURL_MIN:
        log.warning("agent hooks off: %s is missing or older than curl 8.3 (%s)", program, version)
    _curl_checked[program] = version
    return version


def curl_usable() -> bool:
    version = curl_version(curl_program())
    return version is not None and version >= CURL_MIN


def _curl_config(agent: str, event: str | None) -> str:
    """One curl config. With an event the body is the contract's envelope
    around the hook JSON read from stdin; without one (Codex notify, whose
    JSON arrives as the last argument) the body is that JSON and the agent
    rides in the query."""
    query = "" if event else f"?agent={agent}"
    lines = [
        "silent",
        "max-time = 2",
        # Defaults keep curl from stopping on a missing variable; without a
        # session id the request goes nowhere and changes nothing.
        'variable = "%QUICKTERM_PORT=0"',
        'variable = "%QUICKTERM_SESSION_ID=none"',
        'variable = "%QUICKTERM_HOOK_TOKEN="',
        'expand-url = "http://127.0.0.1:{{QUICKTERM_PORT}}/api/sessions/'
        f'{{{{QUICKTERM_SESSION_ID:url}}}}/agent-event{query}"',
        'expand-header = "X-QuickTerm-Hook-Token: {{QUICKTERM_HOOK_TOKEN}}"',
        'header = "Content-Type: application/json"',
    ]
    if event:
        lines += [
            'variable = "payload@-"',
            f'expand-data = "{{\\"agent\\":\\"{agent}\\",\\"event\\":\\"{event}\\",'
            '\\"payload\\":{{payload}}}"',
        ]
    return "\n".join(lines) + "\n"


def _hook_command(config: Path) -> str:
    program = curl_program()
    if " " in program:
        program = f'"{program}"'
    return f'{program} -K "{config.as_posix()}"'


def claude_hooks(base: Path) -> dict[str, list[dict[str, Any]]]:
    """The ``hooks`` table QuickTerm adds to a Claude Code launch."""
    return {
        event: [{
            "hooks": [{
                "type": "command",
                "command": _hook_command(base / f"claude-{event}.curl"),
                # Never block the agent on QuickTerm, and never let a slow or
                # absent backend decide anything.
                "async": True,
                "timeout": 10,
            }]
        }]
        for event in CLAUDE_EVENTS
    }


def _holds(path: Path, text: str) -> bool:
    try:
        return path.read_text(encoding="utf-8") == text
    except OSError:
        return False


def _write_if_changed(path: Path, text: str) -> None:
    if _holds(path, text):
        return
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f"{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        # Windows refuses a replace while another writer (a second QuickTerm
        # backend) has the target open; what counts is that it ends up
        # holding this text, whoever wrote it.
        for attempt in range(_REPLACE_TRIES):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if _holds(path, text):
                    return
                if attempt == _REPLACE_TRIES - 1:
                    raise
                time.sleep(0.005)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def ensure_files(base: Path) -> None:
    """Write the curl configs and the Claude settings file. Blocking."""
    with _files_lock:
        _ensure_files(base)


def _ensure_files(base: Path) -> None:
    base.mkdir(parents=True, exist_ok=True)
    for event in CLAUDE_EVENTS:
        _write_if_changed(base / f"claude-{event}.curl", _curl_config("claude", event))
    _write_if_changed(base / CODEX_CURL_FILE, _curl_config("codex", None))
    settings: dict[str, Any] = {"hooks": claude_hooks(base)}
    _add_status_line(settings)
    _write_if_changed(base / CLAUDE_SETTINGS_FILE, json.dumps(settings, indent=2) + "\n")


def _user_settings(value: str, cwd: str | None) -> dict[str, Any] | None:
    """The user's own ``--settings`` value as a dict, or None when unreadable."""
    text = value.strip()
    if not text.startswith("{"):
        path = Path(os.path.expandvars(os.path.expanduser(text)))
        if not path.is_absolute() and cwd:
            path = Path(cwd) / path
        try:
            if path.stat().st_size > SETTINGS_MAX_BYTES:
                return None
            text = path.read_text(encoding="utf-8-sig")
        except OSError:
            return None
    try:
        parsed = json.loads(text)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def merge_claude_settings(user: dict[str, Any], base: Path) -> dict[str, Any]:
    """``user`` with QuickTerm's hooks appended to its own, which keep running."""
    merged = dict(user)
    hooks = dict(user.get("hooks") or {}) if isinstance(user.get("hooks"), dict) else {}
    for event, entries in claude_hooks(base).items():
        existing = hooks.get(event)
        hooks[event] = (list(existing) if isinstance(existing, list) else []) + entries
    merged["hooks"] = hooks
    _add_status_line(merged)
    return merged


def statusline_command() -> str | None:
    """The ``statusLine`` command that reports Claude's rate limits
    (``statusline_chain.py``), or None when the program path is unsafe in a
    shell. A source run imports only that module: Claude starts it on every
    status update, and the whole app takes over a second to import."""
    from quickterm.statusline_chain import FLAG

    program = Path(sys.executable).as_posix()
    if _SHELL_UNSAFE.search(program):
        return None
    if getattr(sys, "frozen", False):
        return f'"{program}" {FLAG}'
    # -P: no project folder on sys.path, so a file there cannot shadow a module.
    code = "import sys; from quickterm.statusline_chain import run; sys.exit(run(sys.argv[1:]))"
    return f'"{program}" -P -c "{code}" {FLAG}'


def _add_status_line(settings: dict[str, Any]) -> None:
    """QuickTerm's status line, unless these settings name one of their own:
    a ``--settings`` value that sets ``statusLine`` keeps it for the launch."""
    if "statusLine" in settings:
        return
    command = statusline_command()
    if command is not None:
        settings["statusLine"] = {"type": "command", "command": command}


def _settings_arg(args: list[str]) -> tuple[int, int, str] | None:
    """Where the user's own ``--settings`` sits: (start, length, value)."""
    found = None
    for at, arg in enumerate(args):
        if arg.startswith("--settings="):
            found = (at, 1, arg[len("--settings="):])
        elif arg == "--settings" and at + 1 < len(args):
            found = (at, 2, args[at + 1])
    return found


def _is_batch(cmd: str) -> bool:
    # A bare name runs whatever PATH finds, as in agents._guard_batch.
    resolved = cmd if os.path.dirname(cmd) else (shutil.which(cmd) or cmd)
    return resolved.lower().endswith((".cmd", ".bat"))


def _prune_merged(base: Path, keep: Path) -> None:
    """Delete all but the most recently used merged settings files.

    Each copies the user's settings, secrets in ``env`` included, so they
    must not pile up; ``keep`` was just used and is marked newest.
    """
    os.utime(keep)
    try:
        merged = sorted(
            base.glob("claude-settings-*.json"), key=lambda p: p.stat().st_mtime_ns, reverse=True
        )
    except OSError:
        return
    for stale in merged[MERGED_KEEP:]:
        if stale != keep:
            try:
                stale.unlink()
            except OSError:
                pass


def claude_args(cmd: str, args: list[str], cwd: str | None, base: Path) -> list[str]:
    """``args`` with QuickTerm's settings for this launch.

    Claude keeps only the last ``--settings`` it is given, so a user's own
    settings option is merged into a file of its own instead of being passed
    next to ours.
    """
    if args[:1] == ["agents"]:
        # The agent manager takes no --settings.
        return args
    target = base / CLAUDE_SETTINGS_FILE
    user = _settings_arg(args)
    out = list(args)
    if user is not None:
        start, length, value = user
        parsed = _user_settings(value, cwd)
        if parsed is None:
            # Unreadable: Claude reports it itself; QuickTerm adds nothing.
            return args
        text = json.dumps(merge_claude_settings(parsed, base), indent=2) + "\n"
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
        target = base / f"claude-settings-{digest}.json"
        with _files_lock:
            _write_if_changed(target, text)
            _prune_merged(base, target)
        del out[start:start + length]
    arg = f"--settings={target.as_posix()}"
    if _is_batch(cmd) and _BATCH_UNSAFE.search(arg):
        return args
    return [*out, arg]


def _codex_user_notify() -> list[str] | None:
    """The user's own ``notify`` argv; [] when none is set; None when it
    cannot be read or is not a list of strings (then QuickTerm stays out)."""
    from quickterm.agents import codex_home

    try:
        data = tomllib.loads((codex_home() / "config.toml").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, ValueError, UnicodeError):
        return None
    notify = data.get("notify")
    if not notify:
        return []
    if not isinstance(notify, list) or not all(isinstance(part, str) and part for part in notify):
        return None
    return notify


def toml_strings(items: list[str]) -> str:
    """A TOML array of strings for a ``-c key=<value>`` argument.

    Literal strings ('...') where they can hold the item: a double quote in
    the argument is lost by Windows PowerShell 5.1's native argument passing
    and refused by the cmd wrap, and a literal string needs none. An item
    with a single quote is a multi-line literal ('''...''') when that can
    hold it, else a basic (JSON) string.
    """
    parts = []
    for item in items:
        if "'" not in item and "\n" not in item and "\r" not in item:
            parts.append(f"'{item}'")
        elif "'''" not in item and not item.endswith("'") and not item.startswith(("\n", "\r")):
            parts.append(f"'''{item}'''")
        else:
            parts.append(json.dumps(item))
    return "[" + ",".join(parts) + "]"


def _self_command() -> list[str]:
    """How a child process starts this program (codex_notify.py's entry)."""
    if getattr(sys, "frozen", False):
        return [sys.executable]
    return [sys.executable, "-c", "from quickterm.app import main; main()"]


def codex_args(cmd: str, args: list[str], base: Path) -> list[str]:
    """``args`` with a per-launch ``notify`` that reports each finished turn.

    ``-c notify`` replaces the user's own notify program for the launch, so
    when they have one, QuickTerm's program runs theirs first and then reports
    (``codex_notify.py``). Codex hooks are not used: each hook definition
    must be trusted in ``/hooks`` before it runs, and bypassing that would
    bypass it for every hook.
    """
    if args[:1] == ["agents"] or _is_batch(cmd):
        return args
    notify = _codex_notify(base)
    return args if notify is None else [*notify, *args]


def _codex_notify(base: Path) -> list[str] | None:
    """The ``-c notify=...`` pair of a Codex launch, or None when the user's
    own notify cannot be read."""
    user = _codex_user_notify()
    if user is None:
        return None
    if user:
        from quickterm.codex_notify import FLAG

        notify = [*_self_command(), FLAG, *user]
    else:
        # Codex appends the notification JSON as the last argument, which
        # becomes the --data-binary body.
        notify = [curl_program(), "-K", (base / CODEX_CURL_FILE).as_posix(), "--data-binary"]
    return ["-c", "notify=" + toml_strings(notify)]


def shell_hooks(base: Path | None = None) -> dict[str, tuple[tuple[str, ...], bool]]:
    """What the user's own ``claude`` and ``codex`` get in a PowerShell
    terminal QuickTerm started: per agent, the hook arguments and whether a
    .cmd/.bat program may be given them. Blocking: writes the hook files.

    Empty when hooks are unavailable; an agent is missing when its part
    cannot be built. Claude gets the static settings file only: a user's own
    ``--settings`` on the command line makes the shell pass everything through.
    """
    base = base if base is not None else hooks_dir()
    if _SHELL_UNSAFE.search(base.as_posix()) or not curl_usable():
        return {}
    try:
        ensure_files(base)
        out: dict[str, tuple[tuple[str, ...], bool]] = {}
        arg = f"--settings={(base / CLAUDE_SETTINGS_FILE).as_posix()}"
        out["claude"] = ((arg,), not _BATCH_UNSAFE.search(arg))
        notify = _codex_notify(base)
        if notify is not None:
            # codex_args never hands a .cmd/.bat Codex its notify.
            out["codex"] = (tuple(notify), False)
        return out
    except OSError:
        log.warning("agent hooks unavailable for this shell", exc_info=True)
        return {}


def launch_args(
    agent: str, cmd: str, args: list[str], cwd: str | None, base: Path | None = None
) -> list[str]:
    """The argv one agent launch starts with. Blocking: writes the hook files.

    Any failure leaves the launch as it was: hooks are an extra.
    """
    base = base if base is not None else hooks_dir()
    if _SHELL_UNSAFE.search(base.as_posix()) or not curl_usable():
        return args
    try:
        ensure_files(base)
        if agent == "claude":
            return claude_args(cmd, args, cwd, base)
        if agent == "codex":
            return codex_args(cmd, args, base)
    except OSError:
        log.warning("agent hooks unavailable for this launch", exc_info=True)
    return args


# --- launch inside WSL ----------------------------------------------------------
#
# A Linux agent runs Windows' own curl.exe through WSL interop, with the same
# curl configs as a local launch, so the request goes to 127.0.0.1 on
# Windows whatever WSL's network mode. WSLENV carries the port, session id
# and token into the distribution and from there back to curl.exe; with /p it
# also turns the curl.exe path into the distribution's form. The token is in
# the agent's environment only, never in an argument or a file.

WSL_CURL_VAR = "QUICKTERM_CURL"
_WSLENV_NAMES = (
    "QUICKTERM_PORT", "QUICKTERM_SESSION_ID", "QUICKTERM_HOOK_TOKEN", f"{WSL_CURL_VAR}/p",
)


def wsl_hook_command(config: Path, *, notify: bool = False) -> str:
    """The POSIX command one hook runs inside WSL. A Codex notify gets its
    JSON as `$1` and sends it on stdin. Without curl.exe (interop off) it
    does nothing and exits 0."""
    run = f'"${WSL_CURL_VAR}" -K {shlex.quote(config.as_posix())}'
    if notify:
        run = f'printf %s "$1" | {run} --data-binary @-'
    return f'[ -x "${WSL_CURL_VAR}" ] && {run}; exit 0'


def wsl_claude_args(args: list[str], base: Path) -> list[str]:
    """``args`` with QuickTerm's hooks as one inline ``--settings``; a launch
    that passes settings of its own keeps them and gets no hooks."""
    if args[:1] == ["agents"] or _settings_arg(args) is not None:
        return args
    hooks = {
        event: [{"hooks": [{
            "type": "command", "command": wsl_hook_command(base / f"claude-{event}.curl"),
            "async": True, "timeout": 10,
        }]}]
        for event in CLAUDE_EVENTS
    }
    return [*args, "--settings", json.dumps({"hooks": hooks}, separators=(",", ":"))]


def wsl_codex_args(args: list[str], base: Path) -> list[str]:
    """``args`` with a notify that posts each finished turn, only when the
    Windows Codex config has no notify of its own (the distribution's config
    cannot be read before the launch, and this would replace it)."""
    if args[:1] == ["agents"] or _codex_user_notify() != []:
        return args
    notify = ["sh", "-c", wsl_hook_command(base / CODEX_CURL_FILE, notify=True), "quickterm-notify"]
    return ["-c", "notify=" + toml_strings(notify), *args]


def wsl_env(env: dict[str, str]) -> dict[str, str]:
    """``env`` with what the WSL hooks need: the curl.exe path and the
    variables added to WSLENV (the user's own entries stay)."""
    out = dict(env)
    root = os.environ.get("SystemRoot") or r"C:\Windows"
    out[WSL_CURL_VAR] = str(Path(root) / "System32" / "curl.exe")
    key = next((name for name in out if name.casefold() == "wslenv"), None)
    current = out.pop(key) if key is not None else os.environ.get("WSLENV", "")
    names = [name for name in current.split(":") if name]
    have = {name.split("/")[0] for name in names}
    names += [name for name in _WSLENV_NAMES if name.split("/")[0] not in have]
    out["WSLENV"] = ":".join(names)
    return out


def wsl_launch(
    agent: str, args: list[str], env: dict[str, str], base: Path | None = None,
) -> tuple[list[str], dict[str, str]]:
    """The argv and environment of one agent launch inside WSL. Blocking:
    writes the hook files. Any failure leaves the launch as it was."""
    base = base if base is not None else hooks_dir()
    if os.name != "nt" or not curl_usable():
        return args, env
    try:
        ensure_files(base)
    except OSError:
        log.warning("agent hooks unavailable for this WSL launch", exc_info=True)
        return args, env
    hooked = wsl_claude_args(args, base) if agent == "claude" else wsl_codex_args(args, base)
    if hooked == args:
        return args, env
    return hooked, wsl_env(env)


# --- launch on an SSH host ----------------------------------------------------
#
# The agent runs on the host, so the Windows curl configs cannot reach it.
# The session's ssh forwards a Unix socket on the host to the backend
# (`-R <socket>:127.0.0.1:<port>`), and the hooks post through it with the
# host's own curl. The token is read from the session's environment and fed
# to curl on stdin (`-H @-`), so it is in no command line and no file there.


def remote_hook_command(agent: str, port: int, *, body: str = "@/dev/fd/4") -> str:
    """The POSIX command one remote hook runs. The Host header names the
    backend's port, which the guard's Host allowlist expects. Without the
    socket or curl it does nothing and exits 0."""
    url = f"http://127.0.0.1:{int(port)}/api/sessions/$QUICKTERM_SESSION_ID/agent-event?agent={agent}"
    keep_stdin = "exec 4<&0; " if body == "@/dev/fd/4" else ""
    return (
        '[ -S "$QUICKTERM_HOOK_SOCKET" ] && command -v curl >/dev/null 2>&1 && { '
        f"{keep_stdin}"
        "printf 'X-QuickTerm-Hook-Token: %s\\n' \"$QUICKTERM_HOOK_TOKEN\" | "
        'curl --unix-socket "$QUICKTERM_HOOK_SOCKET" -sS -m 2 -o /dev/null -H @- '
        "-H 'Content-Type: application/json' "
        f'--data-binary {body} "{url}"; }}; exit 0'
    )


def remote_lifecycle_command(agent: str, port: int, event: str) -> str:
    """A hook command the remote script itself runs, before the agent starts
    (`AGENT_START`) and after it ended (`AGENT_EXIT`), with the contract's
    envelope as its body. It ends with `exit 0`, so the caller runs it in a
    subshell."""
    body = json.dumps({"agent": agent, "event": event, "payload": {}}, separators=(",", ":"))
    return remote_hook_command(agent, port, body=shlex.quote(body))


def remote_claude_args(args: list[str], port: int) -> list[str]:
    """``args`` with QuickTerm's hooks as one inline ``--settings``. A launch
    that already passes its own settings keeps them and gets no hooks: the
    file it names lives on the host, so it cannot be merged from here."""
    if args[:1] == ["agents"] or _settings_arg(args) is not None:
        return args
    command = remote_hook_command("claude", port)
    hooks = {
        event: [{"hooks": [{"type": "command", "command": command, "async": True, "timeout": 10}]}]
        for event in CLAUDE_EVENTS
    }
    return [*args, "--settings", json.dumps({"hooks": hooks}, separators=(",", ":"))]


def remote_codex_args(args: list[str], port: int) -> list[str]:
    """``args`` with a per-launch notify that posts each finished turn. Only
    when the local Codex config has no notify of its own: the remote one
    cannot be read before the launch, and this would replace it."""
    if args[:1] == ["agents"] or _codex_user_notify() != []:
        return args
    script = remote_hook_command("codex", port, body='"$1"')
    notify = ["sh", "-c", script, "quickterm-notify"]
    return ["-c", "notify=" + toml_strings(notify), *args]


def remote_launch_args(agent: str, args: list[str], port: int) -> list[str]:
    """The remote agent argv with QuickTerm's hooks; any failure keeps it as it was."""
    try:
        if agent == "claude":
            return remote_claude_args(args, port)
        if agent == "codex":
            return remote_codex_args(args, port)
    except (OSError, ValueError):
        log.warning("agent hooks unavailable for this remote launch", exc_info=True)
    return args


# --- state ------------------------------------------------------------------


@dataclass(frozen=True)
class Subagent:
    id: str
    type: str | None
    description: str | None
    started: float
    # Asked for a permission and has not used a tool since.
    waiting: bool = False


@dataclass(frozen=True)
class AgentState:
    kind: str
    state: str  # working | waiting | done | failed | idle
    changed: float
    prompt: str | None = None
    message: str | None = None
    tool: str | None = None
    subagents: tuple[Subagent, ...] = field(default_factory=tuple)
    # The board's card: the last prompt and the start of the last answer, up
    # to LAST_TEXT_LIMIT characters, and when any event last arrived.
    last_prompt: str | None = None
    last_answer: str | None = None
    last_event: float = 0.0
    # The agent's own conversation (Claude's session id, Codex's thread id),
    # the folder it runs in, and its title once the agent has one.
    conversation: str | None = None
    cwd: str | None = None
    title: str | None = None


_RANK = {"idle": 0, "working": 1, "waiting": 2, "done": 3, "failed": 3}


def _text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = clean_text(value, TEXT_LIMIT)
    return text or None


def _long_text(value: Any) -> str | None:
    """The first LAST_TEXT_LIMIT characters, control characters and runs of
    whitespace collapsed, without an ellipsis (the card clamps its own)."""
    if not isinstance(value, str):
        return None
    text = " ".join(_CONTROL.sub(" ", value).split())[:LAST_TEXT_LIMIT].rstrip()
    return text or None


def _field(payload: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in payload:
            return payload[key]
    return None


def _ident(value: Any) -> str | None:
    """A conversation id as the CLIs print it, or None."""
    if isinstance(value, str) and _CONVERSATION_ID.fullmatch(value):
        return value
    return None


def _folder(value: Any) -> str | None:
    """The hook's ``cwd``, kept as text for the resume command and never
    opened. A network path is dropped: running a copied ``cd`` into one would
    log on to that host."""
    if not isinstance(value, str) or not value or len(value) > 1024 or _CONTROL.search(value):
        return None
    if value[:2] in ("\\\\", "//", "\\/", "/\\"):
        return None
    return value


@dataclass(frozen=True)
class Outcome:
    """What one event did: the new state (None: no agent), and the text of a
    "needs you" attention when the event moved the agent to waiting, or of a
    finished turn when it moved the agent to done or failed."""

    state: AgentState | None
    waiting: str | None = None
    finished: str | None = None


def _is_permission_notification(payload: dict[str, Any]) -> bool:
    kind = payload.get("notification_type")
    if isinstance(kind, str):
        return kind == "permission_prompt"
    message = payload.get("message")
    return isinstance(message, str) and "permission" in message.casefold()


def _stamped(state: AgentState, payload: dict[str, Any], now: float, conversation_key: str) -> AgentState:
    """``state`` with this event's time and the conversation it names."""
    return replace(
        state,
        last_event=now,
        conversation=_ident(payload.get(conversation_key)) or state.conversation,
        cwd=_folder(payload.get("cwd")) or state.cwd,
    )


def apply(
    current: AgentState | None, agent: str, event: str, payload: dict[str, Any], now: float
) -> Outcome:
    """Fold one hook event into the agent state. Unknown events change nothing."""
    if event == AGENT_EXIT:
        return Outcome(None)
    if event == AGENT_START:
        if current is not None and current.kind == agent:
            return Outcome(current)
        return Outcome(AgentState(agent, "idle", now))
    if agent == "codex":
        if event != CODEX_TURN_COMPLETE:
            return Outcome(current)
        base = current if current is not None and current.kind == "codex" else AgentState(
            "codex", "idle", now
        )
        inputs = payload.get("input-messages")
        last_input = inputs[-1] if isinstance(inputs, list) and inputs else None
        answer = payload.get("last-assistant-message")
        state = replace(
            base,
            state="done",
            changed=now,
            prompt=_text(last_input) or base.prompt,
            message=_text(answer),
            tool=None,
            last_prompt=_long_text(last_input) or base.last_prompt,
            last_answer=_long_text(answer),
        )
        state = _stamped(state, payload, now, "thread-id")
        return Outcome(state, finished=state.last_answer or "")

    if event == "SessionEnd":
        return Outcome(None)

    def stamp(state: AgentState) -> AgentState:
        return _stamped(state, payload, now, "session_id")

    # SessionStart also fires with source "compact" in the middle of a turn,
    # which starts nothing new.
    if event == "SessionStart" and (
        current is None or payload.get("source") in (None, "startup", "resume", "clear", "fork")
    ):
        # A resumed or forked conversation keeps the title it had.
        title = current.title if current is not None and payload.get("source") == "resume" else None
        return Outcome(stamp(AgentState("claude", "idle", now, title=title)))
    state = current if current is not None and current.kind == "claude" else AgentState(
        "claude", "idle", now
    )

    def moved(new_state: str, **changes: Any) -> AgentState:
        if new_state == state.state and not changes:
            return stamp(state)
        return stamp(replace(state, state=new_state, changed=now if new_state != state.state
                             else state.changed, **changes))

    def straggler(new_state: str) -> bool:
        return (
            _RANK[new_state] < _RANK[state.state]
            and state.state != "idle"
            and now - state.changed < LATE_S
        )

    def subagents_with(agent_id: Any, waiting: bool) -> tuple[Subagent, ...]:
        if not isinstance(agent_id, str):
            return state.subagents
        return tuple(
            replace(s, waiting=waiting) if s.id == agent_id[:100] else s for s in state.subagents
        )

    if event == "SessionStart":
        return Outcome(state)  # compaction: the turn goes on
    if event == "UserPromptSubmit":
        prompt = payload.get("prompt")
        return Outcome(stamp(replace(
            state, state="working", changed=now, prompt=_text(prompt),
            message=None, tool=None, last_prompt=_long_text(prompt), last_answer=None,
        )))
    if event in ("PreToolUse", "PostToolUse"):
        # A tool call inside a subagent means it got what it waited for.
        subagents = subagents_with(payload.get("agent_id"), False)
        if straggler("working"):
            return Outcome(state if subagents == state.subagents else replace(state, subagents=subagents))
        tool = _text(payload.get("tool_name")) if event == "PreToolUse" else None
        return Outcome(moved("working", tool=tool, subagents=subagents))
    if event == "PermissionRequest" or (
        event == "Notification" and _is_permission_notification(payload)
    ):
        subagents = subagents_with(payload.get("agent_id"), True)
        if straggler("waiting"):
            return Outcome(state if subagents == state.subagents else replace(state, subagents=subagents))
        tool = _text(payload.get("tool_name")) or state.tool
        text = _text(payload.get("message")) or (
            f"permission to use {tool}" if tool else "permission requested"
        )
        changed = state.state != "waiting"
        return Outcome(moved("waiting", tool=tool, subagents=subagents),
                       waiting=text if changed else None)
    if event == "Stop":
        answer = payload.get("last_assistant_message")
        message = _text(answer)
        done = stamp(replace(
            state, state="done", changed=now, tool=None, message=message or state.message,
            last_answer=_long_text(answer) or state.last_answer,
        ))
        return Outcome(done, finished=(done.last_answer or "") if state.state != "done" else None)
    if event == "StopFailure":
        error = _field(payload, "last_assistant_message", "error_details", "error")
        message = _text(error)
        failed = stamp(replace(
            state, state="failed", changed=now, tool=None, message=message or state.message,
            last_answer=_long_text(error) or state.last_answer,
        ))
        return Outcome(failed, finished=(failed.last_answer or "") if state.state != "failed" else None)
    if event == "SubagentStart":
        agent_id = payload.get("agent_id")
        if not isinstance(agent_id, str) or not agent_id:
            return Outcome(state)
        kept = tuple(s for s in state.subagents if s.id != agent_id)[-(MAX_SUBAGENTS - 1):]
        added = Subagent(
            agent_id[:100],
            _text(payload.get("agent_type")),
            _text(_field(payload, "description", "task_description")),
            now,
        )
        return Outcome(stamp(replace(state, subagents=(*kept, added))))
    if event == "SubagentStop":
        agent_id = payload.get("agent_id")
        kept = tuple(s for s in state.subagents if s.id != agent_id)
        return Outcome(stamp(replace(state, subagents=kept)))
    return Outcome(current)


def seen(state: AgentState | None, now: float) -> AgentState | None:
    """The user looked: a finished or failed agent becomes idle."""
    if state is not None and state.state in ("done", "failed"):
        return replace(state, state="idle", changed=now)
    return state


def with_title(state: AgentState | None, title: str | None) -> AgentState | None:
    """``state`` carrying the conversation's title, when it has one."""
    text = _text(title)
    if state is None or not text or text == state.title:
        return state
    return replace(state, title=text)


def board_column(state: AgentState | None, now: float) -> str | None:
    """Where the board's Agents tab shows this agent.

    Waiting, or a subagent waiting for permission, is "needs-you" however long
    it has waited. Otherwise an agent that sent no event for IDLE_AFTER_S is
    "idle". A finished turn stays "done" after it was seen, until then; only an
    agent that never finished a turn is idle at once.
    """
    if state is None:
        return None
    if state.state == "waiting" or any(s.waiting for s in state.subagents):
        return "needs-you"
    if now - state.last_event >= IDLE_AFTER_S:
        return "idle"
    if state.state == "working":
        return "working"
    if state.state in ("done", "failed") or state.last_answer or state.last_prompt:
        return "done"
    return "idle"


def _iso_utc(seconds: float) -> str:
    stamp = datetime.fromtimestamp(seconds, tz=timezone.utc)
    return stamp.isoformat(timespec="seconds").replace("+00:00", "Z")


def describe(state: AgentState | None, now: float, wall: float | None = None) -> dict[str, Any] | None:
    """The ``agent`` field of ``GET /api/sessions``. ``now`` is the monotonic
    clock the state was stamped with, ``wall`` the matching epoch time."""
    if state is None:
        return None
    wall = time.time() if wall is None else wall
    event_age = max(0.0, now - state.last_event)
    return {
        "kind": state.kind,
        "state": state.state,
        "prompt": state.prompt,
        "message": state.message,
        "tool": state.tool if state.state == "working" else None,
        "subagents": [
            {
                "id": s.id,
                "type": s.type,
                "description": s.description,
                "age_seconds": max(0, int(now - s.started)),
                "waiting": s.waiting,
            }
            for s in state.subagents
        ],
        "age_seconds": max(0, int(now - state.changed)),
        "last_prompt": state.last_prompt,
        "last_answer": state.last_answer,
        "last_event_at": _iso_utc(wall - event_age),
        "event_age_seconds": int(event_age),
        "board": board_column(state, now),
        "conversation_id": state.conversation,
        "cwd": state.cwd,
        "title": state.title,
    }


# --- what the hook payload only points at ---------------------------------------


def _assistant_text(record: Any) -> str | None:
    if not isinstance(record, dict) or record.get("type") != "assistant":
        return None
    message = record.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        return content.strip() or None
    if not isinstance(content, list):
        return None
    parts = [
        part["text"] for part in content
        if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str)
    ]
    return " ".join(parts).strip() or None


def transcript_answer(path: Any, cap: int = TRANSCRIPT_TAIL) -> str | None:
    """The last assistant text in a Claude transcript, read from its end.

    Only the last ``cap`` bytes are read; a transcript holds the whole
    conversation and can be tens of megabytes. Blocking: reads a file, and
    only one in Claude's own projects folder on a local disk.
    """
    from quickterm import agent_sessions

    path = agent_sessions.claude_transcript(path)
    if path is None:
        return None
    try:
        with open(path, "rb") as handle:
            size = os.fstat(handle.fileno()).st_size
            start = max(0, size - cap)
            handle.seek(start)
            data = handle.read(cap)
    except OSError:
        return None
    lines = data.split(b"\n")
    if start > 0:
        lines = lines[1:]  # the first line was cut by the seek
    for line in reversed(lines):
        if b'"assistant"' not in line:
            continue
        try:
            text = _assistant_text(json.loads(line))
        except (ValueError, RecursionError):
            continue
        if text:
            return _long_text(text)
    return None


def turn_details(agent: str, event: str, payload: dict[str, Any]) -> tuple[dict[str, Any], str | None]:
    """What a finished turn's hook only points at: the payload with the answer
    filled in from the transcript when the hook did not carry it, and the
    conversation's own title. Blocking: reads the agent's files. Never call it
    for a session on an SSH host: its paths are the host's, not this disk's."""
    from quickterm import agent_sessions

    if agent == "codex":
        if event != CODEX_TURN_COMPLETE:
            return payload, None
        thread = _ident(payload.get("thread-id"))
        return payload, agent_sessions.codex_thread_name(thread) if thread else None
    if event != "Stop":
        return payload, None
    transcript = payload.get("transcript_path")
    if not _long_text(payload.get("last_assistant_message")):
        answer = transcript_answer(transcript)
        if answer:
            payload = {**payload, "last_assistant_message": answer}
    title = agent_sessions.claude_title(transcript) if isinstance(transcript, str) else None
    return payload, title


def parse_body(raw: Any, query_agent: str | None) -> tuple[str, str, dict[str, Any]]:
    """``(agent, event, payload)`` from a request body. ValueError when malformed.

    The contract's envelope is ``{"agent", "event", "payload"}``. Codex's
    notify passes its JSON as an argument that curl can only send as the
    whole body, so a body without ``event`` is taken as the raw hook JSON of
    ``?agent=``, its event read from ``hook_event_name`` (Claude) or ``type``
    (Codex).
    """
    if not isinstance(raw, dict):
        raise ValueError("body must be a JSON object")
    if "event" in raw:
        agent, event, payload = raw.get("agent"), raw.get("event"), raw.get("payload", {})
    else:
        agent = query_agent
        payload = raw
        event = raw.get("hook_event_name") if agent == "claude" else raw.get("type")
    if agent not in AGENTS:
        raise ValueError("agent must be claude or codex")
    if not isinstance(event, str) or not event or len(event) > 64:
        raise ValueError("event must be a hook event name")
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")
    return agent, event, payload
