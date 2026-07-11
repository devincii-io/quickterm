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
