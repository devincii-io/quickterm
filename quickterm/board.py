"""The workspace board: where each workspace stands, derived, never set by hand.

`derive` is the whole rule, a pure function over what is known about one
workspace: its terminals and agents (from the session manager), its git
state and its branch's pull request. `Board` keeps the git and pull request
facts in memory and refreshes them in the background, so a request answers
from what was last found and never waits for git, ssh, wsl.exe or gh.

Before 4.5 the column was dragged by hand and kept in `board.json`; that
file is ignored and removed once (`forget_manual_board`).
"""

from __future__ import annotations

import concurrent.futures
import importlib
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from quickterm import ws_exec
from quickterm.config import config_dir

log = logging.getLogger(__name__)

STATUSES = ("needs-you", "working", "in-review", "changes", "done", "idle")
GIT_TTL_S = 20.0
PR_TTL_S = 120.0
REASON_MAX_CHARS = 120
_AGENT_LABELS = {"claude": "Claude", "codex": "Codex"}
_BASE_NAMES = ("main", "master")
_FAILING = ("fail", "cancel")


@dataclass(frozen=True)
class Terminal:
    """One terminal of a workspace as the board sees it."""

    alive: bool = True
    attention: str | None = None  # "bell" | "notify" | "exit"
    attention_text: str | None = None
    agent: str | None = None  # "claude" | "codex"
    agent_state: str | None = None  # working | waiting | done | failed | idle
    agent_message: str | None = None
    subagent_waiting: bool = False


@dataclass(frozen=True)
class Git:
    branch: str | None
    upstream: str | None
    ahead: int
    behind: int
    dirty: int


@dataclass(frozen=True)
class Pr:
    number: int
    state: str  # "open" | "draft" | "merged" | "closed"
    checks: str | None  # "passing" | "failing" | "pending" | None
    url: str | None


@dataclass(frozen=True)
class Branch:
    """What the slower refresh found for one branch: its base, the commits
    it has that the base has not, and its pull request. `checked` is True
    when GitHub answered, so "no pull request" is a fact and not a gap."""

    branch: str
    base: str | None = None
    ahead_of_base: int | None = None
    pr: Pr | None = None
    checked: bool = False


# --- the rule -------------------------------------------------------------------------


def _count(number: int, one: str, many: str) -> str:
    return f"{number} {one if number == 1 else many}"


def _clip(text: str) -> str:
    text = " ".join(text.split())
    return text if len(text) <= REASON_MAX_CHARS else text[: REASON_MAX_CHARS - 3].rstrip() + "..."


def _label(agent: str | None) -> str:
    return _AGENT_LABELS.get(agent or "", "An agent")


def _needs_you(terminal: Terminal) -> str | None:
    """Why this terminal needs the user, or None."""
    if not terminal.alive and terminal.attention is None:
        return None
    if terminal.agent_state == "waiting" or terminal.subagent_waiting:
        message = (terminal.agent_message or "").lower()
        if terminal.subagent_waiting or "permission" in message:
            return f"{_label(terminal.agent)} waits for permission"
        return f"{_label(terminal.agent)} waits for an answer"
    if terminal.agent_state == "failed":
        return f"{_label(terminal.agent)}'s last turn failed"
    if terminal.attention == "bell":
        return "A terminal rang the bell"
    if terminal.attention == "exit":
        return "A terminal stopped"
    if terminal.attention is not None:
        return _clip(terminal.attention_text) if terminal.attention_text else "A terminal asks for you"
    return None


def _working(terminals: list[Terminal]) -> str | None:
    labels = [_label(t.agent) for t in terminals if t.alive and t.agent_state == "working"]
    if not labels:
        return None
    if len(labels) == 1:
        return f"{labels[0]} is working"
    if len(set(labels)) == 1:
        return f"{len(labels)} {labels[0]} agents are working"
    return f"{len(labels)} agents are working"


def _checks(pr: Pr) -> str:
    return f" · checks {pr.checks}" if pr.checks else ""


def _is_base(git: Git, info: Branch | None) -> bool:
    if info is not None and info.base:
        return git.branch == info.base
    return git.branch in _BASE_NAMES


def _changes(git: Git, info: Branch | None) -> list[str]:
    parts: list[str] = []
    if git.dirty:
        parts.append(_count(git.dirty, "file changed", "files changed"))
    if git.branch is None:
        return parts
    if git.upstream is not None and git.ahead:
        parts.append(_count(git.ahead, "commit not pushed", "commits not pushed"))
        return parts
    # Past the base: a branch never pushed, or pushed with no pull request.
    on_branch = info.ahead_of_base if info is not None else None
    if not on_branch or _is_base(git, info):
        return parts
    if git.upstream is None:
        parts.append(_count(on_branch, "commit not pushed", "commits not pushed"))
    elif info is not None and info.checked and info.pr is None:
        parts.append(_count(on_branch, "commit not in a pull request",
                            "commits not in a pull request"))
    return parts


def derive(terminals: list[Terminal], git: Git | None, info: Branch | None) -> tuple[str, str]:
    """`(status, reason)` for one workspace: the first status that holds, in
    the order of STATUSES. `info` must belong to `git`'s branch."""
    needing = [reason for reason in map(_needs_you, terminals) if reason]
    if needing:
        more = f" · {len(needing) - 1} more" if len(needing) > 1 else ""
        return "needs-you", needing[0] + more
    working = _working(terminals)
    if working:
        return "working", working
    pr = info.pr if info is not None else None
    if pr is not None and pr.state in ("open", "draft"):
        return "in-review", f"PR #{pr.number} {pr.state}{_checks(pr)}"
    if git is not None:
        parts = _changes(git, info)
        if parts:
            return "changes", " · ".join(parts)
    if pr is not None and pr.state == "merged" and git is not None and not git.dirty:
        return "done", f"PR #{pr.number} merged"
    if pr is not None and pr.state == "closed":
        return "idle", f"PR #{pr.number} closed"
    if not any(t.alive for t in terminals):
        return "idle", "No terminals"
    return "idle", "Clean and quiet"


def checks_summary(checks: list[dict]) -> str | None:
    """`gh pr checks` in one word: failing wins over pending over passing."""
    buckets = {str(check.get("bucket") or "").lower() for check in checks if isinstance(check, dict)}
    if buckets & set(_FAILING):
        return "failing"
    if "pending" in buckets:
        return "pending"
    if "pass" in buckets:
        return "passing"
    return None


# --- reading the facts (blocking, in the background) ------------------------------------


def read_git(ws: Any) -> Git | None:
    """One `git status` in the workspace folder, wherever it is."""
    ws_git = importlib.import_module("quickterm.ws_git")
    try:
        found = ws_git.board_status(ws)
    except ws_git.GitError:
        return None
    if found is None:
        return None
    return Git(found["branch"], found["upstream"], found["ahead"], found["behind"], found["dirty"])


def _short_base(base: str | None) -> str | None:
    if base and base.startswith("origin/"):
        return base[len("origin/"):]
    return base


def read_branch(ws: Any, git: Git) -> Branch | None:
    """The base, the commits past it and the pull request of `git.branch`.
    gh is only asked for a branch that is not the base."""
    if not git.branch:
        return None
    ws_git = importlib.import_module("quickterm.ws_git")
    ws_pr = importlib.import_module("quickterm.ws_pr")
    try:
        base = ws_git.base_branch(ws)
    except ws_git.GitError:
        base = None
    short = _short_base(base)
    if base is None or short == git.branch:
        return Branch(git.branch, base=short)
    try:
        ahead = ws_git.commits_since(ws, base)
    except ws_git.GitError:
        ahead = None
    try:
        found = ws_pr.status(ws)
    except Exception:
        log.debug("board: pull request lookup failed", exc_info=True)
        return Branch(git.branch, base=short, ahead_of_base=ahead)
    checked = found.get("gh") == "ok" and found.get("reason") in (
        None, "no pull request for this branch",
    )
    raw = found.get("pr")
    pr = None
    if isinstance(raw, dict) and isinstance(raw.get("number"), int):
        state = str(raw.get("state") or "").lower()
        if state == "open" and raw.get("isDraft"):
            state = "draft"
        pr = Pr(raw["number"], state, checks_summary(found.get("checks") or []), raw.get("url"))
    return Branch(git.branch, base=short, ahead_of_base=ahead, pr=pr, checked=checked)


# --- the cache ------------------------------------------------------------------------------


def _key(ws: Any) -> tuple[str | None, str | None]:
    return getattr(ws, "host", None), getattr(ws, "path", None)


def _executor_submit() -> Callable[..., Any]:
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="board")
    return pool.submit


class Board:
    """The facts the board answers from, refreshed in the background.

    Git is read when its entry is older than GIT_TTL_S, the branch and its
    pull request when theirs is older than PR_TTL_S or the branch changed.
    One refresh per folder runs at a time. `since` is when a workspace's
    status last changed, in this process.
    """

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        wall: Callable[[], float] = time.time,
        submit: Callable[..., Any] | None = None,
        git_reader: Callable[[Any], Git | None] = read_git,
        branch_reader: Callable[[Any, Git], Branch | None] = read_branch,
    ) -> None:
        self._clock = clock
        self._wall = wall
        self._submit = submit
        self._read_git = git_reader
        self._read_branch = branch_reader
        self._lock = threading.Lock()
        self._git: dict[tuple, tuple[float, Git | None]] = {}
        self._branch: dict[tuple, tuple[float, Branch | None]] = {}
        self._running: set[tuple] = set()
        self._since: dict[str, tuple[str, float]] = {}

    def _due(self, key: tuple, now: float) -> bool:
        git = self._git.get(key)
        if git is None or now - git[0] >= GIT_TTL_S:
            return True
        return self._branch_due(key, git[1], now)

    def _branch_due(self, key: tuple, git: Git | None, now: float) -> bool:
        if git is None or not git.branch:
            return False
        entry = self._branch.get(key)
        return (
            entry is None or now - entry[0] >= PR_TTL_S
            or entry[1] is None or entry[1].branch != git.branch
        )

    def _refresh(self, ws: Any, key: tuple) -> None:
        try:
            now = self._clock()
            with self._lock:
                cached = self._git.get(key)
            git = cached[1] if cached is not None else None
            if ws_exec.asleep(ws):
                return  # a stopped WSL distribution stays stopped
            if cached is None or now - cached[0] >= GIT_TTL_S:
                git = self._read_git(ws)
                with self._lock:
                    self._git[key] = (self._clock(), git)
            with self._lock:
                due = self._branch_due(key, git, self._clock())
            if due and git is not None:
                info = self._read_branch(ws, git)
                with self._lock:
                    self._branch[key] = (self._clock(), info)
        except Exception:
            log.debug("board refresh failed", exc_info=True)
        finally:
            with self._lock:
                self._running.discard(key)

    def _kick(self, ws: Any, key: tuple) -> None:
        with self._lock:
            if key in self._running:
                return
            self._running.add(key)
        if self._submit is None:
            self._submit = _executor_submit()
        try:
            self._submit(self._refresh, ws, key)
        except RuntimeError:
            # The pool is shutting down with the backend.
            with self._lock:
                self._running.discard(key)

    def facts(self, ws: Any) -> tuple[Git | None, Branch | None]:
        """What is known for `ws` now; starts a refresh when it is stale."""
        key = _key(ws)
        now = self._clock()
        with self._lock:
            due = self._due(key, now)
            git_entry = self._git.get(key)
            branch_entry = self._branch.get(key)
        if due:
            self._kick(ws, key)
        git = git_entry[1] if git_entry is not None else None
        info = branch_entry[1] if branch_entry is not None else None
        if git is None or info is None or info.branch != git.branch:
            info = None
        return git, info

    def card(self, name: str, ws: Any, terminals: list[Terminal]) -> dict:
        git, info = self.facts(ws)
        status, reason = derive(terminals, git, info)
        with self._lock:
            previous = self._since.get(name)
            since = previous[1] if previous is not None and previous[0] == status else self._wall()
            self._since[name] = (status, since)
        return {
            "status": status,
            "reason": reason,
            "since": int(since),
            "git": _git_out(git, info),
            "pr": _pr_out(info.pr if info is not None else None),
        }

    def keep_only(self, names: set[str]) -> None:
        """Forget `since` for workspaces that are gone."""
        with self._lock:
            for name in [name for name in self._since if name not in names]:
                del self._since[name]


def _git_out(git: Git | None, info: Branch | None) -> dict | None:
    if git is None:
        return None
    if git.upstream is not None:
        ahead, behind = git.ahead, git.behind
    else:
        ahead = info.ahead_of_base if info is not None else None
        behind = None
    return {"branch": git.branch, "dirty": git.dirty, "ahead": ahead, "behind": behind}


def _pr_out(pr: Pr | None) -> dict | None:
    if pr is None:
        return None
    return {"number": pr.number, "state": pr.state, "checks": pr.checks, "url": pr.url}


def terminal_from(info: Any, attention: dict | None, agent: dict | None) -> Terminal:
    """A board Terminal from one row of the session manager."""
    agent = agent if isinstance(agent, dict) else {}
    attention = attention if isinstance(attention, dict) else {}
    subagents = agent.get("subagents") or []
    return Terminal(
        alive=bool(getattr(info, "alive", False)),
        attention=attention.get("kind"),
        attention_text=attention.get("text"),
        agent=agent.get("kind"),
        agent_state=agent.get("state"),
        agent_message=agent.get("message"),
        subagent_waiting=any(isinstance(s, dict) and s.get("waiting") for s in subagents),
    )


_forgot_manual = False


def forget_manual_board() -> None:
    """Remove the pre-4.5 `board.json` (hand-set columns) once per process."""
    global _forgot_manual
    if _forgot_manual:
        return
    _forgot_manual = True
    try:
        (config_dir() / "board.json").unlink(missing_ok=True)
    except OSError:
        log.debug("could not remove board.json", exc_info=True)
