"""A workspace's setup: its environment and startup items (CONTRACTS.md, 4.5 wave 2)."""

from __future__ import annotations

import json
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from quickterm import config as config_mod
from quickterm import workspace as workspace_mod
from quickterm.server import create_app
from quickterm.workspace import (
    Workspace,
    load_workspace,
    save_workspace,
    validate_command,
    validate_env,
    validate_startup,
)
from tests.test_server import FakeConfig, FakeSessionManager


@pytest.fixture(autouse=True)
def appdata(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    monkeypatch.setattr(workspace_mod, "_NAMESPACE", None)
    return tmp_path / "appdata"


@pytest.fixture
def sealed(monkeypatch):
    """DPAPI stand-in: values are visibly sealed, and opened again."""
    store = config_mod.secret_store
    monkeypatch.setattr(store, "protection_available", lambda: True)
    monkeypatch.setattr(store, "protect", lambda data: b"sealed:" + data)
    monkeypatch.setattr(store, "unprotect", lambda data: data.removeprefix(b"sealed:"))


@pytest.fixture
def client():
    with TestClient(create_app(FakeSessionManager(), FakeConfig()),
                    base_url="http://127.0.0.1:8620") as c:
        yield c


def stored(appdata, name: str) -> dict:
    (path,) = (appdata / "quickterm" / "workspaces").glob(f"{name}*.json")
    return json.loads(path.read_text(encoding="utf-8"))


# --- validation ---------------------------------------------------------------


def test_env_takes_plain_names_and_text():
    assert validate_env(None) == {}
    assert validate_env({"API_URL": "http://x", "_x1": ""}) == {"API_URL": "http://x", "_x1": ""}


@pytest.mark.parametrize("env, message", [
    ([], "object"),
    ({"1ABC": "x"}, "not a variable name"),
    ({"A-B": "x"}, "not a variable name"),
    ({"": "x"}, "not a variable name"),
    ({"QUICKTERM_PORT": "1"}, "set by QuickTerm"),
    ({"quickterm_hook_token": "1"}, "set by QuickTerm"),
    ({"WslEnv": "PATH/l"}, "set by QuickTerm"),
    ({"Path": "a", "PATH": "b"}, "twice"),
    ({"A": 1}, "must be text"),
    ({"A": "x\0y"}, "NUL"),
    ({"A": "x" * (8 * 1024 + 1)}, "8 KB"),
    ({"A": "ä" * 4097}, "8 KB"),
    ({f"V{i}": "" for i in range(65)}, "at most 64"),
])
def test_env_refuses(env, message):
    with pytest.raises(ValueError, match=message):
        validate_env(env)


def test_env_value_may_be_exactly_8_kb():
    assert validate_env({"A": "x" * 8192})["A"] == "x" * 8192


def test_command_is_one_line():
    assert validate_command(None) is None
    assert validate_command("  npm run dev  ") == "npm run dev"
    assert validate_command("   ") is None
    for bad in ("a\nb", "a\rb", "a\0b", 3):
        with pytest.raises(ValueError):
            validate_command(bad)
    with pytest.raises(ValueError, match="4096"):
        validate_command("x" * 4097)


def test_startup_items_are_normalized_to_all_seven_keys():
    items = validate_startup([
        {"kind": "shell", "command": "npm run dev", "name": " Dev server ", "shell": "git-bash"},
        {"kind": "claude-code", "agent_mode": "new", "agent": {"model": "opus"}, "env": {"A": "1"}},
        {"kind": "codex"},
    ])
    assert items == [
        {"kind": "shell", "name": "Dev server", "shell": "git-bash", "command": "npm run dev", "agent_mode": None,
         "agent": None, "env": None},
        {"kind": "claude-code", "name": None, "shell": None, "command": None, "agent_mode": "new",
         "agent": {"model": "opus"}, "env": {"A": "1"}},
        {"kind": "codex", "name": None, "shell": None, "command": None, "agent_mode": None, "agent": None,
         "env": None},
    ]


@pytest.mark.parametrize("items, message", [
    ({}, "list"),
    ([{"kind": "shell"}] * 9, "at most 8"),
    (["shell"], "object"),
    ([{"kind": "vim"}], "kind"),
    ([{"kind": "shell", "extra": 1}], "unknown startup field"),
    ([{"kind": "claude-code", "command": "ls"}], "command is for a shell"),
    ([{"kind": "shell", "agent_mode": "new"}], "agent_mode"),
    ([{"kind": "shell", "shell": "fish"}], "shell"),
    ([{"kind": "codex", "shell": "cmd"}], "shell is for a shell item"),
    ([{"kind": "shell", "shell": "cmd", "command": "echo %PATH%"}], "cmd.exe"),
    ([{"kind": "codex", "agent_mode": "bogus"}], "launch mode"),
    ([{"kind": "claude-code", "agent_mode": "fork"}], "launch mode"),
    ([{"kind": "claude-code", "agent": {"nonsense": "1"}}], "unknown agent option"),
    ([{"kind": "claude-code", "agent": "opus"}], "object"),
    ([{"kind": "shell", "env": {"QUICKTERM_X": "1"}}], "set by QuickTerm"),
    ([{"kind": "shell", "name": 3}], "name"),
])
def test_startup_refuses(items, message):
    with pytest.raises(ValueError, match=message):
        validate_startup(items)


# --- storage --------------------------------------------------------------------


def test_env_is_sealed_at_rest_and_opened_on_load(appdata, sealed):
    save_workspace(Workspace(
        name="api", layout={}, env={"TOKEN": "s3cret"},
        startup=[{"kind": "shell", "command": "make", "env": {"ONE": "only-here"}}],
    ))
    raw = stored(appdata, "api")
    text = json.dumps(raw)
    assert "s3cret" not in text and "only-here" not in text
    assert raw["env"]["TOKEN"]["protected"] == "dpapi-v1"
    assert raw["startup"][0]["env"]["ONE"]["protected"] == "dpapi-v1"
    loaded = load_workspace("api")
    assert loaded.env == {"TOKEN": "s3cret"}
    assert loaded.startup[0]["env"] == {"ONE": "only-here"}
    assert loaded.startup[0]["command"] == "make"


def test_without_os_protection_values_stay_text_in_the_private_file(appdata, monkeypatch):
    monkeypatch.setattr(config_mod.secret_store, "protection_available", lambda: False)
    save_workspace(Workspace(name="api", layout={}, env={"TOKEN": "t"}))
    assert stored(appdata, "api")["env"] == {"TOKEN": "t"}
    assert load_workspace("api").env == {"TOKEN": "t"}


def test_a_workspace_without_setup_stores_no_keys(appdata):
    save_workspace(Workspace(name="plain", layout={}))
    raw = stored(appdata, "plain")
    assert "env" not in raw and "startup" not in raw
    loaded = load_workspace("plain")
    assert loaded.env == {} and loaded.startup == []


def test_a_value_this_user_cannot_open_is_left_out(appdata, sealed, monkeypatch):
    save_workspace(Workspace(name="api", layout={}, env={"A": "1", "B": "2"}))
    path = next((appdata / "quickterm" / "workspaces").glob("api*.json"))
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["env"]["B"] = {"protected": "dpapi-v1", "data": "!!not base64!!"}
    path.write_text(json.dumps(raw), encoding="utf-8")
    assert load_workspace("api").env == {"A": "1"}


def test_a_hand_edited_bad_entry_drops_only_itself(appdata):
    save_workspace(Workspace(name="api", layout={}))
    path = next((appdata / "quickterm" / "workspaces").glob("api*.json"))
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["env"] = {"QUICKTERM_PORT": "1", "KEEP": "yes"}
    raw["startup"] = [{"kind": "nope"}, {"kind": "codex"}]
    path.write_text(json.dumps(raw), encoding="utf-8")
    loaded = load_workspace("api")
    assert loaded.env == {"KEEP": "yes"}
    assert [item["kind"] for item in loaded.startup] == ["codex"]


# --- routes -----------------------------------------------------------------------


def put(client, name: str, **body):
    return client.put(f"/api/workspaces/{quote(name, safe='')}", json={"layout": {}, **body})


def test_put_absent_preserves_and_a_value_replaces(client, sealed):
    assert put(client, "api", env={"A": "1"}, startup=[{"kind": "codex"}]).status_code == 204
    # A layout autosave sends neither key.
    assert put(client, "api").status_code == 204
    got = client.get("/api/workspaces/api").json()
    assert got["env"] == {"A": "1"}
    assert [item["kind"] for item in got["startup"]] == ["codex"]
    assert put(client, "api", env={"B": "2"}).status_code == 204
    got = client.get("/api/workspaces/api").json()
    assert got["env"] == {"B": "2"} and len(got["startup"]) == 1
    assert put(client, "api", env=None, startup=None).status_code == 204
    got = client.get("/api/workspaces/api").json()
    assert got["env"] == {} and got["startup"] == []


def test_put_refuses_a_bad_setup_with_the_reason(client):
    response = put(client, "api", env={"QUICKTERM_PORT": "1"})
    assert response.status_code == 400
    assert "set by QuickTerm" in response.json()["detail"]
    response = put(client, "api", startup=[{"kind": "shell", "command": "a\nb"}])
    assert response.status_code == 400
    assert client.get("/api/workspaces/api").status_code == 404


def test_an_ssh_workspace_refuses_a_line_break_in_a_variable(client):
    assert put(client, "box", host="me@box", path="/srv", env={"A": "1"}).status_code == 204
    response = client.patch("/api/workspaces/box", json={"env": {"CERT": "a\nb"}})
    assert response.status_code == 400 and "line break" in response.json()["detail"]
    response = client.patch("/api/workspaces/box", json={"startup": [{"kind": "shell", "env": {"X": "a\rb"}}]})
    assert response.status_code == 400
    # On this PC a value may span lines.
    assert put(client, "here", env={"CERT": "a\nb"}).status_code == 204


def test_patch_keeps_the_setup_and_can_change_it(client):
    assert put(client, "api", env={"A": "1"}, startup=[{"kind": "shell"}]).status_code == 204
    assert client.patch("/api/workspaces/api", json={"logo": "x.svg"}).status_code == 204
    got = client.get("/api/workspaces/api").json()
    assert got["env"] == {"A": "1"} and len(got["startup"]) == 1
    assert client.patch("/api/workspaces/api", json={"env": {"C": "3"}}).status_code == 204
    assert client.get("/api/workspaces/api").json()["env"] == {"C": "3"}
    assert client.patch("/api/workspaces/api", json={"env": {"1": "x"}}).status_code == 400


def test_get_answers_setup_for_a_workspace_that_has_none(client):
    assert put(client, "plain").status_code == 204
    got = client.get("/api/workspaces/plain").json()
    assert got["env"] == {} and got["startup"] == []
