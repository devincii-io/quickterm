"""The pull request of a workspace's branch, through the GitHub CLI (`gh`).

The repository and the branch come from git in the workspace folder
(`ws_exec`): two calls, one `git rev-parse` for the branch and one
`git config --get-regexp` for every remote, upstream, push remote and URL
rewrite, so an SSH or WSL workspace pays two round trips, not seven. The
rules git applies to those values (insteadOf, pushInsteadOf, the push
remote's order) run here. `gh` itself always runs on this machine with `-R`,
so a workspace on an SSH host needs no `gh` there. Blocking: callers run
these off the event loop.

A remote URL may carry a credential (`https://user:token@host/...`). It is
never put into a reason, an error or a log: messages name the remote and
its host only.
"""

from __future__ import annotations

import importlib
import json
import os
import re
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
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

# The reasons `status` gives when there is no PR to show. The board reads
# NO_PR as "gh was asked and found none".
NOT_A_REPO = "not a git repository"
NO_PR = "no pull request for this branch"
NO_BRANCH = "no branch checked out"
NO_COMMITS = "the branch has no commits yet"
NO_REMOTE = "this repository has no remote"
GITHUB_ONLY = "pull requests are shown for GitHub repositories"

# Everything the remote rules need, in one `git config` call. Section and
# variable names come back lower-case; remote, branch and URL names keep
# their case.
CONFIG_KEYS = (
    r"^(remote\..+\.(url|pushurl)|branch\..+\.(remote|pushremote)|remote\.pushdefault"
    r"|url\..+\.(insteadof|pushinsteadof))$"
)

GITHUB = "github.com"
# ssh.github.com is GitHub's SSH over port 443.
_GITHUB_HOSTS = {"github.com", "www.github.com", "ssh.github.com"}
# Forges whose pull requests gh cannot show.
_OTHER_FORGES = (
    "gitlab", "bitbucket", "dev.azure.com", "visualstudio.com", "azure.com", "codeberg", "gitea",
    "forgejo", "sr.ht", "sourcehut",
)
_SCHEME = re.compile(r"^([A-Za-z][A-Za-z0-9+.-]*)://(.*)$", re.DOTALL)
_DRIVE = re.compile(r"^[A-Za-z]:[\\/]")
_HOSTNAME = re.compile(r"^[a-z0-9_](?:[a-z0-9_.-]{0,252})$|^\[[0-9a-f:.]{2,45}\]$")
# Up to the last "@" before the path: a password may hold "@" itself.
_CREDENTIAL = re.compile(r"(://)[^/\s]*@")
_RUN_LINK = re.compile(r"/actions/runs/(\d+)(?:/job/(\d+))?")
_OWNER_REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")

# The ssh_config aliases of this computer and of each WSL distribution.
ALIAS_TTL = 60.0
_alias_cache: dict[str | None, tuple[float, dict[str, str]]] = {}
_alias_lock = threading.Lock()

_methods_cache: dict[str, tuple[float, list[str]]] = {}
_methods_lock = threading.Lock()


class PrError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


# --- remote URLs -------------------------------------------------------------


@dataclass(frozen=True)
class RemoteUrl:
    """What a remote URL names, without its credential. `host` is None for a
    folder; `ssh` says the host may be an ssh_config alias."""

    host: str | None
    path: str
    ssh: bool


def _clean_path(path: str) -> str:
    path = path.strip("/")
    if path.endswith(".git"):
        path = path[:-4]
    return path.strip("/")


def _host_of(authority: str) -> str | None:
    """The host of `[user[:password]@]host[:port]`, lower-case; None when
    it is not a host name. The credential is dropped first: everything up to
    the last `@`, so an `@` in a password cannot leak into the host."""
    hostport = authority.rpartition("@")[2]
    if hostport.startswith("["):
        end = hostport.find("]")
        host = hostport[:end + 1] if end > 0 else ""
    else:
        host = hostport.partition(":")[0]
    host = host.lower()
    return host if _HOSTNAME.fullmatch(host) else None


def parse_url(url: str) -> RemoteUrl | None:
    """A remote URL the way git reads it: `scheme://[user@]host[:port]/path`,
    scp-like `[user@]host:path`, or a folder (`file://`, a path, a drive
    letter). None when it is none of these."""
    text = url.strip()
    if not text or any(ord(char) < 32 for char in text):
        return None
    match = _SCHEME.match(text)
    if match:
        scheme, rest = match.group(1).lower(), match.group(2)
        if scheme == "file":
            return RemoteUrl(None, _clean_path(rest), ssh=False)
        authority, _, path = rest.partition("/")
        host = _host_of(authority)
        return RemoteUrl(host, _clean_path(path), ssh="ssh" in scheme) if host else None
    if _DRIVE.match(text) or text.startswith(("/", "\\", ".", "~")):
        return RemoteUrl(None, _clean_path(text), ssh=False)
    if text.startswith("["):
        end = text.find("]:")
        if end < 0:
            return None
        host = _host_of(text[1:end].rpartition("@")[2].partition(":")[0])
        return RemoteUrl(host, _clean_path(text[end + 2:]), ssh=True) if host else None
    colon, slash = text.find(":"), text.find("/")
    if colon > 0 and (slash < 0 or colon < slash):
        host = _host_of(text[:colon])
        return RemoteUrl(host, _clean_path(text[colon + 1:]), ssh=True) if host else None
    return RemoteUrl(None, _clean_path(text), ssh=False)


def _other_forge(host: str) -> bool:
    return any(name in host for name in _OTHER_FORGES)


def _github_host(host: str, *, alias: bool) -> str:
    """github.com for GitHub's own names and, for an ssh alias nobody could
    resolve, a name like `github-work` or `github.com-work`. Any other host
    stays as it is: a GitHub Enterprise server is gh's to reach."""
    if host in _GITHUB_HOSTS:
        return GITHUB
    if alias and "github" in host and ("." not in host or host.startswith("github.com")):
        return GITHUB
    return host


def repo_from_remote(url: str, resolve_alias: Callable[[str], str | None] | None = None) -> str | None:
    """`host/owner/repo` for gh's `-R`, from a remote URL; None when the URL
    names no GitHub-style owner and repository."""
    found, _ = _classify("origin", url, resolve_alias or (lambda _alias: None))
    return found


def _label(name: str) -> str:
    return name if _REMOTE_NAME.fullmatch(name) else "a remote"


def _classify(
    name: str, url: str | None, resolve_alias: Callable[[str], str | None],
) -> tuple[str | None, str | None]:
    """(gh repository, None) for a GitHub remote, else (None, why not)."""
    label = _label(name)
    parsed = parse_url(url) if url else None
    if parsed is None:
        return None, f"{label} has no URL QuickTerm can read"
    if parsed.host is None:
        return None, f"{label} is a folder, not a GitHub repository"
    host = parsed.host
    alias = parsed.ssh and host not in _GITHUB_HOSTS and not _other_forge(host)
    if alias:
        resolved = resolve_alias(host)
        if resolved:
            host, alias = resolved.lower(), False
    host = _github_host(host, alias=alias)
    if _other_forge(host):
        return None, f"{label} is on {host}; {GITHUB_ONLY}"
    if not _OWNER_REPO.fullmatch(parsed.path):
        if host == GITHUB:
            return None, f"{label} names no repository on {host}"
        return None, f"{label} is on {host}; {GITHUB_ONLY}"
    return f"{host}/{parsed.path}", None


# --- ssh_config aliases ----------------------------------------------------------


def _aliases(text: str, base_dir: Path, read: Callable[[Path], str | None] | None = None) -> dict[str, str]:
    ssh_config = importlib.import_module("quickterm.ssh_config")
    kwargs = {"read": read} if read is not None else {}
    entries = ssh_config.parse(text, base_dir=base_dir, **kwargs)
    return {entry.alias.lower(): entry.hostname for entry in entries if entry.hostname}


def _local_aliases() -> dict[str, str]:
    ssh_config = importlib.import_module("quickterm.ssh_config")
    path = Path(ssh_config.config_path())
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    return _aliases(text, path.parent)


def _wsl_aliases(ws: Any) -> dict[str, str]:
    """The distribution's own ~/.ssh/config: its git runs its ssh. An
    Include there names a Linux path, which is not followed."""
    try:
        result = ws_exec.run(ws, ["sh", "-c", 'cat "$HOME/.ssh/config" 2>/dev/null; exit 0'], timeout=10.0)
    except (OSError, subprocess.TimeoutExpired):
        return {}
    if result.returncode != 0 or not result.stdout:
        return {}
    return _aliases(result.stdout, Path("."), read=lambda _path: None)


def _alias_resolver(ws: Any) -> Callable[[str], str | None]:
    """HostName of an ssh alias where the workspace's git would read it.
    Only for this computer and WSL: an SSH host's ssh_config is on that
    host, and reading it would cost another round trip there."""
    host = getattr(ws, "host", None)
    kind = importlib.import_module("quickterm.workspace").location_kind(host)
    if kind == "ssh":
        return lambda _alias: None
    key = host if kind == "wsl" else None

    def resolve(alias: str) -> str | None:
        now = time.monotonic()
        with _alias_lock:
            cached = _alias_cache.get(key)
        if cached is None or now - cached[0] >= ALIAS_TTL:
            found = _wsl_aliases(ws) if kind == "wsl" else _local_aliases()
            cached = (now, found)
            with _alias_lock:
                _alias_cache[key] = cached
        return cached[1].get(alias.lower())

    return resolve


# --- what git says ------------------------------------------------------------------


class _Unavailable(Exception):
    """git could not be asked; `reason` says why, for the panel."""

    def __init__(self, why: str) -> None:
        super().__init__(why)
        self.reason = f"git could not be asked: {why}"


class _NotARepo(Exception):
    pass


def _scrub(text: str) -> str:
    return _CREDENTIAL.sub(r"\1", text)


def _said(result: subprocess.CompletedProcess[str]) -> str:
    """The last line git (or ssh, or wsl.exe) wrote, without credentials."""
    lines = [line.strip() for line in (result.stderr or "").splitlines() if line.strip()]
    if not lines:
        return f"exit code {result.returncode}"
    text = lines[-1]
    if "dubious ownership" in (result.stderr or ""):
        text = "git refuses this folder (dubious ownership; see git config safe.directory)"
    return _scrub(text)[:300]


def _git(ws: Any, args: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return ws_exec.run(ws, ["git", *args], timeout=TIMEOUT, env=ws_exec.GIT_ENV)
    except ws_exec.RemoteUnavailable as exc:
        raise _Unavailable(str(exc)) from None
    except FileNotFoundError as exc:
        missing = str(exc).startswith("workspace folder not found")
        raise _Unavailable("the workspace folder was not found" if missing else "git is not installed") from None
    except subprocess.TimeoutExpired:
        raise _Unavailable(f"git did not answer within {int(TIMEOUT)} s") from None
    except OSError as exc:
        raise _Unavailable(_scrub(str(exc.strerror or exc))) from None


@dataclass
class Facts:
    """A repository's branch and remotes, as two git calls read them."""

    branch: str | None = None
    unborn: bool = False
    urls: dict[str, list[str]] = field(default_factory=dict)
    push_urls: dict[str, list[str]] = field(default_factory=dict)
    values: dict[str, str] = field(default_factory=dict)
    instead_of: list[tuple[str, str]] = field(default_factory=list)
    push_instead_of: list[tuple[str, str]] = field(default_factory=list)

    @property
    def remotes(self) -> list[str]:
        return list(dict.fromkeys([*self.urls, *self.push_urls]))

    def _remote_value(self, key: str) -> str | None:
        value = self.values.get(key)
        return value if value and value != "." else None

    @property
    def upstream_remote(self) -> str | None:
        return self._remote_value(f"branch.{self.branch}.remote") if self.branch else None

    @property
    def push_remote(self) -> str:
        """The remote `git push` uses: the branch's pushRemote, else
        remote.pushDefault, else its upstream remote, else origin."""
        if self.branch:
            pushed = self._remote_value(f"branch.{self.branch}.pushremote")
            if pushed:
                return pushed
        return self._remote_value("remote.pushdefault") or self.upstream_remote or "origin"

    def fetch_url(self, name: str) -> str | None:
        urls = self.urls.get(name)
        return _rewrite(urls[0], self.instead_of) if urls else None

    def push_url(self, name: str) -> str | None:
        """As git computes it: an explicit pushurl (insteadOf applies), else
        the url through pushInsteadOf, else through insteadOf."""
        pushed = self.push_urls.get(name)
        if pushed:
            return _rewrite(pushed[0], self.instead_of)
        urls = self.urls.get(name)
        if not urls:
            return None
        rewritten = _rewrite(urls[0], self.push_instead_of, keep=False)
        return rewritten if rewritten is not None else _rewrite(urls[0], self.instead_of)


def _rewrite(url: str, rules: list[tuple[str, str]], *, keep: bool = True) -> str | None:
    """git's url.<base>.insteadOf: the longest matching prefix wins. With
    `keep=False`, None when no rule matched."""
    best = max((rule for rule in rules if url.startswith(rule[0])), key=lambda rule: len(rule[0]), default=None)
    if best is None:
        return url if keep else None
    return best[1] + url[len(best[0]):]


def parse_config(output: str) -> Facts:
    """`git config --null --get-regexp CONFIG_KEYS` as Facts (no branch)."""
    facts = Facts()
    for entry in output.split("\0"):
        if not entry:
            continue
        key, _, value = entry.partition("\n")
        if key.startswith("remote.") and key.endswith(".pushurl"):
            facts.push_urls.setdefault(key[7:-8], []).append(value)
        elif key.startswith("remote.") and key.endswith(".url"):
            facts.urls.setdefault(key[7:-4], []).append(value)
        elif key.startswith("url.") and key.endswith(".pushinsteadof"):
            facts.push_instead_of.append((value, key[4:-14]))
        elif key.startswith("url.") and key.endswith(".insteadof"):
            facts.instead_of.append((value, key[4:-10]))
        else:
            # Single-valued keys: the last one git reads wins.
            facts.values[key] = value
    return facts


def read_facts(ws: Any) -> Facts:
    """The branch and the remotes in two git calls. _NotARepo outside a work
    tree, _Unavailable when git could not be asked."""
    head = _git(ws, ["rev-parse", "--is-inside-work-tree", "--symbolic-full-name", "HEAD"])
    lines = head.stdout.splitlines()
    if not lines or lines[0].strip() != "true":
        if head.returncode != 0 and "not a git repository" not in (head.stderr or "").lower():
            raise _Unavailable(_said(head))
        raise _NotARepo
    config = _git(ws, ["config", "--null", "--get-regexp", CONFIG_KEYS])
    # 1: no key matched, which is a repository without remotes.
    if config.returncode not in (0, 1):
        raise _Unavailable(_said(config))
    facts = parse_config(config.stdout if config.returncode == 0 else "")
    ref = lines[1].strip() if len(lines) > 1 else ""
    if head.returncode != 0:
        # A branch without commits: rev-parse knows the work tree, not HEAD.
        facts.unborn = True
    elif ref.startswith("refs/heads/"):
        facts.branch = ref[len("refs/heads/"):]
    return facts


@dataclass
class Target:
    repo: str | None  # where the PR lives, host/owner/name
    head: str | None  # the repository the branch pushes to
    why: str | None  # why there is no repo


def choose(facts: Facts, resolve_alias: Callable[[str], str | None]) -> Target:
    """The GitHub repository to ask: the branch's upstream remote, else
    origin, else upstream, else the push remote, else the first other
    remote that is a GitHub repository. When none is, why the first of
    those is not."""
    remotes = facts.remotes
    if not remotes:
        return Target(None, None, NO_REMOTE)
    order = [facts.upstream_remote, "origin", "upstream", facts.push_remote, *remotes]
    candidates = [name for name in dict.fromkeys(order) if name in remotes]
    first_why = None
    repo = None
    for name in candidates:
        found, why = _classify(name, facts.fetch_url(name) or facts.push_url(name), resolve_alias)
        if found:
            repo = found
            break
        first_why = first_why or why
    if repo is None:
        return Target(None, None, first_why)
    # A fork (`gh repo fork`): origin is yours, `upstream` the parent, and a
    # pull request goes into the parent, so ask there as gh does.
    if "upstream" in remotes:
        parent, _ = _classify("upstream", facts.fetch_url("upstream") or facts.push_url("upstream"), resolve_alias)
        if parent and parent.lower() != repo.lower():
            repo = parent
    push = facts.push_remote
    head = None
    if push in remotes:
        head, _ = _classify(push, facts.push_url(push), resolve_alias)
    return Target(repo, head, None)


def _target(ws: Any) -> tuple[Target, Facts] | str:
    """(target, facts), or the reason there is none."""
    try:
        facts = read_facts(ws)
    except _NotARepo:
        return NOT_A_REPO
    except _Unavailable as exc:
        return exc.reason
    return choose(facts, _alias_resolver(ws)), facts


# --- gh ------------------------------------------------------------------------------


def run_ids(link: str | None) -> tuple[str | None, str | None]:
    match = _RUN_LINK.search(link or "")
    return (match.group(1), match.group(2)) if match else (None, None)


def _here() -> Any:
    """Where gh runs: this machine, in the home folder."""
    return SimpleNamespace(name="", path=os.path.expanduser("~"), host=None)


def _gh(args: list[str], timeout: float = TIMEOUT) -> subprocess.CompletedProcess[str]:
    return ws_exec.run(_here(), [GH, *args], timeout=timeout, env={"GH_PROMPT_DISABLED": "1"})


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


def _view(repo: str, branch: str, head: str | None = None) -> tuple[dict | None, str | None, str | None]:
    """(pr, gh state, reason): state is None when gh answered, reason says
    why gh could not when it failed for another cause.

    `gh pr list --head` and not `gh pr view <branch>`: view reads an
    all-digit branch name as a PR number. `--head` matches the branch name
    in every fork too, so only a PR from `head` (the repository the branch
    pushes to) counts. The open PR wins over older ones of the same branch.
    """
    if branch.startswith("-"):
        return None, None, None
    try:
        result = _gh([
            "pr", "list", f"--head={branch}", "-R", repo, "--state", "all", "--limit", "20",
            "--json", PR_FIELDS,
        ])
    except FileNotFoundError:
        return None, "missing", None
    if result.returncode != 0:
        if _unauthenticated(result.stderr):
            return None, "unauthenticated", None
        return None, None, f"gh could not ask {repo.split('/')[0]}: {_said(result)}"
    try:
        data = json.loads(result.stdout)
    except ValueError:
        return None, None, None
    found = [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []
    found = [item for item in found if item.get("headRefName") == branch and _ours(item, repo, head)]
    if not found:
        return None, None, None
    return next((item for item in found if item.get("state") == "OPEN"), found[0]), None, None


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
    found = _target(ws)
    if isinstance(found, str):
        return _empty("ok", found)
    target, facts = found
    if target.repo is None:
        return _empty("ok", target.why)
    if facts.branch is None:
        return _empty("ok", NO_COMMITS if facts.unborn else NO_BRANCH)
    try:
        pr, state, reason = _view(target.repo, facts.branch, target.head)
        if state is not None:
            return _empty(state)
        number = pr.get("number") if pr else None
        if not isinstance(number, int):
            return _empty("ok", reason or NO_PR)
        pr["merge_methods"] = merge_methods(target.repo)
        return {"gh": "ok", "pr": pr, "checks": _checks(target.repo, number), "reason": None}
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
    found = _target(ws)
    if isinstance(found, str):
        raise PrError(404, found)
    target, _ = found
    if target.repo is None:
        raise PrError(404, target.why or NO_REMOTE)
    args = ["run", "view", run, "-R", target.repo, "--log-failed"]
    if job:
        args += ["--job", job]
    try:
        result = _gh(args, timeout=60.0)
    except FileNotFoundError:
        raise PrError(404, "gh is not installed") from None
    except subprocess.TimeoutExpired:
        raise PrError(504, "gh took too long to answer") from None
    if result.returncode != 0:
        raise PrError(502, _scrub(result.stderr.strip() or "gh could not read the log")[-OUTPUT_CAP:])
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
    found = _target(ws)
    if isinstance(found, str) or found[0].repo is None or found[1].branch is None:
        raise PrError(404, NO_PR)
    target, facts = found
    repo, branch = str(target.repo), str(facts.branch)
    try:
        pr, state, reason = _view(repo, branch, target.head)
        if state == "missing":
            raise PrError(404, "gh is not installed")
        if state == "unauthenticated":
            raise PrError(401, "gh is not signed in; run gh auth login")
        if pr is None and reason:
            raise PrError(502, reason)
        if pr is None or not isinstance(pr.get("number"), int):
            raise PrError(404, NO_PR)
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
    return {"ok": result.returncode == 0, "output": _scrub(output)[-OUTPUT_CAP:]}
