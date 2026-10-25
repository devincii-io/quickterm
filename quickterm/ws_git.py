"""Git for the right panel: the file tree's marks, search, changes and diffs,
staging and the commit/push/pull button.

Every git call goes through `ws_exec.run`, so the same code serves a
workspace on an SSH host once ws_exec reaches one. Paths in and out are
relative to the workspace folder (ws_files.clean_rel has checked them), and
git gets them with `--literal-pathspecs`, so a file called `*.py` stays one
file. Blocking: callers run these off the event loop.
"""

from __future__ import annotations

import posixpath
import re
import subprocess
from dataclasses import dataclass, field
from typing import Any

from quickterm import ws_exec, ws_files

GIT = "git"
# Read-only calls; a status in a large repository can take a few seconds.
READ_TIMEOUT = 20.0
# Commit runs the repository's hooks, which may run a test suite.
COMMIT_TIMEOUT = 300.0
NETWORK_TIMEOUT = 120.0
DIFF_LINE_CAP = 5_000
DIFF_BYTE_CAP = 4 * 1024 * 1024
OUTPUT_CAP = 20_000
SEARCH_RESULT_CAP = 200
SEARCH_TEXT_CAP = 300
SEARCH_FILE_CAP = 1024 * 1024
CHANGES_CAP = 5_000
# Paths the name search looks through.
NAMES_CAP = 100_000
PATHS_CAP = 2_000
MESSAGE_CAP = 20_000
QUERY_CAP = 200
# Untracked files whose lines are counted for the "+n" of a row.
UNTRACKED_COUNT_CAP = 500

# The panel polls git every few seconds, so nothing a repository's config
# names as a program may run on that path: no fsmonitor hook, no external
# diff (each diff call also passes --no-ext-diff and --no-textconv). Commit
# still runs the repository's hooks; that is what the user asked for.
_BASE = (
    "git", "-c", "core.quotepath=off", "-c", "color.ui=false", "-c", "core.fsmonitor=false",
    "-c", "diff.external=", "--no-optional-locks",
)
_NO_PROGRAMS = ["--no-ext-diff", "--no-textconv"]


class GitError(Exception):
    """A git failure a route answers with `status` and `message`."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


# Filter drivers (clean, smudge, process) are programs too, and status and
# diff run them on any file whose stat changed. A read lists the drivers
# first (`git config --get-regexp` runs nothing) and empties each one, so git
# reads the content unfiltered. Writes keep them: stage, discard, commit,
# push and pull must store and check out what the filters make, and a -c
# option reaches the hooks' own git calls through the environment.
_filter_cache: dict[tuple[str | None, str | None], list[str]] = {}


def _ws_key(ws: Any) -> tuple[str | None, str | None]:
    return getattr(ws, "host", None), getattr(ws, "path", None)


def refresh_filters(ws: Any) -> list[str]:
    """Read the filter drivers again; every public read starts with this."""
    try:
        result = ws_exec.run(ws, [*_BASE, "config", "--name-only", "--get-regexp", r"^filter\."],
                             timeout=READ_TIMEOUT, env=ws_exec.GIT_ENV)
        keys = result.stdout.split() if result.returncode == 0 else []
    except (OSError, subprocess.TimeoutExpired):
        keys = []
    names = sorted({key[len("filter."):key.rindex(".")] for key in keys
                    if key.startswith("filter.") and key.count(".") >= 2})
    off: list[str] = []
    for name in names:
        for variable, value in (("clean", ""), ("smudge", ""), ("process", ""), ("required", "false")):
            off += ["-c", f"filter.{name}.{variable}={value}"]
    _filter_cache[_ws_key(ws)] = off
    return off


def _no_filters(ws: Any) -> list[str]:
    cached = _filter_cache.get(_ws_key(ws))
    return cached if cached is not None else refresh_filters(ws)


def _git(ws: Any, args: list[str], *, timeout: float = READ_TIMEOUT,
         input: str | None = None, literal: bool = False,
         filters: bool = False) -> subprocess.CompletedProcess[str]:
    """`filters=True` for the writes that must run the repository's filter
    drivers; every other call reads with them emptied."""
    off = [] if filters else _no_filters(ws)
    argv = [*_BASE, *off, *(["--literal-pathspecs"] if literal else []), *args]
    try:
        return ws_exec.run(ws, argv, timeout=timeout, input=input, env=ws_exec.GIT_ENV)
    except ws_exec.RemoteUnavailable as exc:
        raise GitError(502, str(exc)) from exc
    except FileNotFoundError as exc:
        if ws_exec.exists(ws):
            raise GitError(503, "git is not installed") from exc
        raise GitError(404, "workspace folder not found") from exc
    except subprocess.TimeoutExpired as exc:
        raise GitError(504, f"git took longer than {int(timeout)} s") from exc


def _ok(ws: Any, args: list[str], **kwargs: Any) -> str:
    result = _git(ws, args, **kwargs)
    if result.returncode != 0:
        raise GitError(500, _trim((result.stderr or result.stdout).strip()) or "git failed")
    return result.stdout


def _trim(text: str, cap: int = OUTPUT_CAP) -> str:
    # The end of git's output says what went wrong; keep that part.
    return text if len(text) <= cap else "…" + text[-cap:]


def prefix(ws: Any) -> str:
    """The workspace folder's path inside its repository ("" at the top).
    GitError(409) when the folder is not in a repository."""
    result = _git(ws, ["rev-parse", "--show-prefix"])
    if result.returncode != 0:
        raise GitError(409, "not a git repository")
    return result.stdout.strip()


def _strip(path: str, pre: str) -> str | None:
    """A repository-relative path as the workspace sees it, or None when it
    lies outside the workspace folder."""
    if not pre:
        return path
    return path[len(pre):] if path.startswith(pre) else None


def _z(text: str) -> list[str]:
    return [part for part in text.split("\0") if part]


# --- the file tree ----------------------------------------------------------


@dataclass
class TreeMarks:
    ignored: set[str] = field(default_factory=set)  # paths, dirs end with "/"
    changed: dict[str, str] = field(default_factory=dict)  # path -> "M" | "A" | "?"


def tree_marks(ws: Any, rel: str) -> TreeMarks:
    """Git's view of one directory of the tree; empty outside a repository."""
    marks = TreeMarks()
    try:
        refresh_filters(ws)
        pre = prefix(ws)
    except GitError:
        return marks
    result = _git(ws, [
        "status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=normal",
        "--", rel or ".",
    ], literal=True)
    if result.returncode != 0:
        return marks
    items = _z(result.stdout)
    index = 0
    while index < len(items):
        item = items[index]
        index += 1
        code, path = item[:2], item[3:]
        if code[0] in "RC":
            index += 1  # the original path follows a rename
        local = _strip(path, pre)
        if local is None:
            continue
        if code == "!!":
            marks.ignored.add(local)
        elif code == "??":
            marks.changed[local] = "?"
        elif code[0] == "A":
            marks.changed[local] = "A"
        else:
            marks.changed[local] = "M"
    return marks


def entry_mark(marks: TreeMarks, path: str, is_dir: bool) -> tuple[bool, str | None]:
    """(ignored, git letter) for one tree entry at workspace path `path`."""
    slash = path + "/"
    ignored = path in marks.ignored or slash in marks.ignored or any(
        entry.endswith("/") and path.startswith(entry) for entry in marks.ignored
    )
    if not is_dir:
        letter = marks.changed.get(path)
        if letter is None and any(
            changed.endswith("/") and path.startswith(changed) and mark == "?"
            for changed, mark in marks.changed.items()
        ):
            letter = "?"
        return ignored, letter
    if marks.changed.get(slash) == "?":
        return ignored, "?"
    if any(changed.startswith(slash) for changed in marks.changed):
        return ignored, "M"
    return ignored, None


# --- search -----------------------------------------------------------------


def _check_query(query: Any) -> str:
    if not isinstance(query, str) or not query.strip():
        raise GitError(400, "q must be a non-empty string")
    if len(query) > QUERY_CAP or any(ord(char) < 32 for char in query):
        raise GitError(400, f"q must be at most {QUERY_CAP} printable characters")
    return query.strip()


def list_files(ws: Any) -> tuple[list[str], bool] | None:
    """Tracked and untracked (not ignored) files below the folder, or None
    outside a repository."""
    refresh_filters(ws)
    result = _git(ws, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    if result.returncode != 0:
        return None
    files = sorted(set(_z(result.stdout)))
    return files[:NAMES_CAP], len(files) > NAMES_CAP


def name_matches(paths: list[str], query: str) -> list[str]:
    """Paths holding every word of `query`, case-insensitive; matches in the
    file name first, then shorter paths."""
    words = query.casefold().split()
    hits = [path for path in paths if all(word in path.casefold() for word in words)]

    def rank(path: str) -> tuple[int, int, str]:
        name = posixpath.basename(path).casefold()
        return (0 if all(word in name for word in words) else 1, len(path), path)

    return sorted(hits, key=rank)


def search_names(ws: Any, query: Any) -> dict:
    text = _check_query(query)
    listed = list_files(ws)
    truncated = False
    if listed is None:
        paths, truncated = ws_files.folder_for(ws).walk()
    else:
        paths, truncated = listed
    hits = name_matches(paths, text)
    return {
        "results": [{"path": path, "line": None, "text": None} for path in hits[:SEARCH_RESULT_CAP]],
        "truncated": truncated or len(hits) > SEARCH_RESULT_CAP,
    }


def search_contents(ws: Any, query: Any) -> dict:
    text = _check_query(query)
    refresh_filters(ws)
    result = _git(ws, [
        "grep", "-z", "-n", "-I", "-F", "-i", "--untracked", "--max-count=20", "-e", text,
    ])
    if result.returncode in (0, 1):
        return _grep_results(result.stdout)
    return _walk_contents(ws, text)


def _grep_results(output: str) -> dict:
    results: list[dict] = []
    truncated = False
    for line in output.splitlines():
        parts = line.split("\0", 2)
        if len(parts) != 3 or not parts[1].isdigit():
            continue
        if len(results) >= SEARCH_RESULT_CAP:
            truncated = True
            break
        results.append({"path": parts[0], "line": int(parts[1]), "text": parts[2][:SEARCH_TEXT_CAP]})
    return {"results": results, "truncated": truncated}


def _walk_contents(ws: Any, query: str) -> dict:
    folder = ws_files.folder_for(ws)
    if isinstance(folder, ws_files.HostFolder):
        # One grep on the host, not one ssh per file.
        hits = folder.grep(query, SEARCH_RESULT_CAP + 1)
        return {
            "results": [{"path": path, "line": line, "text": text[:SEARCH_TEXT_CAP]}
                        for path, line, text in hits[:SEARCH_RESULT_CAP]],
            "truncated": len(hits) > SEARCH_RESULT_CAP,
        }
    paths, truncated = folder.walk()
    needle = query.casefold()
    results: list[dict] = []
    for path in paths:
        try:
            read = folder.read_file(path, SEARCH_FILE_CAP)
        except (OSError, ws_files.PathError):
            continue
        if read.data is None or ws_files.is_binary(read.data):
            continue
        for number, line in enumerate(ws_files.decode(read.data).splitlines(), 1):
            if needle in line.casefold():
                if len(results) >= SEARCH_RESULT_CAP:
                    return {"results": results, "truncated": True}
                results.append({"path": path, "line": number, "text": line[:SEARCH_TEXT_CAP]})
    return {"results": results, "truncated": truncated}


# --- changes ----------------------------------------------------------------


@dataclass
class _Status:
    branch: str | None = None
    upstream: str | None = None
    ahead: int = 0
    behind: int = 0
    files: list[dict] = field(default_factory=list)


def _parse_status(output: str, pre: str) -> _Status:
    status = _Status()
    items = output.split("\0")
    index = 0
    while index < len(items):
        item = items[index]
        index += 1
        if not item:
            continue
        if item.startswith("# "):
            key, _, value = item[2:].partition(" ")
            if key == "branch.head":
                status.branch = None if value == "(detached)" else value
            elif key == "branch.upstream":
                status.upstream = value
            elif key == "branch.ab":
                ahead, _, behind = value.partition(" ")
                status.ahead = abs(int(ahead or 0))
                status.behind = abs(int(behind or 0))
            continue
        kind = item[0]
        if kind == "?":
            path = _strip(item[2:], pre)
            if path is not None:
                status.files.append(_file(path, "untracked", "?"))
            continue
        if kind not in "12u":
            continue
        fields = item.split(" ", {"1": 8, "2": 9, "u": 10}[kind])
        xy, path = fields[1], fields[-1]
        if kind == "2":
            index += 1  # the original path of a rename
        local = _strip(path, pre)
        if local is None:
            continue
        if kind == "u":
            status.files.append(_file(local, "changes", "U"))
            continue
        if xy[0] != ".":
            status.files.append(_file(local, "staged", xy[0]))
        if xy[1] != ".":
            status.files.append(_file(local, "changes", xy[1]))
    return status


def _file(path: str, group: str, letter: str) -> dict:
    return {"path": path, "group": group, "status": letter, "added": None, "removed": None}


def _numstat(output: str) -> dict[str, tuple[int | None, int | None]]:
    """`git diff --numstat -z` as path -> (added, removed); binary is None."""
    counts: dict[str, tuple[int | None, int | None]] = {}
    items = output.split("\0")
    index = 0
    while index < len(items):
        head = items[index]
        index += 1
        if not head:
            continue
        added, _, rest = head.partition("\t")
        removed, _, path = rest.partition("\t")
        if not path:
            # A rename: the old and the new path follow as their own items.
            path = items[index + 1] if index + 1 < len(items) else ""
            index += 2
        counts[path] = (
            int(added) if added.isdigit() else None,
            int(removed) if removed.isdigit() else None,
        )
    return counts


def base_branch(ws: Any) -> str | None:
    """The branch the workspace's branch is measured against: origin's
    default branch, else origin/main, origin/master, main or master."""
    head = _git(ws, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"])
    if head.returncode == 0 and head.stdout.strip():
        return head.stdout.strip()
    for candidate in ("origin/main", "origin/master", "main", "master"):
        check = _git(ws, ["rev-parse", "--verify", "--quiet", f"{candidate}^{{commit}}"])
        if check.returncode == 0:
            return candidate
    return None


def changes(ws: Any) -> dict:
    refresh_filters(ws)
    pre = prefix(ws)
    output = _ok(ws, [
        "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--", ".",
    ], literal=True)
    status = _parse_status(output, pre)
    files = status.files[:CHANGES_CAP]
    unstaged = _numstat(_git(ws, ["diff", *_NO_PROGRAMS, "--numstat", "-z", "--relative"]).stdout)
    staged = _numstat(_git(ws, ["diff", *_NO_PROGRAMS, "--cached", "--numstat", "-z", "--relative"]).stdout)
    for entry in files:
        counts = {"staged": staged, "changes": unstaged}.get(entry["group"], {}).get(entry["path"])
        if counts:
            entry["added"], entry["removed"] = counts
    _count_untracked(ws, [entry for entry in files if entry["group"] == "untracked"])
    base = base_branch(ws)
    # On the local base branch itself nothing is "committed on branch".
    on_base = bool(base and base == status.branch)
    committed: list[dict] = []
    branch_added = 0
    merge_base = None
    if base and not on_base:
        found = _git(ws, ["merge-base", base, "HEAD"])
        merge_base = found.stdout.strip() if found.returncode == 0 else None
    if merge_base:
        numbers = _numstat(_git(ws, ["diff", *_NO_PROGRAMS, "--numstat", "-z", "--relative", merge_base, "HEAD"]).stdout)
        letters = _name_status(_git(ws, ["diff", *_NO_PROGRAMS, "--name-status", "-z", "--relative", merge_base, "HEAD"]).stdout)
        for path, letter in letters.items():
            added, removed = numbers.get(path, (None, None))
            committed.append({"path": path, "group": "committed", "status": letter,
                              "added": added, "removed": removed})
            branch_added += added or 0
    ahead, behind = status.ahead, status.behind
    if status.upstream is None and merge_base:
        counted = _git(ws, ["rev-list", "--count", f"{merge_base}..HEAD"])
        ahead = int(counted.stdout.strip()) if counted.stdout.strip().isdigit() else 0
        behind = 0
    return {
        "branch": status.branch,
        "upstream": status.upstream,
        "base": base,
        "ahead": ahead,
        "behind": behind,
        "branch_added": branch_added,
        "files": files + committed[:CHANGES_CAP],
        "truncated": len(status.files) > CHANGES_CAP or len(committed) > CHANGES_CAP,
    }


def _name_status(output: str) -> dict[str, str]:
    letters: dict[str, str] = {}
    items = output.split("\0")
    index = 0
    while index < len(items):
        code = items[index]
        index += 1
        if not code:
            continue
        if code[0] in "RC":
            path = items[index + 1] if index + 1 < len(items) else ""
            index += 2
        else:
            path = items[index] if index < len(items) else ""
            index += 1
        if path:
            letters[path] = code[0]
    return letters


def _count_untracked(ws: Any, entries: list[dict]) -> None:
    try:
        folder = ws_files.folder_for(ws)
    except FileNotFoundError:
        return
    if isinstance(folder, ws_files.HostFolder):
        # One ssh per file would make every refresh crawl; no "+n" there.
        return
    for entry in entries[:UNTRACKED_COUNT_CAP]:
        try:
            read = folder.read_file(entry["path"], ws_files.FILE_VIEW_CAP)
        except (OSError, ws_files.PathError):
            continue
        if read.data is None or ws_files.is_binary(read.data):
            continue
        text = ws_files.decode(read.data)
        entry["added"] = text.count("\n") + (0 if not text or text.endswith("\n") else 1)
        entry["removed"] = 0


# --- diff -------------------------------------------------------------------

DIFF_GROUPS = ("staged", "changes", "committed")
_DIFF = ["diff", *_NO_PROGRAMS, "--no-color", "--relative"]


def diff(ws: Any, rel: str, group: str) -> dict:
    if group not in DIFF_GROUPS:
        raise GitError(400, f"group must be one of {', '.join(DIFF_GROUPS)}")
    ws_files.check_paths(ws, [rel])
    refresh_filters(ws)
    prefix(ws)
    if group == "staged":
        text = _ok(ws, [*_DIFF, "--cached", "--", rel], literal=True)
    elif group == "changes":
        text = _ok(ws, [*_DIFF, "--", rel], literal=True)
        if not text and _untracked(ws, [rel]):
            result = _git(ws, ["diff", *_NO_PROGRAMS, "--no-color", "--no-index", "--", "/dev/null", rel])
            if result.returncode not in (0, 1):
                raise GitError(500, _trim(result.stderr.strip()) or "git diff failed")
            text = result.stdout
    else:
        base = base_branch(ws)
        found = _git(ws, ["merge-base", base, "HEAD"]) if base else None
        if found is None or found.returncode != 0:
            return {"text": "", "truncated": False, "lines": 0}
        text = _ok(ws, [*_DIFF, found.stdout.strip(), "HEAD", "--", rel], literal=True)
    lines = text.count("\n")
    if lines > DIFF_LINE_CAP or len(text) > DIFF_BYTE_CAP:
        return {"text": "", "truncated": True, "lines": lines}
    return {"text": text, "truncated": False, "lines": lines}


def _untracked(ws: Any, paths: list[str]) -> list[str]:
    result = _git(ws, ["ls-files", "-z", "--others", "--exclude-standard", "--", *paths], literal=True)
    return _z(result.stdout) if result.returncode == 0 else []


# --- stage, unstage, discard ------------------------------------------------

CHANGE_ACTIONS = ("stage", "unstage", "discard")


def _result(result: subprocess.CompletedProcess[str]) -> dict:
    output = "\n".join(part.strip() for part in (result.stdout, result.stderr) if part.strip())
    return {"ok": result.returncode == 0, "output": _trim(output)}


def change_files(ws: Any, action: str, paths: list[str]) -> dict:
    if action not in CHANGE_ACTIONS:
        raise GitError(400, f"action must be one of {', '.join(CHANGE_ACTIONS)}")
    if not paths:
        raise GitError(400, "paths must name at least one file")
    ws_files.check_paths(ws, paths)
    prefix(ws)
    if action == "stage":
        return _result(_git(ws, ["add", "-A", "--", *paths], literal=True, filters=True))
    if action == "unstage":
        has_head = _git(ws, ["rev-parse", "--verify", "--quiet", "HEAD"]).returncode == 0
        if has_head:
            return _result(_git(ws, ["restore", "--staged", "--", *paths], literal=True))
        return _result(_git(ws, ["rm", "--cached", "-r", "-q", "--", *paths], literal=True))
    untracked = set(_untracked(ws, paths))
    tracked = [path for path in paths if path not in untracked]
    outputs: list[str] = []
    ok = True
    if untracked:
        cleaned = _result(_git(ws, ["clean", "-f", "-q", "--", *sorted(untracked)], literal=True))
        ok = ok and cleaned["ok"]
        outputs.append(cleaned["output"])
    if tracked:
        restored = _result(_git(ws, ["restore", "--worktree", "--", *tracked], literal=True, filters=True))
        ok = ok and restored["ok"]
        outputs.append(restored["output"])
    return {"ok": ok, "output": _trim("\n".join(part for part in outputs if part))}


# --- commit, push, pull -----------------------------------------------------

GIT_ACTIONS = ("commit", "amend", "push", "pull", "publish")
_REMOTE_NAME = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._/-]{0,99}")


def check_message(message: Any, *, required: bool) -> str | None:
    if message is None or (isinstance(message, str) and not message.strip()):
        if required:
            raise GitError(400, "message must be a non-empty string")
        return None
    if not isinstance(message, str):
        raise GitError(400, "message must be a string")
    if len(message) > MESSAGE_CAP or "\0" in message:
        raise GitError(400, f"message must be at most {MESSAGE_CAP} characters, without NUL")
    return message


def git_action(ws: Any, action: str, message: Any = None) -> dict:
    if action not in GIT_ACTIONS:
        raise GitError(400, f"action must be one of {', '.join(GIT_ACTIONS)}")
    prefix(ws)
    if action == "commit":
        text = check_message(message, required=True)
        return _result(_git(ws, ["commit", "-F", "-"], input=text, timeout=COMMIT_TIMEOUT, filters=True))
    if action == "amend":
        text = check_message(message, required=False)
        if text is None:
            return _result(_git(ws, ["commit", "--amend", "--no-edit"], timeout=COMMIT_TIMEOUT, filters=True))
        return _result(_git(ws, ["commit", "--amend", "-F", "-"], input=text, timeout=COMMIT_TIMEOUT, filters=True))
    if action == "push":
        return _result(_git(ws, ["push"], timeout=NETWORK_TIMEOUT, filters=True))
    if action == "pull":
        return _result(_git(ws, ["pull", "--ff-only"], timeout=NETWORK_TIMEOUT, filters=True))
    if _git(ws, ["symbolic-ref", "-q", "HEAD"]).returncode != 0:
        return {"ok": False, "output": "Check out a branch to publish it; HEAD is detached."}
    remotes = _z(_git(ws, ["remote"]).stdout.replace("\n", "\0"))
    if not remotes:
        return {"ok": False, "output": "This repository has no remote to publish to."}
    remote = "origin" if "origin" in remotes else remotes[0]
    # The name comes from the repository's config: it never becomes an option.
    if not _REMOTE_NAME.fullmatch(remote):
        return {"ok": False, "output": f"The remote name {remote!r} is not one QuickTerm publishes to."}
    return _result(_git(ws, ["push", "-u", remote, "HEAD"], timeout=NETWORK_TIMEOUT, filters=True))
