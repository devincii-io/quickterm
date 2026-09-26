"""Routes for "needs you": the attention field, POST seen, and the native notifier."""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

import quickterm.session_manager as session_manager
from quickterm.api import sessions as session_routes
from quickterm.server import create_app
from quickterm.session_manager import SessionManager
from tests.test_server import FakeConfig, FakeSessionManager
from tests.test_session_manager import _RecordingPty

BASE = "http://127.0.0.1:8620"


@pytest.fixture
def real_manager(monkeypatch):
    monkeypatch.setattr(session_manager, "PtySession", _RecordingPty)
    monkeypatch.setattr(session_manager, "process_identities", lambda: [])
    loop = asyncio.new_event_loop()
    manager = SessionManager(loop)
    yield manager
    manager._sessions.clear()
    loop.close()


def client_for(manager, **kwargs) -> TestClient:
    return TestClient(create_app(manager, FakeConfig(), **kwargs), base_url=BASE)


def test_every_entry_carries_attention_and_the_current_folder(real_manager):
    quiet = real_manager.spawn(cmd="x.exe", name="quiet")
    agent = real_manager.spawn(cmd="x.exe", name="agent")
    _RecordingPty.last.on_output(b"\x1b]7;file://localhost/C:/work/repo\x1b\\\x1b]9;Approve?\x07")
    with client_for(real_manager) as client:
        for metrics in ("true", "false"):
            rows = {row["id"]: row for row in client.get(f"/api/sessions?metrics={metrics}").json()}
            assert rows[quiet.id]["attention"] is None
            assert rows[quiet.id]["current_cwd"] is None
            assert rows[agent.id]["attention"] == {
                "kind": "notify", "text": "Approve?", "age_seconds": 0,
            }
            assert rows[agent.id]["current_cwd"] is not None
            assert rows[agent.id]["busy"] is False


def test_seen_clears_attention_and_answers_204(real_manager):
    info = real_manager.spawn(cmd="x.exe")
    _RecordingPty.last.on_output(b"\x07")
    with client_for(real_manager) as client:
        response = client.post(f"/api/sessions/{info.id}/seen")
        assert response.status_code == 204
        assert client.get("/api/sessions").json()[0]["attention"] is None
        # Seen twice is still fine: there is simply nothing left to clear.
        assert client.post(f"/api/sessions/{info.id}/seen").status_code == 204


def test_seen_for_an_unknown_session_is_404():
    with client_for(FakeSessionManager()) as client:
        assert client.post("/api/sessions/missing/seen").status_code == 404


def test_seen_is_token_gated():
    manager = FakeSessionManager()
    info = manager.add_session()
    with TestClient(create_app(manager, FakeConfig(), "tok"), base_url=BASE) as client:
        assert client.post(f"/api/sessions/{info.id}/seen").status_code in (401, 403)
        ok = client.post(f"/api/sessions/{info.id}/seen", headers={"X-QuickTerm-Token": "tok"})
        assert ok.status_code == 204


def test_attention_reaches_the_native_notifier_once_per_interval(real_manager, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(session_routes, "NotifyThrottle",
                        lambda interval: _ClockThrottle(interval, now))
    heard = []
    create_app(real_manager, FakeConfig(), notify=lambda *args: heard.append(args))
    info = real_manager.spawn(cmd="x.exe", name="claude")
    pty = _RecordingPty.last
    pty.on_output(b"\x1b]777;notify;Claude;waiting\x07")
    pty.on_output(b"\x07\x07\x07")
    assert heard == [(info.id, "claude", "notify", "Claude: waiting")]
    now[0] += session_routes.NOTIFY_INTERVAL_S
    pty.on_output(b"\x07")
    assert heard[-1] == (info.id, "claude", "bell", None)
    assert len(heard) == 2


def test_no_desktop_shell_means_no_listener(real_manager):
    create_app(real_manager, FakeConfig())
    assert real_manager._attention_listener is None


class _ClockThrottle(session_routes.NotifyThrottle):
    def __init__(self, interval, now):
        super().__init__(interval, clock=lambda: now[0])
