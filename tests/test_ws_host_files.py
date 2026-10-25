"""The right panel's reader for a workspace on an SSH host (ws_files.HostFolder).

Its POSIX script runs here with a local `sh` in place of ssh: ws_exec.run is
replaced by one that runs the argv in the folder, as the remote command
`cd <folder> && <argv>` would.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from quickterm import ws_exec, ws_files, ws_git


def _posix_bin() -> str:
    """A folder holding sh, realpath, find and grep: PATH, else Git for
    Windows' own usr/bin next to git."""
    sh = shutil.which("sh")
    if sh and shutil.which("realpath"):
        # Still a folder, not "PATH will do": CreateProcess looks in System32
        # before PATH, where find.exe is Windows' own.
        return str(Path(sh).parent)
    git = shutil.which("git")
    if git:
        for parent in Path(git).resolve().parents:
            candidate = parent / "usr" / "bin"
            if (candidate / "sh.exe").is_file() and (candidate / "realpath.exe").is_file():
                return str(candidate)
    return ""


POSIX_BIN = _posix_bin()
pytestmark = pytest.mark.skipif(POSIX_BIN == "", reason="no POSIX sh here")


@pytest.fixture
def host(tmp_path, monkeypatch):
    folder = tmp_path / "project"
    (folder / "src").mkdir(parents=True)
    (folder / "src" / "main.py").write_bytes(b"print('hi')\n")
    (folder / "README.md").write_bytes(b"# readme\nneedle here\n")
    (folder / "blob.bin").write_bytes(b"ab\0cd")
    (folder / ".git").mkdir()
    (folder / ".git" / "config").write_bytes(b"[core]\n")
    (tmp_path / "outside.txt").write_bytes(b"secret\n")
    calls = []
    if POSIX_BIN:
        monkeypatch.setenv("PATH", POSIX_BIN + os.pathsep + os.environ.get("PATH", ""))

    def run(ws, argv, *, timeout=10.0, input=None, env=None):
        calls.append(argv)
        if POSIX_BIN:
            # CreateProcess looks in System32 before PATH, where find.exe is
            # Windows' own; a host has only the POSIX one.
            argv = [shutil.which(argv[0], path=POSIX_BIN) or argv[0], *argv[1:]]
        return subprocess.run(argv, cwd=folder, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=timeout, input=input,
                              env=ws_exec._local_env(env) if env else None)

    monkeypatch.setattr(ws_exec, "run", run)
    ws = SimpleNamespace(name="remote", path="/srv/project", host="buildbox")
    return SimpleNamespace(ws=ws, folder=folder, calls=calls, tmp=tmp_path)


def test_a_host_workspace_reads_through_ws_exec(host):
    reader = ws_files.folder_for(host.ws)
    assert isinstance(reader, ws_files.HostFolder)
    entries = sorted((entry.name, entry.dir) for entry in reader.list_dir(""))
    assert entries == [("README.md", False), ("blob.bin", False), ("src", True)]
    assert [entry.name for entry in reader.list_dir("src")] == ["main.py"]
    read = reader.read_file("src/main.py")
    assert (read.size, read.data) == (12, b"print('hi')\n")
    assert ws_files.is_binary(reader.read_file("blob.bin").data)
    assert reader.read_file("README.md", cap=4).data is None
    assert all(call[:2] == ["sh", "-c"] for call in host.calls)


def test_the_host_script_refuses_what_leaves_the_folder(host):
    reader = ws_files.folder_for(host.ws)
    with pytest.raises(ws_files.PathError):
        reader.read_file("../outside.txt")
    with pytest.raises(ws_files.PathError):
        reader.list_dir(".git")
    with pytest.raises(FileNotFoundError):
        reader.read_file("missing.txt")
    with pytest.raises(IsADirectoryError):
        reader.read_file("src")
    with pytest.raises(ws_files.RemoteFolder):
        reader.resolve("README.md")


def test_a_link_out_of_the_folder_is_refused_on_the_host_too(host):
    link = host.folder / "escape"
    try:
        if sys.platform == "win32":
            import _winapi

            _winapi.CreateJunction(str(host.tmp), str(link))
        else:
            link.symlink_to(host.tmp, target_is_directory=True)
    except OSError:
        pytest.skip("cannot create a directory link here")
    with pytest.raises(ws_files.PathError):
        ws_files.folder_for(host.ws).read_file("escape/outside.txt")


def test_search_without_git_on_a_host_is_one_grep(host):
    found = ws_git._walk_contents(host.ws, "needle")
    assert found == {"results": [{"path": "README.md", "line": 2, "text": "needle here"}], "truncated": False}
    assert host.calls[-1][0] == "grep"
    paths, truncated = ws_files.folder_for(host.ws).walk()
    assert (sorted(paths), truncated) == (["README.md", "blob.bin", "src/main.py"], False)
