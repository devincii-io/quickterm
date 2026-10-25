"""The right panel's pull request routes, with git and gh answered through a
fake `ws_exec.run`."""

from __future__ import annotations

import json
import os
import subprocess
from types import SimpleNamespace

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
    ws_pr._alias_cache.clear()
    # The user's own ~/.ssh/config stays out.
    from quickterm import ssh_config
    monkeypatch.setattr(ssh_config, "config_path", lambda: tmp_path / "no-ssh-config")


HEAD = ["git", "rev-parse", "--is-inside-work-tree", "--symbolic-full-name", "HEAD"]
CONFIG = ["git", "config", "--null", "--get-regexp"]


def config_out(*pairs: tuple[str, str]) -> str:
    """`git config --null --get-regexp` output for these (key, value) pairs."""
    return "".join(f"{key}\n{value}\0" for key, value in pairs)


def answer_git(fake, branch: str | None = "feature", *pairs: tuple[str, str]) -> None:
    """The two git calls of a PR lookup: HEAD on `branch` (None: detached)
    and these config values."""
    ref = f"refs/heads/{branch}" if branch else "HEAD"
    fake.on(HEAD, out=f"true\n{ref}\n")
    fake.on(CONFIG, code=0 if pairs else 1, out=config_out(*pairs))


ORIGIN = ("remote.origin.url", "git@github.com:acme/app.git")


@pytest.fixture
def fake(monkeypatch):
    fake = FakeExec()
    answer_git(fake, "feature", ORIGIN, ("branch.feature.remote", "origin"))
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
    # Every form git accepts for GitHub.
    ("git@github.com:/acme/app.git", "github.com/acme/app"),
    ("github.com:acme/app", "github.com/acme/app"),
    ("ssh://git@ssh.github.com:443/acme/app.git", "github.com/acme/app"),
    ("git+ssh://git@github.com/acme/app.git", "github.com/acme/app"),
    ("ssh+git://git@github.com/acme/app", "github.com/acme/app"),
    ("git://github.com/acme/app.git", "github.com/acme/app"),
    ("http://www.github.com/acme/app.git", "github.com/acme/app"),
    ("HTTPS://GitHub.com/Acme/App.git", "github.com/Acme/App"),
    ("https://github.com/acme/app.git/", "github.com/acme/app"),
    ("https://github.com:443/acme/my.app.git", "github.com/acme/my.app"),
    ("  https://github.com/acme/app.git\r\n", "github.com/acme/app"),
    ("[git@github.com:22]:acme/app.git", "github.com/acme/app"),
    # Credentials parse, and an @ in a password cannot become the host.
    ("https://user:ghp_secret@github.com/acme/app.git", "github.com/acme/app"),
    ("https://x-access-token:p@ss@github.com/acme/app.git", "github.com/acme/app"),
    ("https://oauth2:tok@ghe.example.com/team/tool", "ghe.example.com/team/tool"),
    # Not GitHub.
    ("https://dev.azure.com/org/project/_git/repo", None),
    ("git@ssh.dev.azure.com:v3/org/project/repo", None),
    ("https://org.visualstudio.com/project/_git/repo", None),
    ("https://gitlab.com/group/sub/repo.git", None),
    ("https://gitlab.com/group/repo.git", None),
    ("git@bitbucket.org:team/repo.git", None),
    ("file:///srv/git/repo.git", None),
    ("/srv/git/repo.git", None),
    ("../repo", None),
    ("C:\\repos\\bare.git", None),
    ("", None),
    ("https://", None),
])
def test_repo_from_remote(url, expected):
    assert ws_pr.repo_from_remote(url) == expected


@pytest.mark.parametrize("alias,resolved,expected", [
    ("github-work", "github.com", "github.com/Org/repo"),
    ("work", "ssh.github.com", "github.com/Org/repo"),
    ("gl", "gitlab.com", None),
    # Unresolved: an alias that says github means github.com ...
    ("github-work", None, "github.com/Org/repo"),
    ("github.com-work", None, "github.com/Org/repo"),
    # ... a real GitHub Enterprise name stays, and an unknown alias is left to gh.
    ("github.corp.example", None, "github.corp.example/Org/repo"),
    ("work", None, "work/Org/repo"),
])
def test_ssh_aliases_resolve_to_their_host(alias, resolved, expected):
    lookup = {alias: resolved} if resolved else {}
    assert ws_pr.repo_from_remote(f"git@{alias}:Org/repo.git", lookup.get) == expected
    assert ws_pr.repo_from_remote(f"ssh://git@{alias}/Org/repo.git", lookup.get) == expected


def test_an_https_host_is_never_read_as_an_alias():
    assert ws_pr.repo_from_remote("https://github-work/Org/repo.git", {"github-work": "gitlab.com"}.get) \
        == "github-work/Org/repo"


def test_insteadof_and_pushinsteadof_follow_git():
    facts = ws_pr.parse_config(config_out(
        ("remote.origin.url", "gh:acme/app"),
        ("url.git@github.com:.insteadof", "gh:"),
        ("url.https://github.com/acme/.insteadof", "gh:acme/"),  # the longer prefix wins
        ("remote.fork.url", "https://github.com/me/app.git"),
        ("url.git@github.com:.pushinsteadof", "https://github.com/"),
        ("remote.mirror.url", "gh:x/y"),
        ("remote.mirror.pushurl", "gh:me/mirror"),
    ))
    assert facts.fetch_url("origin") == "https://github.com/acme/app"
    assert facts.push_url("origin") == "https://github.com/acme/app"
    assert facts.fetch_url("fork") == "https://github.com/me/app.git"
    assert facts.push_url("fork") == "git@github.com:me/app.git"
    # An explicit pushurl gets insteadOf, never pushInsteadOf.
    assert facts.push_url("mirror") == "git@github.com:me/mirror"
    assert facts.remotes == ["origin", "fork", "mirror"]


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
    answer_git(fake, "feature", ORIGIN, ("branch.feature.remote", "origin"),
               ("remote.mine.url", "https://github.com/me/app.git"), ("branch.feature.pushremote", "mine"))
    own_fork = {**FORK, "number": 300, "headRepositoryOwner": {"login": "me"}}
    fake.on(["gh", "pr", "list"], out=json.dumps([FORK, PR, own_fork]))
    assert client.get("/api/ws/demo/pr").json()["pr"]["number"] == 300
    # The PR lives in the upstream remote's repository, not the fork.
    listed = [argv for _, argv in fake.calls if argv[:3] == ["gh", "pr", "list"]][-1]
    assert listed[listed.index("-R") + 1] == "github.com/acme/app"
    # A push remote that is no repository: only same-repository PRs count.
    answer_git(fake, "feature", ORIGIN, ("branch.feature.remote", "origin"),
               ("remote.mine.url", "C:/repos/bare.git"), ("branch.feature.pushremote", "mine"))
    assert client.get("/api/ws/demo/pr").json()["pr"]["number"] == 249
    fake.on(["gh", "pr", "list"], out=json.dumps([FORK, own_fork]))
    assert client.get("/api/ws/demo/pr").json()["pr"] is None


def test_remote_pushdefault_names_the_head_repository(client, fake):
    answer_git(fake, "feature", ORIGIN, ("branch.feature.remote", "origin"),
               ("remote.mine.url", "git@github.com:me/app.git"), ("remote.pushdefault", "mine"))
    own_fork = {**FORK, "number": 300, "headRepositoryOwner": {"login": "me"}}
    fake.on(["gh", "pr", "list"], out=json.dumps([PR, own_fork]))
    assert client.get("/api/ws/demo/pr").json()["pr"]["number"] == 300


def test_a_folder_outside_git_says_so(client, fake):
    fake.on(HEAD, code=128, err="fatal: not a git repository (or any of the parent directories): .git")
    answer = client.get("/api/ws/demo/pr").json()
    assert answer == {"gh": "ok", "pr": None, "checks": [], "reason": "not a git repository"}
    assert not any(argv[0] == "gh" for _, argv in fake.calls)
    assert [argv for _, argv in fake.calls] == [HEAD]


def reason(client) -> str:
    answer = client.get("/api/ws/demo/pr").json()
    assert answer["pr"] is None and answer["gh"] == "ok"
    return answer["reason"]


def test_a_repository_without_remotes(client, fake):
    answer_git(fake, "feature")
    assert reason(client) == "this repository has no remote"
    assert not any(argv[0] == "gh" for _, argv in fake.calls)


@pytest.mark.parametrize("url,expected", [
    ("https://dev.azure.com/org/project/_git/repo",
     "origin is on dev.azure.com; pull requests are shown for GitHub repositories"),
    ("git@ssh.dev.azure.com:v3/org/project/repo",
     "origin is on ssh.dev.azure.com; pull requests are shown for GitHub repositories"),
    ("https://gitlab.com/group/sub/repo.git",
     "origin is on gitlab.com; pull requests are shown for GitHub repositories"),
    ("https://git.corp.example/group/sub/repo.git",
     "origin is on git.corp.example; pull requests are shown for GitHub repositories"),
    ("C:/repos/bare.git", "origin is a folder, not a GitHub repository"),
    ("https://github.com/acme", "origin names no repository on github.com"),
    ("https://bad host/acme/app", "origin has no URL QuickTerm can read"),
    ("", "origin has no URL QuickTerm can read"),
])
def test_a_remote_that_is_not_github_says_where_it_is(client, fake, url, expected):
    answer_git(fake, "integrate/1025a", ("remote.origin.url", url), ("branch.integrate/1025a.remote", "origin"))
    assert reason(client) == expected
    assert not any(argv[0] == "gh" for _, argv in fake.calls)


def test_a_credential_in_a_remote_url_never_reaches_an_answer(client, fake):
    secret = "ghp_s3cretT0ken"
    answer_git(fake, "feature", ("remote.origin.url", f"https://user:{secret}@dev.azure.com/o/p/_git/r"))
    text = reason(client)
    assert secret not in text and "user" not in text
    answer_git(fake, "feature", ("remote.origin.url", f"https://user:{secret}@github.com/acme/app.git"))
    fake.on(["gh", "pr", "list"], code=1,
            err=f"fatal: could not read https://user:{secret}@github.com/acme/app.git\n")
    text = reason(client)
    assert secret not in text and text.startswith("gh could not ask github.com: ")
    fake.on(["gh", "run", "view"], code=1, err=f"failed for https://x:{secret}@github.com/acme/app")
    failed = client.get("/api/ws/demo/pr/log", params={"run": "111"})
    assert failed.status_code == 502 and secret not in failed.text
    listed = [argv for _, argv in fake.calls if argv[0] == "gh"]
    assert listed and not any(secret in word for argv in listed for word in argv)


def test_the_lookup_looks_past_origin(client, fake):
    # origin on Azure, the GitHub repository under another name.
    answer_git(fake, "feature", ("remote.origin.url", "https://dev.azure.com/o/p/_git/r"),
               ("remote.upstream.url", "git@github.com:acme/app.git"))
    assert client.get("/api/ws/demo/pr").json()["pr"]["number"] == 249
    listed = [argv for _, argv in fake.calls if argv[:3] == ["gh", "pr", "list"]][-1]
    assert listed[listed.index("-R") + 1] == "github.com/acme/app"
    # The branch's own upstream remote wins over origin.
    answer_git(fake, "feature", ("remote.origin.url", "git@github.com:other/app.git"),
               ("remote.gh.url", "git@github.com:acme/app.git"), ("branch.feature.remote", "gh"))
    client.get("/api/ws/demo/pr")
    listed = [argv for _, argv in fake.calls if argv[:3] == ["gh", "pr", "list"]][-1]
    assert listed[listed.index("-R") + 1] == "github.com/acme/app"
    # Any GitHub remote at all, when origin and upstream are not.
    answer_git(fake, "feature", ("remote.origin.url", "/srv/git/app.git"),
               ("remote.hub.url", "https://github.com/acme/app"))
    assert client.get("/api/ws/demo/pr").json()["pr"]["number"] == 249


def test_detached_and_unborn_heads(client, fake):
    answer_git(fake, None, ORIGIN)
    assert reason(client) == "no branch checked out"
    fake.on(HEAD, code=128, out="true\nHEAD\n", err="fatal: ambiguous argument 'HEAD': unknown revision")
    assert reason(client) == "the branch has no commits yet"
    assert not any(argv[0] == "gh" for _, argv in fake.calls)


@pytest.mark.parametrize("error,expected", [
    (subprocess.TimeoutExpired(["git"], 30), "git could not be asked: git did not answer within 30 s"),
    (FileNotFoundError(2, "The system cannot find the file specified"), "git could not be asked: git is not installed"),
    (ws_exec.RemoteUnavailable(ws_exec.OPENSSH_MISSING), f"git could not be asked: {ws_exec.OPENSSH_MISSING}"),
])
def test_git_that_cannot_be_asked_says_why(client, fake, monkeypatch, error, expected):
    def broken(ws, argv, **kwargs):
        if argv[0] == "git":
            raise error
        return fake.run(ws, argv, **kwargs)

    monkeypatch.setattr(ws_exec, "run", broken)
    assert reason(client) == expected


def test_an_unreachable_host_or_a_refused_folder_is_not_called_outside_git(client, fake):
    fake.on(HEAD, code=255, err="ssh: connect to host devbox port 22: Connection timed out\n")
    assert reason(client) == "git could not be asked: ssh: connect to host devbox port 22: Connection timed out"
    fake.on(HEAD, code=128, err="fatal: detected dubious ownership in repository at '/mnt/c/x'\n"
                                "To add an exception for this directory, call:\n")
    assert "dubious ownership" in reason(client)
    answer_git(fake, "feature", ORIGIN)
    fake.on(CONFIG, code=3, err="error: invalid config file .git/config\n")
    assert reason(client) == "git could not be asked: error: invalid config file .git/config"


def test_a_pr_status_costs_two_git_calls(client, fake):
    answer_git(fake, "feature", ORIGIN, ("branch.feature.remote", "origin"),
               ("remote.upstream.url", "https://github.com/acme/app"), ("remote.pushdefault", "origin"),
               ("url.git@github.com:.insteadof", "gh:"))
    fake.calls.clear()
    assert client.get("/api/ws/demo/pr").json()["pr"]["number"] == 249
    git_calls = [argv for _, argv in fake.calls if argv[0] == "git"]
    assert git_calls == [HEAD, [*CONFIG, ws_pr.CONFIG_KEYS]]


def test_a_local_alias_resolves_through_this_computers_ssh_config(client, fake, tmp_path, monkeypatch):
    from quickterm import ssh_config
    config = tmp_path / "ssh_config"
    config.write_text("Host work\n  HostName github.com\n  User git\nHost lab\n  HostName gitlab.com\n",
                      encoding="utf-8")
    monkeypatch.setattr(ssh_config, "config_path", lambda: config)
    ws_pr._alias_cache.clear()
    answer_git(fake, "feature", ("remote.origin.url", "git@work:acme/app.git"))
    assert client.get("/api/ws/demo/pr").json()["pr"]["number"] == 249
    answer_git(fake, "feature", ("remote.origin.url", "git@lab:acme/app.git"))
    assert reason(client) == "origin is on gitlab.com; pull requests are shown for GitHub repositories"


def test_a_remote_workspace_reads_no_alias_and_guesses_only_github_names(monkeypatch):
    fake = FakeExec()
    monkeypatch.setattr(ws_exec, "run", fake.run)
    ws_pr._alias_cache.clear()
    ssh_ws = SimpleNamespace(name="x", path="/srv/app", host="devbox")
    answer_git(fake, "feature", ("remote.origin.url", "git@github-work:acme/app.git"))
    found = ws_pr._target(ssh_ws)
    assert found[0].repo == "github.com/acme/app"
    assert [argv[0] for _, argv in fake.calls] == ["git", "git"]
    # WSL reads the distribution's own ssh_config, once a minute at most.
    wsl_ws = SimpleNamespace(name="x", path="/home/me/app", host="wsl:Ubuntu")
    answer_git(fake, "feature", ("remote.origin.url", "git@work:acme/app.git"))
    fake.on(["sh", "-c"], out="Host work\n  HostName github.com\n")
    assert ws_pr._target(wsl_ws)[0].repo == "github.com/acme/app"
    assert ws_pr._target(wsl_ws)[0].repo == "github.com/acme/app"
    assert sum(argv[0] == "sh" for _, argv in fake.calls) == 1


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
    fake.on(HEAD, out="true\nrefs/heads/1234\n")
    old = {**PR, "number": 7, "state": "CLOSED", "headRefName": "1234"}
    current = {**PR, "headRefName": "1234"}
    fake.on(["gh", "pr", "list"], out=json.dumps([old, current]))
    assert client.get("/api/ws/demo/pr").json()["pr"]["number"] == 249
    listed = [argv for _, argv in fake.calls if argv[:3] == ["gh", "pr", "list"]][-1]
    assert "--head=1234" in listed
    fake.on(HEAD, out="true\nrefs/heads/--web\n")
    assert client.get("/api/ws/demo/pr").json()["pr"] is None


def test_a_gh_fork_asks_the_parent_repository(client, fake):
    # `gh repo fork`: origin is yours, upstream the parent, the branch
    # tracks origin, and its pull request goes into the parent.
    answer_git(fake, "feature", ("remote.origin.url", "git@github.com:me/app.git"),
               ("remote.upstream.url", "https://github.com/acme/app.git"), ("branch.feature.remote", "origin"))
    own_fork = {**FORK, "number": 300, "headRepositoryOwner": {"login": "me"}}
    fake.on(["gh", "pr", "list"], out=json.dumps([own_fork]))
    assert client.get("/api/ws/demo/pr").json()["pr"]["number"] == 300
    listed = [argv for _, argv in fake.calls if argv[:3] == ["gh", "pr", "list"]][-1]
    assert listed[listed.index("-R") + 1] == "github.com/acme/app"


def test_a_password_with_an_at_sign_is_scrubbed_whole():
    text = "fatal: https://user:p@ss@github.com/acme/app.git and ssh://git@host/x"
    assert ws_pr._scrub(text) == "fatal: https://github.com/acme/app.git and ssh://host/x"
