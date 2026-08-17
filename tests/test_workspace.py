import json

import pytest

from quickterm.app import _workspace_session_ids
from quickterm.workspace import (
    Workspace,
    delete_workspace,
    list_workspaces,
    load_workspace,
    save_workspace,
)

LAYOUT = {
    "type": "split",
    "dir": "h",
    "ratio": 0.5,
    "children": [
        {"type": "pane", "profile": "powershell", "cwd": "C:/dev"},
        {"type": "pane", "profile": "cmd", "cwd": None},
    ],
}


@pytest.fixture(autouse=True)
def fake_appdata(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    return tmp_path


def test_save_load_roundtrip():
    save_workspace(Workspace(name="main", layout=LAYOUT, logo="brand.svg", session_ids=["deadbeef"]))
    ws = load_workspace("main")
    assert ws is not None
    assert ws.name == "main"
    assert ws.layout == LAYOUT
    assert ws.logo == "brand.svg"
    assert ws.session_ids == ["deadbeef"]


def test_old_workspace_infers_session_ownership_from_layout(fake_appdata):
    path = fake_appdata / "quickterm" / "workspaces"
    path.mkdir(parents=True)
    legacy = {"name": "legacy", "layout": {"type": "pane", "session_id": "abc12345"}}
    (path / "legacy.json").write_text(json.dumps(legacy), encoding="utf-8")
    ws = load_workspace("legacy")
    assert ws is not None
    assert ws.session_ids == ["abc12345"]


def test_workspace_owned_detached_sessions_are_protected_from_reaping():
    save_workspace(Workspace(name="dev", layout={"type": "pane"}, session_ids=["detached1"]))
    assert "detached1" in _workspace_session_ids()


def test_list_and_delete():
    save_workspace(Workspace(name="alpha", layout=LAYOUT))
    save_workspace(Workspace(name="beta", layout=LAYOUT))
    assert list_workspaces() == ["alpha", "beta"]
    delete_workspace("alpha")
    assert list_workspaces() == ["beta"]
    delete_workspace("nonexistent")  # no error


def test_load_missing_returns_none():
    assert load_workspace("nope") is None


def test_corrupt_workspace_does_not_break_other_workspaces(fake_appdata):
    folder = fake_appdata / "quickterm" / "workspaces"
    folder.mkdir(parents=True)
    (folder / "broken.json").write_text('{"layout":', encoding="utf-8")
    save_workspace(Workspace(name="healthy", layout=LAYOUT, session_ids=["live1"]))

    assert load_workspace("broken") is None
    assert load_workspace("healthy").session_ids == ["live1"]


def test_non_utf8_workspace_does_not_break_listing_or_loading(fake_appdata):
    folder = fake_appdata / "quickterm" / "workspaces"
    folder.mkdir(parents=True)
    (folder / "broken.json").write_bytes(b"\xff\xfe")
    save_workspace(Workspace(name="healthy", layout=LAYOUT))

    assert list_workspaces() == ["broken", "healthy"]
    assert load_workspace("broken") is None


def test_name_sanitized_to_safe_filename(fake_appdata):
    weird = 'my/ws:with*bad"chars?'
    save_workspace(Workspace(name=weird, layout=LAYOUT))
    files = list((fake_appdata / "quickterm" / "workspaces").glob("*.json"))
    assert len(files) == 1
    for ch in '/\\:*?"<>|':
        assert ch not in files[0].name
    ws = load_workspace(weird)
    assert ws is not None
    assert ws.name == weird  # original name preserved inside the file


def test_unsafe_names_cannot_overwrite_each_other(fake_appdata):
    first = "project:one"
    second = "project*one"
    save_workspace(Workspace(name=first, layout={"id": 1}))
    save_workspace(Workspace(name=second, layout={"id": 2}))

    assert list_workspaces() == sorted([first, second])
    assert load_workspace(first).layout == {"id": 1}
    assert load_workspace(second).layout == {"id": 2}
    assert len(list((fake_appdata / "quickterm" / "workspaces").glob("*.json"))) == 2


def test_legacy_sanitized_workspace_remains_readable_and_migrates(fake_appdata):
    folder = fake_appdata / "quickterm" / "workspaces"
    folder.mkdir(parents=True)
    legacy = folder / "project_one.json"
    legacy.write_text(
        json.dumps({"name": "project:one", "layout": {"old": True}}), encoding="utf-8",
    )

    assert load_workspace("project:one").layout == {"old": True}
    save_workspace(Workspace(name="project:one", layout={"new": True}))

    assert not legacy.exists()
    assert load_workspace("project:one").layout == {"new": True}


def test_case_differing_names_do_not_share_a_file():
    """NTFS filenames are case-insensitive.

    "dev" and "Dev" resolved to the same path, so saving one silently
    destroyed the other's layout and its session-ownership list.
    """
    save_workspace(
        Workspace(name="dev", layout={"type": "pane", "profile": "a"}, session_ids=["a1"])
    )
    save_workspace(
        Workspace(name="Dev", layout={"type": "pane", "profile": "b"}, session_ids=["b1"])
    )

    lower = load_workspace("dev")
    upper = load_workspace("Dev")

    assert lower is not None and upper is not None
    assert lower.layout["profile"] == "a"
    assert upper.layout["profile"] == "b"
    assert lower.session_ids == ["a1"]
    assert upper.session_ids == ["b1"]
    assert sorted(list_workspaces()) == ["Dev", "dev"]
