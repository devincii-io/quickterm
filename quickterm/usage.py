"""Agent usage limits: Claude's from its status line, Codex's from its rollouts.

Claude Code hands its rate limits only to a status line command, so
QuickTerm's per-launch settings run ``statusline_chain.py``, which posts them
to the agent-event route; ``ClaudeLimits`` keeps the latest numbers for the
whole backend rather than per session, and the running backend also keeps
them in ``claude-usage.json`` in the config folder, so a restart still shows
them before Claude reports again.

Codex writes its limits into every ``token_count`` event of the session
rollout it is recording. ``CodexReader`` reads the end of the newest rollout
file and caches the answer by path and mtime. Nothing here reads a
credential or talks to anything but the local disk.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from quickterm.statusline_chain import EVENT as CLAUDE_EVENT

__all__ = [
    "CLAUDE_EVENT", "ClaudeLimits", "CodexReader", "claude_usage_file", "codex_sessions_dir",
]

log = logging.getLogger(__name__)

CLAUDE_FILE = "claude-usage.json"
CLAUDE_FILE_MAX_BYTES = 64 * 1024
CLAUDE_WINDOWS = ("five_hour", "seven_day")
CODEX_WINDOWS = ("primary", "secondary")
CODEX_TAIL_BYTES = 256 * 1024
# A rollout that has not reported limits yet (a session that just started)
# falls back to the next newest, at most this many files deep.
CODEX_FILES_TRIED = 3


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _epoch(value: Any) -> int | None:
    """Epoch seconds from a number or an ISO 8601 string."""
    number = _number(value)
    if number is not None:
        return int(number) if number > 0 else None
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return None
        return int(parsed.timestamp())
    return None


def _percent(value: Any) -> float | None:
    number = _number(value)
    return None if number is None else round(max(0.0, number), 2)


def claude_usage_file() -> Path:
    """Where the latest Claude limits survive a restart. Blocking: creates
    the config folder."""
    from quickterm.config import config_dir

    return config_dir() / CLAUDE_FILE


def _stored_windows(value: Any) -> list[dict[str, Any]] | None:
    """The windows of a stored snapshot, checked like a report; None when
    the file holds anything else."""
    if not isinstance(value, list):
        return None
    windows = []
    for window in value:
        if not isinstance(window, dict) or window.get("id") not in CLAUDE_WINDOWS:
            return None
        used = _percent(window.get("used_percent"))
        resets_at = window.get("resets_at")
        if used is None or not (resets_at is None or _epoch(resets_at) is not None):
            return None
        windows.append({
            "id": window["id"],
            "used_percent": used,
            "resets_at": _epoch(resets_at) if resets_at is not None else None,
        })
    return windows or None


# "local:<config folder>" names which Claude config folder on this PC.
_ORIGIN = re.compile(r"^(local(:[^\x00-\x1f]{1,400})?|wsl:[A-Za-z0-9._-]{1,64}|ssh:\S{1,200})$")


def config_key(folder: Any) -> str | None:
    """A Claude config folder as origins compare it."""
    if not isinstance(folder, str) or not folder.strip() or len(folder) > 400:
        return None
    return os.path.normcase(os.path.normpath(folder.strip()))


def report_origin(info: Any, folder: Any = None) -> str:
    """Where a session's Claude runs, as ``ClaudeLimits`` keys it: its SSH
    destination, the WSL distribution its agent runs in, else this PC with
    the config folder the status line named (two accounts on one PC)."""
    host = getattr(info, "host", None)
    if isinstance(host, str) and host:
        return f"ssh:{host}"
    shell = getattr(info, "agent_shell", None)
    if isinstance(shell, str) and shell.startswith("wsl:"):
        return shell
    key = config_key(folder)
    return f"local:{key}" if key else "local"


class ClaudeLimits:
    """The latest Claude rate limits QuickTerm terminals reported, one
    snapshot per place they ran (``origin``: "local", "wsl:<distro>",
    "ssh:<destination>"), so two accounts in two places do not overwrite
    each other. ``usage_accounts`` joins each place to its account.

    With a ``path`` (``attach_file``), the snapshots are loaded from it and
    written back whenever a window's numbers or reset time changed. The
    status line reports many times a minute, so an unchanged report never
    writes; the stored ``updated_at`` is then the time of the last change.
    The file keeps the newest snapshot at its top level too, as 4.4 wrote it.
    """

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._latest: dict[str, dict[str, Any]] = {}
        self._path: Path | None = None
        # The windows the file holds (or held when loaded), per origin.
        self._saved: dict[str, list[dict[str, Any]]] = {}

    def attach_file(self, path: Path) -> None:
        """Load the stored snapshots from ``path`` and save there from now on.
        Blocking: reads the file. A missing or broken file starts empty."""
        loaded: dict[str, dict[str, Any]] = {}
        try:
            if path.stat().st_size <= CLAUDE_FILE_MAX_BYTES:
                data = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    origins = data.get("origins")
                    if not isinstance(origins, dict):
                        origins = {"local": data}
                    for origin, entry in origins.items():
                        if not isinstance(entry, dict) or not isinstance(origin, str) or not _ORIGIN.match(origin):
                            continue
                        windows = _stored_windows(entry.get("windows"))
                        updated = _number(entry.get("updated_at"))
                        if windows is not None and updated is not None:
                            loaded[origin] = {"windows": windows, "updated_at": int(updated)}
        except (OSError, ValueError, RecursionError):
            loaded = {}
        with self._lock:
            self._path = path
            self._saved = {origin: [dict(w) for w in entry["windows"]] for origin, entry in loaded.items()}
            for origin, entry in loaded.items():
                self._latest.setdefault(origin, entry)

    def record(self, rate_limits: Any, origin: str = "local") -> bool:
        """Keep ``rate_limits`` (the status line's object) for ``origin``.
        False, keeping the previous numbers, when it holds no usable window."""
        if not isinstance(rate_limits, dict) or not _ORIGIN.match(origin):
            return False
        windows = []
        for window_id in CLAUDE_WINDOWS:
            window = rate_limits.get(window_id)
            if not isinstance(window, dict):
                continue
            used = _percent(window.get("used_percentage"))
            if used is None:
                continue
            windows.append({
                "id": window_id,
                "used_percent": used,
                "resets_at": _epoch(window.get("resets_at")),
            })
        if not windows:
            return False
        with self._lock:
            self._latest[origin] = {"windows": windows, "updated_at": int(self._clock())}
        return True

    def _changed(self) -> bool:
        return any(entry["windows"] != self._saved.get(origin) for origin, entry in self._latest.items())

    def needs_save(self) -> bool:
        """Whether the windows differ from what the file holds."""
        with self._lock:
            return self._path is not None and bool(self._latest) and self._changed()

    def save(self) -> None:
        """Write the snapshots when they changed. Blocking: call it off the loop."""
        with self._write_lock:
            with self._lock:
                path = self._path
                if path is None or not self._latest or not self._changed():
                    return
                saved = {origin: [dict(w) for w in entry["windows"]] for origin, entry in self._latest.items()}
                # An unchanged origin keeps the time of its last change.
                origins = {
                    origin: {"windows": saved[origin], "updated_at": entry["updated_at"]}
                    for origin, entry in self._latest.items()
                }
                newest = max(origins.values(), key=lambda entry: entry["updated_at"])
                text = json.dumps({**newest, "origins": origins})
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f"{path.name}.", suffix=".tmp")
                try:
                    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                        handle.write(text + "\n")
                    os.replace(tmp, path)
                finally:
                    if os.path.exists(tmp):
                        os.unlink(tmp)
            except OSError:
                log.warning("could not store Claude usage in %s", path, exc_info=True)
                return
            with self._lock:
                self._saved = saved

    def snapshots(self) -> dict[str, dict[str, Any]]:
        """Every origin's latest snapshot."""
        with self._lock:
            return {
                origin: {"windows": [dict(w) for w in entry["windows"]], "updated_at": entry["updated_at"]}
                for origin, entry in self._latest.items()
            }

    def snapshot(self) -> dict[str, Any] | None:
        """The newest snapshot of any origin."""
        snapshots = self.snapshots()
        if not snapshots:
            return None
        return max(snapshots.values(), key=lambda entry: entry["updated_at"])


def codex_sessions_dir() -> Path:
    from quickterm.agents import codex_home

    return codex_home() / "sessions"


def _rollouts(root: Path) -> list[tuple[int, Path]]:
    """Every ``rollout-*.jsonl`` under ``root`` as (mtime_ns, path)."""
    found: list[tuple[int, Path]] = []
    pending = [root]
    while pending:
        folder = pending.pop()
        try:
            entries = list(os.scandir(folder))
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    pending.append(Path(entry.path))
                elif entry.name.startswith("rollout-") and entry.name.endswith(".jsonl"):
                    found.append((entry.stat().st_mtime_ns, Path(entry.path)))
            except OSError:
                continue
    return found


def _codex_window(window: Any, recorded: int | None) -> dict[str, Any] | None:
    if not isinstance(window, dict):
        return None
    used = _percent(window.get("used_percent"))
    if used is None:
        return None
    minutes = _number(window.get("window_minutes"))
    resets_at = _epoch(window.get("resets_at"))
    if resets_at is None and recorded is not None:
        # Older Codex builds wrote a countdown from the event instead.
        seconds = _number(window.get("resets_in_seconds"))
        resets_at = recorded + int(seconds) if seconds is not None else None
    return {
        "used_percent": used,
        "window_minutes": int(minutes) if minutes is not None and minutes > 0 else None,
        "resets_at": resets_at,
    }


def parse_rollout_line(line: bytes, fallback_time: int) -> dict[str, Any] | None:
    """The ``codex`` answer from one rollout line, or None when the line is
    not a ``token_count`` event carrying usable limits."""
    try:
        event = json.loads(line)
    except (ValueError, RecursionError):
        return None
    if not isinstance(event, dict):
        return None
    payload = event.get("payload")
    if not isinstance(payload, dict) or payload.get("type") != "token_count":
        return None
    limits = payload.get("rate_limits")
    if not isinstance(limits, dict):
        return None
    recorded = _epoch(event.get("timestamp"))
    windows = []
    for window_id in CODEX_WINDOWS:
        window = _codex_window(limits.get(window_id), recorded)
        if window is not None:
            windows.append({"id": window_id, **window})
    if not windows:
        return None
    plan = limits.get("plan_type")
    return {
        "windows": windows,
        "plan": plan if isinstance(plan, str) and plan else None,
        "updated_at": recorded if recorded is not None else fallback_time,
    }


def read_rollout_tail(path: Path, tail: int = CODEX_TAIL_BYTES) -> dict[str, Any] | None:
    """The last usable limits in the final ``tail`` bytes of ``path``."""
    try:
        with open(path, "rb") as handle:
            size = handle.seek(0, os.SEEK_END)
            start = max(0, size - tail)
            handle.seek(start)
            data = handle.read(tail)
            mtime = int(os.fstat(handle.fileno()).st_mtime)
    except OSError:
        return None
    lines = data.split(b"\n")
    if start > 0:
        # The first line was cut by the seek.
        lines = lines[1:]
    for line in reversed(lines):
        if b'"rate_limits"' not in line:
            continue
        found = parse_rollout_line(line, mtime)
        if found is not None:
            return found
    return None


class CodexReader:
    """Codex's limits from the newest rollout, re-read only when it changed."""

    def __init__(self, root: Callable[[], Path] = codex_sessions_dir) -> None:
        self._root = root
        self._lock = threading.Lock()
        self._cache: dict[tuple[str, int], dict[str, Any] | None] = {}

    def read(self) -> dict[str, Any] | None:
        """Blocking: walks the sessions folder and may read a file."""
        try:
            root = self._root()
        except (OSError, RuntimeError):
            return None
        newest = sorted(_rollouts(root), reverse=True)[:CODEX_FILES_TRIED]
        with self._lock:
            cache: dict[tuple[str, int], dict[str, Any] | None] = {}
            answer = None
            for mtime_ns, path in newest:
                key = (str(path), mtime_ns)
                found = self._cache[key] if key in self._cache else read_rollout_tail(path)
                cache[key] = found
                if found is not None:
                    answer = found
                    break
            self._cache = cache
        if answer is None:
            return None
        return {
            "windows": [dict(window) for window in answer["windows"]],
            "plan": answer["plan"],
            "updated_at": answer["updated_at"],
        }
