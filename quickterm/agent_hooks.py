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
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from quickterm.signals import clean_text

log = logging.getLogger(__name__)

AGENTS = ("claude", "codex")
TEXT_LIMIT = 200
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
    settings = {"hooks": claude_hooks(base)}
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
    return merged


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
    user = _codex_user_notify()
    if user is None:
        return args
    if user:
        from quickterm.codex_notify import FLAG

        notify = [*_self_command(), FLAG, *user]
    else:
        # Codex appends the notification JSON as the last argument, which
        # becomes the --data-binary body.
        notify = [curl_program(), "-K", (base / CODEX_CURL_FILE).as_posix(), "--data-binary"]
    return ["-c", "notify=" + json.dumps(notify), *args]


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


# --- state ------------------------------------------------------------------


@dataclass(frozen=True)
class Subagent:
    id: str
    type: str | None
    description: str | None
    started: float


@dataclass(frozen=True)
class AgentState:
    kind: str
    state: str  # working | waiting | done | failed | idle
    changed: float
    prompt: str | None = None
    message: str | None = None
    tool: str | None = None
    subagents: tuple[Subagent, ...] = field(default_factory=tuple)


_RANK = {"idle": 0, "working": 1, "waiting": 2, "done": 3, "failed": 3}


def _text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = clean_text(value, TEXT_LIMIT)
    return text or None


def _field(payload: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in payload:
            return payload[key]
    return None


@dataclass(frozen=True)
class Outcome:
    """What one event did: the new state (None: no agent), and the text of a
    "needs you" attention when the event moved the agent to waiting."""

    state: AgentState | None
    waiting: str | None = None


def _is_permission_notification(payload: dict[str, Any]) -> bool:
    kind = payload.get("notification_type")
    if isinstance(kind, str):
        return kind == "permission_prompt"
    message = payload.get("message")
    return isinstance(message, str) and "permission" in message.casefold()


def apply(
    current: AgentState | None, agent: str, event: str, payload: dict[str, Any], now: float
) -> Outcome:
    """Fold one hook event into the agent state. Unknown events change nothing."""
    if agent == "codex":
        if event != CODEX_TURN_COMPLETE:
            return Outcome(current)
        base = current if current is not None and current.kind == "codex" else AgentState(
            "codex", "idle", now
        )
        inputs = payload.get("input-messages")
        prompt = _text(inputs[-1]) if isinstance(inputs, list) and inputs else None
        return Outcome(replace(
            base,
            state="done",
            changed=now,
            prompt=prompt or base.prompt,
            message=_text(payload.get("last-assistant-message")),
            tool=None,
        ))

    if event == "SessionEnd":
        return Outcome(None)
    # SessionStart also fires with source "compact" in the middle of a turn,
    # which starts nothing new.
    if event == "SessionStart" and (
        current is None or payload.get("source") in (None, "startup", "resume", "clear", "fork")
    ):
        return Outcome(AgentState("claude", "idle", now))
    state = current if current is not None and current.kind == "claude" else AgentState(
        "claude", "idle", now
    )

    def moved(new_state: str, **changes: Any) -> AgentState:
        if new_state == state.state and not changes:
            return state
        return replace(state, state=new_state, changed=now if new_state != state.state
                       else state.changed, **changes)

    def straggler(new_state: str) -> bool:
        return (
            _RANK[new_state] < _RANK[state.state]
            and state.state != "idle"
            and now - state.changed < LATE_S
        )

    if event == "UserPromptSubmit":
        return Outcome(replace(
            state, state="working", changed=now, prompt=_text(payload.get("prompt")),
            message=None, tool=None,
        ))
    if event in ("PreToolUse", "PostToolUse"):
        if straggler("working"):
            return Outcome(state)
        tool = _text(payload.get("tool_name")) if event == "PreToolUse" else None
        return Outcome(moved("working", tool=tool))
    if event == "PermissionRequest" or (
        event == "Notification" and _is_permission_notification(payload)
    ):
        if straggler("waiting"):
            return Outcome(state)
        tool = _text(payload.get("tool_name")) or state.tool
        text = _text(payload.get("message")) or (
            f"permission to use {tool}" if tool else "permission requested"
        )
        changed = state.state != "waiting"
        return Outcome(moved("waiting", tool=tool), waiting=text if changed else None)
    if event == "Stop":
        message = _text(payload.get("last_assistant_message"))
        return Outcome(replace(
            state, state="done", changed=now, tool=None, message=message or state.message
        ))
    if event == "StopFailure":
        message = _text(_field(payload, "last_assistant_message", "error_details", "error"))
        return Outcome(replace(
            state, state="failed", changed=now, tool=None, message=message or state.message
        ))
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
        return Outcome(replace(state, subagents=(*kept, added)))
    if event == "SubagentStop":
        agent_id = payload.get("agent_id")
        kept = tuple(s for s in state.subagents if s.id != agent_id)
        return Outcome(replace(state, subagents=kept))
    return Outcome(current)


def seen(state: AgentState | None, now: float) -> AgentState | None:
    """The user looked: a finished or failed agent becomes idle."""
    if state is not None and state.state in ("done", "failed"):
        return replace(state, state="idle", changed=now)
    return state


def describe(state: AgentState | None, now: float) -> dict[str, Any] | None:
    if state is None:
        return None
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
            }
            for s in state.subagents
        ],
        "age_seconds": max(0, int(now - state.changed)),
    }


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
