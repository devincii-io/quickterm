"""Workspace board status: which column each saved workspace sits in.

Kept in `%APPDATA%/quickterm/board.json`, apart from the workspace files, so a
layout autosave can never write over it. A workspace without an entry is
"in-progress". Every change is a read-modify-write under one lock, written to
a temp file and swapped in, so two quick drags never lose one another.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path

from .config import config_dir, read_text, replace_file

STATUSES = ("todo", "in-progress", "in-review", "done")
DEFAULT_STATUS = "in-progress"
VERSION = 1

_LOCK = threading.Lock()


def board_path() -> Path:
    return config_dir() / "board.json"


def _read() -> dict[str, str]:
    """The stored entries; an absent or unreadable file is an empty board."""
    try:
        raw = json.loads(read_text(board_path()))
    except (FileNotFoundError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    status = raw.get("status") if isinstance(raw, dict) else None
    if not isinstance(status, dict):
        return {}
    return {
        name: value
        for name, value in status.items()
        if isinstance(name, str) and name and value in STATUSES
    }


def _write(status: dict[str, str]) -> None:
    path = board_path()
    text = json.dumps({"version": VERSION, "status": dict(sorted(status.items()))}, indent=2)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        replace_file(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def load_status() -> dict[str, str]:
    with _LOCK:
        return _read()


def set_status(name: str, status: str) -> None:
    if status not in STATUSES:
        raise ValueError(f"status must be one of {', '.join(STATUSES)}")
    with _LOCK:
        current = _read()
        if current.get(name) == status:
            return
        current[name] = status
        _write(current)


def rename_workspace(old: str, new: str) -> None:
    """Move `old`'s entry to `new`; nothing to move leaves `new` as it is."""
    if old == new:
        return
    with _LOCK:
        current = _read()
        if old not in current:
            return
        current[new] = current.pop(old)
        _write(current)


def forget_workspace(name: str) -> None:
    with _LOCK:
        current = _read()
        if name not in current:
            return
        del current[name]
        _write(current)
