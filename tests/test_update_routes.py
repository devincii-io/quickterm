"""Update routes: the check, its automatic download, status, download, install."""

from __future__ import annotations

import sys
import types

import pytest
from fastapi.testclient import TestClient

from quickterm.api import system as system_routes
from quickterm.server import create_app
from tests.test_server import FakeConfig, FakeSessionManager

BASE = "http://127.0.0.1:8620"
CHECK = {
    "current": "0.2.0", "latest": "0.3.0", "update_available": True,
    "url": "https://github.com/devincii-io/quickterm/releases", "notes": "", "installable": True,
}


class UpdateStub(types.ModuleType):
    class UpdateNotReady(Exception):
        pass

    def __init__(self, check=CHECK):
        super().__init__("quickterm.update")
        self.result = dict(check)
        self.started = 0
        self.installs = 0
        self.ready = False
        self.state = {"state": "available", "version": "0.3.0", "received": 0,
                      "total": None, "error": None, "notes_url": CHECK["url"]}

    def check(self, force=False):
        if isinstance(self.result, Exception):
            raise self.result
        return self.result

    def start_download(self):
        self.started += 1
        return True

    def status(self):
        return dict(self.state)

    def restart(self):
        if self.state["state"] != "installed":
            raise self.UpdateNotReady("no installed update waits for a restart")
        self.restarts = getattr(self, "restarts", 0) + 1
        return {"started": True}

    def install(self):
        if not self.ready:
            raise self.UpdateNotReady("no verified installer is ready")
        self.installs += 1
        return {"launched": True, "version": "0.3.0"}


@pytest.fixture
def stub(monkeypatch):
    mod = UpdateStub()
    monkeypatch.setitem(sys.modules, "quickterm.update", mod)
    monkeypatch.setattr(system_routes, "_windows", lambda: True)
    return mod


def _client(cfg=None, elevated=False):
    return TestClient(
        create_app(FakeSessionManager(), cfg or FakeConfig(), elevated=elevated), base_url=BASE
    )


def test_check_starts_the_download_when_installable(stub):
    with _client() as client:
        response = client.get("/api/update")
    assert response.status_code == 200
    assert response.json() == CHECK
    assert stub.started == 1


def test_check_maps_failure_to_502(stub):
    stub.result = OSError("offline")
    with _client() as client:
        assert client.get("/api/update").status_code == 502
    assert stub.started == 0


@pytest.mark.parametrize(
    ("setting", "value"), [("update_auto_download", False), ("update_check", False)]
)
def test_check_does_not_download_when_switched_off(stub, setting, value):
    cfg = FakeConfig()
    setattr(cfg, setting, value)
    with _client(cfg) as client:
        assert client.get("/api/update").status_code == 200
    assert stub.started == 0


def test_auto_download_setting_applies_live(stub):
    cfg = FakeConfig()
    cfg.update_auto_download = False
    with _client(cfg) as client:
        client.get("/api/update")
        cfg.update_auto_download = True
        client.get("/api/update")
    assert stub.started == 1


def test_check_never_downloads_in_the_elevated_instance(stub):
    with _client(elevated=True) as client:
        assert client.get("/api/update").status_code == 200
    assert stub.started == 0


def test_check_never_downloads_off_windows(stub, monkeypatch):
    monkeypatch.setattr(system_routes, "_windows", lambda: False)
    with _client() as client:
        assert client.get("/api/update").status_code == 200
    assert stub.started == 0


def test_check_without_an_installable_update_starts_nothing(stub):
    stub.result = {**CHECK, "installable": False}
    with _client() as client:
        client.get("/api/update")
    assert stub.started == 0


def test_status_route(stub):
    with _client() as client:
        response = client.get("/api/update/status")
    assert response.status_code == 200
    assert set(response.json()) == {"state", "version", "received", "total", "error", "notes_url"}
    assert response.json()["state"] == "available"


def test_status_is_idle_in_the_elevated_instance(stub):
    with _client(elevated=True) as client:
        assert client.get("/api/update/status").json()["state"] == "idle"


def test_download_route_starts_or_joins(stub):
    with _client() as client:
        assert client.post("/api/update/download").status_code == 204
        assert client.post("/api/update/download").status_code == 204
    assert stub.started == 2  # the module decides whether it joins


def test_download_route_400_without_an_installable_update(stub):
    stub.result = {**CHECK, "update_available": False, "installable": False}
    with _client() as client:
        assert client.post("/api/update/download").status_code == 400
    assert stub.started == 0


def test_download_route_400_when_the_module_refuses(stub):
    def refuse():
        raise ValueError("no installable update is available")

    stub.start_download = refuse
    with _client() as client:
        assert client.post("/api/update/download").status_code == 400


def test_download_route_400_in_the_elevated_instance(stub):
    with _client(elevated=True) as client:
        assert client.post("/api/update/download").status_code == 400
    assert stub.started == 0


def test_download_route_400_off_windows(stub, monkeypatch):
    monkeypatch.setattr(system_routes, "_windows", lambda: False)
    with _client() as client:
        assert client.post("/api/update/download").status_code == 400


def test_install_409_when_not_ready(stub):
    with _client() as client:
        response = client.post("/api/update/install")
    assert response.status_code == 409
    assert stub.installs == 0


def test_install_when_ready(stub):
    stub.ready = True
    with _client() as client:
        response = client.post("/api/update/install")
    assert response.status_code == 200
    assert response.json() == {"launched": True, "version": "0.3.0"}


def test_install_400_in_the_elevated_instance(stub):
    stub.ready = True
    with _client(elevated=True) as client:
        assert client.post("/api/update/install").status_code == 400
    assert stub.installs == 0


def test_restart_409_unless_installed(stub):
    with _client() as client:
        assert client.post("/api/update/restart").status_code == 409


def test_restart_when_installed(stub):
    stub.state["state"] = "installed"
    with _client() as client:
        response = client.post("/api/update/restart")
    assert response.status_code == 200
    assert response.json() == {"started": True}
    assert stub.restarts == 1


def test_restart_400_in_the_elevated_instance(stub):
    stub.state["state"] = "installed"
    with _client(elevated=True) as client:
        assert client.post("/api/update/restart").status_code == 400


def test_install_500_when_setup_cannot_start(stub):
    def broken():
        raise OSError("access denied")

    stub.install = broken
    with _client() as client:
        assert client.post("/api/update/install").status_code == 500
