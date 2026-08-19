"""Directory-only listing for the in-app folder browser.

The folder picker used to be the native pywebview dialog and nothing else,
which meant it existed only in the installed desktop app and took focus out of
the page while it was open. This module backs a replacement that works in any
viewer: the frontend walks the filesystem itself, one level at a time.

Two rules shape everything here. Files are never reported, because a folder
picker has no business being a file browser. And no filesystem error may escape
as a traceback: a typed path bar means the caller sends garbage routinely, and
"C:\\System Volume Information" answers a plain listing with PermissionError.
Every failure becomes a `BrowseError` with a sentence a person can read.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path
from typing import Any

# A folder with 200k children would otherwise become a 20 MB JSON body that no
# picker can render. Deep enough that no real project tree hits it.
MAX_ENTRIES = 2000


class BrowseError(Exception):
    """A directory could not be listed. The message is shown to the user.

    ``missing`` separates "no such folder" (the path bar has a typo, or the
    drive is unplugged) from "this is not a folder I can read", because the
    route answers 404 for the first and 400 for the second, exactly as
    ``GET /api/file`` already does.
    """

    def __init__(self, message: str, *, missing: bool = False) -> None:
        super().__init__(message)
        self.missing = missing


def _expand(path: str) -> str:
    """`~` and `%VAR%` are things people paste into a path bar."""
    return os.path.expandvars(os.path.expanduser(path.strip()))


def _resolve_dir(path: str | os.PathLike[str]) -> Path:
    text = str(path)
    try:
        resolved = Path(_expand(text) if isinstance(path, str) else text).resolve()
    except (OSError, ValueError) as exc:
        raise BrowseError(f"not a usable path: {text}") from exc
    try:
        if not resolved.exists():
            raise BrowseError(f"no such folder: {resolved}", missing=True)
        if not resolved.is_dir():
            raise BrowseError(f"not a folder: {resolved}")
    except OSError as exc:
        # A path on a disconnected network share raises here rather than
        # answering False, and so does a reparse point pointing nowhere.
        raise BrowseError(f"cannot read {resolved}: {exc.strerror or exc}") from exc
    return resolved


def _is_hidden(entry: os.DirEntry) -> bool:
    """A dot prefix is the POSIX convention; Windows uses a file attribute.

    Honouring the Windows attribute is what keeps a home directory from listing
    the ACL-denied legacy profile junctions (``Cookies``, ``Anwendungsdaten``)
    and a drive root from listing ``$Recycle.Bin`` and
    ``System Volume Information``, none of which can be entered anyway.
    """
    if entry.name.startswith("."):
        return True
    if os.name != "nt":
        return False
    try:
        attrs = entry.stat(follow_symlinks=False).st_file_attributes
    except (OSError, AttributeError):
        return False
    return bool(attrs & stat.FILE_ATTRIBUTE_HIDDEN)


def _parent_of(base: Path) -> str | None:
    """``None`` at a root, so the caller knows to offer the root list instead.

    ``Path.parent`` is its own fixed point at ``C:\\``, at ``/`` and at a UNC
    share root ``\\\\server\\share``, which is what makes this a plain identity
    test rather than a platform special case.
    """
    parent = base.parent
    return None if parent == base else str(parent)


def _windows_drives() -> list[dict[str, str]]:
    """Mounted drive letters, from the kernel bitmask, never by probing.

    ``os.path.isdir("A:\\\\")`` on a letter with no media makes Windows spin up
    the device and can block for seconds; ``GetLogicalDrives`` is a single
    in-memory call that reports only letters that are actually mounted.
    """
    letters: list[str] = []
    try:
        import ctypes

        mask = int(ctypes.windll.kernel32.GetLogicalDrives())  # type: ignore[attr-defined]
    except Exception:
        mask = 0
    if mask:
        letters = [chr(ord("A") + bit) for bit in range(26) if mask & (1 << bit)]
    else:
        # No ctypes (an odd host, or a stubbed test): fall back to probing, and
        # accept the cost. A drive letter that errors is simply not offered.
        for bit in range(26):
            letter = chr(ord("A") + bit)
            try:
                if os.path.isdir(f"{letter}:\\"):
                    letters.append(letter)
            except OSError:
                continue
    return [{"name": f"{letter}:\\", "path": f"{letter}:\\"} for letter in letters]


def roots() -> list[dict[str, str]]:
    """Where the browser can jump when there is no parent left to climb to."""
    if os.name == "nt":
        return _windows_drives()
    home = str(Path.home())
    entries = [{"name": "/", "path": "/"}]
    if home and home != "/":
        entries.append({"name": "Home", "path": home})
    return entries


def list_dirs(path: str | None = None) -> dict[str, Any]:
    """One level of sub-directories of ``path`` (the home folder when absent).

    Raises ``BrowseError`` and nothing else. A ``.git`` child is reported as a
    flag on its parent row rather than as a row of its own: hidden entries are
    skipped, but "this folder is a repository" is the single most useful thing
    to know while picking a project folder.
    """
    base = _resolve_dir(path) if path and path.strip() else _resolve_dir(Path.home())
    try:
        with os.scandir(base) as scan:
            entries = list(scan)
    except PermissionError as exc:
        raise BrowseError(f"permission denied: {base}") from exc
    except OSError as exc:
        raise BrowseError(f"cannot read {base}: {exc.strerror or exc}") from exc

    dirs: list[dict[str, Any]] = []
    truncated = False
    for entry in entries:
        if len(dirs) >= MAX_ENTRIES:
            truncated = True
            break
        try:
            if _is_hidden(entry) or not entry.is_dir():
                continue
        except OSError:
            continue  # a junction or reparse point we are not allowed to follow
        child = Path(entry.path)
        try:
            is_git = (child / ".git").exists()
        except OSError:
            is_git = False
        dirs.append({"name": entry.name, "path": str(child), "is_git": is_git})
    dirs.sort(key=lambda d: d["name"].casefold())

    return {
        "path": str(base),
        # A drive root has an empty `Path.name`, and an unnamed row is unusable
        # as a heading, so fall back to the path itself.
        "name": base.name or str(base),
        "parent": _parent_of(base),
        "dirs": dirs,
        "roots": roots(),
        "truncated": truncated,
    }
