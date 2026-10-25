"""The right panel's routes (CONTRACTS.md, 4.3 round 2, "The right panel"):
path rules, the file tree, search, the file view, changes, diffs, staging and
commit/push, against real git in a temporary repository."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from quickterm import workspace as workspace_mod
from quickterm import ws_files, ws_git
from quickterm.server import create_app
from tests.test_server import FakeConfig, FakeSessionManager

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")

BASE = "http://127.0.0.1:8620"


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    monkeypatch.setattr(workspace_mod, "_NAMESPACE", None)
    # The user's own git config (signing, hooks path, templates) stays out.
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


def git(cwd: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-c", "init.defaultBranch=main", "-c", "core.autocrlf=false", *args],
        cwd=cwd, capture_output=True, text=True, encoding="utf-8", check=True,
    )
    return result.stdout


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode("utf-8"))


@pytest.fixture
def repo(tmp_path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-q")
    git(root, "config", "core.autocrlf", "false")
    write(root / ".gitignore", "build/\n*.log\n")
    write(root / "README.md", "# demo\nhello world\n")
    write(root / "src" / "app.py", "print('hello')\n")
    git(root, "add", ".")
    git(root, "commit", "-q", "-m", "init")
    return root


@pytest.fixture
def remote(tmp_path, repo) -> Path:
    bare = tmp_path / "remote.git"
    git(tmp_path, "init", "-q", "--bare", str(bare))
    git(repo, "remote", "add", "origin", str(bare))
    git(repo, "push", "-q", "-u", "origin", "main")
    git(repo, "remote", "set-head", "origin", "main")
    return bare


@pytest.fixture
def client():
    with TestClient(create_app(FakeSessionManager(), FakeConfig()), base_url=BASE) as c:
        yield c


def save(client, name: str, path: Path) -> str:
    response = client.put(f"/api/workspaces/{quote(name, safe='')}", json={"layout": {}, "path": str(path)})
    assert response.status_code == 204, response.text
    return f"/api/ws/{quote(name, safe='')}"


# --- path rules -------------------------------------------------------------


@pytest.mark.parametrize("value,expected", [
    (None, ""), ("", ""), (".", ""), ("a//b/./c", "a/b/c"), ("a\\b", "a/b"),
    ("a/../b", "b"), ("src/", "src"), (".github/workflows", ".github/workflows"),
    (".gitignore", ".gitignore"),
])
def test_clean_rel_normalises(value, expected):
    assert ws_files.clean_rel(value) == expected


@pytest.mark.parametrize("value", [
    "..", "../x", "a/../../x", "a/b/../../..",
    "/etc/passwd", "\\Windows", "C:\\Windows", "C:/Windows", "c:relative", "C:",
    "\\\\server\\share\\x", "//server/share/x", "\\\\?\\C:\\x",
    ".git", ".git/config", "sub/.git/HEAD", ".GIT/config", "sub/.git./x", "sub/.git /x",
    "a:stream", "a\0b", "a\nb", "...", 42, ["a"],
    "GIT~1/config", "git~1", "sub/Git~12/HEAD", "GIT~1./index",
])
def test_clean_rel_refuses(value):
    with pytest.raises(ws_files.PathError):
        ws_files.clean_rel(value)


def test_clean_rel_refuses_the_folder_itself_where_a_file_is_needed():
    with pytest.raises(ws_files.PathError):
        ws_files.clean_rel("./", allow_root=False)


def _link_out(link: Path, target: Path) -> bool:
    """A directory link inside the folder pointing out of it: a junction on
    Windows (no privilege needed), a symlink elsewhere."""
    try:
        if sys.platform == "win32":
            import _winapi

            _winapi.CreateJunction(str(target), str(link))
        else:
            link.symlink_to(target, target_is_directory=True)
    except OSError:
        return False
    return True


def test_a_link_out_of_the_folder_is_refused(tmp_path, repo, client):
    outside = tmp_path / "outside"
    write(outside / "secret.txt", "secret\n")
    if not _link_out(repo / "escape", outside):
        pytest.skip("cannot create a directory link here")
    folder = ws_files.LocalFolder(str(repo))
    with pytest.raises(ws_files.PathError):
        folder.resolve("escape/secret.txt")
    base = save(client, "demo", repo)
    assert client.get(f"{base}/file", params={"path": "escape/secret.txt"}).status_code == 400
    assert client.get(f"{base}/files", params={"dir": "escape"}).status_code == 400


def test_a_link_into_git_is_refused(repo):
    if not _link_out(repo / "meta", repo / ".git"):
        pytest.skip("cannot create a directory link here")
    with pytest.raises(ws_files.PathError):
        ws_files.LocalFolder(str(repo)).resolve("meta/config")


@pytest.mark.parametrize("bad", ["..", "../x", "C:\\Windows", "\\\\srv\\share", ".git/config", "/etc"])
def test_every_route_refuses_a_path_outside_the_folder(tmp_path, client, bad):
    (tmp_path / "plain").mkdir()
    base = save(client, "demo", tmp_path / "plain")
    assert client.get(f"{base}/files", params={"dir": bad}).status_code == 400
    assert client.get(f"{base}/file", params={"path": bad}).status_code == 400
    assert client.get(f"{base}/diff", params={"path": bad}).status_code == 400
    response = client.post(f"{base}/changes", json={"action": "stage", "paths": [bad]})
    assert response.status_code == 400


SHORT_GIT = ["GIT~1/HEAD", "GIT~1/config", "GIT~1/index"]


def test_the_short_name_of_git_reaches_nothing(repo, client):
    """GIT~1 is .git under its 8.3 name: git and Windows both resolve it."""
    base = save(client, "demo", repo)
    before = {name: (repo / ".git" / name.split("/")[1]).read_bytes() for name in SHORT_GIT}
    assert client.post(f"{base}/changes", json={"action": "discard", "paths": SHORT_GIT}).status_code == 400
    assert client.post(f"{base}/changes", json={"action": "stage", "paths": SHORT_GIT}).status_code == 400
    assert client.get(f"{base}/diff", params={"path": "GIT~1/config", "group": "changes"}).status_code == 400
    assert client.get(f"{base}/file", params={"path": "GIT~1/config"}).status_code == 400
    assert client.get(f"{base}/files", params={"dir": "GIT~1"}).status_code == 400
    assert {name: (repo / ".git" / name.split("/")[1]).read_bytes() for name in SHORT_GIT} == before
    assert git(repo, "log", "--format=%s").splitlines() == ["init"]


def test_git_calls_resolve_every_path_before_git_sees_it(repo):
    """The second gate: a caller that skipped clean_rel still cannot hand git
    a path that resolves into .git."""
    ws = workspace_mod.Workspace("demo", {}, path=str(repo))
    for call in (
        lambda: ws_git.change_files(ws, "discard", SHORT_GIT),
        lambda: ws_git.change_files(ws, "stage", ["GIT~1/config"]),
        lambda: ws_git.diff(ws, "GIT~1/config", "changes"),
    ):
        with pytest.raises(ws_files.PathError):
            call()
    assert (repo / ".git" / "HEAD").is_file()
    if _link_out(repo / "meta", repo / ".git"):
        with pytest.raises(ws_files.PathError):
            ws_git.change_files(ws, "discard", ["meta/HEAD"])
        assert (repo / ".git" / "HEAD").is_file()


def _marker_program(repo: Path, name: str, body: str) -> Path:
    script = repo / ".git" / f"{name}.sh"
    script.write_bytes(f"#!/bin/sh\necho ran > '{(repo.parent / name).as_posix()}'\n{body}\n".encode())
    script.chmod(0o755)
    return script


def test_polling_runs_no_program_the_repository_names(repo, client):
    """core.fsmonitor and a textconv driver are programs from the repo's
    config; the panel's reads must not start them."""
    monitor = _marker_program(repo, "fsmonitor-ran", "exit 1")
    textconv = _marker_program(repo, "textconv-ran", 'cat "$1"')
    git(repo, "config", "core.fsmonitor", monitor.as_posix())
    git(repo, "config", "diff.evil.textconv", textconv.as_posix())
    git(repo, "config", "diff.external", textconv.as_posix())
    write(repo / ".gitattributes", "*.md diff=evil\n")
    write(repo / "README.md", "# demo\nchanged\n")
    git(repo, "add", ".gitattributes")
    base = save(client, "demo", repo)
    # The setup's own git calls ran them; only the panel's count.
    for name in ("fsmonitor-ran", "textconv-ran"):
        (repo.parent / name).unlink(missing_ok=True)

    assert client.get(f"{base}/changes").status_code == 200
    assert client.get(f"{base}/files").status_code == 200
    assert "+changed" in client.get(f"{base}/diff", params={"path": "README.md", "group": "changes"}).json()["text"]
    assert not (repo.parent / "fsmonitor-ran").exists()
    assert not (repo.parent / "textconv-ran").exists()
    # The probe works: plain git does run them.
    subprocess.run(["git", "status"], cwd=repo, capture_output=True)
    subprocess.run(["git", "diff", "README.md"], cwd=repo, capture_output=True)
    assert (repo.parent / "fsmonitor-ran").exists() or (repo.parent / "textconv-ran").exists()


def test_reads_empty_the_repositorys_filter_drivers_and_writes_keep_them(repo, client):
    """A clean filter is a program from the repository's config; status and
    diff ran it on every poll. Reads now see the content unfiltered."""
    clean = _marker_program(repo, "clean-ran", "cat")
    write(repo / ".gitattributes", "*.txt filter=probe\n")
    write(repo / "notes.txt", "one\n")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "notes")
    git(repo, "config", "filter.probe.clean", clean.as_posix())
    git(repo, "config", "filter.probe.required", "true")
    write(repo / "notes.txt", "two\n")
    base = save(client, "demo", repo)
    marker = repo.parent / "clean-ran"
    marker.unlink(missing_ok=True)

    changes = client.get(f"{base}/changes").json()
    assert [(f["path"], f["group"], f["added"], f["removed"]) for f in changes["files"]] == [("notes.txt", "changes", 1, 1)]
    diff = client.get(f"{base}/diff", params={"path": "notes.txt", "group": "changes"}).json()
    assert "-one" in diff["text"] and "+two" in diff["text"]
    assert client.get(f"{base}/files").json()["entries"]
    assert client.get(f"{base}/files/search", params={"q": "two", "contents": 1}).json()["results"]
    assert not marker.exists()
    # Staging stores what the filter makes, so it runs there.
    assert client.post(f"{base}/changes", json={"action": "stage", "paths": ["notes.txt"]}).json()["ok"] is True
    assert marker.exists()


def test_publish_needs_a_branch_and_a_plain_remote_name(repo, remote, client):
    base = save(client, "demo", repo)
    git(repo, "checkout", "-q", "--detach")
    answer = client.post(f"{base}/git", json={"action": "publish"}).json()
    assert answer["ok"] is False and "detached" in answer["output"]
    git(repo, "checkout", "-q", "main")
    git(repo, "remote", "remove", "origin")
    git(repo, "config", "remote.-oops.url", str(remote))
    answer = client.post(f"{base}/git", json={"action": "publish"}).json()
    assert answer["ok"] is False and "-oops" in answer["output"]


def test_an_unknown_workspace_is_404(client):
    assert client.get("/api/ws/nope/files").status_code == 404
    assert client.get("/api/ws/nope/changes").status_code == 404


# --- files ------------------------------------------------------------------


def test_the_tree_lists_one_level_with_git_marks(repo, client):
    write(repo / "build" / "out.bin", "x")
    write(repo / "debug.log", "x")
    write(repo / "new.txt", "new\n")
    write(repo / "README.md", "# demo\nchanged\n")
    write(repo / "src" / "added.py", "x = 1\n")
    git(repo, "add", "src/added.py")
    base = save(client, "demo", repo)

    top = {entry["name"]: entry for entry in client.get(f"{base}/files").json()["entries"]}
    assert ".git" not in top
    assert top["build"] == {"name": "build", "dir": True, "ignored": True, "git": None}
    assert top["debug.log"]["ignored"] is True
    assert top["new.txt"]["git"] == "?"
    assert top["README.md"]["git"] == "M"
    assert top["src"]["dir"] is True and top["src"]["git"] == "M"
    assert top[".gitignore"]["git"] is None and top[".gitignore"]["ignored"] is False

    inner = {entry["name"]: entry for entry in client.get(f"{base}/files", params={"dir": "src"}).json()["entries"]}
    assert inner["added.py"]["git"] == "A"
    assert inner["app.py"]["git"] is None
    ignored = client.get(f"{base}/files", params={"dir": "build"}).json()["entries"]
    assert ignored == [{"name": "out.bin", "dir": False, "ignored": True, "git": None}]


def test_the_tree_works_outside_a_repository(tmp_path, client):
    plain = tmp_path / "plain"
    write(plain / "a.txt", "a\n")
    base = save(client, "plain", plain)
    assert client.get(f"{base}/files").json() == {
        "entries": [{"name": "a.txt", "dir": False, "ignored": False, "git": None}],
        "truncated": False,
    }


def test_a_cap_says_it_cut_the_list(repo, client, monkeypatch):
    from quickterm import ws_files as files_mod

    write(repo / "a.txt", "a\n")
    write(repo / "b.txt", "b\n")
    base = save(client, "demo", repo)
    monkeypatch.setattr(files_mod, "LIST_CAP", 2)
    listed = client.get(f"{base}/files").json()
    assert len(listed["entries"]) == 2 and listed["truncated"] is True
    monkeypatch.setattr(ws_git, "CHANGES_CAP", 1)
    changes = client.get(f"{base}/changes").json()
    assert changes["truncated"] is True and len(changes["files"]) == 1
    monkeypatch.setattr(ws_git, "NAMES_CAP", 1)
    assert client.get(f"{base}/files/search", params={"q": "txt"}).json()["truncated"] is True


@pytest.mark.parametrize("name", [".scratch", ".hidden", " .scratch"])
def test_a_dot_name_cannot_be_saved(client, tmp_path, name):
    """The backend reserves dot names as the frontend does, so no saved
    workspace hides behind the panel's .scratch."""
    response = client.put(f"/api/workspaces/{quote(name, safe='')}", json={"layout": {}, "path": str(tmp_path)})
    assert response.status_code == 400
    assert response.json()["detail"] == "Names starting with a dot are reserved."
    assert workspace_mod.load_workspace(name.strip()) is None


def test_the_scratch_view_is_its_folder(tmp_path, monkeypatch):
    """The scratch view has no saved workspace but a folder (scratch_dir)."""
    folder = tmp_path / "scratch-here"
    write(folder / "notes.txt", "scratch notes\n")
    with TestClient(create_app(FakeSessionManager(), FakeConfig(scratch_dir=str(folder))), base_url=BASE) as c:
        assert c.get("/api/ws/.scratch/files").json()["entries"] == [
            {"name": "notes.txt", "dir": False, "ignored": False, "git": None},
        ]
        assert c.get("/api/ws/.scratch/file", params={"path": "notes.txt"}).json()["text"] == "scratch notes\n"
        assert c.get("/api/ws/.scratch/file", params={"path": "../x"}).status_code == 400
        changes = c.get("/api/ws/.scratch/changes")
        assert changes.status_code == 409 and changes.json()["detail"] == "not a git repository"
        assert c.get("/api/ws/.scratch/pr").json()["reason"] == "not a git repository"


def test_a_workspace_below_the_repository_top_sees_its_own_paths(repo, client):
    write(repo / "src" / "app.py", "print('changed')\n")
    base = save(client, "src", repo / "src")
    entries = client.get(f"{base}/files").json()["entries"]
    assert entries == [{"name": "app.py", "dir": False, "ignored": False, "git": "M"}]
    files = client.get(f"{base}/changes").json()["files"]
    assert [(f["path"], f["group"]) for f in files] == [("app.py", "changes")]


def test_name_search_uses_git_and_includes_untracked(repo, client):
    write(repo / "src" / "helper_tool.py", "x\n")
    write(repo / "build" / "helper_tool.py", "ignored\n")
    base = save(client, "demo", repo)
    found = client.get(f"{base}/files/search", params={"q": "helper"}).json()
    assert found == {"results": [{"path": "src/helper_tool.py", "line": None, "text": None}], "truncated": False}
    words = client.get(f"{base}/files/search", params={"q": "src app"}).json()["results"]
    assert [item["path"] for item in words] == ["src/app.py"]


def test_contents_search_lists_path_line_and_text(repo, client):
    write(repo / "notes.txt", "first\nHello again\n")
    base = save(client, "demo", repo)
    found = client.get(f"{base}/files/search", params={"q": "hello", "contents": 1}).json()
    assert found["truncated"] is False
    assert {(item["path"], item["line"], item["text"]) for item in found["results"]} == {
        ("README.md", 2, "hello world"),
        ("notes.txt", 2, "Hello again"),
        ("src/app.py", 1, "print('hello')"),
    }


def test_search_without_git_walks_the_folder(tmp_path, client):
    plain = tmp_path / "plain"
    write(plain / "docs" / "guide.md", "needle here\n")
    write(plain / "bin.dat", "needle\0binary")
    base = save(client, "plain", plain)
    names = client.get(f"{base}/files/search", params={"q": "guide"}).json()["results"]
    assert [item["path"] for item in names] == ["docs/guide.md"]
    hits = client.get(f"{base}/files/search", params={"q": "needle", "contents": 1}).json()["results"]
    assert hits == [{"path": "docs/guide.md", "line": 1, "text": "needle here"}]


def test_search_needs_a_query(repo, client):
    base = save(client, "demo", repo)
    assert client.get(f"{base}/files/search", params={"q": " "}).status_code == 400


# --- the file view ----------------------------------------------------------


def test_a_text_file_comes_with_its_language(repo, client):
    base = save(client, "demo", repo)
    answer = client.get(f"{base}/file", params={"path": "src/app.py"}).json()
    assert answer == {"text": "print('hello')\n", "binary": False, "size": 15, "language": "python"}


def test_binary_large_and_folder(repo, client):
    (repo / "blob.bin").write_bytes(b"abc\0def")
    (repo / "big.txt").write_bytes(b"x" * (ws_files.FILE_VIEW_CAP + 1))
    base = save(client, "demo", repo)
    assert client.get(f"{base}/file", params={"path": "blob.bin"}).json() == {
        "text": None, "binary": True, "size": 7, "language": None,
    }
    big = client.get(f"{base}/file", params={"path": "big.txt"}).json()
    assert big == {"text": None, "binary": False, "size": ws_files.FILE_VIEW_CAP + 1, "language": None}
    assert client.get(f"{base}/file", params={"path": "src"}).status_code == 400
    assert client.get(f"{base}/file", params={"path": "missing.txt"}).status_code == 404


def test_an_image_gets_a_token_free_url_for_that_file_only(repo):
    png = b"\x89PNG\r\n\x1a\n" + b"\0" * 32
    (repo / "logo.png").write_bytes(png)
    write(repo / "other.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>")
    with TestClient(create_app(FakeSessionManager(), FakeConfig(), "tok"), base_url=BASE) as c:
        headers = {"X-QuickTerm-Token": "tok"}
        assert c.put("/api/workspaces/demo", json={"layout": {}, "path": str(repo)}, headers=headers).status_code == 204
        answer = c.get("/api/ws/demo/file", params={"path": "logo.png"}, headers=headers).json()
        assert answer["binary"] is True and answer["text"] is None and answer["size"] == len(png)
        url = answer["image_url"]
        assert url.startswith("/api/assets/ws-file/")
        served = c.get(url)  # no token: an <img> cannot send it
        assert served.status_code == 200
        assert served.content == png
        assert served.headers["content-type"] == "image/png"
        assert "sandbox" in served.headers["content-security-policy"]
        # The same file gets the same key; another file another one.
        again = c.get("/api/ws/demo/file", params={"path": "logo.png"}, headers=headers).json()
        assert again["image_url"] == url
        svg = c.get("/api/ws/demo/file", params={"path": "other.svg"}, headers=headers).json()
        assert svg["image_url"] != url
        assert c.get("/api/assets/ws-file/not-a-key").status_code == 404
        # The file view itself still needs the token.
        assert c.get("/api/ws/demo/file", params={"path": "logo.png"}).status_code == 403


def test_open_in_editor_reveal_and_the_default_program(repo, client, monkeypatch):
    import types

    from quickterm.api import ws as ws_routes

    calls = []
    stub = types.ModuleType("quickterm.opener")
    stub.find_vscode = lambda: None
    stub.open_target = lambda target: calls.append(("target", target)) or {"action": "opened"}
    stub.open_folder = lambda path, app: calls.append((app, path)) or {"action": app}
    monkeypatch.setitem(sys.modules, "quickterm.opener", stub)
    popen = []
    monkeypatch.setattr(ws_routes.subprocess, "Popen", lambda argv, cwd=None: popen.append((argv, cwd)))
    base = save(client, "demo", repo)

    assert client.post(f"{base}/open", json={"path": "src/app.py", "app": "editor"}).json() == {"action": "opened"}
    assert calls[-1] == ("target", str((repo / "src" / "app.py").resolve()))
    assert client.post(f"{base}/open", json={"path": "src/app.py", "app": "explorer"}).json() == {"action": "explorer"}
    assert calls[-1] == ("explorer", str((repo / "src").resolve()))
    stub.find_vscode = lambda: "C:/Code/Code.exe"
    assert client.post(f"{base}/open", json={"path": "README.md", "app": "editor"}).json() == {"action": "vscode"}
    assert popen == [(["C:/Code/Code.exe", str((repo / "README.md").resolve())], str(repo.resolve()))]
    assert client.post(f"{base}/open", json={"path": "../x", "app": "editor"}).status_code == 400
    assert client.post(f"{base}/open", json={"path": "README.md", "app": "shell"}).status_code == 400
    assert client.post(f"{base}/open", json={"path": "gone.txt", "app": "editor"}).status_code == 404


# --- changes ----------------------------------------------------------------


def _by_group(files: list[dict]) -> dict[str, dict[str, dict]]:
    grouped: dict[str, dict[str, dict]] = {}
    for item in files:
        grouped.setdefault(item["group"], {})[item["path"]] = item
    return grouped


def test_changes_groups_staged_changes_untracked_and_committed(repo, remote, client):
    git(repo, "checkout", "-q", "-b", "feature")
    write(repo / "src" / "feature.py", "a\nb\nc\n")
    git(repo, "add", "src/feature.py")
    git(repo, "commit", "-q", "-m", "feature")
    write(repo / "README.md", "# demo\nhello world\nmore\n")
    write(repo / "staged.txt", "one\ntwo\n")
    git(repo, "add", "staged.txt")
    write(repo / "loose.txt", "x\ny")
    base = save(client, "demo", repo)

    answer = client.get(f"{base}/changes").json()
    assert answer["branch"] == "feature"
    assert answer["upstream"] is None
    assert answer["base"] == "origin/main"
    assert answer["ahead"] == 1 and answer["behind"] == 0
    assert answer["branch_added"] == 3
    groups = _by_group(answer["files"])
    assert groups["staged"]["staged.txt"] == {
        "path": "staged.txt", "group": "staged", "status": "A", "added": 2, "removed": 0,
    }
    assert groups["changes"]["README.md"]["status"] == "M"
    assert (groups["changes"]["README.md"]["added"], groups["changes"]["README.md"]["removed"]) == (1, 0)
    assert groups["untracked"]["loose.txt"] == {
        "path": "loose.txt", "group": "untracked", "status": "?", "added": 2, "removed": 0,
    }
    assert groups["committed"]["src/feature.py"]["status"] == "A"
    assert groups["committed"]["src/feature.py"]["added"] == 3


def test_changes_reports_upstream_ahead_and_behind(tmp_path, repo, remote, client):
    other = tmp_path / "other"
    git(tmp_path, "clone", "-q", str(remote), str(other))
    write(other / "remote.txt", "r\n")
    git(other, "add", ".")
    git(other, "commit", "-q", "-m", "remote")
    git(other, "push", "-q")
    git(repo, "fetch", "-q")
    write(repo / "local.txt", "l\n")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "local")
    base = save(client, "demo", repo)
    answer = client.get(f"{base}/changes").json()
    assert answer["upstream"] == "origin/main"
    assert (answer["ahead"], answer["behind"]) == (1, 1)


def test_changes_outside_a_repository_is_409(tmp_path, client):
    plain = tmp_path / "plain"
    plain.mkdir()
    base = save(client, "plain", plain)
    response = client.get(f"{base}/changes")
    assert response.status_code == 409
    assert response.json()["detail"] == "not a git repository"


def test_stage_unstage_and_discard(repo, client):
    write(repo / "README.md", "changed\n")
    write(repo / "new.txt", "new\n")
    write(repo / "[odd].txt", "literal\n")
    base = save(client, "demo", repo)

    staged = client.post(f"{base}/changes", json={"action": "stage", "paths": ["README.md", "[odd].txt"]})
    assert staged.json()["ok"] is True
    groups = _by_group(client.get(f"{base}/changes").json()["files"])
    assert set(groups["staged"]) == {"README.md", "[odd].txt"}
    assert set(groups["untracked"]) == {"new.txt"}

    unstaged = client.post(f"{base}/changes", json={"action": "unstage", "paths": ["README.md"]})
    assert unstaged.json()["ok"] is True
    groups = _by_group(client.get(f"{base}/changes").json()["files"])
    assert set(groups["staged"]) == {"[odd].txt"}
    assert set(groups["changes"]) == {"README.md"}

    discarded = client.post(f"{base}/changes", json={"action": "discard", "paths": ["README.md", "new.txt"]})
    assert discarded.json()["ok"] is True, discarded.json()
    assert (repo / "README.md").read_text(encoding="utf-8") == "# demo\nhello world\n"
    assert not (repo / "new.txt").exists()
    # Discard touches only the working tree: the staged file stays staged.
    assert set(_by_group(client.get(f"{base}/changes").json()["files"])) == {"staged"}


def test_change_actions_validate_the_body(repo, client):
    base = save(client, "demo", repo)
    assert client.post(f"{base}/changes", json={"action": "nuke", "paths": ["a"]}).status_code == 400
    assert client.post(f"{base}/changes", json={"action": "stage", "paths": []}).status_code == 400
    assert client.post(f"{base}/changes", json={"action": "stage", "paths": "a"}).status_code == 400
    assert client.post(f"{base}/changes", json={"action": "stage", "paths": ["."]}).status_code == 400


# --- diff -------------------------------------------------------------------


def test_diff_of_each_group(repo, remote, client):
    git(repo, "checkout", "-q", "-b", "feature")
    write(repo / "src" / "app.py", "print('feature')\n")
    git(repo, "commit", "-q", "-am", "feature")
    write(repo / "README.md", "# demo\nhello world\nunstaged\n")
    write(repo / "staged.txt", "staged\n")
    git(repo, "add", "staged.txt")
    write(repo / "fresh.txt", "fresh\n")
    base = save(client, "demo", repo)

    unstaged = client.get(f"{base}/diff", params={"path": "README.md", "group": "changes"}).json()
    assert "+unstaged" in unstaged["text"] and unstaged["truncated"] is False
    assert unstaged["lines"] == unstaged["text"].count("\n")
    staged = client.get(f"{base}/diff", params={"path": "staged.txt", "group": "staged"}).json()
    assert "+staged" in staged["text"]
    fresh = client.get(f"{base}/diff", params={"path": "fresh.txt", "group": "changes"}).json()
    assert "+fresh" in fresh["text"]
    committed = client.get(f"{base}/diff", params={"path": "src/app.py", "group": "committed"}).json()
    assert "-print('hello')" in committed["text"] and "+print('feature')" in committed["text"]
    assert client.get(f"{base}/diff", params={"path": "README.md", "group": "all"}).status_code == 400


def test_a_diff_over_5000_lines_is_only_counted(repo, client):
    write(repo / "long.txt", "".join(f"line {n}\n" for n in range(6000)))
    git(repo, "add", "long.txt")
    base = save(client, "demo", repo)
    answer = client.get(f"{base}/diff", params={"path": "long.txt", "group": "staged"}).json()
    assert answer["truncated"] is True
    assert answer["text"] == ""
    assert answer["lines"] > 6000


# --- commit, push -----------------------------------------------------------


def test_commit_runs_the_hooks_and_reports_a_failure(repo, client):
    hook = repo / ".git" / "hooks" / "pre-commit"
    hook.write_bytes(b"#!/bin/sh\necho 'lint failed: fix src/app.py' >&2\nexit 1\n")
    hook.chmod(0o755)
    write(repo / "README.md", "changed\n")
    git(repo, "add", "README.md")
    base = save(client, "demo", repo)

    refused = client.post(f"{base}/git", json={"action": "commit", "message": "Change the readme"}).json()
    assert refused["ok"] is False
    assert "lint failed: fix src/app.py" in refused["output"]
    assert git(repo, "log", "--format=%s").splitlines() == ["init"]

    hook.unlink()
    done = client.post(f"{base}/git", json={"action": "commit", "message": "Change the readme\n\nWhy."}).json()
    assert done["ok"] is True, done
    assert git(repo, "log", "-1", "--format=%B").strip() == "Change the readme\n\nWhy."


def test_commit_needs_a_message_and_amend_keeps_one(repo, client):
    base = save(client, "demo", repo)
    assert client.post(f"{base}/git", json={"action": "commit", "message": "  "}).status_code == 400
    assert client.post(f"{base}/git", json={"action": "commit"}).status_code == 400
    assert client.post(f"{base}/git", json={"action": "commit", "message": "a\0b"}).status_code == 400
    assert client.post(f"{base}/git", json={"action": "force-push"}).status_code == 400
    write(repo / "README.md", "amended\n")
    git(repo, "add", "README.md")
    amended = client.post(f"{base}/git", json={"action": "amend", "message": None}).json()
    assert amended["ok"] is True
    assert git(repo, "log", "--format=%s").splitlines() == ["init"]
    assert git(repo, "show", "HEAD:README.md") == "amended\n"


def test_push_and_publish_to_a_local_bare_remote(repo, remote, client):
    base = save(client, "demo", repo)
    write(repo / "a.txt", "a\n")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "a")
    pushed = client.post(f"{base}/git", json={"action": "push"}).json()
    assert pushed["ok"] is True, pushed
    assert git(remote, "log", "--format=%s", "main").splitlines()[0] == "a"

    git(repo, "checkout", "-q", "-b", "topic")
    write(repo / "b.txt", "b\n")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "b")
    published = client.post(f"{base}/git", json={"action": "publish"}).json()
    assert published["ok"] is True, published
    assert client.get(f"{base}/changes").json()["upstream"] == "origin/topic"

    pulled = client.post(f"{base}/git", json={"action": "pull"}).json()
    assert pulled["ok"] is True, pulled


def test_publish_without_a_remote_says_so(repo, client):
    base = save(client, "demo", repo)
    answer = client.post(f"{base}/git", json={"action": "publish"}).json()
    assert answer == {"ok": False, "output": "This repository has no remote to publish to."}


def test_numstat_reads_renames():
    output = "1\t2\tplain.txt\0" + "0\t0\t\0old.txt\0new.txt\0" + "-\t-\timg.png\0"
    assert ws_git._numstat(output) == {
        "plain.txt": (1, 2), "new.txt": (0, 0), "img.png": (None, None),
    }


def test_git_missing_is_503(repo, client, monkeypatch):
    base = save(client, "demo", repo)
    monkeypatch.setattr(ws_git, "_BASE", ("git-that-does-not-exist-qt",))
    response = client.get(f"{base}/changes")
    assert response.status_code == 503
    assert os.path.isdir(repo)
