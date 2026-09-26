"""Every route is token-gated unless it is on the one short exemption list.

The token is the real boundary (the Host/Origin guard does not stop a native
local program), so this walks the live route table instead of trusting a
hand-kept list: a new route, a widened exemption, or a route mounted outside
/api fails here.
"""

from __future__ import annotations

import re

import pytest
from fastapi.routing import APIRoute, APIWebSocketRoute
from fastapi.testclient import TestClient
from starlette.routing import Mount

from quickterm.server import create_app
from tests.test_server import FakeConfig, FakeSessionManager

TOKEN = "s3cret"
BASE = "http://127.0.0.1:8620"
# The complete list of API answers that need no token: the liveness probe, and
# workspace logos, which <img> loads and cannot attach a header to.
EXEMPT = {("GET", "/api/health"), ("GET", "/api/assets/{asset_id}")}


def _app():
    return create_app(FakeSessionManager(), FakeConfig(), TOKEN)


def _api_endpoints() -> list[tuple[str, str]]:
    endpoints = []
    for route in _app().routes:
        if isinstance(route, APIRoute) and route.path.startswith("/api"):
            for method in sorted(route.methods - {"HEAD"}):
                endpoints.append((method, route.path))
    return endpoints


def _concrete(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "x", path)


@pytest.fixture(scope="module")
def client():
    with TestClient(_app(), base_url=BASE) as c:
        yield c


def test_the_route_table_is_not_empty():
    # Guards the parametrization below against silently testing nothing.
    assert len(_api_endpoints()) > 30


@pytest.mark.parametrize("method,path", [e for e in _api_endpoints() if e not in EXEMPT])
def test_every_api_route_refuses_a_request_without_the_token(client, method, path):
    response = client.request(method, _concrete(path))
    assert response.status_code == 403, (method, path)
    assert response.text == "forbidden: bad token"
    wrong = client.request(method, _concrete(path), headers={"X-QuickTerm-Token": "nope"})
    assert wrong.status_code == 403


def test_the_exemptions_answer_without_the_token(client, monkeypatch, tmp_path):
    monkeypatch.setenv("APPDATA", str(tmp_path))  # the asset store lives there
    assert client.get("/api/health").status_code == 200
    # Unknown asset: a 404 from the handler, not a 403 from the guard.
    assert client.get("/api/assets/0123456789abcdef.png").status_code == 404


def test_uploading_and_deleting_assets_stay_gated(client):
    assert client.post("/api/assets", content=b"x", headers={"content-type": "image/png"}).status_code == 403
    assert client.delete("/api/assets/x.png").status_code == 403


def test_the_schema_is_not_served():
    # /openapi.json listed every route without asking for the token.
    app = _app()
    assert app.openapi_url is None
    with TestClient(app, base_url=BASE) as c:
        assert c.get("/openapi.json").status_code == 404
        assert c.get("/docs").status_code == 404


def test_outside_api_there_is_only_the_viewer_the_socket_and_the_static_shell():
    outside = set()
    for route in _app().routes:
        if isinstance(route, APIRoute):
            if not route.path.startswith("/api/"):
                outside.add(("route", route.path))
        elif isinstance(route, APIWebSocketRoute):
            outside.add(("websocket", route.path))
        elif isinstance(route, Mount):
            outside.add(("mount", route.path or "/"))
        else:
            outside.add((type(route).__name__, getattr(route, "path", "?")))
    assert outside == {
        ("route", "/viewer"),
        ("websocket", "/ws/session/{sid}"),
        ("mount", "/"),
    }


def test_a_native_client_attaches_with_the_token_and_no_origin():
    manager = FakeSessionManager()
    info = manager.add_session(scrollback=b"x")
    with TestClient(create_app(manager, FakeConfig(), TOKEN), base_url=BASE) as c:
        with c.websocket_connect(
            f"/ws/session/{info.id}",
            headers={"host": "127.0.0.1:8620"},
            subprotocols=[f"qtauth.{TOKEN}"],
        ) as ws:
            assert ws.receive_json()["type"] == "replay_size"
