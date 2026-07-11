"""Tests for quickterm-mcp: JSON-RPC dispatch, workspace scoping, tools, and
the urllib REST client — all against an in-memory fake backend (no sockets)."""

from __future__ import annotations

import io
import json
import sys
import urllib.error

import pytest

from quickterm.mcp_server import (
    BackendError,
    QuickTerm,
    RestBackend,
    Server,
    _bind_stdio,
    mcp_invocation,
    setup_message,
    serve,
)


# --- fake backend -----------------------------------------------------------


class FakeBackend:
    base = "http://127.0.0.1:8620"

    def __init__(self) -> None:
        self.sessions: list[dict] = []
        self.workspaces: dict[str, dict] = {}
        self.inputs: list[tuple[str, str]] = []
        self.spawned: list[dict] = []
        self.killed: list[str] = []
        self.focused: str | None = None
        self.allow_input = True
        self._counter = 0

    def add_session(self, sid: str, **kw) -> dict:
        s = {
            "id": sid,
            "name": kw.get("name", sid),
            "profile": kw.get("profile"),
            "alive": kw.get("alive", True),
            "exit_code": kw.get("exit_code"),
            "cols": 120,
            "rows": 30,
            "busy": kw.get("busy", False),
            "touched": kw.get("touched", False),
            "mcp_touched": kw.get("mcp_touched", False),
            "workspace": kw.get("workspace"),
            "text": kw.get("text", ""),
        }
        self.sessions.append(s)
        return s

    def add_workspace(self, name: str, session_ids=(), layout=None) -> None:
        self.workspaces[name] = {
            "name": name,
            "layout": layout or {"type": "pane"},
            "logo": None,
            "session_ids": list(session_ids),
        }

    def _find(self, sid: str) -> dict | None:
        return next((s for s in self.sessions if s["id"] == sid), None)

    # RestBackend surface -----------------------------------------------------

    def list_sessions(self) -> list[dict]:
        return [dict(s) for s in self.sessions]

    def list_workspaces(self) -> list[str]:
        return sorted(self.workspaces)

    def get_workspace(self, name: str) -> dict | None:
        ws = self.workspaces.get(name)
        return dict(ws) if ws else None

    def scrollback(self, sid: str, lines: int, strip_ansi: bool) -> dict:
        s = self._find(sid)
        if s is None:
            raise BackendError(404, "no such session")
        return {
            "id": sid,
            "text": s["text"],
            "lines": s["text"].count("\n") + 1,
            "truncated": False,
            "alive": s["alive"],
            "exit_code": s["exit_code"],
        }

    def send_input(self, sid: str, text: str) -> dict:
        if not self.allow_input:
            raise BackendError(403, "terminal input via API is disabled")
        s = self._find(sid)
        if s is None:
            raise BackendError(404, "no such session")
        if not s["alive"]:
            raise BackendError(409, "session has exited")
        self.inputs.append((sid, text))
        return {"written": len(text.encode())}

    def spawn(self, spec: dict) -> dict:
        self._counter += 1
        sid = f"spawn{self._counter}"
        self.spawned.append(spec)
        return self.add_session(
            sid, name=spec.get("name") or spec.get("profile"),
            profile=spec.get("profile"), workspace=spec.get("workspace"),
        )

    def kill(self, sid: str) -> None:
        self.killed.append(sid)
        self.sessions = [s for s in self.sessions if s["id"] != sid]

    def focus(self) -> dict:
        return {"session_id": self.focused}


def _call(server: Server, name: str, args: dict | None = None) -> dict:
    resp = server.handle(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
         "params": {"name": name, "arguments": args or {}}}
    )
    return resp["result"]


def _text(result: dict) -> str:
    return result["content"][0]["text"]


# --- protocol layer ---------------------------------------------------------


def test_initialize_echoes_protocol_and_includes_instructions():
    server = Server(QuickTerm(FakeBackend()))
    resp = server.handle(
        {"jsonrpc": "2.0", "id": 0, "method": "initialize",
         "params": {"protocolVersion": "2025-06-18"}}
    )
    assert resp["result"]["protocolVersion"] == "2025-06-18"
    assert resp["result"]["serverInfo"]["name"] == "quickterm"
    assert "tools" in resp["result"]["capabilities"]
    # the LLM's primer travels in the initialize result
    assert "workspace" in resp["result"]["instructions"].lower()
    assert "send_input" in resp["result"]["instructions"]


def test_tools_list_exposes_all_tools():
    server = Server(QuickTerm(FakeBackend()))
    resp = server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    names = {t["name"] for t in resp["result"]["tools"]}
    assert {
        "about", "whoami", "list_sessions", "read_terminal", "send_input",
        "spawn_session", "kill_session", "list_workspaces", "get_focused_session",
    } <= names


def test_about_tool_explains_the_bridge():
    server = Server(QuickTerm(FakeBackend()))
    result = _call(server, "about")
    assert result["isError"] is False
    text = _text(result)
    assert "workspace" in text.lower()
    assert "read_terminal" in text and "send_input" in text


def test_notification_returns_nothing_and_unknown_method_errors():
    server = Server(QuickTerm(FakeBackend()))
    assert server.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
    err = server.handle({"jsonrpc": "2.0", "id": 5, "method": "does/not/exist"})
    assert err["error"]["code"] == -32601


def test_serve_loop_roundtrips_over_streams():
    server = Server(QuickTerm(FakeBackend()))
    stdin = io.StringIO(
        '{"jsonrpc":"2.0","id":1,"method":"ping"}\n'
        "\n"  # blank line ignored
        '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'
    )
    stdout = io.StringIO()
    serve(server, stdin, stdout)
    out = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
    assert out[0]["id"] == 1 and out[0]["result"] == {}
    assert out[1]["id"] == 2 and "tools" in out[1]["result"]


def test_serve_loop_reports_parse_error():
    server = Server(QuickTerm(FakeBackend()))
    stdout = io.StringIO()
    serve(server, io.StringIO("not json\n"), stdout)
    out = json.loads(stdout.getvalue().strip())
    assert out["error"]["code"] == -32700


# --- scope resolution -------------------------------------------------------


def test_scope_from_workspace_file_membership():
    b = FakeBackend()
    for sid, nm in [("srv", "server"), ("tst", "tests"), ("cla", "claude")]:
        b.add_session(sid, name=nm, workspace="proj")
    b.add_session("other", name="other", workspace="misc")
    b.add_workspace("proj", session_ids=["srv", "tst", "cla"])
    b.add_workspace("misc", session_ids=["other"])
    server = Server(QuickTerm(b, own_session="cla"))
    data = json.loads(_text(_call(server, "list_sessions")))
    assert data["workspace"] == "proj"
    assert {s["id"] for s in data["sessions"]} == {"srv", "tst", "cla"}
    assert any(s["is_self"] for s in data["sessions"])


def test_scope_from_env_override():
    b = FakeBackend()
    b.add_session("a", workspace="x")
    b.add_session("b", workspace="y")
    name, in_scope, _all = QuickTerm(b, workspace="x").scoped()
    assert name == "x"
    assert {s["id"] for s in in_scope} == {"a"}


def test_scope_from_tag_when_no_workspace_file():
    b = FakeBackend()
    b.add_session("a", workspace="proj")
    b.add_session("b", workspace="proj")
    b.add_session("c", workspace="other")
    name, in_scope, _all = QuickTerm(b, own_session="a").scoped()
    assert name == "proj"
    assert {s["id"] for s in in_scope} == {"a", "b"}


def test_file_membership_wins_over_stale_tag_after_rename():
    # A session spawned during scratch keeps workspace="scratch" as its tag, but
    # once the layout is saved as "proj" the file is authoritative.
    b = FakeBackend()
    b.add_session("cla", workspace="scratch")
    b.add_session("srv", workspace="scratch")
    b.add_workspace("proj", session_ids=["cla", "srv"])
    name, in_scope, _all = QuickTerm(b, own_session="cla").scoped()
    assert name == "proj"
    assert {s["id"] for s in in_scope} == {"cla", "srv"}


def test_unscoped_when_no_workspace_resolves():
    b = FakeBackend()
    b.add_session("a")
    b.add_session("b")
    name, in_scope, _all = QuickTerm(b, own_session="a").scoped()
    assert name is None
    assert len(in_scope) == 2  # all live sessions


# --- read / write tools -----------------------------------------------------


def test_read_terminal_in_and_out_of_scope():
    b = FakeBackend()
    b.add_session("a", workspace="proj", text="hello\nworld")
    b.add_session("z", workspace="other", text="secret")
    b.add_workspace("proj", session_ids=["a"])
    b.add_workspace("other", session_ids=["z"])
    server = Server(QuickTerm(b, own_session="a"))
    ok = _call(server, "read_terminal", {"session_id": "a"})
    assert ok["isError"] is False
    assert "world" in _text(ok)
    blocked = _call(server, "read_terminal", {"session_id": "z"})
    assert blocked["isError"] is True
    assert "not in" in _text(blocked)


def test_send_input_sibling_self_and_disabled():
    b = FakeBackend()
    b.add_session("cla", workspace="proj")
    b.add_session("srv", workspace="proj")
    b.add_workspace("proj", session_ids=["cla", "srv"])
    server = Server(QuickTerm(b, own_session="cla"))

    ok = _call(server, "send_input", {"session_id": "srv", "text": "ls\r"})
    assert ok["isError"] is False
    assert b.inputs == [("srv", "ls\r")]

    own = _call(server, "send_input", {"session_id": "cla", "text": "x\r"})
    assert own["isError"] is True
    assert "own session" in _text(own)

    b.allow_input = False
    disabled = _call(server, "send_input", {"session_id": "srv", "text": "y\r"})
    assert disabled["isError"] is True


def test_spawn_joins_workspace_and_kill_is_limited():
    b = FakeBackend()
    b.add_session("cla", workspace="proj")
    b.add_workspace("proj", session_ids=["cla"])
    server = Server(QuickTerm(b, own_session="cla"))

    spawned = _call(server, "spawn_session", {"profile": "pwsh", "name": "build"})
    assert spawned["isError"] is False
    new_id = json.loads(_text(spawned))["spawned"]["id"]
    assert b.spawned[0]["workspace"] == "proj"

    # kill is allowed for a session this bridge spawned…
    killed = _call(server, "kill_session", {"session_id": new_id})
    assert killed["isError"] is False
    assert new_id in b.killed

    # …but refused for the user's own terminals.
    refused = _call(server, "kill_session", {"session_id": "cla"})
    assert refused["isError"] is True


def test_get_focused_session_reports_scope():
    b = FakeBackend()
    b.add_session("cla", name="claude", workspace="proj")
    b.add_workspace("proj", session_ids=["cla"])
    b.focused = "cla"
    server = Server(QuickTerm(b, own_session="cla"))
    data = json.loads(_text(_call(server, "get_focused_session")))
    assert data["session_id"] == "cla"
    assert data["in_scope"] is True
    assert data["is_self"] is True


def test_whoami_and_missing_args_error():
    b = FakeBackend()
    b.add_session("cla", workspace="proj")
    b.add_workspace("proj", session_ids=["cla"])
    server = Server(QuickTerm(b, own_session="cla"))
    who = json.loads(_text(_call(server, "whoami")))
    assert who["own_session"] == "cla" and who["workspace"] == "proj"
    bad = _call(server, "read_terminal", {})  # missing session_id
    assert bad["isError"] is True


# --- REST client ------------------------------------------------------------


class _FakeResp:
    def __init__(self, data: bytes) -> None:
        self._data = data

    def read(self) -> bytes:
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_rest_backend_sends_token_and_parses_json():
    seen = []

    def opener(req, timeout=None):
        seen.append(req)
        return _FakeResp(b'[{"id":"a"}]')

    backend = RestBackend("127.0.0.1", 8620, "tok", opener=opener)
    assert backend.list_sessions() == [{"id": "a"}]
    req = seen[0]
    assert req.full_url == "http://127.0.0.1:8620/api/sessions"
    # urllib capitalizes header keys: "X-QuickTerm-Token" -> "X-quickterm-token"
    assert req.get_header("X-quickterm-token") == "tok"


def test_rest_backend_maps_http_error_to_backend_error():
    def opener(req, timeout=None):
        raise urllib.error.HTTPError(
            req.full_url, 404, "nf", {}, io.BytesIO(b'{"detail":"no such session"}')
        )

    backend = RestBackend("127.0.0.1", 8620, "tok", opener=opener)
    with pytest.raises(BackendError) as info:
        backend.scrollback("x", 200, True)
    assert info.value.status == 404
    assert "no such session" in info.value.message


def test_rest_backend_get_workspace_404_is_none():
    def opener(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 404, "nf", {}, io.BytesIO(b""))

    backend = RestBackend("127.0.0.1", 8620, "t", opener=opener)
    assert backend.get_workspace("missing") is None


def test_setup_message_mentions_claude_add_command():
    text = setup_message()
    assert "claude mcp add quickterm" in text
    assert "mcpServers" in text


# --- frozen / dual-mode -----------------------------------------------------


def test_mcp_invocation_dev_and_frozen(monkeypatch):
    monkeypatch.delattr(sys, "frozen", raising=False)
    assert mcp_invocation() == ("quickterm-mcp", [])
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", r"C:\Apps\QuickTerm\QuickTerm.exe", raising=False)
    command, args = mcp_invocation()
    assert command.endswith("QuickTerm.exe") and args == ["mcp"]


def test_setup_message_quotes_frozen_path():
    text = setup_message(r"C:\Program Files\QuickTerm\QuickTerm.exe", ["mcp"])
    assert 'claude mcp add quickterm -- "C:\\Program Files\\QuickTerm\\QuickTerm.exe" mcp' in text
    assert '"args"' in text  # the .mcp.json block carries the subcommand


def test_bind_stdio_prefers_existing_streams(monkeypatch):
    fake_in, fake_out = io.StringIO(), io.StringIO()
    monkeypatch.setattr(sys, "stdin", fake_in)
    monkeypatch.setattr(sys, "stdout", fake_out)
    assert _bind_stdio() == (fake_in, fake_out)


def test_app_mcp_subcommand_delegates(monkeypatch):
    import quickterm.app as app
    import quickterm.mcp_server as mcp

    captured = {}
    monkeypatch.setattr(sys, "argv", ["QuickTerm.exe", "mcp", "--setup", "--port", "9"])
    monkeypatch.setattr(mcp, "main", lambda argv=None: captured.setdefault("argv", argv))
    app.main()
    assert captured["argv"] == ["--setup", "--port", "9"]
