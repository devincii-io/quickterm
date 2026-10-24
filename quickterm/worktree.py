"""Create a git worktree next to a workspace's repository.

Everything here blocks (it runs git), so the route calls it through
`asyncio.to_thread`. Every git call is a list argv with no shell, every value
from the request is validated first, and option parsing is ended with `--`
wherever git accepts it, so a branch or base can never become an option.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from quickterm import git_info

MAX_BRANCH_CHARS = 200
MAX_BASE_CHARS = 256
_QUICK_TIMEOUT = 15.0
# A checkout of a large repository writes every file; still bounded so a hung
# hook or a credential prompt cannot hold the request forever.
_ADD_TIMEOUT = 180.0

# The first match wins; the backend reports it and never runs it.
SETUP_COMMANDS = (
    ("uv.lock", "uv sync"),
    ("package-lock.json", "npm ci"),
    ("pnpm-lock.yaml", "pnpm install"),
    ("yarn.lock", "yarn install"),
    ("poetry.lock", "poetry install"),
)

# git check-ref-format's rules, minus the ones about `@{` expansion that
# --branch would otherwise apply: we never want "@{-1}" to mean anything.
_REF_FORBIDDEN = re.compile(r"[\x00-\x20\x7f~^:?*\[\\]")
# Variables that would point git at another repository than the one we found.
_GIT_LOCATION_ENV = (
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
)


class WorktreeError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass(frozen=True)
class Created:
    path: str
    setup: dict | None


def validate_branch(value: object) -> str:
    if not isinstance(value, str) or not value:
        raise WorktreeError(400, "branch must be a non-empty string")
    if len(value) > MAX_BRANCH_CHARS:
        raise WorktreeError(400, "branch name is too long")
    problem = None
    if value.startswith("-"):
        problem = "must not start with '-'"
    elif _REF_FORBIDDEN.search(value):
        problem = "contains whitespace, a control character or one of ~ ^ : ? * [ \\"
    elif ".." in value or "@{" in value or "//" in value or value == "@":
        problem = "contains '..', '@{', '//' or is '@'"
    elif value.startswith("/") or value.endswith(("/", ".")):
        problem = "must not start with '/' or end with '/' or '.'"
    elif any(part.startswith(".") or part.endswith(".lock") for part in value.split("/")):
        problem = "has a part that starts with '.' or ends with '.lock'"
    if problem:
        raise WorktreeError(400, f"invalid branch name: {problem}")
    return value


def validate_base(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise WorktreeError(400, "base must be a string or null")
    text = value.strip()
    if not text:
        return None
    if len(text) > MAX_BASE_CHARS:
        raise WorktreeError(400, "base is too long")
    if text.startswith("-") or re.search(r"[\x00-\x20\x7f]", text):
        raise WorktreeError(400, "invalid base: must not start with '-' or contain whitespace")
    return text


def branch_slug(branch: str) -> str:
    """Folder- and name-safe form of a branch: `feature/x` -> `feature-x`."""
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", branch)
    slug = re.sub(r"-{2,}", "-", slug).strip("-.")
    if not slug:
        raise WorktreeError(400, "branch name has no characters usable in a folder name")
    return slug


def detect_setup(folder: str | os.PathLike[str]) -> dict | None:
    base = Path(folder)
    for lockfile, command in SETUP_COMMANDS:
        try:
            if (base / lockfile).is_file():
                return {"command": command, "source": lockfile}
        except OSError:
            continue
    return None


def target_path(repo: git_info.Repo, slug: str) -> Path:
    main = repo.main_top
    return main.parent / f"{main.name}-{slug}"


def _git_env() -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if key not in _GIT_LOCATION_ENV}
    env["GIT_TERMINAL_PROMPT"] = "0"  # no credential prompt nobody can answer
    env["LC_ALL"] = "C"  # stable messages to match on
    return env


def _run(git: str, cwd: Path, args: list[str], timeout: float) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(
            [git, "-C", str(cwd), *args],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=timeout,
            env=_git_env(),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise WorktreeError(500, f"git {args[0]} timed out") from exc
    except OSError as exc:
        raise WorktreeError(500, f"could not run git: {exc}") from exc


def _message(result: subprocess.CompletedProcess[bytes]) -> str:
    text = result.stderr.decode("utf-8", "replace").strip()
    lines = [line for line in text.splitlines() if line.strip()]
    return lines[-1][:500] if lines else f"git exited with {result.returncode}"


def find_git() -> str:
    git = shutil.which("git")
    if not git:
        raise WorktreeError(400, "git was not found on PATH; install Git to create worktrees")
    return git


def create_worktree(folder: str | None, branch: str, base: str | None = None) -> Created:
    """`git worktree add -b <branch> <target> [<base>]` for the repo holding `folder`."""
    branch = validate_branch(branch)
    base = validate_base(base)
    slug = branch_slug(branch)
    repo = git_info.find_repo(folder)
    if repo is None:
        raise WorktreeError(400, "the workspace folder is not inside a git repository")
    git = find_git()
    if _run(git, repo.top, ["check-ref-format", "--branch", branch], _QUICK_TIMEOUT).returncode:
        raise WorktreeError(400, "invalid branch name: git refuses it")
    target = target_path(repo, slug)
    if os.path.lexists(target):
        raise WorktreeError(409, f"the folder already exists: {target}")
    exists = _run(git, repo.top, ["rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"],
                  _QUICK_TIMEOUT)
    if exists.returncode == 0:
        raise WorktreeError(409, f"the branch already exists: {branch}")
    if base is not None:
        known = _run(git, repo.top, ["rev-parse", "--verify", "--quiet", f"{base}^{{commit}}"],
                     _QUICK_TIMEOUT)
        if known.returncode:
            raise WorktreeError(400, f"unknown base: {base}")
    args = ["worktree", "add", "-b", branch, "--", str(target)]
    if base is not None:
        args.append(base)
    result = _run(git, repo.top, args, _ADD_TIMEOUT)
    if result.returncode:
        message = _message(result)
        # Lost a race with another request for the same branch or folder.
        if "already exists" in message:
            raise WorktreeError(409, message)
        raise WorktreeError(500, f"git worktree add failed: {message}")
    return Created(path=str(target), setup=detect_setup(target))
