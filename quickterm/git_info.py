"""Git facts for a folder, read from `.git` and `HEAD` without starting git.

The sidebar asks for every workspace folder on each refresh, so this stays a
handful of small, bounded file reads. Nothing here writes, locks or runs a
process. Callers keep it off the event loop: a folder on a network share can
still stall a read.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

# A `.git` file, HEAD and commondir hold one short line each. Anything larger
# is not a git file, and reading it whole would be the only expensive step.
_READ_CAP = 4096
# A workspace may sit below its repository root, but never thirty-two levels.
_MAX_ASCENT = 32
_SHA = re.compile(r"[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?")
_BRANCH_PREFIX = "refs/heads/"


@dataclass(frozen=True)
class Repo:
    """Where a folder's repository lives on disk."""

    top: Path  # the checkout that contains the folder (holds the `.git` entry)
    git_dir: Path  # its git directory (`.git`, or `.git/worktrees/<name>`)
    worktree: bool  # a linked worktree, not the main checkout
    main_top: Path  # the main checkout's folder (== top when not a worktree)


def _read_small(path: Path) -> str | None:
    try:
        with open(path, "rb") as handle:
            raw = handle.read(_READ_CAP + 1)
    except OSError:
        return None
    if len(raw) > _READ_CAP:
        return None
    return raw.decode("utf-8", "replace").strip()


def _resolve(base: Path, value: str) -> Path:
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = base / candidate
    return Path(os.path.normpath(candidate))


def _repo_at(folder: Path) -> Repo | None:
    dot_git = folder / ".git"
    try:
        if dot_git.is_dir():
            if not (dot_git / "HEAD").is_file():
                return None
            return Repo(top=folder, git_dir=dot_git, worktree=False, main_top=folder)
        if not dot_git.is_file():
            return None
    except OSError:
        return None
    text = _read_small(dot_git)
    if not text or not text.startswith("gitdir:"):
        return None
    git_dir = _resolve(folder, text[len("gitdir:"):].strip())
    common = _read_small(git_dir / "commondir")
    if common is None:
        # A submodule's `.git` file points at `.git/modules/<name>`, which has
        # no commondir: its own repository, not a worktree of another.
        if not (git_dir / "HEAD").is_file():
            return None
        return Repo(top=folder, git_dir=git_dir, worktree=False, main_top=folder)
    common_dir = _resolve(git_dir, common)
    # A bare main repository has no checkout of its own; its folder is still
    # the closest thing to a main path the user can open.
    main_top = common_dir.parent if common_dir.name.lower() == ".git" else common_dir
    return Repo(top=folder, git_dir=git_dir, worktree=True, main_top=main_top)


def find_repo(path: str | os.PathLike[str] | None) -> Repo | None:
    """The repository that contains `path`, walking up a bounded number of levels."""
    if not path:
        return None
    try:
        current = Path(os.path.abspath(os.fspath(path)))
        if not current.is_dir():
            return None
    except (OSError, ValueError):
        return None
    for _ in range(_MAX_ASCENT):
        repo = _repo_at(current)
        if repo is not None:
            return repo
        parent = current.parent
        if parent == current:
            return None
        current = parent
    return None


def head_of(repo: Repo) -> tuple[str | None, str | None]:
    """(branch, short sha): the branch on a branch, the sha when detached."""
    text = _read_small(repo.git_dir / "HEAD")
    if not text:
        return None, None
    if text.startswith("ref:"):
        ref = text[len("ref:"):].strip()
        if ref.startswith(_BRANCH_PREFIX) and len(ref) > len(_BRANCH_PREFIX):
            return ref[len(_BRANCH_PREFIX):], None
        return None, None
    if _SHA.fullmatch(text):
        return None, text[:7].lower()
    return None, None


def git_info(path: str | os.PathLike[str] | None) -> dict | None:
    """The contract's `git_info` for a folder, or None outside a repository."""
    repo = find_repo(path)
    if repo is None:
        return None
    branch, head = head_of(repo)
    return {
        "branch": branch,
        "head": head,
        "worktree": repo.worktree,
        "main_path": str(repo.main_top) if repo.worktree else None,
    }


def git_info_many(paths: list[str]) -> dict[str, dict | None]:
    return {path: git_info(path) for path in paths}
