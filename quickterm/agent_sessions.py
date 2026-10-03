"""Recent Claude Code and Codex sessions of one folder, for resuming by id.

Both stores are internal formats that change between releases, so everything
here is best effort: bounded reads, every parse guarded, and an unreadable
store lists nothing. The CLIs' own pickers remain the fallback.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

READ_CAP = 256 * 1024
# A rollout's first line carries the base instructions (tens of KB), but
# every field read here comes before them.
META_CAP = 8 * 1024
INDEX_CAP = 4 * 1024 * 1024
CODEX_SCAN_MAX = 2000
TITLE_MAX = 120
_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_DIGITS = re.compile(r"^\d+$")


def _iso(seconds: float) -> str:
    stamp = datetime.fromtimestamp(seconds, tz=timezone.utc)
    return stamp.isoformat(timespec="seconds").replace("+00:00", "Z")


def _title(text: str) -> str:
    collapsed = " ".join(text.split())
    return collapsed[:TITLE_MAX]


def _fallback_title(session_id: str) -> str:
    return f"session {session_id[:8]}"


def claude_root() -> Path:
    configured = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(configured) if configured else Path.home() / ".claude"


def claude_slug(cwd: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


def _claude_project_dir(cwd: str) -> Path | None:
    projects = claude_root() / "projects"
    slug = claude_slug(cwd)
    direct = projects / slug
    if direct.is_dir():
        return direct
    if os.name == "nt":
        # The drive letter's case depends on who spelled the path.
        folded = slug.casefold()
        for child in projects.iterdir():
            if child.name.casefold() == folded and child.is_dir():
                return child
    return None


def _read_bounded(path: Path) -> str:
    """The head and, for a big file, the tail: titles are rewritten later on."""
    with path.open("rb") as handle:
        size = os.fstat(handle.fileno()).st_size
        if size <= READ_CAP:
            data = handle.read(READ_CAP)
        else:
            half = READ_CAP // 2
            head = handle.read(half)
            handle.seek(size - half)
            data = head + b"\n" + handle.read(half)
    return data.decode("utf-8", errors="replace")


def _user_text(record: dict) -> str | None:
    if record.get("type") != "user" or record.get("isMeta"):
        return None
    message = record.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        parts = [
            part.get("text") for part in content
            if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str)
        ]
        text = " ".join(parts)
    else:
        return None
    text = text.strip()
    # Slash commands and their output are stored as tagged user lines.
    if not text or text.startswith("<"):
        return None
    return text


def _claude_title(path: Path) -> str | None:
    # A title the user chose (/rename, `--name`) beats the generated one, and
    # the last of each wins because both can be rewritten.
    custom_title = None
    ai_title = None
    first_user = None
    for line in _read_bounded(path).splitlines():
        try:
            record = json.loads(line)
        except (ValueError, RecursionError):
            continue
        if not isinstance(record, dict):
            continue
        kind = record.get("type")
        if kind == "custom-title" and isinstance(record.get("customTitle"), str) and record["customTitle"].strip():
            custom_title = record["customTitle"]
        elif kind == "ai-title" and isinstance(record.get("aiTitle"), str):
            ai_title = record["aiTitle"]
        elif first_user is None:
            first_user = _user_text(record)
    chosen = custom_title or ai_title or first_user
    return _title(chosen) if chosen else None


def claude_sessions(cwd: str, limit: int = 20) -> list[dict]:
    """`[{id, title, updated_at, cwd}]`, newest first."""
    try:
        folder = _claude_project_dir(cwd)
        if folder is None:
            return []
        files = []
        for path in folder.glob("*.jsonl"):
            if not _UUID.fullmatch(path.stem):
                continue
            try:
                files.append((path.stat().st_mtime, path))
            except OSError:
                continue
    except OSError:
        return []
    files.sort(key=lambda item: item[0], reverse=True)
    sessions = []
    for mtime, path in files[: max(0, limit)]:
        try:
            title = _claude_title(path)
        except OSError:
            title = None
        sessions.append({
            "id": path.stem,
            "title": title or _fallback_title(path.stem),
            "updated_at": _iso(mtime),
            "cwd": cwd,
        })
    return sessions


def codex_home() -> Path:
    configured = os.environ.get("CODEX_HOME")
    return Path(configured) if configured else Path.home() / ".codex"


def _same_folder(left: str, right: str) -> bool:
    def norm(value: str) -> str:
        if value.startswith("\\\\?\\"):
            value = value[4:]
        return os.path.normcase(os.path.normpath(value)).rstrip("\\/")

    return norm(left) == norm(right)


def _codex_index(home: Path) -> dict[str, dict]:
    """Thread names and update times by id; later lines win."""
    path = home / "session_index.jsonl"
    try:
        with path.open("rb") as handle:
            size = os.fstat(handle.fileno()).st_size
            if size > INDEX_CAP:
                handle.seek(size - INDEX_CAP)
            text = handle.read(INDEX_CAP).decode("utf-8", errors="replace")
    except OSError:
        return {}
    index: dict[str, dict] = {}
    for line in text.splitlines():
        try:
            record = json.loads(line)
        except (ValueError, RecursionError):
            continue
        if isinstance(record, dict) and isinstance(record.get("id"), str):
            index[record["id"]] = record
    return index


def _codex_stamp(value: object) -> str | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        seconds = value / 1000 if value > 1e12 else value
        try:
            return _iso(seconds)
        except (OverflowError, OSError, ValueError):
            return None
    return value if isinstance(value, str) and value else None


def _rollouts(home: Path):
    """Rollout files under sessions/YYYY/MM/DD, newest first, at most the cap."""
    count = 0
    root = home / "sessions"

    def children(folder: Path) -> list[Path]:
        try:
            return sorted(
                (p for p in folder.iterdir() if p.is_dir() and _DIGITS.match(p.name)),
                key=lambda p: p.name, reverse=True,
            )
        except OSError:
            return []

    for year in children(root):
        for month in children(year):
            for day in children(month):
                try:
                    names = sorted(day.glob("rollout-*.jsonl"), key=lambda p: p.name, reverse=True)
                except OSError:
                    continue
                for path in names:
                    if count >= CODEX_SCAN_MAX:
                        return
                    count += 1
                    yield path


def _session_meta(path: Path) -> dict | None:
    with path.open("rb") as handle:
        first = handle.readline(META_CAP).decode("utf-8", errors="replace")
    try:
        record = json.loads(first)
    except (ValueError, RecursionError):
        # The first line carries the instructions and is cut off by the cap;
        # every field read here comes before them, so take them from the raw
        # text. The first match is the payload's own field.
        found_id = re.search(r'"id"\s*:\s*"([^"]+)"', first)
        found_cwd = re.search(r'"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"', first)
        if not (found_id and found_cwd):
            return None
        try:
            cwd = json.loads(f'"{found_cwd.group(1)}"')
        except ValueError:
            return None
        meta: dict = {"id": found_id.group(1), "cwd": cwd}
        source = re.search(r'"source"\s*:\s*(?:"([^"]*)"|\{)', first)
        if source:
            meta["source"] = source.group(1) if source.group(1) is not None else {}
        if re.search(r'"parent_thread_id"\s*:\s*"', first):
            meta["parent_thread_id"] = True
        return meta
    if not isinstance(record, dict) or record.get("type") != "session_meta":
        return None
    payload = record.get("payload")
    return payload if isinstance(payload, dict) else None


# Sources of a conversation a person had. Subagent threads (source
# {"subagent": ...} with a parent_thread_id) and `codex exec` runs are hidden
# by Codex's own resume picker; a missing source is an older interactive one.
_INTERACTIVE_SOURCES = {"cli", "vscode"}


def _interactive(meta: dict) -> bool:
    if meta.get("parent_thread_id"):
        return False
    source = meta.get("source")
    return source is None or (isinstance(source, str) and source in _INTERACTIVE_SOURCES)


def codex_sessions(cwd: str, limit: int = 20) -> list[dict]:
    """`[{id, title, updated_at, cwd}]` of the folder, newest first."""
    home = codex_home()
    try:
        index = _codex_index(home)
        sessions = []
        for path in _rollouts(home):
            if len(sessions) >= limit:
                break
            try:
                meta = _session_meta(path)
            except OSError:
                continue
            if not meta or not _interactive(meta):
                continue
            session_id, folder = meta.get("id"), meta.get("cwd")
            if not isinstance(session_id, str) or not _UUID.fullmatch(session_id):
                continue
            if not isinstance(folder, str) or not _same_folder(folder, cwd):
                continue
            entry = index.get(session_id, {})
            name = entry.get("thread_name")
            updated = _codex_stamp(entry.get("updated_at")) or _codex_stamp(meta.get("timestamp"))
            if updated is None:
                try:
                    updated = _iso(path.stat().st_mtime)
                except OSError:
                    updated = ""
            sessions.append({
                "id": session_id,
                "title": _title(name) if isinstance(name, str) and name.strip() else _fallback_title(session_id),
                "updated_at": updated,
                "cwd": folder,
            })
    except OSError:
        return []
    sessions.sort(key=lambda item: item["updated_at"], reverse=True)
    return sessions


def sessions(kind: str, cwd: str, limit: int = 20) -> list[dict]:
    """Dispatch by agent type. Never raises for an unreadable store."""
    try:
        if kind == "claude-code":
            return claude_sessions(cwd, limit)
        if kind == "codex":
            return codex_sessions(cwd, limit)
    except Exception:
        # Internal formats: anything unexpected lists nothing rather than 500.
        return []
    raise ValueError(f"unknown agent type: {kind}")
