"""Paths inside a workspace folder, and the right panel's direct file access.

Every path the right panel takes from a request is relative to the workspace
folder. `clean_rel` is the one gate: it normalises the path and refuses
anything absolute, anything that climbs out of the folder and anything that
names `.git`. `LocalFolder` then reads the disk for a local workspace and
checks once more after following links, so a symlink or a junction inside
the folder cannot lead out of it. `folder_for` is the one place that decides
how a workspace's files are read: `HostFolder` reads a workspace on an SSH
host through ws_exec, with the same checks done by the host's shell.
"""

from __future__ import annotations

import os
import posixpath
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from quickterm import ws_exec

MAX_PATH_CHARS = 4096
# The file view shows text up to this size and says "file too large" above.
FILE_VIEW_CAP = 2 * 1024 * 1024
# A NUL in the first 8 KB marks a file as binary, as git decides.
BINARY_SNIFF = 8 * 1024
# The name search without git, and the contents search without git, stop
# after this many entries.
WALK_CAP = 20_000
# One directory listing returns at most this many entries.
LIST_CAP = 5_000

IMAGE_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
}

# File name or extension to a highlight.js language of the common build.
_LANGUAGE_BY_NAME = {
    "makefile": "makefile",
    "gnumakefile": "makefile",
    "dockerfile": "bash",
    "cmakelists.txt": "makefile",
    ".gitignore": "bash",
    ".bashrc": "bash",
    ".zshrc": "bash",
    ".profile": "bash",
}
_LANGUAGE_BY_EXT = {
    ".py": "python", ".pyi": "python", ".pyw": "python",
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
    ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
    ".json": "json", ".jsonc": "json", ".json5": "json",
    ".html": "xml", ".htm": "xml", ".xml": "xml", ".svg": "xml", ".xaml": "xml",
    ".csproj": "xml", ".props": "xml", ".plist": "xml", ".vue": "xml",
    ".css": "css", ".scss": "scss", ".less": "less",
    ".md": "markdown", ".markdown": "markdown",
    ".yml": "yaml", ".yaml": "yaml",
    ".toml": "ini", ".ini": "ini", ".cfg": "ini", ".conf": "ini", ".editorconfig": "ini",
    ".sh": "bash", ".bash": "bash", ".zsh": "bash",
    ".ps1": "powershell", ".psm1": "powershell",
    ".bat": "dos", ".cmd": "dos",
    ".c": "c", ".h": "c",
    ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp", ".hxx": "cpp",
    ".cs": "csharp", ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin",
    ".kts": "kotlin", ".swift": "swift", ".m": "objectivec", ".mm": "objectivec",
    ".rb": "ruby", ".php": "php", ".pl": "perl", ".pm": "perl", ".lua": "lua",
    ".r": "r", ".sql": "sql", ".graphql": "graphql", ".gql": "graphql",
    ".diff": "diff", ".patch": "diff", ".vb": "vbnet", ".wat": "wasm", ".mk": "makefile",
}
# Languages the vendored common build does not carry fall back to none.
_COMMON_BUILD = frozenset({
    "bash", "c", "cpp", "csharp", "css", "diff", "go", "graphql", "ini", "java",
    "javascript", "json", "kotlin", "less", "lua", "makefile", "markdown", "objectivec",
    "perl", "php", "plaintext", "python", "r", "ruby", "rust", "scss", "shell", "sql",
    "swift", "typescript", "vbnet", "wasm", "xml", "yaml",
})

_DRIVE = re.compile(r"^[A-Za-z]:")
_SHORT_GIT = re.compile(r"git~\d+", re.IGNORECASE)


class PathError(ValueError):
    """A request path the right panel refuses (a 400)."""


class RemoteFolder(LookupError):
    """The workspace lives on another host; its files are not read here."""


def clean_rel(value: Any, *, allow_root: bool = True) -> str:
    """The normalised relative path of a request, "" for the folder itself.

    Refused: a non-string, control characters, an absolute path (leading
    slash or backslash, a drive letter, a UNC share), a colon anywhere
    (alternate data streams), a step out of the folder, and any part that is
    `.git`, also as Windows reads it (`.GIT`, `.git.`, `.git `).
    """
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise PathError("path must be a string")
    if len(value) > MAX_PATH_CHARS:
        raise PathError("path is too long")
    if any(ord(char) < 32 for char in value):
        raise PathError("path contains control characters")
    text = value.replace("\\", "/")
    if text.startswith("/") or _DRIVE.match(text):
        raise PathError("path must be relative to the workspace folder")
    if ":" in text:
        raise PathError("path must not contain ':'")
    parts: list[str] = []
    for part in text.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if not parts:
                raise PathError("path leaves the workspace folder")
            parts.pop()
            continue
        bare = part.rstrip(". ")
        if not bare:
            raise PathError("path has an invalid part")
        # GIT~1 is the 8.3 short name Windows gives .git; git itself and the
        # file system both resolve it to the repository's own folder.
        if bare.casefold() == ".git" or _SHORT_GIT.fullmatch(bare):
            raise PathError("paths inside .git are not shown")
        parts.append(part)
    rel = posixpath.join(*parts) if parts else ""
    if not rel and not allow_root:
        raise PathError("path must name a file")
    return rel


@dataclass(frozen=True)
class FileRead:
    size: int
    data: bytes | None  # None: larger than the cap, not read
    path: Path


@dataclass(frozen=True)
class Entry:
    name: str
    dir: bool


def _names_git(part: str) -> bool:
    bare = part.rstrip(". ")
    return bare.casefold() == ".git" or _SHORT_GIT.fullmatch(bare) is not None


def check_paths(ws: Any, rels: list[str]) -> None:
    """For a local workspace, resolve every path with links followed and
    refuse one that lands outside the folder or in .git. A host's paths are
    checked by clean_rel alone: a POSIX host has no short names, and the
    host script re-checks every file read."""
    if getattr(ws, "host", None):
        return
    folder_for(ws).check(rels)


def _norm(path: str) -> str:
    return os.path.normcase(os.path.normpath(path))


class LocalFolder:
    """Direct reads of a workspace folder on this machine."""

    def __init__(self, root: str) -> None:
        self.root = os.path.realpath(root)

    def resolve(self, rel: str) -> Path:
        """The real path of `rel`, refused when links lead out of the folder
        or into a `.git` folder."""
        full = os.path.realpath(os.path.join(self.root, *rel.split("/")) if rel else self.root)
        root = _norm(self.root)
        real = _norm(full)
        if real != root:
            prefix = root if root.endswith(os.sep) else root + os.sep
            if not real.startswith(prefix):
                raise PathError("path leaves the workspace folder")
            inner = real[len(prefix):]
            if any(_names_git(part) for part in inner.split(os.sep)):
                raise PathError("paths inside .git are not shown")
        return Path(full)

    def check(self, rels: list[str]) -> None:
        """Refuse any path that resolves outside the folder or into .git,
        before git is handed it (a path need not exist: discard of a deleted
        file)."""
        for rel in rels:
            self.resolve(rel)

    def list_dir(self, rel: str) -> list[Entry]:
        path = self.resolve(rel)
        if not path.is_dir():
            raise FileNotFoundError(rel or ".")
        entries: list[Entry] = []
        with os.scandir(path) as scan:
            for item in scan:
                if item.name.casefold() == ".git":
                    continue
                try:
                    is_dir = item.is_dir()
                except OSError:
                    is_dir = False
                entries.append(Entry(item.name, is_dir))
                if len(entries) > LIST_CAP:  # one past: the caller can tell
                    break
        return entries

    def read_file(self, rel: str, cap: int = FILE_VIEW_CAP) -> FileRead:
        path = self.resolve(rel)
        info = path.stat()
        if not stat.S_ISREG(info.st_mode):
            raise IsADirectoryError(rel)
        if info.st_size > cap:
            return FileRead(info.st_size, None, path)
        with open(path, "rb") as handle:
            data = handle.read(cap + 1)
        return FileRead(info.st_size, data[:cap], path)

    def walk(self, cap: int = WALK_CAP) -> tuple[list[str], bool]:
        """Every file below the folder as a relative path, `.git` skipped,
        links not followed; True when the cap cut it short."""
        found: list[str] = []
        seen = 0
        for top, dirs, files in os.walk(self.root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d.casefold() != ".git")
            rel_top = os.path.relpath(top, self.root)
            for name in sorted(files):
                seen += 1
                if seen > cap:
                    return found, True
                rel = name if rel_top == "." else f"{rel_top}/{name}"
                found.append(rel.replace(os.sep, "/"))
            seen += len(dirs)
            if seen > cap:
                return found, True
        return found, False


# Run on the host by HostFolder: resolve "$1" with links followed, refuse it
# outside the folder or inside .git (exit 4), missing (exit 3), then do "$2".
_HOST_SCRIPT = r"""
root=$(pwd -P) || exit 3
p=$(realpath -e -- "${1:-.}" 2>/dev/null) || exit 3
case "$p" in "$root") rel= ;; "$root"/*) rel=${p#"$root"/} ;; *) exit 4 ;; esac
case "/$rel/" in */.git/*) exit 4 ;; esac
case "$2" in
list)
  [ -d "$p" ] || exit 5
  for f in "$p"/* "$p"/.[!.]* "$p"/..?*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    n=${f##*/}
    [ "$n" = .git ] && continue
    if [ -d "$f" ]; then printf 'd/%s\0' "$n"; else printf 'f/%s\0' "$n"; fi
  done ;;
read)
  [ -f "$p" ] || exit 5
  s=$(wc -c < "$p" | tr -d ' ')
  printf '%s\n' "$s"
  [ "$s" -le "$3" ] && head -c "$3" "$p"
  exit 0 ;;
esac
"""


class HostFolder:
    """Reads of a workspace folder on its SSH host, through ws_exec."""

    def __init__(self, ws: Any) -> None:
        self.ws = ws

    def _run(self, rel: str, op: str, *extra: str, timeout: float = 20.0) -> str:
        result = ws_exec.run(self.ws, ["sh", "-c", _HOST_SCRIPT, "sh", rel or ".", op, *extra],
                             timeout=timeout)
        if result.returncode == 3:
            raise FileNotFoundError(rel or ".")
        if result.returncode == 4:
            raise PathError("path leaves the workspace folder")
        if result.returncode == 5:
            raise IsADirectoryError(rel) if op == "read" else NotADirectoryError(rel)
        if result.returncode != 0:
            raise OSError((result.stderr or "").strip()[-300:] or f"ssh exited with {result.returncode}")
        return result.stdout

    def resolve(self, rel: str) -> Path:
        raise RemoteFolder(getattr(self.ws, "host", ""))

    def list_dir(self, rel: str) -> list[Entry]:
        entries = []
        for item in self._run(rel, "list").split("\0"):
            if len(item) > 2 and item[1] == "/":
                entries.append(Entry(item[2:], item[0] == "d"))
            if len(entries) > LIST_CAP:  # one past: the caller can tell
                break
        return entries

    def read_file(self, rel: str, cap: int = FILE_VIEW_CAP) -> FileRead:
        size_line, _, body = self._run(rel, "read", str(cap)).partition("\n")
        size = int(size_line) if size_line.strip().isdigit() else 0
        if size > cap:
            return FileRead(size, None, Path(rel))
        return FileRead(size, body.encode("utf-8", "surrogateescape"), Path(rel))

    def walk(self, cap: int = WALK_CAP) -> tuple[list[str], bool]:
        result = ws_exec.run(self.ws, [
            "find", ".", "-name", ".git", "-prune", "-o", "-type", "f", "-print0",
        ], timeout=30.0)
        found = [item[2:] if item.startswith("./") else item for item in result.stdout.split("\0") if item]
        return sorted(found[:cap]), len(found) > cap

    def grep(self, query: str, cap: int) -> list[tuple[str, int, str]]:
        result = ws_exec.run(self.ws, [
            "grep", "-rnIiF", "--exclude-dir=.git", "-m", "50", "-e", query, ".",
        ], timeout=30.0)
        hits = []
        for line in result.stdout.splitlines():
            path, _, rest = line.partition(":")
            number, _, text = rest.partition(":")
            if number.isdigit():
                hits.append((path[2:] if path.startswith("./") else path, int(number), text))
            if len(hits) >= cap:
                break
        return hits


def folder_for(ws: Any) -> LocalFolder | HostFolder:
    """How the right panel reads `ws`'s files: directly on this computer,
    through ws_exec on an SSH host. FileNotFoundError when a local folder is
    gone."""
    if getattr(ws, "host", None):
        return HostFolder(ws)
    path = getattr(ws, "path", None)
    if not isinstance(path, str) or not os.path.isdir(path):
        raise FileNotFoundError("workspace folder not found")
    return LocalFolder(path)


def is_binary(data: bytes) -> bool:
    return b"\0" in data[:BINARY_SNIFF]


def image_type(rel: str) -> str | None:
    return IMAGE_TYPES.get(posixpath.splitext(rel)[1].lower())


def language_for(rel: str) -> str | None:
    name = posixpath.basename(rel).lower()
    language = _LANGUAGE_BY_NAME.get(name) or _LANGUAGE_BY_EXT.get(posixpath.splitext(name)[1])
    if language in ("powershell", "dos"):
        # Not in the common build; shell colours are close enough.
        language = "bash"
    return language if language in _COMMON_BUILD else None


def decode(data: bytes) -> str:
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    return data.decode("utf-8", errors="replace")
