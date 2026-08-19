"""Directory listing behind the in-app folder browser (quickterm/browse.py)."""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from quickterm import browse


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    root = tmp_path / "root"
    (root / "alpha").mkdir(parents=True)
    (root / "Beta").mkdir()
    (root / "repo" / ".git").mkdir(parents=True)
    (root / ".hidden").mkdir()
    (root / "notes.txt").write_text("not a folder", encoding="utf-8")
    # Resolved up front: the listing reports resolved paths, and a temp root can
    # sit behind a symlink (POSIX /tmp) or a short name (Windows).
    return root.resolve()


def test_lists_only_directories_sorted_case_insensitively(tree: Path):
    result = browse.list_dirs(str(tree))

    assert [d["name"] for d in result["dirs"]] == ["alpha", "Beta", "repo"]
    assert result["path"] == str(tree)
    assert result["name"] == "root"
    assert result["parent"] == str(tree.parent)
    assert result["truncated"] is False
    # Every row is addressable on its own, so the frontend never joins paths.
    assert all(os.path.isdir(d["path"]) for d in result["dirs"])


def test_a_git_child_is_a_flag_on_its_parent_not_a_row(tree: Path):
    result = browse.list_dirs(str(tree / "repo"))
    assert result["dirs"] == []

    parent = browse.list_dirs(str(tree))
    flags = {d["name"]: d["is_git"] for d in parent["dirs"]}
    assert flags == {"alpha": False, "Beta": False, "repo": True}


def test_hidden_entries_are_skipped(tree: Path):
    assert ".hidden" not in [d["name"] for d in browse.list_dirs(str(tree))["dirs"]]


def test_roots_are_offered_and_a_root_has_no_parent():
    result = browse.list_dirs(None)  # no path at all means the home folder
    assert result["path"] == str(Path.home().resolve())
    assert result["roots"], "the browser needs somewhere to jump when it runs out of parents"
    assert all(r["name"] and r["path"] for r in result["roots"])

    root_path = result["roots"][0]["path"]
    assert browse.list_dirs(root_path)["parent"] is None
    if os.name == "nt":
        assert all(r["path"].endswith(":\\") for r in result["roots"])
    else:
        assert result["roots"][0]["path"] == "/"


def test_a_file_is_not_a_directory(tree: Path):
    with pytest.raises(browse.BrowseError) as exc:
        browse.list_dirs(str(tree / "notes.txt"))
    assert exc.value.missing is False
    assert "not a folder" in str(exc.value)


def test_a_missing_path_is_reported_as_missing(tree: Path):
    with pytest.raises(browse.BrowseError) as exc:
        browse.list_dirs(str(tree / "nope" / "deeper"))
    assert exc.value.missing is True


def test_an_unreadable_directory_never_raises_a_bare_oserror(tree: Path, monkeypatch):
    # A real ACL-denied directory (C:\System Volume Information, or a POSIX
    # mode 000 folder under root) cannot be created portably in a test, so the
    # refusal is injected at the call the OS would refuse.
    def refuse(path):
        raise PermissionError(13, "Access is denied")

    monkeypatch.setattr(browse.os, "scandir", refuse)
    with pytest.raises(browse.BrowseError) as exc:
        browse.list_dirs(str(tree))
    assert exc.value.missing is False
    assert "permission denied" in str(exc.value)


@pytest.mark.skipif(os.name == "nt", reason="POSIX permission bits")
def test_a_real_mode_000_directory_is_refused_cleanly(tmp_path: Path):
    if os.geteuid() == 0:
        pytest.skip("root reads every directory regardless of mode")
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(0o000)
    try:
        with pytest.raises(browse.BrowseError):
            browse.list_dirs(str(locked))
    finally:
        locked.chmod(stat.S_IRWXU)


def test_an_entry_that_cannot_be_stat_ed_is_skipped_not_fatal(tree: Path, monkeypatch):
    real_scandir = browse.os.scandir

    class Hostile:
        """A reparse point the process may not follow: is_dir() itself raises."""

        name = "junction"
        path = str(tree / "junction")

        def is_dir(self, follow_symlinks=True):
            raise OSError(1920, "cannot access the file")

        def stat(self, follow_symlinks=True):
            raise OSError(1920, "cannot access the file")

    class Scan:
        def __init__(self, entries):
            self._entries = entries

        def __enter__(self):
            return iter(self._entries)

        def __exit__(self, *exc):
            return False

    def scandir(path):
        with real_scandir(path) as scan:
            return Scan([Hostile(), *scan])

    monkeypatch.setattr(browse.os, "scandir", scandir)
    names = [d["name"] for d in browse.list_dirs(str(tree))["dirs"]]
    assert names == ["alpha", "Beta", "repo"]


def test_the_listing_is_capped_so_one_folder_cannot_become_a_huge_response(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setattr(browse, "MAX_ENTRIES", 3)
    many = tmp_path / "many"
    many.mkdir()
    for i in range(6):
        (many / f"d{i}").mkdir()

    result = browse.list_dirs(str(many))
    assert len(result["dirs"]) == 3
    assert result["truncated"] is True


def test_a_path_with_a_user_or_variable_reference_is_expanded():
    result = browse.list_dirs("~")
    assert result["path"] == str(Path.home().resolve())
