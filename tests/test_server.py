"""Server tests against fake manager/config implementing the CONTRACTS.md surface."""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import json
import os
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
    ssh_host: str | None = None
    ssh_port: int | None = None
    ssh_user: str | None = None
    ssh_key: str | None = None


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
    font_size: int = 14
    theme: str = "graphite"
    custom_theme: dict = field(default_factory=dict)
    logo: str | None = None
    idle_timeout_s: int = 300
    max_sessions: int = 0
    update_check: bool = True
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
    touched: bool = False
    workspace: str | None = None


class FakeAttachment:
    def __init__(self) -> None:
        self.queue: asyncio.Queue = asyncio.Queue()
        self.overflow_sentinel = object()
        self.overflowed = False
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
        self.max_sessions = 0

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
              env=(), cols=120, rows=30, workspace=None) -> FakeSessionInfo:
        self.last_spawn = {"name": name, "profile": profile, "cmd": cmd,
                           "args": list(args), "cwd": cwd, "env": dict(env),
                           "workspace": workspace}
        return self.add_session(name=name or "s", profile=profile, cols=cols,
                                rows=rows, workspace=workspace)

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

    def has_attachments(self, sid: str) -> bool:
        return sid in getattr(self, "attached_ids", set())

    def attach(self, sid: str) -> FakeAttachment:
        att = FakeAttachment()
        for chunk in self.initial_live:
            att.queue.put_nowait(chunk)
        self.last_attachment = att
        return att

    def shutdown(self) -> None:
        self.sessions.clear()

    def set_max_sessions(self, limit: int) -> None:
        self.max_sessions = limit


# --- fixtures ---------------------------------------------------------------


@pytest.fixture
def manager() -> FakeSessionManager:
    return FakeSessionManager()


@pytest.fixture
def cfg(tmp_path) -> FakeConfig:
    profile_cwd = tmp_path / "dev"
    profile_cwd.mkdir()
    return FakeConfig(
        profiles=[
            FakeProfile(name="powershell", cmd="powershell.exe", args=["-NoLogo"]),
            FakeProfile(name="claude", cmd="claude", cwd=str(profile_cwd), env={"X": "1"}),
        ],
        snippets=[FakeSnippet(name="greet", text="echo hi\n")],
    )


@pytest.fixture(autouse=True)
def no_putty_tools(monkeypatch):
    # Hermetic default: tests must not depend on whether vendor/putty exists on
    # the machine. Tests that need the tools use the putty_dir fixture.
    from quickterm import putty_tools

    monkeypatch.setattr(putty_tools, "tools_dir", lambda: None)
    monkeypatch.setattr(putty_tools, "plink_path", lambda: None)
    monkeypatch.setattr(putty_tools, "psftp_path", lambda: None)
    monkeypatch.setattr(putty_tools, "pscp_path", lambda: None)


@pytest.fixture
def putty_dir(no_putty_tools, monkeypatch, tmp_path):
    from quickterm import putty_tools

    base = tmp_path / "putty"
    base.mkdir()
    for name in ("plink.exe", "pscp.exe", "psftp.exe"):
        (base / name).write_bytes(b"")
    monkeypatch.setattr(putty_tools, "tools_dir", lambda: base)
    monkeypatch.setattr(putty_tools, "plink_path", lambda: base / "plink.exe")
    monkeypatch.setattr(putty_tools, "psftp_path", lambda: base / "psftp.exe")
    monkeypatch.setattr(putty_tools, "pscp_path", lambda: base / "pscp.exe")
    return base


@pytest.fixture
def client(manager, cfg) -> TestClient:
    # base_url must match the server's Host allowlist (see _local_guard)
    with TestClient(create_app(manager, cfg), base_url=f"http://127.0.0.1:{cfg.port}") as c:
        yield c


@pytest.fixture
def fake_workspace(monkeypatch):
    mod = types.ModuleType("quickterm.workspace")

    @dataclass
    class Workspace:
        name: str
        layout: dict
        logo: str | None = None
        session_ids: list[str] = field(default_factory=list)

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


def test_health(client):
    body = client.get("/api/health").json()
    assert body["app"] == "quickterm"
    assert body["version"]


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


def test_spawn_resolves_profile(client, manager, cfg):
    r = client.post("/api/sessions", json={"profile": "claude"})
    assert r.status_code == 200
    assert manager.last_spawn["cmd"] == "claude"
    assert manager.last_spawn["cwd"] == cfg.profiles[1].cwd
    assert manager.last_spawn["env"] == {"X": "1"}
    assert r.json()["profile"] == "claude"


def test_spawn_cmd_overrides_profile(client, manager):
    r = client.post("/api/sessions", json={"profile": "claude", "cmd": "other.exe"})
    assert r.status_code == 200
    assert manager.last_spawn["cmd"] == "other.exe"


def test_spawn_profile_start_command(client, manager, cfg, tmp_path):
    project_cwd = tmp_path / "project"
    project_cwd.mkdir()
    cfg.profiles.append(FakeProfile(
        name="project",
        cmd="pwsh.exe",
        terminal_type="powershell-core",
        start_command="uv run dev",
        cwd=str(project_cwd),
    ))
    r = client.post("/api/sessions", json={"profile": "project"})
    assert r.status_code == 200
    assert manager.last_spawn["cmd"] == "pwsh.exe"
    assert manager.last_spawn["args"] == ["-NoLogo", "-NoExit", "-Command", "uv run dev"]
    assert manager.last_spawn["cwd"] == str(project_cwd)


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


def test_spawn_wsl_profile_defaults_to_linux_home(client, manager, cfg):
    cfg.profiles.append(FakeProfile(
        name="ubuntu-home",
        cmd="wsl.exe",
        terminal_type="wsl",
        wsl_distro="Ubuntu-24.04",
    ))
    response = client.post("/api/sessions", json={"profile": "ubuntu-home"})
    assert response.status_code == 200
    assert manager.last_spawn["args"] == ["-d", "Ubuntu-24.04", "--cd", "~"]
    assert manager.last_spawn["cwd"] is None


def test_spawn_wsl_profile_request_folder_becomes_wsl_cd(client, manager, cfg):
    cfg.profiles.append(FakeProfile(
        name="ubuntu-project",
        cmd="wsl.exe",
        terminal_type="wsl",
        cwd="~/default",
    ))
    response = client.post(
        "/api/sessions",
        json={"profile": "ubuntu-project", "cwd": "~/requested", "cols": 80, "rows": 24},
    )
    assert response.status_code == 200
    assert manager.last_spawn["args"] == ["--cd", "~/requested"]
    assert manager.last_spawn["cwd"] is None


def test_spawn_ssh_profile_builds_plink_argv(client, manager, cfg, putty_dir):
    cfg.profiles.append(FakeProfile(
        name="server",
        cmd="",
        terminal_type="ssh",
        ssh_host="host.example.com",
        ssh_port=2222,
        ssh_user="deploy",
        ssh_key="C:\\keys\\id.ppk",
        start_command="uptime",
    ))
    r = client.post("/api/sessions", json={"profile": "server"})
    assert r.status_code == 200
    assert manager.last_spawn["cmd"] == str(putty_dir / "plink.exe")
    assert manager.last_spawn["args"] == [
        "-ssh", "-P", "2222", "-i", "C:\\keys\\id.ppk", "deploy@host.example.com", "uptime",
    ]


def test_spawn_sftp_profile_builds_psftp_argv(client, manager, cfg, putty_dir):
    cfg.profiles.append(FakeProfile(
        name="files", cmd="", terminal_type="sftp", ssh_host="box", ssh_user="u",
    ))
    r = client.post("/api/sessions", json={"profile": "files"})
    assert r.status_code == 200
    assert manager.last_spawn["cmd"] == str(putty_dir / "psftp.exe")
    assert manager.last_spawn["args"] == ["u@box"]


def test_spawn_ssh_profile_without_tools_is_400(client, cfg):
    cfg.profiles.append(FakeProfile(name="server", cmd="", terminal_type="ssh", ssh_host="h"))
    r = client.post("/api/sessions", json={"profile": "server"})
    assert r.status_code == 400
    assert "PuTTY" in r.json()["detail"]


def test_spawn_appends_putty_dir_to_path(client, manager, putty_dir, monkeypatch):
    monkeypatch.setenv("PATH", "C:\\base")
    r = client.post("/api/sessions", json={"cmd": "cmd.exe"})
    assert r.status_code == 200
    path = manager.last_spawn["env"]["PATH"]
    assert path == f"C:\\base{os.pathsep}{putty_dir}"


def test_spawn_appends_putty_dir_after_profile_path(client, manager, cfg, putty_dir):
    cfg.profiles[0].env = {"PATH": "C:\\profile"}
    r = client.post("/api/sessions", json={"profile": "powershell"})
    assert r.status_code == 200
    assert manager.last_spawn["env"]["PATH"] == f"C:\\profile{os.pathsep}{putty_dir}"


@pytest.mark.skipif(os.name != "nt", reason="bundled PuTTY inventory is Windows-only")
def test_terminal_inventory_lists_putty_types(client, putty_dir):
    entries = {t["id"]: t for t in client.get("/api/system/terminals").json()["types"]}
    assert entries["ssh"]["available"] is True
    assert entries["ssh"]["executable"] == str(putty_dir / "plink.exe")
    assert entries["sftp"]["available"] is True
    assert entries["sftp"]["executable"] == str(putty_dir / "psftp.exe")


@pytest.mark.skipif(os.name != "nt", reason="bundled PuTTY inventory is Windows-only")
def test_terminal_inventory_marks_putty_missing(client):
    entries = {t["id"]: t for t in client.get("/api/system/terminals").json()["types"]}
    assert entries["ssh"]["available"] is False
    assert entries["ssh"]["executable"] is None


def test_spawn_unknown_profile_404(client):
    assert client.post("/api/sessions", json={"profile": "nope"}).status_code == 404


def test_spawn_requires_cmd_or_profile(client):
    assert client.post("/api/sessions", json={}).status_code == 400


def test_spawn_returns_conflict_when_live_terminal_limit_is_reached(client, manager, monkeypatch):
    from quickterm.session_manager import SessionLimitError

    def blocked(**_kwargs):
        raise SessionLimitError("terminal limit reached (4); stop a terminal or raise the limit")

    monkeypatch.setattr(manager, "spawn", blocked)
    response = client.post("/api/sessions", json={"cmd": "cmd.exe"})
    assert response.status_code == 409
    assert "terminal limit reached (4)" in response.json()["detail"]


@pytest.mark.parametrize("body", [
    [],
    {"cmd": "cmd.exe", "args": "not-a-list"},
    {"cmd": "cmd.exe", "args": ["ok", 3]},
    {"cmd": "cmd.exe", "env": {"KEY": 3}},
    {"cmd": "cmd.exe", "env": {"BAD=NAME": "value"}},
    {"cmd": "cmd.exe", "env": {"KEY": "bad\0value"}},
    {"cmd": "cmd.exe", "env": {"Path": "one", "PATH": "two"}},
    {"cmd": "cmd.exe", "cols": 0},
    {"cmd": "cmd.exe", "rows": "many"},
    {"cmd": ["cmd.exe"]},
])
def test_spawn_rejects_malformed_payloads(client, manager, body):
    response = client.post("/api/sessions", json=body)
    assert response.status_code == 400
    assert manager.list() == []


def test_spawn_rejects_missing_local_folder(client, manager, tmp_path):
    missing = tmp_path / "does-not-exist"
    response = client.post(
        "/api/sessions",
        json={"cmd": "cmd.exe", "cwd": str(missing), "name": "Standard"},
    )
    assert response.status_code == 400
    assert "starting folder does not exist" in response.json()["detail"]
    assert manager.list() == []


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


def test_kill_all_sessions(client, manager):
    manager.add_session(name="one")
    manager.add_session(name="two")
    manager.add_session(name="stopped", alive=False)
    response = client.post("/api/sessions/kill-all")
    assert response.status_code == 200
    assert response.json() == {"killed": 2}
    assert len(manager.killed) == 2


def test_spawn_tags_workspace(client, manager):
    r = client.post("/api/sessions", json={"cmd": "cmd.exe", "workspace": "proj"})
    assert r.status_code == 200
    assert manager.last_spawn["workspace"] == "proj"
    # empty/missing workspace is normalized to None
    client.post("/api/sessions", json={"cmd": "cmd.exe", "workspace": ""})
    assert manager.last_spawn["workspace"] is None


# --- REST: profiles / snippets / config ------------------------------------


def test_profiles_and_snippets(client):
    profs = client.get("/api/profiles").json()
    assert [p["name"] for p in profs] == ["powershell", "claude"]
    snips = client.get("/api/snippets").json()
    assert snips == [{"name": "greet", "text": "echo hi\n"}]


def test_config_endpoint(client, cfg):
    body = client.get("/api/config").json()
    assert body["font_family"] == cfg.font_family
    assert body["default_profile"] == "powershell"
    assert [p["name"] for p in body["profiles"]] == ["powershell", "claude"]
    assert body["snippets"][0]["name"] == "greet"
    assert body["voice_available"] is False  # voice module absent in tests
    assert client.get("/api/config").headers["cache-control"] == "no-store"


def test_spawn_rejects_oversized_json_before_parsing(client, manager):
    response = client.post(
        "/api/sessions",
        content=b" " * (1024 * 1024 + 1),
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 413
    assert manager.list() == []


@pytest.fixture
def fake_config_mod(monkeypatch):
    mod = types.ModuleType("quickterm.config")
    saved: list = []

    def config_from_dict(raw: dict):
        if raw.get("font_family") == "explode":
            raise ValueError("bad font")
        cfg = FakeConfig()
        for k, v in raw.items():
            if k in {"font_family", "default_profile", "max_sessions"}:
                setattr(cfg, k, v)
        return cfg

    mod.config_from_dict = config_from_dict
    def save_config(cfg):
        if cfg.default_profile == "save-explode":
            raise ValueError("bad profile folder")
        saved.append(cfg)

    mod.save_config = save_config
    monkeypatch.setitem(sys.modules, "quickterm.config", mod)
    return saved


def test_full_config_roundtrip(client, cfg, manager, fake_config_mod):
    body = client.get("/api/config/full").json()
    assert body["font_family"] == cfg.font_family
    assert body["port"] == cfg.port

    body["font_family"] = "Cascadia Mono"
    body["max_sessions"] = 7
    r = client.put("/api/config", json=body)
    assert r.status_code == 204
    assert len(fake_config_mod) == 1          # persisted
    assert cfg.font_family == "Cascadia Mono"  # applied live
    assert cfg.max_sessions == 7
    assert manager.max_sessions == 7


def test_put_config_invalid_400(client, fake_config_mod):
    r = client.put("/api/config", json={"font_family": "explode"})
    assert r.status_code == 400
    assert not fake_config_mod


def test_put_config_maps_save_validation_to_400(client, fake_config_mod):
    response = client.put("/api/config", json={"default_profile": "save-explode"})
    assert response.status_code == 400
    assert "bad profile folder" in response.json()["detail"]
    assert not fake_config_mod


# --- REST: workspaces -------------------------------------------------------


def test_workspace_crud(client, fake_workspace):
    layout = {"type": "pane", "profile": "claude", "cwd": "C:/dev"}
    assert client.get("/api/workspaces").json() == []
    r = client.put("/api/workspaces/dev", json={"layout": layout})
    assert r.status_code == 204
    assert client.get("/api/workspaces").json() == ["dev"]
    ws = client.get("/api/workspaces/dev").json()
    assert ws == {"name": "dev", "layout": layout, "logo": None, "session_ids": []}
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
    assert sorted(manager.killed) == sorted([first.id, second.id])


def test_deleting_workspace_spares_attached_sessions(client, manager, fake_workspace):
    detached = manager.add_session(name="idle")
    attached = manager.add_session(name="in-use")
    manager.attached_ids = {attached.id}
    layout = {
        "type": "split",
        "dir": "h",
        "children": [
            {"type": "pane", "session_id": detached.id},
            {"type": "pane", "session_id": attached.id},
        ],
    }
    assert client.put("/api/workspaces/dev", json={"layout": layout}).status_code == 204
    assert client.delete("/api/workspaces/dev").status_code == 204
    assert manager.killed == [detached.id]  # the attached terminal survives


def test_workspace_keeps_and_deletes_detached_session_ids(client, manager, fake_workspace):
    detached = manager.add_session(name="detached")
    layout = {"type": "pane", "profile": "powershell"}
    assert client.put(
        "/api/workspaces/dev",
        json={"layout": layout, "session_ids": [detached.id]},
    ).status_code == 204
    assert client.get("/api/workspaces/dev").json()["session_ids"] == [detached.id]
    assert client.delete("/api/workspaces/dev").status_code == 204
    assert manager.killed == [detached.id]


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


# --- update endpoints ---------------------------------------------------------


def _stub_update_module(monkeypatch, **attrs):
    mod = types.ModuleType("quickterm.update")
    for name, value in attrs.items():
        setattr(mod, name, value)
    monkeypatch.setitem(sys.modules, "quickterm.update", mod)


def test_update_check_endpoint(client, monkeypatch):
    payload = {"current": "0.2.0", "latest": "0.3.0", "update_available": True,
               "url": "https://github.com/devincii-io/quickterm/releases", "notes": "",
               "installable": True}
    _stub_update_module(monkeypatch, check=lambda force=False: payload)
    r = client.get("/api/update")
    assert r.status_code == 200
    assert r.json() == payload


def test_update_check_maps_failure_to_502(client, monkeypatch):
    def boom(force=False):
        raise OSError("offline")

    _stub_update_module(monkeypatch, check=boom)
    r = client.get("/api/update")
    assert r.status_code == 502


def test_update_install_endpoint(client, monkeypatch):
    _stub_update_module(
        monkeypatch, download_and_run=lambda: {"launched": True, "version": "0.3.0"}
    )
    r = client.post("/api/update/install")
    assert r.status_code == 200
    assert r.json()["launched"] is True


def test_update_install_value_error_is_400(client, monkeypatch):
    def nope():
        raise ValueError("not on this platform")

    _stub_update_module(monkeypatch, download_and_run=nope)
    r = client.post("/api/update/install")
    assert r.status_code == 400


# --- open endpoint (terminal Ctrl+click links) --------------------------------


def _stub_opener_module(monkeypatch, open_target):
    mod = types.ModuleType("quickterm.opener")
    mod.open_target = open_target
    monkeypatch.setitem(sys.modules, "quickterm.opener", mod)


def test_open_endpoint(client, monkeypatch):
    opened = []

    def fake_open(target):
        opened.append(target)
        return {"action": "url"}

    _stub_opener_module(monkeypatch, fake_open)
    r = client.post("/api/open", json={"target": "https://example.com"})
    assert r.status_code == 200
    assert r.json() == {"action": "url"}
    assert opened == ["https://example.com"]


def test_open_endpoint_maps_errors(client, monkeypatch):
    def refuse(target):
        raise ValueError("only http/https URLs can be opened")

    _stub_opener_module(monkeypatch, refuse)
    assert client.post("/api/open", json={"target": "ftp://x"}).status_code == 400
    assert client.post("/api/open", json={"nope": 1}).status_code == 400

    def missing(target):
        raise FileNotFoundError(target)

    _stub_opener_module(monkeypatch, missing)
    assert client.post("/api/open", json={"target": "C:/gone"}).status_code == 404


# --- WebSocket attach protocol ----------------------------------------------


def test_ws_attach_protocol(client, manager):
    info = manager.add_session(scrollback=b"old-output", cols=80, rows=24)
    manager.initial_live = [b"live-1", b"live-2"]

    with client.websocket_connect(f"/ws/session/{info.id}", headers={"host": "127.0.0.1:8620"}) as ws:
        # 1. replay_size at recorded size
        assert json.loads(ws.receive_text()) == {"type": "replay_size", "cols": 80, "rows": 24}
        # 2. one binary scrollback frame
        assert ws.receive_bytes() == b"old-output"
        ws.send_text(json.dumps({"type": "replay_ack"}))
        # 3. replay_done
        assert json.loads(ws.receive_text()) == {"type": "replay_done"}
        # 4. live binary output — raw bytes, which the pump may coalesce into a
        # single frame (wire-compatible: the client treats it as a byte stream).
        live = ws.receive_bytes()
        while live != b"live-1live-2":
            live += ws.receive_bytes()
        assert live == b"live-1live-2"
        # client input: raw bytes -> manager.write, resize JSON -> manager.resize
        ws.send_bytes(b"dir\r")
        ws.send_text(json.dumps({"type": "resize", "cols": "bad", "rows": 43}))
        ws.send_text(json.dumps(["not", "an", "object"]))
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
    with client.websocket_connect("/ws/session/00000000", headers={"host": "127.0.0.1:8620"}) as ws:
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
        with client.websocket_connect(f"/ws/session/{info.id}", headers={"host": "127.0.0.1:8620"}) as ws:
            ws.receive_text()   # replay_size
            ws.receive_bytes()  # scrollback (empty frame)
            ws.receive_text()   # replay_done
    _wait_for(lambda: manager.last_attachment is not None and manager.last_attachment.detached)


# --- security guard -----------------------------------------------------------


def test_guard_rejects_foreign_host(manager, cfg):
    # DNS rebinding: attacker's domain resolves to 127.0.0.1 -> Host mismatch
    with TestClient(create_app(manager, cfg), base_url="http://evil.example:8620") as c:
        assert c.get("/api/sessions").status_code == 403


def test_guard_rejects_cross_origin(client):
    r = client.get("/api/sessions", headers={"origin": "https://evil.example"})
    assert r.status_code == 403
    ok = client.get("/api/sessions", headers={"origin": "http://127.0.0.1:8620"})
    assert ok.status_code == 200


def test_ws_rejects_cross_origin(client, manager):
    info = manager.add_session(scrollback=b"x")
    with pytest.raises(Exception):
        with client.websocket_connect(
            f"/ws/session/{info.id}",
            headers={"host": "127.0.0.1:8620", "origin": "https://evil.example"},
        ):
            pass


def test_token_gates_api(manager, cfg):
    base = f"http://127.0.0.1:{cfg.port}"
    with TestClient(create_app(manager, cfg, "s3cret"), base_url=base) as c:
        assert c.get("/api/sessions").status_code == 403  # no token
        assert c.get("/api/sessions", headers={"x-quickterm-token": "nope"}).status_code == 403
        assert c.get("/api/sessions", headers={"x-quickterm-token": "s3cret"}).status_code == 200
        assert c.get("/api/health").status_code == 200  # public probe stays open


def test_ws_requires_token(manager, cfg):
    info = manager.add_session(scrollback=b"x")
    host = {"host": f"127.0.0.1:{cfg.port}"}
    with TestClient(create_app(manager, cfg, "s3cret"), base_url=f"http://127.0.0.1:{cfg.port}") as c:
        with pytest.raises(Exception):  # missing token subprotocol
            with c.websocket_connect(f"/ws/session/{info.id}", headers=host):
                pass
        with c.websocket_connect(
            f"/ws/session/{info.id}", headers=host, subprotocols=["qtauth.s3cret"]
        ) as ws:
            assert ws.receive_json()["type"] == "replay_size"


def test_config_reports_elevated(manager, cfg):
    base = f"http://127.0.0.1:{cfg.port}"
    with TestClient(create_app(manager, cfg, elevated=True), base_url=base) as c:
        assert c.get("/api/config").json()["elevated"] is True
    with TestClient(create_app(manager, cfg), base_url=base) as c:
        assert c.get("/api/config").json()["elevated"] is False
