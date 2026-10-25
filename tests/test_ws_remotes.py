"""The right panel against real git for every kind of remote: the Changes
head (branch and upstream), the Pull request tab's reason, and how many git
processes one refresh costs."""

from __future__ import annotations

import shutil
import subprocess
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from quickterm import ssh_config, ws_exec, ws_git, ws_pr
from quickterm import workspace as workspace_mod
from quickterm.server import create_app
from tests.test_server import FakeConfig, FakeSessionManager
from tests.test_ws_panel import BASE, git, save, write

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")

BRANCH = "integrate/1025a"


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    monkeypatch.setattr(workspace_mod, "_NAMESPACE", None)
    empty = tmp_path / "gitconfig"
    empty.write_text("", encoding="utf-8")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(empty))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for key, value in {
        "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.invalid",
        "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.invalid",
    }.items():
        monkeypatch.setenv(key, value)
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        monkeypatch.delenv(key, raising=False)
    ssh = tmp_path / "ssh_config"
    ssh.write_text("Host github-work\n  HostName github.com\n  User git\n", encoding="utf-8")
    monkeypatch.setattr(ssh_config, "config_path", lambda: ssh)
    ws_pr._alias_cache.clear()
    ws_pr._methods_cache.clear()


@pytest.fixture
def gh(monkeypatch):
    """gh answers "no pull request" and records what it was asked."""
    asked: list[list[str]] = []

    def fake(args, timeout=ws_pr.TIMEOUT):
        asked.append(list(args))
        return subprocess.CompletedProcess(args, 0, "[]", "")

    monkeypatch.setattr(ws_pr, "_gh", fake)
    return asked


@pytest.fixture
def calls(monkeypatch):
    """Every program ws_exec runs, by argv, while the real one runs it."""
    seen: list[list[str]] = []
    real = ws_exec.run

    def counting(ws, argv, **kwargs):
        seen.append(list(argv))
        return real(ws, argv, **kwargs)

    monkeypatch.setattr(ws_exec, "run", counting)
    return seen


@pytest.fixture
def client():
    with TestClient(create_app(FakeSessionManager(), FakeConfig()), base_url=BASE) as c:
        yield c


def make_repo(tmp_path: Path, *, remote: bool = True) -> Path:
    """A repository on BRANCH; with `remote`, pushed to a bare origin with
    an upstream and origin/HEAD, like a clone."""
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-q")
    write(root / "README.md", "# demo\n")
    git(root, "add", ".")
    git(root, "commit", "-q", "-m", "init")
    if remote:
        bare = tmp_path / "origin.git"
        git(tmp_path, "init", "-q", "--bare", str(bare))
        git(root, "remote", "add", "origin", str(bare))
        git(root, "push", "-q", "-u", "origin", "main")
        git(root, "remote", "set-head", "origin", "main")
    git(root, "checkout", "-q", "-b", BRANCH)
    write(root / "work.txt", "one\ntwo\n")
    git(root, "add", ".")
    git(root, "commit", "-q", "-m", "work")
    if remote:
        git(root, "push", "-q", "-u", "origin", BRANCH)
    return root


def git_calls(seen: list[list[str]]) -> list[list[str]]:
    return [argv for argv in seen if "git" in argv[:1]]


@pytest.mark.parametrize("url,reason,repo", [
    (None, "origin is a folder, not a GitHub repository", None),
    ("https://dev.azure.com/acme/project/_git/app",
     "origin is on dev.azure.com; pull requests are shown for GitHub repositories", None),
    ("git@gitlab.com:acme/platform/app.git",
     "origin is on gitlab.com; pull requests are shown for GitHub repositories", None),
    ("git@github-work:Acme/app.git", ws_pr.NO_PR, "github.com/Acme/app"),
    ("ssh://git@ssh.github.com:443/Acme/app.git", ws_pr.NO_PR, "github.com/Acme/app"),
    ("https://user:ghp_secret@github.com/Acme/app.git", ws_pr.NO_PR, "github.com/Acme/app"),
])
def test_branch_upstream_and_pr_reason_for_each_remote(tmp_path, client, gh, url, reason, repo):
    root = make_repo(tmp_path)
    if url:
        # The upstream stays: origin/<branch> was fetched before the URL changed.
        git(root, "remote", "set-url", "origin", url)
    base = save(client, "demo", root)
    changes = client.get(f"{base}/changes").json()
    assert (changes["branch"], changes["upstream"], changes["base"]) == (BRANCH, f"origin/{BRANCH}", "origin/main")
    assert (changes["ahead"], changes["behind"]) == (0, 0)
    assert [entry["path"] for entry in changes["files"] if entry["group"] == "committed"] == ["work.txt"]
    pr = client.get(f"{base}/pr").json()
    assert pr["gh"] == "ok" and pr["pr"] is None and pr["reason"] == reason
    assert "secret" not in str(pr)
    if repo is None:
        assert gh == []
    else:
        assert gh[-1][gh[-1].index("-R") + 1] == repo and f"--head={BRANCH}" in gh[-1]


def test_a_repository_without_a_remote(tmp_path, client, gh):
    root = make_repo(tmp_path, remote=False)
    base = save(client, "demo", root)
    changes = client.get(f"{base}/changes").json()
    assert (changes["branch"], changes["upstream"], changes["base"]) == (BRANCH, None, "main")
    # Without an upstream, ahead counts the commits past the base branch.
    assert (changes["ahead"], changes["behind"]) == (1, 0)
    assert client.get(f"{base}/pr").json()["reason"] == "this repository has no remote"
    assert gh == []


def test_a_detached_head(tmp_path, client, gh):
    root = make_repo(tmp_path)
    git(root, "remote", "set-url", "origin", "git@github.com:Acme/app.git")
    git(root, "checkout", "-q", "--detach")
    base = save(client, "demo", root)
    changes = client.get(f"{base}/changes").json()
    assert (changes["branch"], changes["upstream"], changes["base"]) == (None, None, "origin/main")
    assert client.get(f"{base}/pr").json()["reason"] == "no branch checked out"
    assert gh == []


def test_an_unborn_branch(tmp_path, client, gh):
    root = tmp_path / "fresh"
    root.mkdir()
    git(root, "init", "-q")
    git(root, "remote", "add", "origin", "https://github.com/Acme/app.git")
    base = save(client, "demo", root)
    assert client.get(f"{base}/pr").json()["reason"] == "the branch has no commits yet"


def test_insteadof_in_the_users_config_is_honoured(tmp_path, client, gh):
    root = make_repo(tmp_path)
    git(root, "remote", "set-url", "origin", "corp:Acme/app")
    git(root, "config", "url.git@github.com:.insteadOf", "corp:")
    base = save(client, "demo", root)
    assert client.get(f"{base}/pr").json()["reason"] == ws_pr.NO_PR
    assert gh[-1][gh[-1].index("-R") + 1] == "github.com/Acme/app"


# --- what one refresh costs ---------------------------------------------------------


def test_a_pr_refresh_is_two_git_calls(tmp_path, client, gh, calls):
    root = make_repo(tmp_path)
    git(root, "remote", "set-url", "origin", "git@github.com:Acme/app.git")
    base = save(client, "demo", root)
    calls.clear()
    assert client.get(f"{base}/pr").json()["reason"] == ws_pr.NO_PR
    assert len(git_calls(calls)) == 2


def test_a_changes_refresh_is_seven_git_calls(tmp_path, client, calls):
    root = make_repo(tmp_path)
    base = save(client, "demo", root)
    calls.clear()
    client.get(f"{base}/changes")
    # filters, prefix, status, two numstats, the base, the branch's commits.
    assert len(git_calls(calls)) == 7
    # A repository without origin/HEAD finds its base in the same one call.
    git(root, "remote", "set-head", "origin", "--delete")
    calls.clear()
    assert client.get(f"{base}/changes").json()["base"] == "origin/main"
    assert len(git_calls(calls)) == 7


@pytest.mark.parametrize("refs,expected", [
    ((), None),
    (("refs/heads/master",), "master"),
    (("refs/heads/master", "refs/heads/main"), "main"),
    (("refs/heads/main", "refs/remotes/origin/master"), "origin/master"),
    (("refs/remotes/origin/master", "refs/remotes/origin/main"), "origin/main"),
])
def test_the_base_branch_order(tmp_path, refs, expected, calls):
    root = tmp_path / "refs"
    root.mkdir()
    git(root, "init", "-q")
    git(root, "commit", "-q", "--allow-empty", "-m", "x")
    head = git(root, "rev-parse", "HEAD").strip()
    git(root, "checkout", "-q", "--detach")
    for ref in ("refs/heads/main", "refs/heads/master"):
        git(root, "update-ref", "-d", ref)
    for ref in refs:
        git(root, "update-ref", ref, head)
    if "refs/heads/main" not in refs:
        # for-each-ref matches a pattern up to a slash: a branch below the
        # candidate's name is not the candidate.
        git(root, "update-ref", "refs/heads/main/old", head)
    ws = SimpleNamespace(name="x", path=str(root), host=None)
    ws_git.refresh_filters(ws)
    calls.clear()
    assert ws_git.base_branch(ws) == expected
    assert len(git_calls(calls)) == 1


def test_a_branch_without_a_merge_base_has_no_commits_on_it(tmp_path, client):
    root = make_repo(tmp_path)
    git(root, "checkout", "-q", "--orphan", "island")
    git(root, "commit", "-q", "-m", "island")
    base = save(client, "demo", root)
    changes = client.get(f"{base}/changes").json()
    assert changes["branch"] == "island" and not [e for e in changes["files"] if e["group"] == "committed"]
    diff = client.get(f"{base}/diff", params={"path": "work.txt", "group": "committed"}).json()
    assert diff == {"text": "", "truncated": False, "lines": 0}


def test_renames_on_the_branch_keep_their_letter_and_counts(tmp_path, client):
    root = make_repo(tmp_path)
    git(root, "checkout", "-q", "main")
    write(root / "big.txt", "".join(f"line {n}\n" for n in range(40)))
    git(root, "add", ".")
    git(root, "commit", "-q", "-m", "big")
    git(root, "push", "-q", "origin", "main")
    git(root, "checkout", "-q", BRANCH)
    git(root, "merge", "-q", "--no-edit", "main")
    git(root, "mv", "big.txt", "moved.txt")
    write(root / "moved.txt", "".join(f"line {n}\n" for n in range(41)))
    git(root, "commit", "-q", "-am", "move")
    base = save(client, "demo", root)
    committed = {e["path"]: e for e in client.get(f"{base}/changes").json()["files"] if e["group"] == "committed"}
    assert set(committed) == {"work.txt", "moved.txt"}
    assert (committed["moved.txt"]["status"], committed["moved.txt"]["added"]) == ("R", 1)
    assert (committed["work.txt"]["status"], committed["work.txt"]["added"]) == ("A", 2)


def test_raw_numstat_reads_both_sections():
    output = "\0".join([
        ":100644 100644 aaa bbb M", "src/a.py",
        ":000000 100644 000 ccc A", "new.txt",
        ":100644 100644 ddd eee R087", "old.txt", "renamed.txt",
        "3\t1\tsrc/a.py", "2\t0\tnew.txt", "5\t2\t", "old.txt", "renamed.txt",
        "-\t-\t", "",
    ])
    letters, numbers = ws_git._raw_numstat(output)
    assert letters == {"src/a.py": "M", "new.txt": "A", "renamed.txt": "R"}
    assert numbers["src/a.py"] == (3, 1) and numbers["new.txt"] == (2, 0) and numbers["renamed.txt"] == (5, 2)


def test_open_folders_listed_together_share_one_setup(tmp_path, calls, monkeypatch):
    root = make_repo(tmp_path)
    for folder in ("a", "b", "c", "d"):
        write(root / folder / "f.txt", "x\n")
    ws = SimpleNamespace(name="x", path=str(root), host=None)
    counting = ws_exec.run

    def slow(ws_, argv, **kwargs):
        # Hold the shared setup long enough for every request to join it.
        if "--show-prefix" in argv:
            time.sleep(0.3)
        return counting(ws_, argv, **kwargs)

    monkeypatch.setattr(ws_exec, "run", slow)
    calls.clear()
    threads = [threading.Thread(target=ws_git.tree_marks, args=(ws, folder)) for folder in "abcd"]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    filters = [argv for argv in calls if "^filter\\." in argv]
    prefixes = [argv for argv in calls if "--show-prefix" in argv]
    statuses = [argv for argv in calls if "status" in argv]
    assert (len(filters), len(prefixes), len(statuses)) == (1, 1, 4)
    # The next refresh asks again: nothing is kept between refreshes.
    ws_git.tree_marks(ws, "a")
    assert len([argv for argv in calls if "^filter\\." in argv]) == 2
