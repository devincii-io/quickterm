"""The pull request of a workspace's branch, through the GitHub CLI (`gh`).

The repository and the branch come from git in the workspace folder
(`ws_exec`); `gh` itself always runs on this machine with `-R`, so a
workspace on an SSH host needs no `gh` there. Blocking: callers run these off
the event loop.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
from types import SimpleNamespace
from typing import Any

from quickterm import ws_exec

GH = "gh"
TIMEOUT = 30.0
MERGE_TIMEOUT = 120.0
LOG_LINES = 200
OUTPUT_CAP = 20_000
PR_FIELDS = (
    "number,title,state,isDraft,url,mergeStateStatus,reviewDecision,headRefName,baseRefName,headRefOid,"
    "isCrossRepository,headRepositoryOwner,headRepository"
)
_REMOTE_NAME = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._/-]{0,99}")
_SHA = re.compile(r"[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?")
CHECK_FIELDS = "name,state,bucket,link,workflow,startedAt,completedAt"
MERGE_METHODS = ("merge", "squash", "rebase")
_METHODS_TTL = 300.0

_REMOTE_PATTERNS = (
    re.compile(r"^(?:https?|ssh|git)://(?:[^@/]+@)?(?P<host>[^/:]+)(?::\d+)?/(?P<path>.+?)(?:\.git)?/?$"),
    re.compile(r"^(?:[^@/]+@)?(?P<host>[^/:]+):(?P<path>[^/].+?)(?:\.git)?/?$"),
)
_RUN_LINK = re.compile(r"/actions/runs/(\d+)(?:/job/(\d+))?")
_OWNER_REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")

_methods_cache: dict[str, tuple[float, list[str]]] = {}
_methods_lock = threading.Lock()


class PrError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def repo_from_remote(url: str) -> str | None:
    """`host/owner/repo` for gh's `-R`, from a remote URL; None when the URL
    names no owner and repository."""
    text = url.strip()
    for pattern in _REMOTE_PATTERNS:
        match = pattern.match(text)
        if match:
            path = match.group("path").strip("/")
            if _OWNER_REPO.fullmatch(path):
                return f"{match.group('host')}/{path}"
    return None


def run_ids(link: str | None) -> tuple[str | None, str | None]:
    match = _RUN_LINK.search(link or "")
    return (match.group(1), match.group(2)) if match else (None, None)


def _here() -> Any:
    """Where gh runs: this machine, in the home folder."""
    return SimpleNamespace(name="", path=os.path.expanduser("~"), host=None)


def _gh(args: list[str], timeout: float = TIMEOUT) -> subprocess.CompletedProcess[str]:
    return ws_exec.run(_here(), [GH, *args], timeout=timeout, env={"GH_PROMPT_DISABLED": "1"})


def _git_line(ws: Any, args: list[str]) -> str | None:
    try:
        result = ws_exec.run(ws, ["git", *args], timeout=TIMEOUT, env=ws_exec.GIT_ENV)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    line = result.stdout.strip()
    return line if result.returncode == 0 and line else None


def _target(ws: Any) -> tuple[str | None, str | None]:
    """(gh repository, branch) of the workspace, either None when unknown."""
    url = _git_line(ws, ["remote", "get-url", "origin"])
    branch = _git_line(ws, ["rev-parse", "--abbrev-ref", "HEAD"])
    return (repo_from_remote(url) if url else None), (None if branch == "HEAD" else branch)


def _push_repo(ws: Any, branch: str) -> str | None:
    """`host/owner/name` of the repository `branch` pushes to: its push
    remote, else the default push remote, else its upstream remote, else
    origin. None when none of them names a GitHub-style repository."""
    remote = None
    for key in (f"branch.{branch}.pushRemote", "remote.pushDefault", f"branch.{branch}.remote"):
        value = _git_line(ws, ["config", "--get", key])
        if value and value != ".":
            remote = value
            break
    remote = remote or "origin"
    if not _REMOTE_NAME.fullmatch(remote):
        return None
    url = _git_line(ws, ["remote", "get-url", "--push", remote])
    return repo_from_remote(url) if url else None


def _owner_name(repo: str) -> tuple[str, str]:
    parts = repo.lower().split("/")
    return parts[-2], parts[-1]


def _ours(item: dict, repo: str, head: str | None) -> bool:
    """A PR whose head is the repository this branch pushes to. A fork's PR
    with the same branch name is someone else's, whatever its name."""
    if head is None or _owner_name(head) == _owner_name(repo):
        return item.get("isCrossRepository") is False
    owner = item.get("headRepositoryOwner") or {}
    source = item.get("headRepository") or {}
    if not isinstance(owner, dict) or not isinstance(source, dict):
        return False
    login, name = str(owner.get("login") or "").lower(), str(source.get("name") or "").lower()
    return item.get("isCrossRepository") is True and (login, name) == _owner_name(head)


def _unauthenticated(text: str) -> bool:
    lowered = text.lower()
    return "gh auth login" in lowered or "not logged" in lowered or "authentication" in lowered


def _empty(gh: str, reason: str | None = None) -> dict:
    return {"gh": gh, "pr": None, "checks": [], "reason": reason}


def _view(repo: str, branch: str, head: str | None = None) -> tuple[dict | None, str | None]:
    """(pr, gh state) where state is None when gh answered.

    `gh pr list --head` and not `gh pr view <branch>`: view reads an
    all-digit branch name as a PR number. `--head` matches the branch name
    in every fork too, so only a PR from `head` (the repository the branch
    pushes to) counts. The open PR wins over older ones of the same branch.
    """
    if branch.startswith("-"):
        return None, None
    try:
        result = _gh([
            "pr", "list", f"--head={branch}", "-R", repo, "--state", "all", "--limit", "20",
            "--json", PR_FIELDS,
        ])
    except FileNotFoundError:
        return None, "missing"
    if result.returncode != 0:
        if _unauthenticated(result.stderr):
            return None, "unauthenticated"
        return None, None
    try:
        data = json.loads(result.stdout)
    except ValueError:
        return None, None
    found = [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []
    found = [item for item in found if item.get("headRefName") == branch and _ours(item, repo, head)]
    if not found:
        return None, None
    return next((item for item in found if item.get("state") == "OPEN"), found[0]), None


def _checks(repo: str, number: int) -> list[dict]:
    result = _gh(["pr", "checks", str(number), "-R", repo, "--json", CHECK_FIELDS])
    # gh exits 8 while checks are pending and 1 when one failed; the JSON is
    # printed either way.
    try:
        data = json.loads(result.stdout or "[]")
    except ValueError:
        return []
    checks = []
    for item in data if isinstance(data, list) else []:
        if not isinstance(item, dict):
            continue
        run, job = run_ids(item.get("link"))
        checks.append({**item, "run_id": run, "job_id": job})
    return checks


def merge_methods(repo: str) -> list[str]:
    now = time.monotonic()
    with _methods_lock:
        cached = _methods_cache.get(repo)
        if cached and now - cached[0] < _METHODS_TTL:
            return cached[1]
    result = _gh([
        "repo", "view", repo, "--json", "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed",
    ])
    methods = list(MERGE_METHODS)
    if result.returncode == 0:
        try:
            data = json.loads(result.stdout)
            methods = [
                method for method, key in zip(
                    MERGE_METHODS, ("mergeCommitAllowed", "squashMergeAllowed", "rebaseMergeAllowed"),
                    strict=True,
                ) if data.get(key)
            ]
        except (ValueError, AttributeError):
            pass
    with _methods_lock:
        _methods_cache[repo] = (now, methods)
    return methods


def status(ws: Any) -> dict:
    if _git_line(ws, ["rev-parse", "--is-inside-work-tree"]) != "true":
        return _empty("ok", "not a git repository")
    repo, branch = _target(ws)
    if repo is None:
        return _empty("ok", "no GitHub remote named origin")
    if branch is None:
        return _empty("ok", "no branch checked out")
    try:
        pr, state = _view(repo, branch, _push_repo(ws, branch))
        if state is not None:
            return _empty(state)
        number = pr.get("number") if pr else None
        if not isinstance(number, int):
            return _empty("ok", "no pull request for this branch")
        pr["merge_methods"] = merge_methods(repo)
        return {"gh": "ok", "pr": pr, "checks": _checks(repo, number), "reason": None}
    except FileNotFoundError:
        return _empty("missing")
    except subprocess.TimeoutExpired:
        raise PrError(504, "gh took too long to answer") from None


def _tail(text: str, lines: int = LOG_LINES) -> str:
    return "\n".join(text.splitlines()[-lines:])


def log(ws: Any, run: Any, job: Any = None) -> dict:
    if not isinstance(run, str) or not run.isdigit() or len(run) > 20:
        raise PrError(400, "run must be a run id")
    if job is not None and (not isinstance(job, str) or not job.isdigit() or len(job) > 20):
        raise PrError(400, "job must be a job id")
    repo, _ = _target(ws)
    if repo is None:
        raise PrError(404, "no GitHub remote named origin")
    args = ["run", "view", run, "-R", repo, "--log-failed"]
    if job:
        args += ["--job", job]
    try:
        result = _gh(args, timeout=60.0)
    except FileNotFoundError:
        raise PrError(404, "gh is not installed") from None
    except subprocess.TimeoutExpired:
        raise PrError(504, "gh took too long to answer") from None
    if result.returncode != 0:
        raise PrError(502, (result.stderr.strip() or "gh could not read the log")[-OUTPUT_CAP:])
    return {"text": _tail(result.stdout)}


def merge(ws: Any, method: Any, number: Any = None, head_sha: Any = None) -> dict:
    """Merge the PR the user confirmed: `number` and `head_sha` are what the
    panel showed; a different PR on the branch, or a push since, is refused,
    and gh checks the head again (--match-head-commit)."""
    if method not in MERGE_METHODS:
        raise PrError(400, f"method must be one of {', '.join(MERGE_METHODS)}")
    if isinstance(number, bool) or not isinstance(number, int) or number <= 0:
        raise PrError(400, "number must be the pull request's number")
    if not isinstance(head_sha, str) or not _SHA.fullmatch(head_sha):
        raise PrError(400, "head_sha must be the pull request's head commit")
    repo, branch = _target(ws)
    if repo is None or branch is None:
        raise PrError(404, "no pull request for this branch")
    try:
        pr, state = _view(repo, branch, _push_repo(ws, branch))
        if state == "missing":
            raise PrError(404, "gh is not installed")
        if state == "unauthenticated":
            raise PrError(401, "gh is not signed in; run gh auth login")
        if pr is None or not isinstance(pr.get("number"), int):
            raise PrError(404, "no pull request for this branch")
        if pr.get("state") != "OPEN" or pr.get("isDraft"):
            raise PrError(409, "only an open pull request that is not a draft can be merged")
        if pr.get("mergeStateStatus") == "DIRTY":
            raise PrError(409, "the pull request has conflicts")
        if pr["number"] != number:
            raise PrError(409, f"this branch's pull request is now #{pr['number']}, not #{number}")
        if str(pr.get("headRefOid", "")).lower() != head_sha.lower():
            raise PrError(409, "the pull request has new commits since it was shown; look again")
        result = _gh([
            "pr", "merge", str(number), "-R", repo, f"--{method}", "--match-head-commit", head_sha,
        ], timeout=MERGE_TIMEOUT)
    except FileNotFoundError:
        raise PrError(404, "gh is not installed") from None
    except subprocess.TimeoutExpired:
        raise PrError(504, "gh took too long to answer") from None
    output = "\n".join(part.strip() for part in (result.stdout, result.stderr) if part.strip())
    return {"ok": result.returncode == 0, "output": output[-OUTPUT_CAP:]}
