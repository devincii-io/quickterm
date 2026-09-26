"""POST /api/launches with a profile or a workspace, and POST /api/sessions/{id}/input."""

from __future__ import annotations

import hashlib
import hmac
import sys
import threading
import types
from dataclasses import dataclass, field

import pytest
from fastapi.testclient import TestClient

from quickterm.server import create_app
from tests.test_server import FakeConfig, FakeProfile, FakeSessionManager

BASE = "http://127.0.0.1:8620"


@pytest.fixture
def manager():
    return FakeSessionManager()


@pytest.fixture
def workspaces(monkeypatch):
    @dataclass
    class Workspace:
        name: str
        layout: dict = field(default_factory=dict)
        path: str | None = None

    loads: list[bool] = []
    store = {"dev": Workspace("dev")}
    mod = types.ModuleType("quickterm.workspace")

    def load_workspace(name):
        loads.append(threading.current_thread() is threading.main_thread())
        return store.get(name)

    mod.load_workspace = load_workspace
    monkeypatch.setitem(sys.modules, "quickterm.workspace", mod)
    return loads


@pytest.fixture
def client(manager, workspaces):
    cfg = FakeConfig(profiles=[FakeProfile(name="pwsh", cmd="pwsh.exe")])
    with TestClient(create_app(manager, cfg), base_url=BASE) as c:
        yield c


def _claim(client):
    return client.get("/api/launches/next?wait=false")


# --- the launch queue ------------------------------------------------------------


def test_a_launch_carries_only_the_fields_it_named(client, tmp_path):
    queued = client.post(
        "/api/launches",
        json={"profile": "pwsh", "workspace": " dev ", "cwd": str(tmp_path), "extra": 1},
    )
    assert queued.status_code == 200
    item = {"profile": "pwsh", "workspace": "dev", "cwd": str(tmp_path)}
    assert queued.json() == item
    assert _claim(client).json() == item


@pytest.mark.parametrize("body", [{"profile": "pwsh"}, {"workspace": "dev"}])
def test_a_profile_or_a_workspace_alone_is_a_launch(client, body):
    assert client.post("/api/launches", json=body).status_code == 200
    assert _claim(client).json() == body


def test_an_unknown_profile_or_workspace_is_refused_and_nothing_is_queued(client, tmp_path):
    unknown = client.post("/api/launches", json={"profile": "nope", "cwd": str(tmp_path)})
    assert unknown.status_code == 404
    assert unknown.json()["detail"] == "unknown profile: nope"
    missing = client.post("/api/launches", json={"workspace": "gone"})
    assert missing.status_code == 404
    assert missing.json()["detail"] == "no such workspace: gone"
    gone = client.post("/api/launches", json={"profile": "pwsh", "cwd": str(tmp_path / "x")})
    assert gone.status_code == 400
    assert _claim(client).status_code == 204


@pytest.mark.parametrize("body", [
    {},
    {"unknown": "x"},
    [],
    {"cwd": ""},
    {"cwd": 3},
    {"profile": ""},
    {"profile": 3},
    {"workspace": "  "},
    {"workspace": 3},
    {"workspace": "a\x01b"},
])
def test_a_launch_that_names_nothing_usable_is_a_bad_request(client, body):
    assert client.post("/api/launches", json=body).status_code == 400


def test_the_workspace_check_runs_off_the_event_loop(client, workspaces):
    assert client.post("/api/launches", json={"workspace": "dev"}).status_code == 200
    # TestClient runs the app on its own loop thread; a check on that thread
    # would block every pane. to_thread moves it to a worker.
    assert workspaces and not any(workspaces)


# --- typing into a session -----------------------------------------------------------


def test_input_is_written_and_marks_the_session_touched(client, manager):
    info = manager.add_session()
    response = client.post(f"/api/sessions/{info.id}/input", json={"text": "ls -la"})
    assert response.status_code == 204
    assert manager.writes == [(info.id, b"ls -la")]
    assert manager.touched == [info.id]


def test_enter_appends_a_carriage_return_and_text_is_utf8(client, manager):
    info = manager.add_session()
    response = client.post(
        f"/api/sessions/{info.id}/input", json={"text": "echo grüße", "enter": True}
    )
    assert response.status_code == 204
    assert manager.writes == [(info.id, "echo grüße\r".encode())]
    enter_only = client.post(f"/api/sessions/{info.id}/input", json={"text": "", "enter": True})
    assert enter_only.status_code == 204
    assert manager.writes[-1] == (info.id, b"\r")


def test_input_to_an_unknown_or_exited_session(client, manager):
    assert client.post("/api/sessions/nope/input", json={"text": "x"}).status_code == 404
    info = manager.add_session(alive=False, exit_code=0)
    response = client.post(f"/api/sessions/{info.id}/input", json={"text": "x"})
    assert response.status_code == 409
    assert manager.writes == []
    assert manager.touched == []


@pytest.mark.parametrize("body", [
    {},
    {"text": 3},
    {"text": "x", "enter": "yes"},
    {"text": ""},
    ["x"],
])
def test_input_with_a_bad_body_writes_nothing(client, manager, body):
    info = manager.add_session()
    assert client.post(f"/api/sessions/{info.id}/input", json=body).status_code == 400
    assert manager.writes == []
    assert manager.touched == []


def test_input_with_a_lone_surrogate_is_refused(client, manager):
    info = manager.add_session()
    response = client.post(
        f"/api/sessions/{info.id}/input",
        content=b'{"text": "a\\ud800"}',
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 400
    assert manager.writes == []


def test_input_is_capped_at_64_kib_of_utf8(client, manager):
    info = manager.add_session()
    url = f"/api/sessions/{info.id}/input"
    assert client.post(url, json={"text": "a" * 65536}).status_code == 204
    # 21846 three-byte characters are 65538 bytes, although only 21846 characters.
    assert client.post(url, json={"text": "€" * 21846}).status_code == 400
    assert len(manager.writes) == 1


def test_a_full_input_queue_is_reported_not_touched(client, manager, monkeypatch):
    info = manager.add_session()

    def full(_sid, _data):
        raise BufferError("full")

    monkeypatch.setattr(manager, "write", full)
    response = client.post(f"/api/sessions/{info.id}/input", json={"text": "x"})
    assert response.status_code == 503
    assert manager.touched == []


def test_a_terminal_that_exits_while_the_body_is_read_gets_409(client, manager):
    info = manager.add_session()

    def body():
        yield b'{"text": '
        info.alive = False  # the shell exits mid-request
        yield b'"x"}'

    response = client.post(
        f"/api/sessions/{info.id}/input", content=body(),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 409
    assert manager.writes == []
    assert manager.touched == []


def test_a_write_the_terminal_did_not_take_is_409_not_204(client, manager, monkeypatch):
    info = manager.add_session()

    def gone(sid, _data):
        # SessionManager.write drops input for a terminal that is gone,
        # without saying so; the route has to notice.
        manager.sessions.pop(sid)

    monkeypatch.setattr(manager, "write", gone)
    response = client.post(f"/api/sessions/{info.id}/input", json={"text": "x"})
    assert response.status_code == 409
    assert manager.touched == []


# --- the health challenge ------------------------------------------------------------


def test_health_proves_the_token_for_a_challenge_and_is_unchanged_without_one(manager):
    cfg = FakeConfig()
    with TestClient(create_app(manager, cfg, "s3cret"), base_url=BASE) as c:
        plain = c.get("/api/health")
        assert plain.status_code == 200
        assert set(plain.json()) == {"app", "version"}
        nonce = "abcDEF_123-xyz456"
        answer = c.get(f"/api/health?challenge={nonce}")
        # Still open: no token was sent, and the proof reveals nothing of it.
        assert answer.status_code == 200
        expected = hmac.new(b"s3cret", nonce.encode(), hashlib.sha256).hexdigest()
        assert answer.json()["proof"] == expected
        assert answer.json()["app"] == "quickterm"


@pytest.mark.parametrize("nonce", ["short", "x" * 65, "has spaces in it, too", "a/b" * 8])
def test_a_malformed_challenge_is_refused(client, nonce):
    assert client.get("/api/health", params={"challenge": nonce}).status_code == 400


def test_the_command_line_trusts_the_real_route_and_nothing_else(manager, monkeypatch):
    from quickterm import cli

    with TestClient(create_app(manager, FakeConfig(), "s3cret"), base_url=BASE) as c:

        class Answer:
            def __init__(self, response):
                self.content = response.content

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return self.content

        monkeypatch.setattr(cli, "_open", lambda url, timeout: Answer(c.get(url[len(BASE):])))
        assert cli.probe(BASE, lambda: "s3cret") == cli.QUICKTERM
        assert cli.probe(BASE, lambda: "another-users-token") == cli.IMPOSTOR
