"""Claude Code's status line inside QuickTerm: report the limits, then run theirs.

Claude Code gives its rate limits (``rate_limits.five_hour`` and
``seven_day``) only to a status line command. QuickTerm's per-launch settings
file (``agent_hooks.claude_args``) sets ``statusLine`` to
``<this program> --statusline``, which takes over the user's own status line
for that launch. So this reads Claude's JSON from stdin, posts the limits to
``/api/sessions/{sid}/agent-event`` with the hook token, runs the user's own
``statusLine.command`` with the same stdin and prints its output unchanged.

The argv after the flag is ignored: the user's command is resolved here from
their Claude settings (user, then project, then local; the last one that sets
a command wins), never from QuickTerm's merged file, so it cannot name this
program again. A command that does anyway (it carries the flag and mentions
QuickTerm) is skipped, and ``QUICKTERM_STATUSLINE_CHAIN`` in the child's
environment stops any loop the text check misses.

Stdlib only, and it never raises: Claude runs it on every status update, and a
failure here must not show up in the user's session. It always exits 0.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

FLAG = "--statusline"
EVENT = "QuickTermRateLimits"
POST_TIMEOUT_S = 2.0
# Claude replaces a status line that takes too long anyway; this only keeps
# a hung command from outliving the session.
USER_TIMEOUT_S = 10.0
STDIN_MAX_BYTES = 1024 * 1024
SETTINGS_MAX_BYTES = 2 * 1024 * 1024
GUARD_ENV = "QUICKTERM_STATUSLINE_CHAIN"


def _read_settings(path: Path) -> dict[str, Any] | None:
    try:
        if path.stat().st_size > SETTINGS_MAX_BYTES:
            return None
        parsed = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, UnicodeError, RecursionError):
        return None
    return parsed if isinstance(parsed, dict) else None


def claude_config_dir() -> Path:
    configured = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(configured) if configured else Path.home() / ".claude"


def _project_dir(status: dict[str, Any]) -> Path | None:
    workspace = status.get("workspace")
    for value in (
        workspace.get("project_dir") if isinstance(workspace, dict) else None,
        status.get("cwd"),
    ):
        if isinstance(value, str) and value:
            return Path(value)
    try:
        return Path.cwd()
    except OSError:
        return None


def is_own_command(command: str) -> bool:
    """True for a command that starts this chain again."""
    return FLAG in command.split() and "quickterm" in command.casefold()


def user_command(status: dict[str, Any]) -> str | None:
    """The user's own status line command, or None when they have none."""
    files = [claude_config_dir() / "settings.json"]
    project = _project_dir(status)
    if project is not None:
        files += [project / ".claude" / "settings.json", project / ".claude" / "settings.local.json"]
    command = None
    for path in files:
        settings = _read_settings(path)
        line = settings.get("statusLine") if settings else None
        if not isinstance(line, dict) or line.get("type", "command") != "command":
            continue
        value = line.get("command")
        if isinstance(value, str) and value.strip():
            command = value
    if command is None or is_own_command(command):
        return None
    return command


def _git_bash() -> str | None:
    """Git Bash, which Claude Code on Windows runs its commands with."""
    configured = os.environ.get("CLAUDE_CODE_GIT_BASH_PATH")
    if configured and os.path.isfile(configured):
        return configured
    git = shutil.which("git")
    if git:
        bash = Path(git).resolve().parent.parent / "bin" / "bash.exe"
        if bash.is_file():
            return str(bash)
    return None


def shell_argv(command: str) -> list[str] | None:
    """How ``command`` is run; None means through the platform shell."""
    if os.name != "nt":
        return None
    bash = _git_bash()
    return [bash, "-c", command] if bash else None


def run_user(command: str, stdin: bytes) -> bytes:
    """The command's stdout, empty when it fails or times out."""
    env = dict(os.environ)
    env[GUARD_ENV] = "1"
    argv = shell_argv(command)
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        done = subprocess.run(
            argv if argv is not None else command,
            shell=argv is None,
            input=stdin,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
            timeout=USER_TIMEOUT_S,
            creationflags=flags,
            check=False,
        )
    except (OSError, ValueError, subprocess.SubprocessError):
        return b""
    return done.stdout or b""


def config_dir(status: Any) -> str | None:
    """The Claude config folder this status line runs from: the part of its
    transcript path before ``projects``, so the backend can tell two
    accounts used on one computer apart."""
    path = status.get("transcript_path") if isinstance(status, dict) else None
    if not isinstance(path, str) or not path:
        return None
    parts = path.replace("\\", "/").split("/")
    if "projects" not in parts:
        return None
    at = len(parts) - 1 - parts[::-1].index("projects")
    folder = "/".join(parts[:at])
    return folder or None


def report(rate_limits: Any, folder: str | None = None) -> None:
    """Post the limits the way the hook curl configs post their events."""
    if not isinstance(rate_limits, dict):
        return
    sid = os.environ.get("QUICKTERM_SESSION_ID")
    port = os.environ.get("QUICKTERM_PORT")
    token = os.environ.get("QUICKTERM_HOOK_TOKEN")
    if not sid or not port or not port.isdigit() or not token:
        return
    url = (
        f"http://127.0.0.1:{int(port)}/api/sessions/"
        f"{urllib.parse.quote(sid, safe='')}/agent-event?agent=claude"
    )
    body = json.dumps({"hook_event_name": EVENT, "rate_limits": rate_limits, "config_dir": folder})
    request = urllib.request.Request(
        url,
        data=body.encode("utf-8"),
        headers={"Content-Type": "application/json", "X-QuickTerm-Hook-Token": token},
        method="POST",
    )
    # No proxy handler: a system proxy would see the hook token (as codex_notify).
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        opener.open(request, timeout=POST_TIMEOUT_S).close()
    except (OSError, ValueError):
        pass


def _parse(data: bytes) -> dict[str, Any]:
    try:
        parsed = json.loads(data.decode("utf-8", "replace"))
    except (ValueError, RecursionError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _write(out: bytes) -> None:
    try:
        sys.stdout.buffer.write(out)
        sys.stdout.flush()
    except (OSError, ValueError, AttributeError):
        pass


def run(argv: list[str]) -> int:
    """``argv`` is ignored; see the module docstring."""
    del argv
    if os.environ.get(GUARD_ENV):
        # Started by this chain's own child: whatever it is, stop here.
        return 0
    try:
        data = sys.stdin.buffer.read(STDIN_MAX_BYTES)
    except (OSError, ValueError, AttributeError):
        data = b""
    status = _parse(data)
    poster = threading.Thread(target=report, args=(status.get("rate_limits"), config_dir(status)), daemon=True)
    poster.start()
    try:
        command = user_command(status)
        if command is not None:
            _write(run_user(command, data))
    except Exception:  # noqa: BLE001 - a status line must never fail the session
        pass
    poster.join(POST_TIMEOUT_S)
    return 0
