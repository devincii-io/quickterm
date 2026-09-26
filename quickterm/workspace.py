"""Workspace models + JSON persistence in %APPDATA%/quickterm/workspaces.

A workspace is a folder first and a layout second: `Workspace.path` is the
root directory every session in that workspace starts in. Profiles carry no
folder of their own, so the workspace is the only thing that places a terminal.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from .config import config_dir, read_text, replace_file


MAX_PATH_CHARS = 4096


@dataclass
class Workspace:
    name: str
    layout: dict
    logo: str | None = None  # per-workspace brand override (asset id)
    # Root folder for every session in this workspace. None means the sessions
    # fall back to default_cwd(), the user's home directory.
    path: str | None = None
    # Workspace ownership is wider than the visible layout: detaching a pane
    # removes it from `layout` but its live session remains here for reattach.
    session_ids: list[str] = field(default_factory=list)


def normalize_root(value: object) -> str | None:
    """Normalize a stored workspace root. Blank/None means "no folder"."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("workspace folder must be a string or null")
    text = value.strip()
    if not text:
        return None
    if len(text) > MAX_PATH_CHARS:
        raise ValueError("workspace folder path is too long")
    if any(ord(char) < 32 for char in text):
        raise ValueError("workspace folder path contains control characters")
    expanded = os.path.expandvars(os.path.expanduser(text))
    # A relative root would resolve against the server process cwd, which for
    # a frozen build is the install directory. Anchor it once, at the edge.
    return os.path.abspath(expanded)


def resolve_start_dir(root: str | None) -> str | None:
    """Existing directory a session should start in, or None if unusable.

    A missing root degrades to the caller's own fallback rather than failing
    the spawn.
    """
    if not root:
        return None
    base = Path(root)
    try:
        if not base.is_dir():
            return None
    except OSError:
        return None
    return str(base)


def root_exists(root: str | None) -> bool:
    if not root:
        return False
    try:
        return Path(root).is_dir()
    except OSError:
        return False


_NAMESPACE: str | None = None


def set_namespace(name: str | None) -> None:
    """Keep this process's workspaces in their own folder (None = the default).

    An elevated instance is a second backend with its own window registry, so
    sharing workspace files with the normal instance let both autosave one
    layout, and its scratch cleanup deleted the other's live scratch file.
    """
    global _NAMESPACE
    if name and not re.fullmatch(r"[A-Za-z0-9_-]+", name):
        raise ValueError(f"workspace namespace must be a plain folder name: {name!r}")
    _NAMESPACE = name or None


def _workspaces_dir() -> Path:
    path = config_dir() / "workspaces"
    if _NAMESPACE:
        path = path / _NAMESPACE
    path.mkdir(parents=True, exist_ok=True)
    return path


def _safe_name(name: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._ -]+", "_", name).strip().strip(".")
    return safe or "workspace"


_RESERVED_DEVICES = frozenset({
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
})


def _is_reserved(safe: str) -> bool:
    # Windows 10 maps "con.txt" and "CON .x" to the console device: only the
    # part before the first dot counts, and trailing spaces in it are ignored.
    return safe.split(".", 1)[0].rstrip(" ").upper() in _RESERVED_DEVICES


def _digest(name: str) -> str:
    return hashlib.sha256(name.encode("utf-8", "surrogatepass")).hexdigest()[:10]


def _path_for(name: str) -> Path:
    safe = _safe_name(name)
    if _is_reserved(safe):
        # A digest at the END left the device name in front of the first dot
        # ("con.txt--<digest>.json" is still CON on Windows 10), so every save
        # of such a workspace failed. The leading underscore moves it out of
        # the way; a typed "_con.txt" never gets a digest, so it cannot collide.
        return _workspaces_dir() / f"_{safe[:80]}--{_digest(name)}.json"
    # NTFS filenames are case-insensitive, so "dev" and "Dev" resolved to the
    # same file and saving one silently destroyed the other's layout and
    # session ownership. Anything that is not already lowercase gets the
    # collision-resistant digest suffix.
    if safe != safe.lower() or safe != name or len(safe) > 80:
        safe = f"{safe[:80]}--{_digest(name)}"
    return _workspaces_dir() / f"{safe}.json"


def _legacy_paths_for(name: str) -> list[Path]:
    """Older path shapes, retained only for reading and migrating old files.

    Pre-2.1 files were named by the sanitized name alone, and before the
    reserved-device fix a device name carried its digest at the end instead of
    an underscore in front. A legacy file only counts when it stores this exact
    name, because many original names share one sanitized form.
    """
    safe = _safe_name(name)
    folder = _workspaces_dir()
    candidates = [folder / f"{safe}.json"]
    if _is_reserved(safe):
        candidates.append(folder / f"{safe[:80]}--{_digest(name)}.json")
    current = _path_for(name)
    # On Windows 10 "con.json" IS the console: reading it blocks on the
    # hidden console's input while the workspace lock is held, and every
    # later autosave waits behind it. No such file can exist there anyway.
    return [
        path for path in candidates
        if path != current and not (_DEVICE_NAMES_TAKE_EXTENSIONS and _is_reserved(path.name))
    ]


# Windows 11 (build 22000) stopped mapping "con.txt" to the console; only the
# bare device names are reserved there. A module flag so tests can exercise
# both.
_DEVICE_NAMES_TAKE_EXTENSIONS = os.name == "nt" and sys.getwindowsversion().build < 22000


# Serializes this process's replaces against quarantine renames, so a listing
# that read a corrupt file can never move aside the valid document a save put
# in its place a moment later.
_FILE_LOCK = threading.Lock()
_QUARANTINED = re.compile(r"\.invalid-\d+$")


class _Corrupt(Exception):
    """The file was read, but it holds no workspace document."""


def _read_document(path: Path) -> dict:
    """Parse one workspace file. OSError propagates; bad content is _Corrupt."""
    try:
        raw = json.loads(read_text(path))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise _Corrupt(str(exc)) from exc
    if not isinstance(raw, dict):
        raise _Corrupt("not a JSON object")
    return raw


def _quarantine(path: Path) -> None:
    """Move a corrupt workspace file aside, the way load_config treats config.json.

    Listing it under its filename made a ghost: for a mixed-case name the stem
    already carries a digest, so opening or deleting it hashed the stem again
    and missed the file. A lowercase one was overwritten by the next save
    without a trace. The renamed file stays for the user to recover by hand.
    """
    if _QUARANTINED.search(path.stem):
        return  # already set aside once; never stack suffixes
    with _FILE_LOCK:
        try:
            _read_document(path)
        except _Corrupt:
            pass
        except OSError:
            return  # gone or locked: nothing to set aside right now
        else:
            return  # a save replaced it after our read; it is valid now
        try:
            replace_file(path, path.with_name(f"{path.stem}.invalid-{time.time_ns()}.json"))
        except OSError:
            pass  # best effort; the next read tries again


def _stored_name(path: Path) -> str | None:
    try:
        raw = _read_document(path)
    except (OSError, _Corrupt):
        return None
    value = raw.get("name")
    return value if isinstance(value, str) and value else None


def _listed_name(path: Path, raw: dict) -> str | None:
    """The name `path` answers to, or None when load_workspace would miss it.

    Whatever is listed must be openable and deletable under the listed name,
    so a document is shown only when its own name leads back to this file.
    """
    stored = raw.get("name")
    if not (isinstance(stored, str) and stored):
        # A nameless document is reachable only at the current path shape,
        # because a legacy path counts only for a file that stores the name.
        return path.stem if path == _path_for(path.stem) else None
    if path == _path_for(stored) or path in _legacy_paths_for(stored):
        return stored
    return None


def list_workspaces() -> list[str]:
    # The display name lives in the document. Filenames may carry a collision-
    # resistant suffix for characters Windows cannot represent directly.
    names: set[str] = set()
    for path in _workspaces_dir().glob("*.json"):
        try:
            raw = _read_document(path)
        except _Corrupt:
            _quarantine(path)
            continue
        except OSError:
            continue
        name = _listed_name(path, raw)
        if name is not None:
            names.add(name)
    return sorted(names)


def load_workspace(name: str) -> Workspace | None:
    path = _path_for(name)
    if not path.exists():
        for legacy in _legacy_paths_for(name):
            if _stored_name(legacy) == name:
                path = legacy
                break
    if not path.exists():
        return None
    try:
        raw = _read_document(path)
    except _Corrupt:
        _quarantine(path)
        return None
    except OSError:
        return None
    return _workspace_from(raw, name)


def _workspace_from(raw: dict, name: str) -> Workspace:
    session_ids = raw.get("session_ids")
    if not isinstance(session_ids, list):
        # Backward compatibility: older workspace files expressed ownership
        # only through panes in the saved layout.
        session_ids = sorted(layout_session_ids(raw.get("layout", {})))
    try:
        path = normalize_root(raw.get("path"))
    except ValueError:
        path = None  # a hand-edited file must not make the workspace unloadable
    return Workspace(
        name=raw.get("name", name),
        layout=raw.get("layout", {}),
        logo=raw.get("logo"),
        path=path,
        session_ids=[sid for sid in session_ids if isinstance(sid, str) and sid],
    )


def save_workspace(ws: Workspace) -> None:
    path = _path_for(ws.name)
    # Canonicalize on the way in so the stored document always holds an
    # absolute folder, whatever the caller passed (env vars, ~, a relative
    # path). A value we cannot make sense of is dropped, not persisted.
    try:
        root = normalize_root(ws.path)
    except ValueError:
        root = None
    text = json.dumps(
        {
            "name": ws.name,
            "layout": ws.layout,
            "logo": ws.logo,
            "path": root,
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
        with _FILE_LOCK:
            replace_file(temp_name, path)
        for legacy in _legacy_paths_for(ws.name):
            if _stored_name(legacy) == ws.name:
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


def layout_session_ids(node: object) -> set[str]:
    """Session ids of every pane in a saved layout tree (the one walker)."""
    found: set[str] = set()
    pending = [node]
    while pending:
        current = pending.pop()
        if not isinstance(current, dict):
            continue
        if current.get("type") == "split":
            children = current.get("children", [])
            if isinstance(children, list):
                pending.extend(children)
            continue
        sid = current.get("session_id")
        if isinstance(sid, str) and sid:
            found.add(sid)
    return found


def referenced_session_ids() -> set[str]:
    """Every session any saved workspace owns, through its layout or its list.

    This is the reaper's protection list, so it errs towards protecting: every
    readable document counts, even one no name leads back to, and a file that
    cannot be read right now raises instead of quietly dropping its sessions
    from the list (the reaper then skips that pass).
    """
    ids: set[str] = set()
    for path in _workspaces_dir().glob("*.json"):
        try:
            raw = _read_document(path)
        except (_Corrupt, FileNotFoundError):
            continue  # deleted since the glob, or nothing readable to protect
        ws = _workspace_from(raw, path.stem)
        ids.update(layout_session_ids(ws.layout))
        ids.update(ws.session_ids)
    return ids


def delete_workspace(name: str) -> None:
    path = _path_for(name)
    if path.exists():
        path.unlink()
    for legacy in _legacy_paths_for(name):
        if _stored_name(legacy) == name:
            legacy.unlink()
