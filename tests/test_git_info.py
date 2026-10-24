"""git_info reads `.git` and HEAD without starting git (CONTRACTS.md, 4.2)."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from fastapi.testclient import TestClient

from quickterm import git_info
from quickterm import workspace as workspace_mod
from quickterm.server import create_app
from tests.test_server import FakeConfig, FakeSessionManager

SHA = "0123456789abcdef0123456789abcdef01234567"


@pytest.fixture
def client(tmp_path, monkeypatch):
    # The real workspace store, kept in tmp_path rather than %APPDATA%.
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    monkeypatch.setattr(workspace_mod, "_NAMESPACE", None)
    with TestClient(create_app(FakeSessionManager(), FakeConfig()),
                    base_url="http://127.0.0.1:8620") as c:
        yield c


def _main_repo(root: Path, head: str = "ref: refs/heads/main\n") -> Path:
    (root / ".git").mkdir(parents=True)
    (root / ".git" / "HEAD").write_text(head)
    return root


def _linked(root: Path, main: Path, name: str, head: str) -> Path:
    git_dir = main / ".git" / "worktrees" / name
    git_dir.mkdir(parents=True)
    (git_dir / "HEAD").write_text(head)
    (git_dir / "commondir").write_text("../..\n")
    root.mkdir(parents=True)
    (root / ".git").write_text(f"gitdir: {git_dir}\n")
    return root


def test_main_checkout_on_a_branch(tmp_path):
    repo = _main_repo(tmp_path / "proj")
    assert git_info.git_info(str(repo)) == {
        "branch": "main", "head": None, "worktree": False, "main_path": None,
    }


def test_branch_names_keep_their_slashes(tmp_path):
    repo = _main_repo(tmp_path / "proj", "ref: refs/heads/feature/x\n")
    assert git_info.git_info(str(repo))["branch"] == "feature/x"


def test_detached_head_reports_a_short_sha(tmp_path):
    repo = _main_repo(tmp_path / "proj", SHA + "\n")
    assert git_info.git_info(str(repo)) == {
        "branch": None, "head": "0123456", "worktree": False, "main_path": None,
    }


def test_a_subfolder_finds_the_repository_above_it(tmp_path):
    repo = _main_repo(tmp_path / "proj")
    sub = repo / "src" / "pkg"
    sub.mkdir(parents=True)
    assert git_info.git_info(str(sub))["branch"] == "main"


def test_linked_worktree_points_back_at_the_main_checkout(tmp_path):
    main = _main_repo(tmp_path / "proj")
    linked = _linked(tmp_path / "proj-x", main, "proj-x", "ref: refs/heads/x\n")
    assert git_info.git_info(str(linked)) == {
        "branch": "x", "head": None, "worktree": True, "main_path": str(main),
    }


def test_relative_gitdir_resolves_against_the_checkout(tmp_path):
    main = _main_repo(tmp_path / "proj")
    linked = _linked(tmp_path / "proj-y", main, "proj-y", "ref: refs/heads/y\n")
    (linked / ".git").write_text("gitdir: ../proj/.git/worktrees/proj-y\n")
    assert git_info.git_info(str(linked))["main_path"] == str(main)


def test_a_submodule_is_its_own_repository_not_a_worktree(tmp_path):
    main = _main_repo(tmp_path / "proj")
    modules = main / ".git" / "modules" / "lib"
    modules.mkdir(parents=True)
    (modules / "HEAD").write_text(SHA)
    sub = main / "lib"
    sub.mkdir()
    (sub / ".git").write_text(f"gitdir: {modules}\n")
    info = git_info.git_info(str(sub))
    assert info["worktree"] is False and info["head"] == "0123456"


@pytest.mark.parametrize("value", [None, "", "relative/that/does/not/exist"])
def test_no_folder_means_no_info(value):
    assert git_info.git_info(value) is None


def test_a_folder_outside_any_repository(tmp_path):
    plain = tmp_path / "plain"
    plain.mkdir()
    assert git_info.git_info(str(plain)) is None


def test_unreadable_or_oversized_files_are_not_git(tmp_path):
    folder = tmp_path / "odd"
    folder.mkdir()
    (folder / ".git").write_text("gitdir: " + "x" * 5000)
    assert git_info._repo_at(folder) is None
    (folder / ".git").write_text("not a gitdir line")
    assert git_info._repo_at(folder) is None


def test_a_dot_git_folder_without_head_is_ignored(tmp_path):
    folder = tmp_path / "half"
    (folder / ".git").mkdir(parents=True)
    assert git_info._repo_at(folder) is None


def test_garbage_head_reports_neither_branch_nor_sha(tmp_path):
    repo = _main_repo(tmp_path / "proj", "ref: refs/remotes/origin/x")
    assert git_info.git_info(str(repo))["branch"] is None
    (repo / ".git" / "HEAD").write_text("nonsense")
    assert git_info.git_info(str(repo)) == {
        "branch": None, "head": None, "worktree": False, "main_path": None,
    }


def test_listing_never_starts_a_process(tmp_path, monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("git_info must not start a process")

    monkeypatch.setattr(subprocess, "Popen", refuse)
    repo = _main_repo(tmp_path / "proj")
    assert git_info.git_info(str(repo))["branch"] == "main"


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_matches_a_real_git_worktree(tmp_path):
    main = tmp_path / "real"
    main.mkdir()
    env_cfg = ["-c", "user.name=t", "-c", "user.email=t@example.invalid",
               "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"]
    subprocess.run(["git", *env_cfg, "init", "-q", str(main)], check=True)
    subprocess.run(["git", *env_cfg, "-C", str(main), "commit", "-q", "--allow-empty", "-m", "a"],
                   check=True)
    linked = tmp_path / "real-feature-x"
    subprocess.run(["git", "-C", str(main), "worktree", "add", "-q", "-b", "feature/x",
                    str(linked)], check=True)
    assert git_info.git_info(str(main))["branch"] == "main"
    info = git_info.git_info(str(linked))
    assert info["branch"] == "feature/x"
    assert info["worktree"] is True
    assert Path(info["main_path"]).resolve() == main.resolve()


# --- routes -----------------------------------------------------------------


def test_post_git_info_answers_per_path_as_sent(client, tmp_path):
    repo = _main_repo(tmp_path / "proj")
    plain = tmp_path / "plain-folder"
    plain.mkdir()
    paths = [str(repo), str(tmp_path / "missing"), ""]
    response = client.post("/api/git/info", json={"paths": paths})
    assert response.status_code == 200
    body = response.json()
    assert set(body) == set(paths)
    assert body[str(repo)]["branch"] == "main"
    assert body[str(tmp_path / "missing")] is None
    assert body[""] is None


@pytest.mark.parametrize("body", [{}, {"paths": "x"}, {"paths": [1]}, [], {"paths": None}])
def test_post_git_info_rejects_bad_bodies(client, body):
    assert client.post("/api/git/info", json=body).status_code == 400


def test_post_git_info_caps_the_path_count(client):
    assert client.post("/api/git/info", json={"paths": ["x"] * 256}).status_code == 200
    assert client.post("/api/git/info", json={"paths": ["x"] * 257}).status_code == 400


def test_get_workspace_carries_git(client, tmp_path):
    repo = _main_repo(tmp_path / "proj")
    assert client.put("/api/workspaces/dev", json={"layout": {}, "path": str(repo)}).status_code == 204
    assert client.put("/api/workspaces/none", json={"layout": {}}).status_code == 204
    assert client.get("/api/workspaces/dev").json()["git"]["branch"] == "main"
    assert client.get("/api/workspaces/none").json()["git"] is None
