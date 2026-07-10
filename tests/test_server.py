"""Server tests against fake manager/config implementing the CONTRACTS.md surface."""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import json
import sys
import time
import types
import uuid
from dataclasses import dataclass, field

import pytest
from fastapi.testclient import TestClient

from quickterm.server import create_app

# --- fakes implementing the contract surface -------------------------------


@dataclass
class FakeProfile:
    name: str
    cmd: str
    args: list = field(default_factory=list)
    cwd: str | None = None
    env: dict = field(default_factory=dict)
    keybinding: str | None = None
    autostart: bool = False
    terminal_type: str | None = None
    wsl_distro: str | None = None
    start_command: str | None = None


@dataclass
class FakeSnippet:
    name: str
    text: str


@dataclass
class FakeVoiceConfig:
    enabled: bool = True
    model_size: str = "small"
    hotkey: str = "ctrl+alt+v"
    language: str | None = None


@dataclass
class FakeConfig:
    host: str = "127.0.0.1"
    port: int = 8620
    scrollback_bytes: int = 512 * 1024
    font_family: str = "JetBrains Mono"
    summon_hotkey: str = "ctrl+alt+grave"
    default_profile: str = "powershell"
    profiles: list = field(default_factory=list)
    snippets: list = field(default_factory=list)
    voice: FakeVoiceConfig = field(default_factory=FakeVoiceConfig)


@dataclass
class FakeSessionInfo:
    id: str
    name: str
    profile: str | None
    alive: bool
    exit_code: int | None
    cols: int
    rows: int


class FakeAttachment:
    def __init__(self) -> None:
        self.queue: asyncio.Queue = asyncio.Queue()
        self.loop = asyncio.get_running_loop()
        self.detached = False

    def detach(self) -> None:
        self.detached = True

    def push_threadsafe(self, item: bytes | None) -> None:
        self.loop.call_soon_threadsafe(self.queue.put_nowait, item)


class FakeSession:
    def __init__(self, info: FakeSessionInfo, scrollback: bytes = b"") -> None:
        self.info = info
        self._scrollback = scrollback

    def scrollback(self) -> tuple[bytes, int, int]:
        return self._scrollback, self.info.cols, self.info.rows


class FakeSessionManager:
    def __init__(self) -> None:
        self.sessions: dict[str, FakeSession] = {}
        self.writes: list[tuple[str, bytes]] = []
        self.resizes: list[tuple[str, int, int]] = []
        self.killed: list[str] = []
        self.focused_session_id: str | None = None
        self.last_attachment: FakeAttachment | None = None
        self.initial_live: list[bytes] = []

    def add_session(self, scrollback: bytes = b"", **overrides) -> FakeSessionInfo:
        info = FakeSessionInfo(
            id=uuid.uuid4().hex[:8], name="s", profile=None,
            alive=True, exit_code=None, cols=120, rows=30,
        )
        for k, v in overrides.items():
            setattr(info, k, v)
        self.sessions[info.id] = FakeSession(info, scrollback)
        return info

    def spawn(self, *, name=None, profile=None, cmd, args=(), cwd=None,
              env=(), cols=120, rows=30) -> FakeSessionInfo:
        self.last_spawn = {"name": name, "profile": profile, "cmd": cmd,
                           "args": list(args), "cwd": cwd, "env": dict(env)}
        return self.add_session(name=name or "s", profile=profile, cols=cols, rows=rows)

    def list(self) -> list[FakeSessionInfo]:
        return [s.info for s in self.sessions.values()]

    def get(self, sid: str) -> FakeSession | None:
        return self.sessions.get(sid)

    def write(self, sid: str, data: bytes) -> None:
        self.writes.append((sid, data))

    def resize(self, sid: str, cols: int, rows: int) -> None:
        self.resizes.append((sid, cols, rows))

    def kill(self, sid: str) -> None:
        self.killed.append(sid)
        self.sessions.pop(sid, None)

    def attach(self, sid: str) -> FakeAttachment:
        att = FakeAttachment()
        for chunk in self.initial_live:
            att.queue.put_nowait(chunk)
        self.last_attachment = att
        return att

    def shutdown(self) -> None:
        self.sessions.clear()


# --- fixtures ---------------------------------------------------------------


@pytest.fixture
def manager() -> FakeSessionManager:
    return FakeSessionManager()


@pytest.fixture
def cfg() -> FakeConfig:
    return FakeConfig(
        profiles=[
            FakeProfile(name="powershell", cmd="powershell.exe", args=["-NoLogo"]),
            FakeProfile(name="claude", cmd="claude", cwd="C:/dev", env={"X": "1"}),
        ],
        snippets=[FakeSnippet(name="greet", text="echo hi\n")],
    )


@pytest.fixture
def client(manager, cfg) -> TestClient:
    with TestClient(create_app(manager, cfg)) as c:
        yield c


@pytest.fixture
def fake_workspace(monkeypatch):
    mod = types.ModuleType("quickterm.workspace")

    @dataclass
    class Workspace:
        name: str
        layout: dict

    store: dict[str, Workspace] = {}
    mod.Workspace = Workspace
    mod.list_workspaces = lambda: sorted(store)
    mod.load_workspace = lambda name: store.get(name)
    mod.save_workspace = lambda ws: store.__setitem__(ws.name, ws)
    mod.delete_workspace = lambda name: store.pop(name, None)
    monkeypatch.setitem(sys.modules, "quickterm.workspace", mod)
    return store


def _wait_for(predicate, timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("condition not met within timeout")


# --- REST: sessions ---------------------------------------------------------


def test_list_sessions(client, manager):
    assert client.get("/api/sessions").json() == []
    info = manager.add_session(name="one", profile="powershell")
    data = client.get("/api/sessions").json()
    assert len(data) == 1
    assert data[0]["id"] == info.id
    assert data[0]["alive"] is True


def test_spawn_with_explicit_cmd(client, manager):
    r = client.post("/api/sessions", json={"cmd": "cmd.exe", "args": ["/c", "echo hi"],
                                           "name": "t", "cols": 100, "rows": 40})
    assert r.status_code == 200
    body = r.json()
    assert body["cols"] == 100 and body["rows"] == 40
    assert manager.last_spawn["cmd"] == "cmd.exe"
    assert manager.last_spawn["args"] == ["/c", "echo hi"]


def test_spawn_resolves_profile(client, manager):
    r = client.post("/api/sessions", json={"profile": "claude"})
    assert r.status_code == 200
    assert manager.last_spawn["cmd"] == "claude"
    assert manager.last_spawn["cwd"] == "C:/dev"
    assert manager.last_spawn["env"] == {"X": "1"}
    assert r.json()["profile"] == "claude"


def test_spawn_cmd_overrides_profile(client, manager):
    r = client.post("/api/sessions", json={"profile": "claude", "cmd": "other.exe"})
    assert r.status_code == 200
    assert manager.last_spawn["cmd"] == "other.exe"


def test_spawn_profile_start_command(client, manager, cfg):
    cfg.profiles.append(FakeProfile(
        name="project",
        cmd="pwsh.exe",
        terminal_type="powershell-core",
        start_command="uv run dev",
        cwd="C:/dev/project",
    ))
    r = client.post("/api/sessions", json={"profile": "project"})
    assert r.status_code == 200
    assert manager.last_spawn["cmd"] == "pwsh.exe"
    assert manager.last_spawn["args"] == ["-NoLogo", "-NoExit", "-Command", "uv run dev"]
    assert manager.last_spawn["cwd"] == "C:/dev/project"


def test_spawn_wsl_profile_resolves_distribution_and_folder(client, manager, cfg):
    cfg.profiles.append(FakeProfile(
        name="ubuntu",
        cmd="wsl.exe",
        terminal_type="wsl",
        wsl_distro="Ubuntu-24.04",
        start_command="source .venv/bin/activate",
        cwd="~/dev/project",
    ))
    r = client.post("/api/sessions", json={"profile": "ubuntu"})
    assert r.status_code == 200
    assert manager.last_spawn["cmd"] == "wsl.exe"
    assert manager.last_spawn["args"] == [
        "-d", "Ubuntu-24.04", "--cd", "~/dev/project", "--", "bash", "-lc",
        "source .venv/bin/activate; exec bash -l",
    ]
    assert manager.last_spawn["cwd"] is None


def test_spawn_unknown_profile_404(client):
    assert client.post("/api/sessions", json={"profile": "nope"}).status_code == 404


def test_spawn_requires_cmd_or_profile(client):
    assert client.post("/api/sessions", json={}).status_code == 400


def test_kill_session(client, manager):
    info = manager.add_session()
    r = client.delete(f"/api/sessions/{info.id}")
    assert r.status_code == 204
    assert manager.killed == [info.id]
    assert client.delete("/api/sessions/deadbeef").status_code == 404


def test_cleanup_sessions(client, manager):
    first = manager.add_session(name="scratch-1")
    second = manager.add_session(name="scratch-2")
    kept = manager.add_session(name="workspace")
    r = client.post("/api/sessions/cleanup", json={"session_ids": [first.id, second.id]})
    assert r.status_code == 204
    assert manager.killed == [first.id, second.id]
    assert manager.get(kept.id) is not None


# --- REST: profiles / snippets / focus / config -----------------------------


def test_profiles_and_snippets(client):
    profs = client.get("/api/profiles").json()
    assert [p["name"] for p in profs] == ["powershell", "claude"]
    snips = client.get("/api/snippets").json()
    assert snips == [{"name": "greet", "text": "echo hi\n"}]


def test_focus(client, manager):
    info = manager.add_session()
    r = client.post("/api/focus", json={"session_id": info.id})
    assert r.status_code == 204
    assert manager.focused_session_id == info.id


def test_config_endpoint(client, cfg):
    body = client.get("/api/config").json()
    assert body["font_family"] == cfg.font_family
    assert body["default_profile"] == "powershell"
    assert [p["name"] for p in body["profiles"]] == ["powershell", "claude"]
    assert body["snippets"][0]["name"] == "greet"
    assert body["voice_available"] is False  # voice module absent in tests


@pytest.fixture
def fake_config_mod(monkeypatch):
    mod = types.ModuleType("quickterm.config")
    saved: list = []

    def config_from_dict(raw: dict):
        if raw.get("font_family") == "explode":
            raise ValueError("bad font")
        cfg = FakeConfig()
        for k, v in raw.items():
            if k in {"font_family", "default_profile"}:
                setattr(cfg, k, v)
        return cfg

    mod.config_from_dict = config_from_dict
    mod.save_config = saved.append
    monkeypatch.setitem(sys.modules, "quickterm.config", mod)
    return saved


def test_full_config_roundtrip(client, cfg, fake_config_mod):
    body = client.get("/api/config/full").json()
    assert body["font_family"] == cfg.font_family
    assert body["port"] == cfg.port

    body["font_family"] = "Cascadia Mono"
    r = client.put("/api/config", json=body)
    assert r.status_code == 204
    assert len(fake_config_mod) == 1          # persisted
    assert cfg.font_family == "Cascadia Mono"  # applied live


def test_put_config_invalid_400(client, fake_config_mod):
    r = client.put("/api/config", json={"font_family": "explode"})
    assert r.status_code == 400
    assert not fake_config_mod


# --- REST: workspaces -------------------------------------------------------


def test_workspace_crud(client, fake_workspace):
    layout = {"type": "pane", "profile": "claude", "cwd": "C:/dev"}
    assert client.get("/api/workspaces").json() == []
    r = client.put("/api/workspaces/dev", json={"layout": layout})
    assert r.status_code == 204
    assert client.get("/api/workspaces").json() == ["dev"]
    ws = client.get("/api/workspaces/dev").json()
    assert ws == {"name": "dev", "layout": layout}
    assert client.get("/api/workspaces/missing").status_code == 404
    assert client.delete("/api/workspaces/dev").status_code == 204
    assert client.get("/api/workspaces").json() == []


def test_workspace_put_requires_layout(client, fake_workspace):
    assert client.put("/api/workspaces/dev", json={"nope": 1}).status_code == 400


def test_deleting_workspace_kills_its_saved_sessions(client, manager, fake_workspace):
    first = manager.add_session(name="one")
    second = manager.add_session(name="two")
    layout = {
        "type": "split",
        "dir": "h",
        "children": [
            {"type": "pane", "session_id": first.id},
            {"type": "pane", "session_id": second.id},
        ],
    }
    assert client.put("/api/workspaces/dev", json={"layout": layout}).status_code == 204
    assert client.delete("/api/workspaces/dev").status_code == 204
    assert manager.killed == [first.id, second.id]


# --- REST: file viewer ------------------------------------------------------


def test_file_read(client, tmp_path):
    f = tmp_path / "hello.txt"
    f.write_text("hello wörld", encoding="utf-8")
    body = client.get("/api/file", params={"path": str(f)}).json()
    assert body["text"] == "hello wörld"
    assert body["size"] == f.stat().st_size
    assert body["truncated"] is False
    assert body["path"] == str(f)


def test_file_truncation_cap(client, tmp_path):
    f = tmp_path / "big.txt"
    f.write_bytes(b"a" * (512 * 1024 + 100))
    body = client.get("/api/file", params={"path": str(f)}).json()
    assert body["truncated"] is True
    assert len(body["text"]) == 512 * 1024
    assert body["size"] == 512 * 1024 + 100


def test_file_invalid_utf8_replaced(client, tmp_path):
    f = tmp_path / "bin.dat"
    f.write_bytes(b"ok\xff\xfeok")
    body = client.get("/api/file", params={"path": str(f)}).json()
    assert "�" in body["text"]


def test_file_missing_404(client, tmp_path):
    r = client.get("/api/file", params={"path": str(tmp_path / "gone.txt")})
    assert r.status_code == 404


def test_file_directory_400(client, tmp_path):
    r = client.get("/api/file", params={"path": str(tmp_path)})
    assert r.status_code == 400


# --- WebSocket attach protocol ----------------------------------------------


def test_ws_attach_protocol(client, manager):
    info = manager.add_session(scrollback=b"old-output", cols=80, rows=24)
    manager.initial_live = [b"live-1", b"live-2"]

    with client.websocket_connect(f"/ws/session/{info.id}") as ws:
        # 1. replay_size at recorded size
        assert json.loads(ws.receive_text()) == {"type": "replay_size", "cols": 80, "rows": 24}
        # 2. one binary scrollback frame
        assert ws.receive_bytes() == b"old-output"
        # 3. replay_done
        assert json.loads(ws.receive_text()) == {"type": "replay_done"}
        # 4. live binary frames
        assert ws.receive_bytes() == b"live-1"
        assert ws.receive_bytes() == b"live-2"
        # client input: raw bytes -> manager.write, resize JSON -> manager.resize
        ws.send_bytes(b"dir\r")
        ws.send_text(json.dumps({"type": "resize", "cols": 132, "rows": 43}))
        _wait_for(lambda: manager.resizes == [(info.id, 132, 43)])
        assert manager.writes == [(info.id, b"dir\r")]
        # session death: None sentinel -> exit message with exit_code, then close
        info.alive = False
        info.exit_code = 7
        manager.last_attachment.push_threadsafe(None)
        assert json.loads(ws.receive_text()) == {"type": "exit", "code": 7}
        closed = ws.receive()
        assert closed["type"] == "websocket.close"
    assert manager.last_attachment.detached is True


def test_ws_unknown_session_closes_4404(client):
    with client.websocket_connect("/ws/session/00000000") as ws:
        msg = ws.receive()
    assert msg["type"] == "websocket.close"
    assert msg["code"] == 4404


def test_ws_detach_on_client_disconnect(client, manager):
    info = manager.add_session(scrollback=b"")
    # TestClient's portal may cancel the app task while the handler is still
    # unwinding from the disconnect; detach (in `finally`) runs regardless, so
    # the CancelledError at __exit__ is a test-client artifact, not a server bug.
    # 3.14 de-aliased concurrent.futures.CancelledError from asyncio's — catch both.
    with contextlib.suppress(asyncio.CancelledError, concurrent.futures.CancelledError):
        with client.websocket_connect(f"/ws/session/{info.id}") as ws:
            ws.receive_text()   # replay_size
            ws.receive_bytes()  # scrollback (empty frame)
            ws.receive_text()   # replay_done
    _wait_for(lambda: manager.last_attachment is not None and manager.last_attachment.detached)
