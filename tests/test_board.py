"""The workspace board's status store and routes (CONTRACTS.md, 4.3)."""

from __future__ import annotations

import json
import threading
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from quickterm import board
from quickterm import workspace as workspace_mod
from quickterm.server import create_app
from tests.test_server import FakeConfig, FakeSessionManager


@pytest.fixture(autouse=True)
def appdata(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    monkeypatch.setattr(workspace_mod, "_NAMESPACE", None)
    return tmp_path / "appdata"


@pytest.fixture
def client():
    with TestClient(create_app(FakeSessionManager(), FakeConfig()),
                    base_url="http://127.0.0.1:8620") as c:
        yield c


def stored(appdata) -> dict:
    return json.loads((appdata / "quickterm" / "board.json").read_text(encoding="utf-8"))


def save(client, name: str) -> None:
    response = client.put(f"/api/workspaces/{quote(name, safe='')}", json={"layout": {}})
    assert response.status_code == 204


# --- the store --------------------------------------------------------------


def test_an_absent_file_is_an_empty_board():
    assert board.load_status() == {}


def test_set_status_writes_the_versioned_document(appdata):
    board.set_status("api", "todo")
    board.set_status("web", "done")
    assert stored(appdata) == {"version": 1, "status": {"api": "todo", "web": "done"}}
    assert board.load_status() == {"api": "todo", "web": "done"}
    # Nothing is left behind by the temp-file swap.
    assert sorted(path.name for path in (appdata / "quickterm").iterdir()) == ["board.json"]


def test_an_unknown_status_is_refused_and_nothing_is_written(appdata):
    with pytest.raises(ValueError):
        board.set_status("api", "blocked")
    assert not (appdata / "quickterm" / "board.json").exists()


def test_rename_moves_the_entry_and_forget_removes_it():
    board.set_status("old", "in-review")
    board.set_status("other", "todo")
    board.rename_workspace("old", "new")
    assert board.load_status() == {"new": "in-review", "other": "todo"}
    board.rename_workspace("missing", "other")
    assert board.load_status()["other"] == "todo"
    board.forget_workspace("new")
    board.forget_workspace("never-there")
    assert board.load_status() == {"other": "todo"}


def test_an_unreadable_or_foreign_file_reads_as_empty_and_keeps_only_known_statuses(appdata):
    path = appdata / "quickterm" / "board.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json", encoding="utf-8")
    assert board.load_status() == {}
    path.write_text(json.dumps({"version": 1, "status": {"a": "done", "b": "later", "": "todo", "c": 3}}),
                    encoding="utf-8")
    assert board.load_status() == {"a": "done"}
    path.write_text("[]", encoding="utf-8")
    assert board.load_status() == {}


def test_parallel_writes_lose_no_entry():
    names = [f"ws{index}" for index in range(24)]
    threads = [threading.Thread(target=board.set_status, args=(name, "done")) for name in names]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert board.load_status() == dict.fromkeys(names, "done")


# --- the routes -------------------------------------------------------------


def test_get_board_lists_existing_workspaces_only(client):
    save(client, "api")
    save(client, "a/b")
    board.set_status("gone", "done")
    assert client.get("/api/board").json()["status"] == {}
    assert client.put("/api/board/api", json={"status": "in-review"}).status_code == 204
    assert client.put("/api/board/a%2Fb", json={"status": "todo"}).status_code == 204
    assert client.get("/api/board").json()["status"] == {"api": "in-review", "a/b": "todo"}


def test_put_board_answers_404_for_an_unknown_workspace(client):
    response = client.put("/api/board/nope", json={"status": "todo"})
    assert response.status_code == 404
    assert board.load_status() == {}


@pytest.mark.parametrize("body", [{"status": "blocked"}, {"status": None}, {}, [], {"status": 1}])
def test_put_board_answers_400_for_an_unknown_status(client, body):
    save(client, "api")
    response = client.put("/api/board/api", json=body)
    assert response.status_code == 400
    assert board.load_status() == {}


def test_deleting_a_workspace_removes_its_entry(client):
    save(client, "api")
    save(client, "web")
    client.put("/api/board/api", json={"status": "done"})
    client.put("/api/board/web", json={"status": "todo"})
    assert client.delete("/api/workspaces/api").status_code == 204
    assert board.load_status() == {"web": "todo"}
    # Saved again under the same name, it starts in the default column.
    save(client, "api")
    assert client.get("/api/board").json()["status"] == {"web": "todo"}


def test_a_layout_autosave_never_touches_the_board(client, appdata):
    save(client, "api")
    client.put("/api/board/api", json={"status": "in-review"})
    before = stored(appdata)
    save(client, "api")
    client.patch("/api/workspaces/api", json={"path": None})
    assert stored(appdata) == before
