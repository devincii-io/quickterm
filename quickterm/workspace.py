"""Workspace models + JSON persistence in %APPDATA%/quickterm/workspaces.

A workspace is a folder first and a layout second: `Workspace.path` is the
root directory every session in that workspace starts in, at the workspace's
location (`Workspace.host`): this PC, a WSL distribution, or an SSH host.
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

from .config import config_dir, protect_environment, read_text, replace_file, unprotect_value


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
    temporary: bool = False
    # The location: None is this PC, "wsl:<distro>" a WSL distribution, any
    # other value an SSH destination. Away from this PC `path` is POSIX.
    host: str | None = None
    # Variables every terminal of the workspace gets (decrypted in memory,
    # sealed with DPAPI in the file) and what a fresh view starts.
    env: dict[str, str] = field(default_factory=dict)
    startup: list[dict] = field(default_factory=list)


# --- workspace setup: environment and startup items --------------------------------

ENV_MAX_ENTRIES = 64
ENV_MAX_NAME_CHARS = 255
ENV_MAX_VALUE_BYTES = 8 * 1024
STARTUP_MAX_ITEMS = 8
STARTUP_KINDS = ("shell", "claude-code", "codex")
STARTUP_KEYS = ("kind", "name", "shell", "command", "agent_mode", "agent", "env")
COMMAND_MAX_CHARS = 4096
STARTUP_NAME_MAX_CHARS = 80
_ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def validate_env(value: object) -> dict[str, str]:
    """A workspace's or one terminal's own variables. ValueError says why not.

    QuickTerm's own names (`QUICKTERM_*`) and `WSLENV` are refused in any
    spelling: Windows reads names without case, and both are set per launch.
    """
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("env must be an object of NAME: value")
    if len(value) > ENV_MAX_ENTRIES:
        raise ValueError(f"env takes at most {ENV_MAX_ENTRIES} variables")
    seen: set[str] = set()
    out: dict[str, str] = {}
    for name, text in value.items():
        if not isinstance(name, str) or not _ENV_NAME.fullmatch(name):
            raise ValueError(f"not a variable name: {str(name)[:40]!r}")
        if len(name) > ENV_MAX_NAME_CHARS:
            raise ValueError(f"variable names cannot exceed {ENV_MAX_NAME_CHARS} characters")
        folded = name.upper()
        if folded.startswith("QUICKTERM_") or folded == "WSLENV":
            raise ValueError(f"{name} is set by QuickTerm")
        if folded in seen:
            raise ValueError(f"{name} is given twice")
        seen.add(folded)
        if not isinstance(text, str):
            raise ValueError(f"{name} must be text")
        if "\0" in text:
            raise ValueError(f"{name} must not contain NUL")
        if len(text.encode("utf-8", "surrogatepass")) > ENV_MAX_VALUE_BYTES:
            raise ValueError(f"{name} cannot exceed 8 KB")
        out[name] = text
    return out


def validate_command(value: object) -> str | None:
    """What a plain shell runs once before its prompt: one line of the
    shell's own language, or None."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("command must be a string")
    if any(char in value for char in ("\0", "\r", "\n")):
        raise ValueError("command must be one line")
    text = value.strip()
    if len(text) > COMMAND_MAX_CHARS:
        raise ValueError(f"command cannot exceed {COMMAND_MAX_CHARS} characters")
    return text or None


def _startup_item(value: object) -> dict:
    if not isinstance(value, dict):
        raise ValueError("each startup item must be an object")
    unknown = sorted(str(key) for key in value if key not in STARTUP_KEYS)
    if unknown:
        raise ValueError(f"unknown startup field: {unknown[0][:40]}")
    kind = value.get("kind")
    if kind not in STARTUP_KINDS:
        raise ValueError("startup kind must be shell, claude-code or codex")
    name = value.get("name")
    if name is not None and not isinstance(name, str):
        raise ValueError("startup name must be a string or null")
    name = (name or "").strip()[:STARTUP_NAME_MAX_CHARS] or None
    command = validate_command(value.get("command"))
    shell = value.get("shell") or None
    mode = value.get("agent_mode")
    options = value.get("agent")
    if kind == "shell":
        if mode is not None or options:
            raise ValueError("agent_mode and agent are for claude-code and codex")
        options = None
        if shell is not None:
            from . import shells

            # Which installed shell on this PC; null is the configured one.
            # In WSL or over SSH the location's own shell starts instead.
            shells.validate(shell)
            if shell == "cmd" and command is not None:
                shells.check_cmd_command(command)
    else:
        if command is not None:
            raise ValueError("command is for a shell")
        if shell is not None:
            raise ValueError("shell is for a shell item")
        from . import agents

        if mode is not None and (not isinstance(mode, str) or mode not in agents.MODES[kind]):
            raise ValueError(agents._mode_error(kind))
        if options is not None and not isinstance(options, dict):
            raise ValueError("agent options must be an object")
        options = dict(options) if options else None
        agents.validate(_AgentOptions(kind, mode, options or {}))
    env = validate_env(value.get("env"))
    return {
        "kind": kind, "name": name, "shell": shell, "command": command, "agent_mode": mode,
        "agent": options, "env": env or None,
    }


@dataclass(frozen=True)
class _AgentOptions:
    """The fields agents.validate reads, for one startup item."""

    terminal_type: str
    agent_mode: str | None
    agent: dict


def validate_startup(value: object) -> list[dict]:
    """The `startup` list, each item with all seven keys. ValueError says why not."""
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("startup must be a list")
    if len(value) > STARTUP_MAX_ITEMS:
        raise ValueError(f"startup takes at most {STARTUP_MAX_ITEMS} items")
    return [_startup_item(item) for item in value]


def _sealed_env(env: dict[str, str]) -> dict:
    return protect_environment(env)


def _opened_env(raw: object) -> dict[str, str]:
    """Stored variables as text. A value this user cannot decrypt (the file
    came from another account) is left out rather than failing the load."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for name, value in raw.items():
        try:
            out[name] = unprotect_value(value)
        except (TypeError, ValueError):
            continue
    return out


def _stored_setup(env: object, startup: object) -> tuple[dict[str, str], list[dict]]:
    """`env` and `startup` of a workspace file; a hand-edited mistake drops
    only the entry it is in."""
    # Entry by entry: one hand-edited bad name must not take the rest along
    # (the next autosave would write the file without them).
    clean_env: dict[str, str] = {}
    for name, value in _opened_env(env).items():
        if len(clean_env) >= ENV_MAX_ENTRIES:
            break
        try:
            clean_env.update(validate_env({**clean_env, name: value}))
        except ValueError:
            continue
    items = []
    for item in startup if isinstance(startup, list) else []:
        if isinstance(item, dict) and isinstance(item.get("env"), dict):
            item = {**item, "env": _opened_env(item["env"])}
        items.append(item)
    clean_startup: list[dict] = []
    for item in items[:STARTUP_MAX_ITEMS]:
        try:
            clean_startup.append(_startup_item(item))
        except ValueError:
            continue
    return clean_env, clean_startup


MAX_HOST_CHARS = 200
WSL_PREFIX = "wsl:"
# The distribution name rule of shells._DISTRO: wsl.exe takes it after -d.
_DISTRO = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_SSH_URI = re.compile(
    r"^ssh://(?:[^@/?#]+@)?(?:\[[^\]/]+\]|[^@/:?#\[\]]+)(?::(\d{1,5}))?$", re.IGNORECASE
)


def location_kind(host: str | None) -> str:
    """"local", "wsl" or "ssh" for a stored `Workspace.host`."""
    if not host:
        return "local"
    return "wsl" if host.startswith(WSL_PREFIX) else "ssh"


def wsl_distro(host: str | None) -> str | None:
    """The distribution of a WSL location, else None."""
    if host and host.startswith(WSL_PREFIX):
        return host[len(WSL_PREFIX):]
    return None


def normalize_host(value: object) -> str | None:
    """A stored location: None for this PC, "wsl:<distro>", or an SSH
    destination (`~/.ssh/config` alias, `[user@]host`, `ssh://[user@]host[:port]`).

    The destination reaches ssh as an argument, so a leading `-` (an option),
    whitespace and control characters are refused.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("host must be a string or null")
    text = value.strip()
    if not text:
        return None
    if len(text) > MAX_HOST_CHARS:
        raise ValueError(f"host must be at most {MAX_HOST_CHARS} characters")
    if any(ord(char) < 32 or ord(char) == 127 for char in text):
        raise ValueError("host must not contain control characters")
    if text.startswith(WSL_PREFIX):
        if not _DISTRO.fullmatch(text[len(WSL_PREFIX):]):
            raise ValueError("a WSL location is wsl:<distribution name>")
        return text
    if text.startswith("-"):
        raise ValueError("an SSH destination must not start with -")
    if any(char.isspace() for char in text):
        raise ValueError("an SSH destination must not contain spaces")
    if text.lower().startswith("ssh://"):
        match = _SSH_URI.fullmatch(text)
        if match is None or (match.group(1) and not 1 <= int(match.group(1)) <= 65535):
            raise ValueError("an SSH URL is ssh://[user@]host[:port]")
    elif text.startswith("@") or text.endswith("@"):
        raise ValueError("an SSH destination is a host alias or [user@]host")
    return text


def normalize_remote_root(value: object) -> str | None:
    """A folder in WSL or on an SSH host: an absolute POSIX path, `~` or `~/...`.

    Kept as typed apart from a trailing slash; it is never resolved against
    this computer. NUL, newlines and other control characters are refused,
    because the path goes into a remote shell command.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("workspace folder must be a string or null")
    text = value.strip()
    if not text:
        return None
    if len(text) > MAX_PATH_CHARS:
        raise ValueError("workspace folder path is too long")
    if any(ord(char) < 32 or ord(char) == 127 for char in text):
        raise ValueError("workspace folder path contains control characters")
    if not (text.startswith("/") or text == "~" or text.startswith("~/")):
        raise ValueError("a folder in WSL or on an SSH host must start with / or ~/")
    while len(text) > 1 and text.endswith("/"):
        text = text[:-1]
    return text


def normalize_folder(value: object, host: str | None) -> str | None:
    """`normalize_root` on this PC, `normalize_remote_root` in WSL or over SSH."""
    return normalize_remote_root(value) if host else normalize_root(value)


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
    # A hand-edited file must not make the workspace unloadable.
    try:
        host = normalize_host(raw.get("host"))
    except ValueError:
        host = None
    try:
        path = normalize_folder(raw.get("path"), host)
    except ValueError:
        path = None
    env, startup = _stored_setup(raw.get("env"), raw.get("startup"))
    return Workspace(
        name=raw.get("name", name),
        layout=raw.get("layout", {}),
        logo=raw.get("logo"),
        path=path,
        session_ids=[sid for sid in session_ids if isinstance(sid, str) and sid],
        temporary=raw.get("temporary") is True,
        host=host,
        env=env,
        startup=startup,
    )


def save_workspace(ws: Workspace) -> None:
    path = _path_for(ws.name)
    # Canonicalize on the way in so the stored document always holds an
    # absolute folder, whatever the caller passed (env vars, ~, a relative
    # path). A value we cannot make sense of is dropped, not persisted.
    try:
        host = normalize_host(getattr(ws, "host", None))
    except ValueError:
        host = None
    try:
        root = normalize_folder(ws.path, host)
    except ValueError:
        root = None
    document = {
        "name": ws.name,
        "layout": ws.layout,
        "logo": ws.logo,
        "path": root,
        "session_ids": sorted(set(ws.session_ids)),
        "temporary": ws.temporary,
    }
    if host:
        # Only a workspace away from this PC carries the key, so a local file
        # reads the same to an older build.
        document["host"] = host
    # The same for the setup: only a workspace that has one stores it.
    try:
        env = validate_env(getattr(ws, "env", None))
    except ValueError:
        env = {}
    try:
        startup = validate_startup(getattr(ws, "startup", None))
    except ValueError:
        startup = []
    if env:
        document["env"] = _sealed_env(env)
    if startup:
        document["startup"] = [
            {**item, "env": _sealed_env(item["env"]) if item["env"] else None}
            for item in startup
        ]
    text = json.dumps(document, indent=2)
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
