"""Workspace models + JSON persistence in %APPDATA%/quickterm/workspaces."""

from __future__ import annotations

import json
import re
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
    return _workspaces_dir() / f"{_safe_name(name)}.json"


def list_workspaces() -> list[str]:
    return sorted(p.stem for p in _workspaces_dir().glob("*.json"))


def load_workspace(name: str) -> Workspace | None:
    path = _path_for(name)
    if not path.exists():
        return None
    raw = json.loads(path.read_text(encoding="utf-8"))
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
    _path_for(ws.name).write_text(
        json.dumps(
            {
                "name": ws.name,
                "layout": ws.layout,
                "logo": ws.logo,
                "session_ids": sorted(set(ws.session_ids)),
            },
            indent=2,
        ),
        encoding="utf-8",
    )


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
