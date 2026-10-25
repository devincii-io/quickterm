"""The workspace board sorts itself (CONTRACTS.md, 4.5 wave 2): the rule,
the facts behind it, their caches, and the route."""

from __future__ import annotations

import json
import subprocess
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from quickterm import board, ws_exec, ws_git, ws_pr
from quickterm import workspace as workspace_mod
from quickterm.board import Branch, Git, Pr, Terminal, derive
from quickterm.server import create_app
from tests.test_server import FakeConfig, FakeSessionManager
from tests.test_ws_pr import CHECKS, ORIGIN, PR, FakeExec, answer_git


@pytest.fixture(autouse=True)
def appdata(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    monkeypatch.setattr(workspace_mod, "_NAMESPACE", None)
    monkeypatch.setattr(board, "_forgot_manual", False)
    ws_pr._methods_cache.clear()
    return tmp_path / "appdata"


CLEAN = Git("feature", "origin/feature", 0, 0, 0)
AGENT_WAITING = Terminal(agent="claude", agent_state="waiting",
                         agent_message="Claude needs your permission to use Bash")


def open_pr(state="open", checks="passing") -> Branch:
    return Branch("feature", base="main", ahead_of_base=2,
                  pr=Pr(12, state, checks, "https://github.com/a/b/pull/12"), checked=True)


# --- the rule -----------------------------------------------------------------------------


@pytest.mark.parametrize("terminals, git, info, expected", [
    # 1. needs you beats everything
    ([AGENT_WAITING, Terminal(agent="codex", agent_state="working")], Git("f", None, 0, 0, 3),
     open_pr(), ("needs-you", "Claude waits for permission")),
    ([Terminal(agent="codex", agent_state="waiting", agent_message="Which file?")], None, None,
     ("needs-you", "Codex waits for an answer")),
    ([Terminal(agent="claude", agent_state="working", subagent_waiting=True)], None, None,
     ("needs-you", "Claude waits for permission")),
    ([Terminal(agent="claude", agent_state="failed")], None, None,
     ("needs-you", "Claude's last turn failed")),
    ([Terminal(attention="bell")], None, None, ("needs-you", "A terminal rang the bell")),
    ([Terminal(attention="notify", attention_text="Continue? [y/N]")], None, None,
     ("needs-you", "Continue? [y/N]")),
    ([Terminal(alive=False, attention="exit")], None, None, ("needs-you", "A terminal stopped")),
    ([Terminal(attention="bell"), AGENT_WAITING], None, None,
     ("needs-you", "A terminal rang the bell · 1 more")),
    # 2. working
    ([Terminal(agent="claude", agent_state="working")], CLEAN, open_pr(),
     ("working", "Claude is working")),
    ([Terminal(agent="claude", agent_state="working"), Terminal(agent="codex", agent_state="working")],
     None, None, ("working", "2 agents are working")),
    ([Terminal(agent="claude", agent_state="working")] * 2, None, None,
     ("working", "2 Claude agents are working")),
    # 3. in review, draft included, dirty or not
    ([], Git("feature", "origin/feature", 0, 0, 4), open_pr(), ("in-review", "PR #12 open · checks passing")),
    ([], CLEAN, open_pr("draft", None), ("in-review", "PR #12 draft")),
    ([], CLEAN, open_pr(checks="failing"), ("in-review", "PR #12 open · checks failing")),
    # 4. changes
    ([], Git("feature", "origin/feature", 2, 0, 3), None,
     ("changes", "3 files changed · 2 commits not pushed")),
    ([], Git("main", "origin/main", 1, 0, 0), None, ("changes", "1 commit not pushed")),
    ([], Git(None, None, 0, 0, 1), None, ("changes", "1 file changed")),
    ([], Git("feature", None, 0, 0, 0), Branch("feature", base="main", ahead_of_base=3),
     ("changes", "3 commits not pushed")),
    ([], CLEAN, Branch("feature", base="main", ahead_of_base=2, checked=True),
     ("changes", "2 commits not in a pull request")),
    # 5. done
    ([Terminal()], CLEAN, open_pr("merged"), ("done", "PR #12 merged")),
    # 6. idle
    ([], Git("feature", "origin/feature", 0, 0, 1), open_pr("merged"),
     ("changes", "1 file changed")),
    ([], None, None, ("idle", "No terminals")),
    ([Terminal(alive=False)], None, None, ("idle", "No terminals")),
    ([Terminal(agent="claude", agent_state="done")], CLEAN, None, ("idle", "Clean and quiet")),
    ([], CLEAN, open_pr("closed"), ("idle", "PR #12 closed")),
    # Not claimed without knowing: GitHub did not answer, or the branch is the base.
    ([], CLEAN, Branch("feature", base="main", ahead_of_base=2, checked=False), ("idle", "No terminals")),
    ([], Git("main", "origin/main", 0, 0, 0), Branch("main", base="main"), ("idle", "No terminals")),
    ([], Git("feature", None, 0, 0, 0), None, ("idle", "No terminals")),
    ([], Git("feature", None, 0, 0, 0), Branch("feature", base="main", ahead_of_base=0),
     ("idle", "No terminals")),
])
def test_the_first_status_that_holds_wins(terminals, git, info, expected):
    assert derive(terminals, git, info) == expected
    assert expected[0] in board.STATUSES


def test_a_long_question_is_clipped_to_one_short_line():
    status, reason = derive([Terminal(attention="notify", attention_text="x " * 200)], None, None)
    assert status == "needs-you" and len(reason) <= board.REASON_MAX_CHARS


def test_checks_in_one_word():
    assert board.checks_summary(CHECKS) == "failing"
    assert board.checks_summary([{"bucket": "pending"}, {"bucket": "pass"}]) == "pending"
    assert board.checks_summary([{"bucket": "pass"}, {"bucket": "skipping"}]) == "passing"
    assert board.checks_summary([]) is None


def test_a_terminal_from_the_session_managers_row():
    info = SimpleNamespace(alive=True)
    terminal = board.terminal_from(
        info, {"kind": "notify", "text": "May I?"},
        {"kind": "claude", "state": "working", "message": None,
         "subagents": [{"waiting": False}, {"waiting": True}]},
    )
    assert terminal == Terminal(True, "notify", "May I?", "claude", "working", None, True)
    assert board.terminal_from(info, None, None) == Terminal()


# --- reading the facts ---------------------------------------------------------------------


def test_git_facts_come_from_one_porcelain_v2_status(monkeypatch):
    calls = []

    def run(ws, argv, **kwargs):
        calls.append(argv)
        if "config" in argv:
            return subprocess.CompletedProcess(argv, 1, "", "")
        out = "\0".join([
            "# branch.oid abc", "# branch.head feature", "# branch.upstream origin/feature",
            "# branch.ab +2 -1", "1 .M N... 100644 100644 100644 a b src/a.py",
            "1 M. N... 100644 100644 100644 a b src/a.py", "? new.txt", "",
        ])
        return subprocess.CompletedProcess(argv, 0, out, "")

    monkeypatch.setattr(ws_exec, "run", run)
    ws_git._filter_cache.clear()
    ws = SimpleNamespace(name="x", path="/x", host="devbox")
    assert board.read_git(ws) == Git("feature", "origin/feature", 2, 1, 2)
    status = [argv for argv in calls if "status" in argv]
    assert len(status) == 1
    assert status[0][-5:] == ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"]
    assert "core.fsmonitor=false" in status[0]


def test_no_repository_means_no_git_facts(monkeypatch):
    monkeypatch.setattr(ws_exec, "run", lambda ws, argv, **kw: subprocess.CompletedProcess(
        argv, 128, "", "not a git repository"))
    ws_git._filter_cache.clear()
    assert board.read_git(SimpleNamespace(name="x", path="/x", host="devbox")) is None


@pytest.fixture
def gh(monkeypatch):
    fake = FakeExec()
    answer_git(fake, "feature", ORIGIN)
    fake.on(["gh", "pr", "list"], out=json.dumps([PR]))
    fake.on(["gh", "pr", "checks"], code=1, out=json.dumps(CHECKS))
    fake.on(["gh", "repo", "view"], out="{}")
    monkeypatch.setattr(ws_exec, "run", fake.run)
    monkeypatch.setattr(ws_git, "base_branch", lambda ws: "origin/main")
    monkeypatch.setattr(ws_git, "commits_since", lambda ws, base: 4)
    return fake


def test_the_branch_facts_ask_gh_the_way_the_panel_does(gh):
    ws = SimpleNamespace(name="x", path="/x", host=None)
    info = board.read_branch(ws, CLEAN)
    assert info == Branch("feature", base="main", ahead_of_base=4,
                          pr=Pr(249, "open", "failing", PR["url"]), checked=True)
    gh.on(["gh", "pr", "list"], out=json.dumps([{**PR, "isDraft": True}]))
    assert board.read_branch(ws, CLEAN).pr.state == "draft"
    gh.on(["gh", "pr", "list"], out=json.dumps([{**PR, "state": "MERGED"}]))
    assert board.read_branch(ws, CLEAN).pr.state == "merged"
    gh.on(["gh", "pr", "list"], out="[]")
    assert board.read_branch(ws, CLEAN) == Branch("feature", base="main", ahead_of_base=4, checked=True)


def test_gh_is_not_asked_for_the_base_branch_or_without_github(gh):
    ws = SimpleNamespace(name="x", path="/x", host=None)
    assert board.read_branch(ws, Git("main", "origin/main", 0, 0, 0)) == Branch("main", base="main")
    assert not [argv for _path, argv in gh.calls if argv[0] == "gh"]
    answer_git(gh, "feature", ("remote.origin.url", "C:/repos/bare.git"))
    info = board.read_branch(ws, CLEAN)
    assert info.pr is None and info.checked is False
    assert not [argv for _path, argv in gh.calls if argv[0] == "gh"]
    gh.gh_missing = True
    answer_git(gh, "feature", ORIGIN)
    assert board.read_branch(ws, CLEAN).checked is False


# --- caching -----------------------------------------------------------------------------------


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class Readers:
    def __init__(self) -> None:
        self.git = Git("feature", "origin/feature", 0, 0, 0)
        self.info = Branch("feature", base="main", ahead_of_base=1, pr=None, checked=True)
        self.git_calls = 0
        self.branch_calls = 0

    def read_git(self, ws):
        self.git_calls += 1
        return self.git

    def read_branch(self, ws, git):
        self.branch_calls += 1
        return self.info if self.info is None else Branch(git.branch, self.info.base,
                                                          self.info.ahead_of_base, self.info.pr,
                                                          self.info.checked)


def make_board(clock, readers, *, run=True):
    pending = []

    def submit(fn, *args):
        pending.append((fn, args))
        if run:
            fn(*args)

    cards = board.Board(clock=clock, wall=lambda: clock.now + 1_700_000_000, submit=submit,
                        git_reader=readers.read_git, branch_reader=readers.read_branch)
    return cards, pending


WS = SimpleNamespace(name="api", path="/srv/api", host=None)


def test_the_first_answer_is_from_the_empty_cache_and_starts_one_refresh():
    clock, readers = Clock(), Readers()
    cards, pending = make_board(clock, readers, run=False)
    first = cards.card("api", WS, [])
    assert first["git"] is None and first["pr"] is None and first["status"] == "idle"
    cards.card("api", WS, [])
    # One refresh per folder at a time, however often the board asks.
    assert len(pending) == 1
    fn, args = pending[0]
    fn(*args)
    assert readers.git_calls == 1 and readers.branch_calls == 1
    answer = cards.card("api", WS, [])
    assert answer["status"] == "changes" and answer["reason"] == "1 commit not in a pull request"
    assert answer["git"] == {"branch": "feature", "dirty": 0, "ahead": 0, "behind": 0}


def test_git_is_read_again_after_30_s_and_the_pull_request_after_120_s():
    clock, readers = Clock(), Readers()
    cards, _ = make_board(clock, readers)
    cards.card("api", WS, [])
    assert (readers.git_calls, readers.branch_calls) == (1, 1)
    clock.now += 29
    cards.card("api", WS, [])
    assert (readers.git_calls, readers.branch_calls) == (1, 1)
    clock.now += 2
    cards.card("api", WS, [])
    assert (readers.git_calls, readers.branch_calls) == (2, 1)
    clock.now += 100
    cards.card("api", WS, [])
    assert (readers.git_calls, readers.branch_calls) == (3, 2)


def test_a_new_branch_asks_for_its_pull_request_at_once_and_never_shows_the_old_one():
    clock, readers = Clock(), Readers()
    readers.info = Branch("feature", base="main", ahead_of_base=1,
                          pr=Pr(7, "open", None, None), checked=True)
    cards, _ = make_board(clock, readers)
    cards.card("api", WS, [])
    assert cards.card("api", WS, [])["pr"]["number"] == 7
    readers.git = Git("other", "origin/other", 0, 0, 0)
    clock.now += 31
    cards.card("api", WS, [])
    # The refresh read the new branch and asked for its pull request with it.
    assert readers.branch_calls == 2
    readers.info = None
    clock.now += 31
    cards.card("api", WS, [])
    # Git moved on again but the branch facts are for "other": the old PR is gone.
    readers.git = Git("third", "origin/third", 0, 0, 0)
    clock.now += 31
    cards = board.Board(clock=clock, submit=lambda fn, *a: None,
                        git_reader=readers.read_git, branch_reader=readers.read_branch)
    cards._git[("", "")] = (clock.now, readers.git)
    cards._branch[("", "")] = (clock.now, Branch("feature", pr=Pr(7, "open", None, None)))
    assert cards.facts(SimpleNamespace(host="", path=""))[1] is None


def test_since_moves_only_when_the_status_changes():
    clock, readers = Clock(), Readers()
    readers.info = None
    readers.git = Git("main", "origin/main", 0, 0, 0)
    cards, _ = make_board(clock, readers)
    first = cards.card("api", WS, [])
    clock.now += 50
    assert cards.card("api", WS, [])["since"] == first["since"]
    clock.now += 5
    working = cards.card("api", WS, [Terminal(agent="claude", agent_state="working")])
    assert working["status"] == "working" and working["since"] == first["since"] + 55
    cards.keep_only(set())
    clock.now += 1
    assert cards.card("api", WS, [Terminal(agent="claude", agent_state="working")])["since"] == (
        first["since"] + 56
    )


def test_a_failing_reader_leaves_the_board_answering():
    clock = Clock()

    def broken(ws):
        raise RuntimeError("boom")

    cards = board.Board(clock=clock, submit=lambda fn, *a: fn(*a), git_reader=broken,
                        branch_reader=lambda ws, git: None)
    assert cards.card("api", WS, [])["status"] == "idle"
    clock.now += 31
    assert cards.card("api", WS, [])["status"] == "idle"


# --- the route ----------------------------------------------------------------------------------


@pytest.fixture
def manager():
    return FakeSessionManager()


@pytest.fixture
def client(manager):
    with TestClient(create_app(manager, FakeConfig()), base_url="http://127.0.0.1:8620") as c:
        c.app.state.board._submit = lambda fn, *args: None  # no background git in route tests
        yield c


def save(name, **kwargs):
    workspace_mod.save_workspace(workspace_mod.Workspace(name=name, layout={}, **kwargs))


def test_the_board_lists_each_saved_workspace_but_never_scratch(client, manager):
    save("api")
    save("web")
    save("scratch")
    save("scratch-view-0123456789ab", temporary=True)
    answer = client.get("/api/board").json()
    assert set(answer) == {"workspaces"}
    assert sorted(answer["workspaces"]) == ["api", "web"]
    card = answer["workspaces"]["api"]
    assert set(card) == {"status", "reason", "since", "git", "pr"}
    assert (card["status"], card["reason"], card["git"], card["pr"]) == ("idle", "No terminals", None, None)
    assert isinstance(card["since"], int)


def test_agents_and_attention_come_from_the_session_manager(client, manager):
    save("api")
    save("web")
    waiting = manager.add_session(workspace="api")
    working = manager.add_session(workspace="web")
    manager.add_session(workspace=None)
    manager.agents = {
        waiting.id: {"kind": "claude", "state": "waiting", "message": "needs your permission"},
        working.id: {"kind": "codex", "state": "working"},
    }
    cards = client.get("/api/board").json()["workspaces"]
    assert (cards["api"]["status"], cards["api"]["reason"]) == ("needs-you", "Claude waits for permission")
    assert (cards["web"]["status"], cards["web"]["reason"]) == ("working", "Codex is working")
    manager.agents = {}
    manager.attention = {working.id: {"kind": "bell", "text": None}}
    assert client.get("/api/board").json()["workspaces"]["web"]["status"] == "needs-you"


def test_the_old_board_file_is_removed_once_and_put_is_gone(client, appdata):
    path = appdata / "quickterm" / "board.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": 1, "status": {"api": "done"}}), encoding="utf-8")
    save("api")
    assert client.get("/api/board").json()["workspaces"]["api"]["status"] == "idle"
    assert not path.exists()
    assert client.put("/api/board/api", json={"status": "done"}).status_code in (404, 405)


def test_the_board_is_token_gated(manager):
    app = create_app(manager, FakeConfig(), "s3cret")
    with TestClient(app, base_url="http://127.0.0.1:8620") as c:
        assert c.get("/api/board").status_code == 403
        assert c.get("/api/board", headers={"X-QuickTerm-Token": "s3cret"}).status_code == 200
