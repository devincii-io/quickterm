"""The right panel's pull request routes, with git and gh answered through a
fake `ws_exec.run`."""

from __future__ import annotations

import json
import os
import subprocess

import pytest
from fastapi.testclient import TestClient

from quickterm import workspace as workspace_mod
from quickterm import ws_exec, ws_pr
from quickterm.server import create_app
from tests.test_server import FakeConfig, FakeSessionManager

PR = {
    "number": 249, "title": "Widen the panel", "state": "OPEN", "isDraft": False,
    "url": "https://github.com/acme/app/pull/249", "mergeStateStatus": "CLEAN",
    "reviewDecision": "APPROVED", "headRefName": "feature", "baseRefName": "main",
    "headRefOid": "a" * 40, "isCrossRepository": False,
    "headRepositoryOwner": {"login": "acme"}, "headRepository": {"name": "app"},
}
CHECKS = [
    {"name": "test", "state": "FAILURE", "bucket": "fail", "workflow": "ci",
     "link": "https://github.com/acme/app/actions/runs/111/job/222",
     "startedAt": "2026-10-25T08:00:00Z", "completedAt": "2026-10-25T08:05:00Z"},
    {"name": "lint", "state": "SUCCESS", "bucket": "pass", "workflow": "ci",
     "link": "https://github.com/acme/app/actions/runs/111/job/223",
     "startedAt": "2026-10-25T08:00:00Z", "completedAt": "2026-10-25T08:01:00Z"},
]


class FakeExec:
    """Answers argv prefixes with (returncode, stdout, stderr); records calls."""

    def __init__(self) -> None:
        self.answers: list[tuple[list[str], tuple[int, str, str]]] = []
        self.calls: list[tuple[str | None, list[str]]] = []
        self.gh_missing = False

    def on(self, prefix: list[str], code: int = 0, out: str = "", err: str = "") -> None:
        self.answers.insert(0, (prefix, (code, out, err)))

    def run(self, ws, argv, *, timeout=10.0, input=None, env=None):
        self.calls.append((getattr(ws, "path", None), list(argv)))
        if argv[0] == "gh" and self.gh_missing:
            raise FileNotFoundError("gh")
        for prefix, (code, out, err) in self.answers:
            if argv[:len(prefix)] == prefix:
                return subprocess.CompletedProcess(argv, code, out, err)
        return subprocess.CompletedProcess(argv, 1, "", "unexpected call")


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    monkeypatch.setattr(workspace_mod, "_NAMESPACE", None)
    ws_pr._methods_cache.clear()


@pytest.fixture
def fake(monkeypatch):
    fake = FakeExec()
    fake.on(["git", "rev-parse", "--is-inside-work-tree"], out="true\n")
    fake.on(["git", "remote", "get-url", "origin"], out="git@github.com:acme/app.git\n")
    fake.on(["git", "remote", "get-url", "--push", "origin"], out="git@github.com:acme/app.git\n")
    fake.on(["git", "rev-parse", "--abbrev-ref", "HEAD"], out="feature\n")
    fake.on(["gh", "pr", "list"], out=json.dumps([PR]))
    fake.on(["gh", "pr", "checks"], code=1, out=json.dumps(CHECKS))
    fake.on(["gh", "repo", "view"], out=json.dumps(
        {"mergeCommitAllowed": False, "squashMergeAllowed": True, "rebaseMergeAllowed": True}))
    monkeypatch.setattr(ws_exec, "run", fake.run)
    return fake


@pytest.fixture
def client(tmp_path):
    folder = tmp_path / "repo"
    folder.mkdir()
    with TestClient(create_app(FakeSessionManager(), FakeConfig()), base_url="http://127.0.0.1:8620") as c:
        assert c.put("/api/workspaces/demo", json={"layout": {}, "path": str(folder)}).status_code == 204
        yield c


@pytest.mark.parametrize("url,expected", [
    ("git@github.com:acme/app.git", "github.com/acme/app"),
    ("https://github.com/acme/app.git", "github.com/acme/app"),
    ("https://github.com/acme/app", "github.com/acme/app"),
    ("ssh://git@github.com/acme/app.git", "github.com/acme/app"),
    ("https://user@ghe.example.com:8443/team/tool.git/", "ghe.example.com/team/tool"),
    ("C:/repos/bare.git", None),
    ("https://github.com/acme", None),
    ("https://github.com/acme/app/extra", None),
])
def test_repo_from_remote(url, expected):
    assert ws_pr.repo_from_remote(url) == expected


def test_the_pr_with_checks_and_merge_methods(client, fake):
    answer = client.get("/api/ws/demo/pr").json()
    assert answer["gh"] == "ok"
    assert answer["pr"]["number"] == 249
    assert answer["pr"]["merge_methods"] == ["squash", "rebase"]
    assert [check["name"] for check in answer["checks"]] == ["test", "lint"]
    assert (answer["checks"][0]["run_id"], answer["checks"][0]["job_id"]) == ("111", "222")
    view = next(argv for _, argv in fake.calls if argv[:3] == ["gh", "pr", "list"])
    assert view[3:6] == ["--head=feature", "-R", "github.com/acme/app"]
    assert "--state" in view and view[view.index("--state") + 1] == "all"
    # gh runs here, never in the workspace folder (which may be on a host).
    assert {path for path, argv in fake.calls if argv[0] == "gh"} == {os.path.expanduser("~")}
    assert all(path.endswith("repo") for path, argv in fake.calls if argv[0] == "git")


def test_gh_missing_unauthenticated_and_no_pr(client, fake):
    fake.gh_missing = True
    assert client.get("/api/ws/demo/pr").json() == {"gh": "missing", "pr": None, "checks": [], "reason": None}
    fake.gh_missing = False
    fake.on(["gh", "pr", "list"], code=4, err="To get started with GitHub CLI, please run:  gh auth login")
    assert client.get("/api/ws/demo/pr").json()["gh"] == "unauthenticated"
    fake.on(["gh", "pr", "list"], out="[]")
    answer = client.get("/api/ws/demo/pr").json()
    assert answer == {"gh": "ok", "pr": None, "checks": [], "reason": "no pull request for this branch"}


FORK = {
    **PR, "number": 666, "title": "Totally harmless", "headRefOid": "f" * 40, "isCrossRepository": True,
    "headRepositoryOwner": {"login": "mallory"}, "headRepository": {"name": "app"},
}


def test_a_strangers_fork_pr_with_the_same_branch_name_is_not_ours(client, fake):
    fake.on(["gh", "pr", "list"], out=json.dumps([FORK]))
    answer = client.get("/api/ws/demo/pr").json()
    assert answer["pr"] is None and answer["checks"] == []
    assert not any(argv[:3] == ["gh", "pr", "checks"] for _, argv in fake.calls)
    merged = client.post("/api/ws/demo/pr/merge", json={"method": "merge", "number": 666, "head_sha": "f" * 40})
    assert merged.status_code == 404
    assert not any(argv[:3] == ["gh", "pr", "merge"] for _, argv in fake.calls)
    # Listed next to our own, ours is the one shown.
    fake.on(["gh", "pr", "list"], out=json.dumps([FORK, PR]))
    assert client.get("/api/ws/demo/pr").json()["pr"]["number"] == 249


def test_a_branch_that_pushes_to_a_fork_finds_the_pr_from_that_fork(client, fake):
    fake.on(["git", "config", "--get", "branch.feature.pushRemote"], out="mine\n")
    fake.on(["git", "remote", "get-url", "--push", "mine"], out="https://github.com/me/app.git\n")
    own_fork = {**FORK, "number": 300, "headRepositoryOwner": {"login": "me"}}
    fake.on(["gh", "pr", "list"], out=json.dumps([FORK, PR, own_fork]))
    assert client.get("/api/ws/demo/pr").json()["pr"]["number"] == 300
    # A push remote that is no repository: only same-repository PRs count.
    fake.on(["git", "remote", "get-url", "--push", "mine"], out="C:/repos/bare.git\n")
    assert client.get("/api/ws/demo/pr").json()["pr"]["number"] == 249
    fake.on(["gh", "pr", "list"], out=json.dumps([FORK, own_fork]))
    assert client.get("/api/ws/demo/pr").json()["pr"] is None


def test_a_folder_outside_git_says_so(client, fake):
    fake.on(["git", "rev-parse", "--is-inside-work-tree"], code=128, err="fatal: not a git repository")
    answer = client.get("/api/ws/demo/pr").json()
    assert answer == {"gh": "ok", "pr": None, "checks": [], "reason": "not a git repository"}
    assert not any(argv[0] == "gh" for _, argv in fake.calls)


def test_no_github_remote(client, fake):
    fake.on(["git", "remote", "get-url", "origin"], code=2, err="error: No such remote 'origin'")
    answer = client.get("/api/ws/demo/pr").json()
    assert answer["pr"] is None and answer["reason"] == "no GitHub remote named origin"


def test_the_failed_log_is_the_last_200_lines(client, fake):
    fake.on(["gh", "run", "view"], out="".join(f"line {n}\n" for n in range(500)))
    text = client.get("/api/ws/demo/pr/log", params={"run": "111", "job": "222"}).json()["text"]
    lines = text.splitlines()
    assert len(lines) == 200 and lines[-1] == "line 499"
    call = next(argv for _, argv in fake.calls if argv[:3] == ["gh", "run", "view"])
    assert call[3:] == ["111", "-R", "github.com/acme/app", "--log-failed", "--job", "222"]
    assert client.get("/api/ws/demo/pr/log", params={"run": "1; rm -rf /"}).status_code == 400
    assert client.get("/api/ws/demo/pr/log", params={"run": "1", "job": "--web"}).status_code == 400


def test_merge_asks_gh_with_the_method_and_refuses_what_cannot_merge(client, fake):
    fake.on(["gh", "pr", "merge"], out="Merged pull request #249\n")
    shown = {"number": 249, "head_sha": "a" * 40}
    answer = client.post("/api/ws/demo/pr/merge", json={"method": "squash", **shown}).json()
    assert answer == {"ok": True, "output": "Merged pull request #249"}
    merge = next(argv for _, argv in fake.calls if argv[:3] == ["gh", "pr", "merge"])
    assert merge[3:] == ["249", "-R", "github.com/acme/app", "--squash", "--match-head-commit", "a" * 40]
    assert client.post("/api/ws/demo/pr/merge", json={"method": "force", **shown}).status_code == 400
    fake.on(["gh", "pr", "list"], out=json.dumps([{**PR, "isDraft": True}]))
    assert client.post("/api/ws/demo/pr/merge", json={"method": "merge", **shown}).status_code == 409
    fake.on(["gh", "pr", "list"], out=json.dumps([{**PR, "mergeStateStatus": "DIRTY"}]))
    assert client.post("/api/ws/demo/pr/merge", json={"method": "merge", **shown}).status_code == 409


def test_merge_is_tied_to_the_pr_and_head_the_user_saw(client, fake):
    fake.on(["gh", "pr", "merge"], out="Merged\n")
    post = lambda body: client.post("/api/ws/demo/pr/merge", json={"method": "merge", **body})  # noqa: E731
    assert post({}).status_code == 400
    assert post({"number": 249}).status_code == 400
    assert post({"number": "249", "head_sha": "a" * 40}).status_code == 400
    assert post({"number": 249, "head_sha": "not-a-sha"}).status_code == 400
    # Another PR took the branch, or someone pushed since the panel showed it.
    stale = post({"number": 248, "head_sha": "a" * 40})
    assert stale.status_code == 409 and "#249" in stale.json()["detail"]
    moved = post({"number": 249, "head_sha": "b" * 40})
    assert moved.status_code == 409 and "new commits" in moved.json()["detail"]
    assert not any(argv[:3] == ["gh", "pr", "merge"] for _, argv in fake.calls)


def test_the_open_pr_wins_and_a_digit_branch_stays_a_branch(client, fake):
    fake.on(["git", "rev-parse", "--abbrev-ref", "HEAD"], out="1234\n")
    old = {**PR, "number": 7, "state": "CLOSED", "headRefName": "1234"}
    current = {**PR, "headRefName": "1234"}
    fake.on(["gh", "pr", "list"], out=json.dumps([old, current]))
    assert client.get("/api/ws/demo/pr").json()["pr"]["number"] == 249
    listed = [argv for _, argv in fake.calls if argv[:3] == ["gh", "pr", "list"]][-1]
    assert "--head=1234" in listed
    fake.on(["git", "rev-parse", "--abbrev-ref", "HEAD"], out="--web\n")
    assert client.get("/api/ws/demo/pr").json()["pr"] is None
