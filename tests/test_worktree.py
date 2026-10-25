"""POST /api/workspaces/worktree and its helpers (CONTRACTS.md, 4.2)."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from quickterm import worktree
from quickterm import workspace as workspace_mod
from quickterm.server import create_app
from tests.test_server import FakeConfig, FakeSessionManager

needs_git = pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
GIT_CFG = ["-c", "user.name=t", "-c", "user.email=t@example.invalid",
           "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"]


def git(cwd: Path, *args: str) -> str:
    result = subprocess.run(["git", *GIT_CFG, "-C", str(cwd), *args],
                            check=True, capture_output=True, text=True)
    return result.stdout.strip()


@pytest.fixture
def repo(tmp_path) -> Path:
    main = tmp_path / "src" / "proj"
    main.mkdir(parents=True)
    git(main, "init", "-q")
    (main / "uv.lock").write_text("")
    (main / "README").write_text("hi\n")
    git(main, "add", ".")
    git(main, "commit", "-q", "-m", "first")
    return main


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    monkeypatch.setattr(workspace_mod, "_NAMESPACE", None)
    with TestClient(create_app(FakeSessionManager(), FakeConfig()),
                    base_url="http://127.0.0.1:8620") as c:
        yield c


def put(client, name: str, path: str | None) -> None:
    from urllib.parse import quote

    response = client.put(f"/api/workspaces/{quote(name, safe='')}",
                          json={"layout": {}, "path": path})
    assert response.status_code == 204


# --- validation, slug, setup ------------------------------------------------


@pytest.mark.parametrize("name", [
    "feature/x", "fix-1", "a.b", "user/name/topic", "UPPER_case",
])
def test_good_branch_names_pass(name):
    assert worktree.validate_branch(name) == name


@pytest.mark.parametrize("name", [
    "", "-x", "--force", "a b", "a\tb", "a\nb", "a..b", "a~1", "a^", "a:b", "a?", "a*",
    "a[b", "a\\b", "a/", "/a", "a.", "a//b", "a@{1}", "@", ".hidden", "a/.b", "x.lock",
    "a/b.lock/c", "a\x7f", 5, None, "x" * 201,
])
def test_bad_branch_names_are_refused(name):
    with pytest.raises(worktree.WorktreeError) as info:
        worktree.validate_branch(name)
    assert info.value.status == 400


@pytest.mark.parametrize("base,expected", [
    (None, None), ("", None), ("  ", None), ("main", "main"), ("origin/main", "origin/main"),
])
def test_base_accepts_refs_and_blank(base, expected):
    assert worktree.validate_base(base) == expected


@pytest.mark.parametrize("base", ["-x", "--upload-pack=x", "a b", 3, "x" * 257])
def test_base_refuses_options_and_whitespace(base):
    with pytest.raises(worktree.WorktreeError):
        worktree.validate_base(base)


@pytest.mark.parametrize("branch,slug", [
    ("feature/x", "feature-x"), ("a/b/c", "a-b-c"), ("fix-1", "fix-1"),
    ("we+ird", "we-ird"), ("über", "ber"),
])
def test_branch_slug(branch, slug):
    assert worktree.branch_slug(branch) == slug


def test_slug_with_nothing_left_is_refused():
    with pytest.raises(worktree.WorktreeError):
        worktree.branch_slug("+++")


def test_setup_detection_order(tmp_path):
    assert worktree.detect_setup(tmp_path) is None
    for lockfile in ("poetry.lock", "yarn.lock", "pnpm-lock.yaml", "package-lock.json", "uv.lock"):
        (tmp_path / lockfile).write_text("")
        assert worktree.detect_setup(tmp_path)["source"] == lockfile
    assert worktree.detect_setup(tmp_path) == {"command": "uv sync", "source": "uv.lock"}
    (tmp_path / "uv.lock").unlink()
    assert worktree.detect_setup(tmp_path) == {"command": "npm ci", "source": "package-lock.json"}


def test_missing_git_is_a_clear_400(tmp_path, monkeypatch):
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
    monkeypatch.setattr(worktree.shutil, "which", lambda name: None)
    with pytest.raises(worktree.WorktreeError) as info:
        worktree.create_worktree(str(tmp_path), "x")
    assert info.value.status == 400 and "git" in info.value.message


def test_git_runs_without_a_window_or_a_shell(tmp_path, monkeypatch):
    seen = {}

    def fake_run(argv, **kwargs):
        seen["argv"], seen["kwargs"] = argv, kwargs
        return subprocess.CompletedProcess(argv, 0, b"", b"")

    monkeypatch.setattr(worktree.subprocess, "run", fake_run)
    worktree._run("git", tmp_path, ["status"], 1.0)
    assert isinstance(seen["argv"], list) and "shell" not in seen["kwargs"]
    assert seen["kwargs"]["stdin"] is subprocess.DEVNULL
    assert seen["kwargs"]["env"]["GIT_TERMINAL_PROMPT"] == "0"
    assert seen["kwargs"]["creationflags"] == getattr(subprocess, "CREATE_NO_WINDOW", 0)


def test_a_git_timeout_becomes_an_error(tmp_path, monkeypatch):
    def slow(argv, **kwargs):
        raise subprocess.TimeoutExpired(argv, kwargs["timeout"])

    monkeypatch.setattr(worktree.subprocess, "run", slow)
    with pytest.raises(worktree.WorktreeError) as info:
        worktree._run("git", tmp_path, ["worktree"], 1.0)
    assert info.value.status == 500


# --- real git -----------------------------------------------------------------


@needs_git
def test_create_worktree_next_to_the_main_checkout(repo):
    created = worktree.create_worktree(str(repo), "feature/x")
    target = repo.parent / "proj-feature-x"
    assert created.path == str(target)
    assert created.setup == {"command": "uv sync", "source": "uv.lock"}
    assert git(target, "rev-parse", "--abbrev-ref", "HEAD") == "feature/x"


@needs_git
def test_create_from_a_subfolder_and_from_a_linked_worktree(repo):
    sub = repo / "deep"
    sub.mkdir()
    first = worktree.create_worktree(str(sub), "one")
    # A worktree made from a worktree still lands next to the MAIN checkout.
    second = worktree.create_worktree(first.path, "two")
    assert Path(second.path) == repo.parent / "proj-two"
    # The default base is the source checkout's HEAD.
    assert git(Path(second.path), "rev-parse", "HEAD") == git(repo, "rev-parse", "HEAD")


@needs_git
def test_create_from_a_base(repo):
    first = git(repo, "rev-parse", "HEAD")
    (repo / "README").write_text("two\n")
    git(repo, "commit", "-qam", "second")
    created = worktree.create_worktree(str(repo), "old", base=first)
    assert git(Path(created.path), "rev-parse", "HEAD") == first


@needs_git
def test_existing_branch_or_folder_is_409(repo):
    git(repo, "branch", "taken")
    with pytest.raises(worktree.WorktreeError) as info:
        worktree.create_worktree(str(repo), "taken")
    assert info.value.status == 409
    (repo.parent / "proj-free").mkdir()
    with pytest.raises(worktree.WorktreeError) as info:
        worktree.create_worktree(str(repo), "free")
    assert info.value.status == 409


@needs_git
def test_unknown_base_and_no_repository_are_400(repo, tmp_path):
    with pytest.raises(worktree.WorktreeError) as info:
        worktree.create_worktree(str(repo), "x", base="no-such-ref")
    assert info.value.status == 400
    plain = tmp_path / "plain"
    plain.mkdir()
    with pytest.raises(worktree.WorktreeError) as info:
        worktree.create_worktree(str(plain), "x")
    assert info.value.status == 400
    with pytest.raises(worktree.WorktreeError) as info:
        worktree.create_worktree(None, "x")
    assert info.value.status == 400


# --- route --------------------------------------------------------------------


@needs_git
def test_route_creates_worktree_and_workspace(client, repo):
    put(client, "proj", str(repo))
    response = client.post("/api/workspaces/worktree", json={"from": "proj", "branch": "feature/x"})
    assert response.status_code == 201, response.text
    body = response.json()
    target = str(repo.parent / "proj-feature-x")
    assert body == {"workspace": "proj/feature-x", "path": target,
                    "setup": {"command": "uv sync", "source": "uv.lock"}}
    assert "proj/feature-x" in client.get("/api/workspaces").json()
    saved = client.get("/api/workspaces/proj%2Ffeature-x").json()
    assert saved["path"] == target
    assert saved["layout"] == {}
    assert saved["git"] == {"branch": "feature/x", "head": None, "worktree": True,
                            "main_path": str(repo)}
    # The same request again: the branch and the folder now exist.
    again = client.post("/api/workspaces/worktree", json={"from": "proj", "branch": "feature/x"})
    assert again.status_code == 409


def test_route_errors(client, tmp_path, monkeypatch):
    assert client.post("/api/workspaces/worktree",
                       json={"from": "nope", "branch": "x"}).status_code == 404
    put(client, "plain", str(tmp_path))
    assert client.post("/api/workspaces/worktree",
                       json={"from": "plain", "branch": "-x"}).status_code == 400
    assert client.post("/api/workspaces/worktree",
                       json={"from": "plain", "branch": "x", "base": "--all"}).status_code == 400
    assert client.post("/api/workspaces/worktree", json={"branch": "x"}).status_code == 400
    assert client.post("/api/workspaces/worktree", json=[1]).status_code == 400
    put(client, "nofolder", None)
    response = client.post("/api/workspaces/worktree", json={"from": "nofolder", "branch": "x"})
    assert response.status_code == 400
    assert "git repository" in response.json()["detail"]


def test_route_refuses_an_existing_workspace_name(client, tmp_path, monkeypatch):
    put(client, "proj", str(tmp_path))
    put(client, "proj/feature-x", str(tmp_path))
    called = []
    monkeypatch.setattr(worktree, "create_worktree", lambda *a: called.append(a))
    response = client.post("/api/workspaces/worktree", json={"from": "proj", "branch": "feature/x"})
    assert response.status_code == 409
    assert called == []


def test_workspace_names_with_a_slash_round_trip(client, tmp_path):
    put(client, "a/b", str(tmp_path))
    assert client.get("/api/workspaces").json() == ["a/b"]
    assert client.get("/api/workspaces/a%2Fb").json()["name"] == "a/b"
    assert client.patch("/api/workspaces/a%2Fb", json={"logo": None}).status_code == 204
    assert client.delete("/api/workspaces/a%2Fb").status_code == 204
    assert client.get("/api/workspaces").json() == []
