"""Workspace models + JSON persistence in %APPDATA%/quickterm/workspaces."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from .config import config_dir


@dataclass
class Workspace:
    name: str
    layout: dict
    logo: str | None = None  # per-workspace brand override (asset id)
    # Workspace ownership is wider than the visible layout: detaching a pane
    # removes it from `layout` but its live session remains here for reattach.
    session_ids: list[str] = field(default_factory=list)


def _workspaces_dir() -> Path:
    path = config_dir() / "workspaces"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _safe_name(name: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._ -]+", "_", name).strip().strip(".")
    return safe or "workspace"


def _path_for(name: str) -> Path:
    safe = _safe_name(name)
    reserved = safe.split(".", 1)[0].upper() in {
        "CON", "PRN", "AUX", "NUL",
        *(f"COM{i}" for i in range(1, 10)),
        *(f"LPT{i}" for i in range(1, 10)),
    }
    # NTFS filenames are case-insensitive, so "dev" and "Dev" resolved to the
    # same file and saving one silently destroyed the other's layout and
    # session ownership. Anything that is not already lowercase gets the
    # collision-resistant digest suffix.
    if safe != safe.lower():
        safe = f"{safe[:80]}--{hashlib.sha256(name.encode('utf-8', 'surrogatepass')).hexdigest()[:10]}"
        return _workspaces_dir() / f"{safe}.json"
    if safe != name or len(safe) > 80 or reserved:
        digest = hashlib.sha256(name.encode("utf-8", "surrogatepass")).hexdigest()[:10]
        safe = f"{safe[:80]}--{digest}"
    return _workspaces_dir() / f"{safe}.json"


def _legacy_path_for(name: str) -> Path:
    """Pre-2.1 path shape, retained only for reading/migrating old files."""
    return _workspaces_dir() / f"{_safe_name(name)}.json"


def _stored_name(path: Path) -> str | None:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    value = raw.get("name") if isinstance(raw, dict) else None
    return value if isinstance(value, str) and value else None


def list_workspaces() -> list[str]:
    # The display name lives in the document. Filenames may carry a collision-
    # resistant suffix for characters Windows cannot represent directly.
    return sorted({_stored_name(p) or p.stem for p in _workspaces_dir().glob("*.json")})


def load_workspace(name: str) -> Workspace | None:
    path = _path_for(name)
    if not path.exists():
        legacy = _legacy_path_for(name)
        if legacy != path and _stored_name(legacy) == name:
            path = legacy
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(raw, dict):
        return None
    session_ids = raw.get("session_ids")
    if not isinstance(session_ids, list):
        # Backward compatibility: older workspace files expressed ownership
        # only through panes in the saved layout.
        found: set[str] = set()
        _collect_session_ids(raw.get("layout", {}), found)
        session_ids = sorted(found)
    return Workspace(
        name=raw.get("name", name),
        layout=raw.get("layout", {}),
        logo=raw.get("logo"),
        session_ids=[sid for sid in session_ids if isinstance(sid, str) and sid],
    )


def save_workspace(ws: Workspace) -> None:
    path = _path_for(ws.name)
    text = json.dumps(
        {
            "name": ws.name,
            "layout": ws.layout,
            "logo": ws.logo,
            "session_ids": sorted(set(ws.session_ids)),
        },
        indent=2,
    )
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
        legacy = _legacy_path_for(ws.name)
        if legacy != path and _stored_name(legacy) == ws.name:
            try:
                legacy.unlink()
            except OSError:
                pass  # migration cleanup is best-effort; the new file is durable
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def _collect_session_ids(node: object, out: set[str]) -> None:
    if not isinstance(node, dict):
        return
    if node.get("type") == "split":
        for child in node.get("children", []):
            _collect_session_ids(child, out)
        return
    sid = node.get("session_id")
    if isinstance(sid, str) and sid:
        out.add(sid)


def delete_workspace(name: str) -> None:
    path = _path_for(name)
    if path.exists():
        path.unlink()
    legacy = _legacy_path_for(name)
    if legacy != path and _stored_name(legacy) == name:
        legacy.unlink()
