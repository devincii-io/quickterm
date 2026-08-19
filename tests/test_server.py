"""Server tests against fake manager/config implementing the CONTRACTS.md surface."""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import dataclasses
import json
import os
import sys
import time
import types
import uuid
from dataclasses import dataclass, field

import pytest
from fastapi.testclient import TestClient

from quickterm import workspace as real_workspace
from quickterm.server import create_app

# --- fakes implementing the contract surface -------------------------------


@dataclass
class FakeProfile:
    name: str
    cmd: str
    args: list = field(default_factory=list)
    cwd: str | None = None
    subpath: str | None = None
    env: dict = field(default_factory=dict)
    keybinding: str | None = None
    autostart: bool = False
    terminal_type: str | None = None
    wsl_distro: str | None = None
    start_command: str | None = None
    claude_mode: str | None = None
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
    scratch_dir: str = ""
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
    retained: bool = False
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

    def sync_workspace(self, name: str, session_ids: set[str]) -> None:
        for sid, session in self.sessions.items():
            if sid in session_ids:
                session.info.workspace = name
            elif session.info.workspace == name:
                session.info.workspace = None

    def get(self, sid: str) -> FakeSession | None:
        return self.sessions.get(sid)

    def write(self, sid: str, data: bytes) -> None:
        self.writes.append((sid, data))

    def resize(self, sid: str, cols: int, rows: int) -> None:
        self.resizes.append((sid, cols, rows))

    def kill(self, sid: str) -> bool:
        self.killed.append(sid)
        self.sessions.pop(sid, None)
        return True

    def has_attachments(self, sid: str) -> bool:
        return sid in getattr(self, "attached_ids", set())

    def attachment_count(self, sid: str) -> int:
        return int(self.has_attachments(sid))

    def session_metrics(self) -> tuple[set[str], dict[str, dict]]:
        return set(), {}

    def session_activity(self, sid: str) -> dict[str, int | None]:
        return {
            "idle_seconds": 0,
            "background_output_bytes": 0,
            "background_output_age_seconds": None,
        }

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
        path: str | None = None
        session_ids: list[str] = field(default_factory=list)

    store: dict[str, Workspace] = {}
    mod.Workspace = Workspace
    mod.list_workspaces = lambda: sorted(store)
    mod.load_workspace = lambda name: store.get(name)
    mod.save_workspace = lambda ws: store.__setitem__(ws.name, ws)
    mod.delete_workspace = lambda name: store.pop(name, None)
    # Complete-interface fake: the folder helpers the server calls are the real
    # ones, so path handling is exercised rather than stubbed away.
    mod.normalize_root = real_workspace.normalize_root
    mod.validate_subpath = real_workspace.validate_subpath
    mod.resolve_start_dir = real_workspace.resolve_start_dir
    mod.root_exists = real_workspace.root_exists
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


def test_list_sessions_includes_background_activity(client, manager):
    info = manager.add_session(name="agent")
    manager.session_activity = lambda sid: {
        "idle_seconds": 12,
        "background_output_bytes": 4096 if sid == info.id else 0,
        "background_output_age_seconds": 3,
    }
    activity = client.get("/api/sessions").json()[0]["activity"]
    assert activity == {
        "idle_seconds": 12,
        "background_output_bytes": 4096,
        "background_output_age_seconds": 3,
    }


def test_list_sessions_lightweight_skips_process_metrics(client, manager, monkeypatch):
    manager.add_session(name="agent")

    def fail_if_sampled():
        raise AssertionError("lightweight session listing sampled processes")

    monkeypatch.setattr(manager, "session_metrics", fail_if_sampled)
    response = client.get("/api/sessions?metrics=false")
    assert response.status_code == 200
    assert response.json()[0]["busy"] is None
    assert "usage" not in response.json()[0]


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


def test_spawn_profile_allows_explicit_recovery_command(client, manager, cfg, tmp_path):
    project_cwd = tmp_path / "recover"
    project_cwd.mkdir()
    cfg.profiles.append(FakeProfile(
        name="claude-shell",
        cmd="pwsh.exe",
        terminal_type="powershell-core",
        start_command="claude",
        cwd=str(project_cwd),
    ))
    response = client.post(
        "/api/sessions",
        json={"profile": "claude-shell", "start_command": "claude --continue"},
    )
    assert response.status_code == 200
    assert manager.last_spawn["args"] == [
        "-NoLogo", "-NoExit", "-Command", "claude --continue",
    ]


def test_spawn_first_class_claude_profile_supports_continue_and_picker(
    client, manager, cfg, tmp_path
):
    project_cwd = tmp_path / "claude-project"
    project_cwd.mkdir()
    cfg.profiles.append(FakeProfile(
        name="project-agent",
        cmd="claude.exe",
        terminal_type="claude-code",
        claude_mode="resume",
        cwd=str(project_cwd),
    ))

    response = client.post("/api/sessions", json={"profile": "project-agent"})
    assert response.status_code == 200
    assert manager.last_spawn["cmd"] == "claude.exe"
    assert manager.last_spawn["args"] == ["--resume"]
    assert manager.last_spawn["cwd"] == str(project_cwd)

    response = client.post(
        "/api/sessions", json={"profile": "project-agent", "claude_mode": "continue"}
    )
    assert response.status_code == 200
    assert manager.last_spawn["args"] == ["--continue"]

    response = client.post(
        "/api/sessions", json={"profile": "project-agent", "claude_mode": "agents"}
    )
    assert response.status_code == 200
    assert manager.last_spawn["args"] == ["agents", "--cwd", str(project_cwd)]


def test_claude_profile_rejects_missing_project_folder(client, cfg):
    cfg.profiles.append(FakeProfile(
        name="unscoped-agent",
        cmd="claude.exe",
        terminal_type="claude-code",
        claude_mode="continue",
    ))
    response = client.post("/api/sessions", json={"profile": "unscoped-agent"})
    assert response.status_code == 400
    assert "project folder" in response.json()["detail"]


def test_claude_mode_override_is_bounded_to_claude_profiles(client):
    response = client.post(
        "/api/sessions", json={"profile": "powershell", "claude_mode": "resume"}
    )
    assert response.status_code == 400
    assert "Claude Code profile" in response.json()["detail"]


def test_spawn_recovery_command_requires_profile(client):
    response = client.post(
        "/api/sessions",
        json={"cmd": "cmd.exe", "start_command": "claude --continue"},
    )
    assert response.status_code == 400


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


def test_kill_session_reports_backend_failure(client, manager, monkeypatch):
    info = manager.add_session()
    monkeypatch.setattr(manager, "kill", lambda _sid: False)
    response = client.delete(f"/api/sessions/{info.id}")
    assert response.status_code == 500
    assert response.json()["detail"] == "terminal process could not be stopped"


def test_retain_session_marks_explicit_detach_as_user_owned(client, manager):
    info = manager.add_session(touched=False, retained=False)
    response = client.post(f"/api/sessions/{info.id}/retain", json={})

    assert response.status_code == 200
    assert response.json()["retained"] is True
    assert manager.get(info.id).info.retained is True
    assert manager.get(info.id).info.touched is False
    assert client.post("/api/sessions/deadbeef/retain", json={}).status_code == 404


def test_single_viewer_launch_queue_hands_off_folder_once(client, tmp_path):
    folder = tmp_path / "open-here"
    folder.mkdir()

    queued = client.post("/api/launches", json={"cwd": str(folder)})
    assert queued.status_code == 200
    assert queued.json() == {"cwd": str(folder)}

    claimed = client.get("/api/launches/next?wait=false")
    assert claimed.status_code == 200
    assert claimed.json() == {"cwd": str(folder)}
    assert client.get("/api/launches/next?wait=false").status_code == 204


def test_cleanup_sessions(client, manager):
    first = manager.add_session(name="scratch-1")
    second = manager.add_session(name="scratch-2")
    kept = manager.add_session(name="workspace")
    r = client.post("/api/sessions/cleanup", json={"session_ids": [first.id, second.id]})
    assert r.status_code == 204
    assert manager.killed == [first.id, second.id]
    assert manager.get(kept.id) is not None


@pytest.mark.parametrize("method,path", [
    ("patch", "/api/sessions/{sid}"),
    ("post", "/api/sessions/cleanup"),
    ("put", "/api/workspaces/dev"),
    ("post", "/api/open"),
])
def test_json_endpoints_reject_malformed_and_oversized_bodies(
    client, manager, fake_workspace, method, path,
):
    info = manager.add_session()
    path = path.format(sid=info.id)
    malformed = client.request(
        method, path, content=b"{", headers={"content-type": "application/json"},
    )
    assert malformed.status_code == 400
    assert malformed.json()["detail"] == "request body must be valid JSON"

    oversized = client.request(
        method,
        path,
        content=b" " * (1024 * 1024 + 1),
        headers={"content-type": "application/json"},
    )
    assert oversized.status_code == 413


def test_kill_all_sessions(client, manager):
    first = manager.add_session(name="one")
    second = manager.add_session(name="two")
    manager.add_session(name="stopped", alive=False)
    response = client.post("/api/sessions/kill-all")
    assert response.status_code == 200
    assert response.json() == {
        "killed": 2,
        "killed_ids": [first.id, second.id],
        "failed_ids": [],
    }
    assert len(manager.killed) == 2


def test_kill_all_reports_partial_failure(client, manager, monkeypatch):
    first = manager.add_session(name="one")
    second = manager.add_session(name="two")

    def kill(sid):
        if sid == second.id:
            return False
        manager.sessions.pop(sid, None)
        return True

    monkeypatch.setattr(manager, "kill", kill)
    response = client.post("/api/sessions/kill-all")
    assert response.status_code == 200
    assert response.json() == {
        "killed": 1,
        "killed_ids": [first.id],
        "failed_ids": [second.id],
    }
    assert manager.get(first.id) is None
    assert manager.get(second.id) is not None


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
def fake_config_mod(monkeypatch, cfg):
    mod = types.ModuleType("quickterm.config")
    saved: list = []
    # The PERSISTED config, as distinct from the live one. app.py rewrites
    # cfg.port at startup (--port 0, elevated instances), so server.py must
    # serve and preserve this one for port/host/summon_hotkey.
    mod.disk_config = dataclasses.replace(cfg)

    def config_from_dict(raw: dict):
        if raw.get("font_family") == "explode":
            raise ValueError("bad font")
        parsed = FakeConfig()
        for k, v in raw.items():
            if k in {"font_family", "default_profile", "max_sessions", "port",
                     "host", "summon_hotkey"}:
                setattr(parsed, k, v)
        return parsed

    mod.config_from_dict = config_from_dict
    mod.load_config = lambda: dataclasses.replace(mod.disk_config)

    def save_config(new_cfg):
        if new_cfg.default_profile == "save-explode":
            raise ValueError("bad profile folder")
        saved.append(new_cfg)

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
    assert ws == {
        "name": "dev", "layout": layout, "logo": None, "path": None,
        "session_ids": [], "path_exists": False,
    }
    assert client.get("/api/workspaces/missing").status_code == 404
    assert client.delete("/api/workspaces/dev").status_code == 204
    assert client.get("/api/workspaces").json() == []


def test_workspace_save_and_delete_sync_live_ownership(client, manager, fake_workspace):
    moved = manager.add_session(name="moved", workspace="old")
    removed = manager.add_session(name="removed", workspace="dev")
    manager.attached_ids = {moved.id, removed.id}

    layout = {"type": "pane", "session_id": moved.id}
    response = client.put(
        "/api/workspaces/dev",
        json={"layout": layout, "session_ids": [moved.id]},
    )
    assert response.status_code == 204
    assert moved.workspace == "dev"
    assert removed.workspace is None

    assert client.delete("/api/workspaces/dev").status_code == 204
    assert moved.workspace is None


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


def test_deleting_stale_workspace_reference_never_kills_new_owner(
    client, manager, fake_workspace,
):
    moved = manager.add_session(name="moved")
    layout = {"type": "pane", "session_id": moved.id}
    assert client.put("/api/workspaces/old", json={"layout": layout}).status_code == 204
    assert client.put("/api/workspaces/new", json={"layout": layout}).status_code == 204
    assert moved.workspace == "new"

    assert client.delete("/api/workspaces/old").status_code == 204
    assert manager.killed == []
    assert manager.get(moved.id) is not None
    assert moved.workspace == "new"


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


def test_asset_upload_is_bounded_before_storage(client, monkeypatch):
    saved = []
    mod = types.ModuleType("quickterm.assets")
    mod.MAX_ASSET_BYTES = 16
    mod.save_asset = lambda data, content_type: saved.append((data, content_type)) or "x.png"
    monkeypatch.setitem(sys.modules, "quickterm.assets", mod)

    response = client.post(
        "/api/assets", content=b"x" * 17, headers={"content-type": "image/png"},
    )
    assert response.status_code == 413
    assert saved == []


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


def test_ws_exited_session_serves_replay_only(client, manager):
    """An exited session still in the registry replays, reports its exit, and closes.

    Refusing it outright (close 4410) made overflow permanently lossy: the
    client is told to reconnect and replay the ring, and if the PTY died around
    the overflow that replay could never happen — so the session's final output
    was unreachable while still sitting in the ring.
    """
    info = manager.add_session(alive=False, exit_code=0, scrollback=b"build done\r\n")
    with client.websocket_connect(
        f"/ws/session/{info.id}", headers={"host": "127.0.0.1:8620"}
    ) as ws:
        first = json.loads(ws.receive_text())
        assert first["type"] == "replay_size"
        assert ws.receive_bytes() == b"build done\r\n"
        ws.send_text(json.dumps({"type": "replay_ack"}))
        assert json.loads(ws.receive_text()) == {"type": "replay_done"}
        assert json.loads(ws.receive_text()) == {"type": "exit", "code": 0}
        assert ws.receive()["type"] == "websocket.close"
    # Replay-only: no live subscription is created and no input is accepted.
    assert manager.last_attachment is None


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


# --- config: the runtime port must never reach disk -------------------------

def test_full_config_serves_the_persisted_port_not_the_runtime_one(
    client, cfg, fake_config_mod
):
    """Settings edits the persisted config, not the live one.

    app.py overwrites cfg.port at startup for `--port 0` and unconditionally
    for an elevated instance. Serving that value made Settings PUT it straight
    back, writing the ephemeral port into config.json and destroying the
    configured one for every later launch.
    """
    sys.modules["quickterm.config"].disk_config.port = 8620
    cfg.port = 53871  # e.g. an Administrator window on a free port

    body = client.get("/api/config/full").json()

    assert body["port"] == 8620


def test_put_config_keeps_the_persisted_port_for_a_stale_client(
    client, cfg, fake_config_mod
):
    """A page rendered from the live config must not write the runtime port back."""
    sys.modules["quickterm.config"].disk_config.port = 8620
    cfg.port = 53871

    response = client.put(
        "/api/config", json={"font_family": "Cascadia Mono", "port": 53871}
    )

    assert response.status_code == 204
    assert fake_config_mod[-1].port == 8620


def test_put_config_still_honours_a_deliberate_port_change(client, cfg, fake_config_mod):
    sys.modules["quickterm.config"].disk_config.port = 8620
    cfg.port = 8620

    response = client.put("/api/config", json={"font_family": "x", "port": 8700})

    assert response.status_code == 204
    assert fake_config_mod[-1].port == 8700


def test_config_reports_a_failed_hotkey_registration(client, cfg):
    """A shortcut another program owns must not fail silently.

    It is the documented escape hatch for a tray-hidden window; without this
    the user sees "Saved.", nothing happens, and a restart makes it worse.
    """
    assert client.get("/api/config").json()["hotkey_error"] is None

    cfg.hotkey_error = "already in use by another program: ctrl+alt+q"
    assert client.get("/api/config").json()["hotkey_error"] == (
        "already in use by another program: ctrl+alt+q"
    )


# --- the replay handshake must not starve a fresh subscription --------------

async def test_handshake_buffer_drains_a_bounded_queue():
    """Nothing consumed the subscriber queue until the live phase started.

    The fan-out queue counts items, so eight PTY reader callbacks during the
    (multi-round-trip) handshake were enough to mark the attachment overflowed
    — and the client reconnected into exactly the same window every time.
    """
    from quickterm.server import _HandshakeBuffer

    attachment = FakeAttachment()
    attachment.queue = asyncio.Queue(maxsize=8)
    buffer = _HandshakeBuffer(attachment)

    for index in range(20):  # far more than the queue could ever hold
        attachment.queue.put_nowait(bytes([index]))
        await asyncio.sleep(0)  # let the drain task run, as the handshake would

    buffered = buffer.take()

    assert buffered == [bytes([index]) for index in range(20)]
    assert attachment.queue.empty()


async def test_handshake_buffer_stops_at_the_exit_sentinel():
    from quickterm.server import _HandshakeBuffer

    attachment = FakeAttachment()
    buffer = _HandshakeBuffer(attachment)
    attachment.queue.put_nowait(b"tail")
    attachment.queue.put_nowait(None)
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert buffer.take() == [b"tail", None]


async def test_handshake_buffer_is_bounded():
    """It must not become the unbounded buffer the queue cap exists to prevent."""
    from quickterm.server import _HandshakeBuffer

    attachment = FakeAttachment()
    buffer = _HandshakeBuffer(attachment)
    chunk = b"x" * (128 * 1024)
    for _ in range(12):  # cap is 8 frames' worth
        attachment.queue.put_nowait(chunk)
        await asyncio.sleep(0)

    buffered = buffer.take()

    assert attachment.overflow_sentinel in buffered
    assert sum(1 for item in buffered if item is chunk) <= 8


def test_handshake_output_is_delivered_after_replay(client, manager):
    """Output produced during the handshake arrives, in order, once live."""
    info = manager.add_session(scrollback=b"old")
    with client.websocket_connect(
        f"/ws/session/{info.id}", headers={"host": "127.0.0.1:8620"}
    ) as ws:
        assert json.loads(ws.receive_text())["type"] == "replay_size"
        assert ws.receive_bytes() == b"old"
        manager.last_attachment.push_threadsafe(b"during-")
        manager.last_attachment.push_threadsafe(b"handshake")
        ws.send_text(json.dumps({"type": "replay_ack"}))
        assert json.loads(ws.receive_text()) == {"type": "replay_done"}
        assert ws.receive_bytes() == b"during-handshake"


# --- workspaces are folders -------------------------------------------------


def test_workspace_path_is_stored_and_preserved_by_layout_autosaves(
    client, fake_workspace, tmp_path
):
    root = tmp_path / "repo"
    root.mkdir()
    layout = {"type": "pane"}
    assert client.put(
        "/api/workspaces/dev", json={"layout": layout, "path": str(root)}
    ).status_code == 204
    body = client.get("/api/workspaces/dev").json()
    assert body["path"] == str(root)
    assert body["path_exists"] is True

    # An autosave carries no "path" key at all; the folder must survive it.
    assert client.put("/api/workspaces/dev", json={"layout": layout}).status_code == 204
    assert client.get("/api/workspaces/dev").json()["path"] == str(root)

    # An explicit null is the only way to clear it.
    assert client.put(
        "/api/workspaces/dev", json={"layout": layout, "path": None}
    ).status_code == 204
    assert client.get("/api/workspaces/dev").json()["path"] is None


def test_workspace_path_rejects_unusable_values(client, fake_workspace):
    r = client.put("/api/workspaces/dev", json={"layout": {"type": "pane"}, "path": 12})
    assert r.status_code == 400


def test_missing_workspace_folder_is_reported(client, fake_workspace, tmp_path):
    gone = tmp_path / "deleted"
    client.put("/api/workspaces/dev", json={"layout": {"type": "pane"}, "path": str(gone)})
    body = client.get("/api/workspaces/dev").json()
    assert body["path"] == str(gone)
    assert body["path_exists"] is False


def test_session_spawns_in_its_workspace_folder(client, manager, fake_workspace, tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    client.put("/api/workspaces/dev", json={"layout": {"type": "pane"}, "path": str(root)})
    r = client.post("/api/sessions", json={"cmd": "cmd.exe", "workspace": "dev"})
    assert r.status_code == 200
    assert manager.last_spawn["cwd"] == str(root)
    assert manager.last_spawn["workspace"] == "dev"


def test_profile_subpath_resolves_under_the_workspace_folder(
    client, manager, fake_workspace, cfg, tmp_path
):
    root = tmp_path / "repo"
    (root / "backend").mkdir(parents=True)
    cfg.profiles.append(
        FakeProfile(name="api", cmd="cmd.exe", subpath="backend", terminal_type="command-prompt")
    )
    client.put("/api/workspaces/dev", json={"layout": {"type": "pane"}, "path": str(root)})
    client.post("/api/sessions", json={"profile": "api", "workspace": "dev"})
    assert manager.last_spawn["cwd"] == str(root / "backend")


def test_profile_subpath_cannot_escape_the_workspace_folder(
    client, manager, fake_workspace, cfg, tmp_path
):
    root = tmp_path / "repo"
    root.mkdir()
    cfg.profiles.append(
        FakeProfile(name="bad", cmd="cmd.exe", subpath="../..", terminal_type="command-prompt")
    )
    client.put("/api/workspaces/dev", json={"layout": {"type": "pane"}, "path": str(root)})
    client.post("/api/sessions", json={"profile": "bad", "workspace": "dev"})
    assert manager.last_spawn["cwd"] == str(root)


def test_explicit_cwd_beats_the_workspace_folder(client, manager, fake_workspace, tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    client.put("/api/workspaces/dev", json={"layout": {"type": "pane"}, "path": str(root)})
    client.post(
        "/api/sessions",
        json={"cmd": "cmd.exe", "workspace": "dev", "cwd": str(elsewhere)},
    )
    assert manager.last_spawn["cwd"] == str(elsewhere)


def test_a_pinned_profile_keeps_its_folder_inside_a_workspace(
    client, manager, fake_workspace, cfg, tmp_path
):
    """"Always this folder" in Settings is an opt-out, not a suggestion."""
    root = tmp_path / "repo"
    root.mkdir()
    pinned = tmp_path / "pinned"
    pinned.mkdir()
    cfg.profiles.append(
        FakeProfile(name="pinned", cmd="cmd.exe", cwd=str(pinned), terminal_type="command-prompt")
    )
    # No workspace folder at all.
    client.put("/api/workspaces/plain", json={"layout": {"type": "pane"}})
    client.post("/api/sessions", json={"profile": "pinned", "workspace": "plain"})
    assert manager.last_spawn["cwd"] == str(pinned)

    # And with one: the pin still wins, because the user asked for it.
    client.put("/api/workspaces/dev", json={"layout": {"type": "pane"}, "path": str(root)})
    client.post("/api/sessions", json={"profile": "pinned", "workspace": "dev"})
    assert manager.last_spawn["cwd"] == str(pinned)

    # An explicit request directory still overrides everything.
    client.post(
        "/api/sessions",
        json={"profile": "pinned", "workspace": "dev", "cwd": str(root)},
    )
    assert manager.last_spawn["cwd"] == str(root)


def test_scratch_dir_is_exposed_to_the_ui(client):
    scratch = client.get("/api/config").json()["scratch_dir"]
    assert scratch and os.path.isdir(scratch)


def test_elevated_terminal_opens_in_the_workspace_folder(
    client, fake_workspace, cfg, tmp_path, monkeypatch
):
    if os.name != "nt":
        pytest.skip("administrator terminals are Windows-only")
    root = tmp_path / "repo"
    (root / "backend").mkdir(parents=True)
    cfg.profiles.append(
        FakeProfile(name="api", cmd="cmd.exe", subpath="backend", terminal_type="command-prompt")
    )
    client.put("/api/workspaces/dev", json={"layout": {"type": "pane"}, "path": str(root)})

    launched: list[dict] = []
    elevation = types.ModuleType("quickterm.elevation")
    elevation.launch = launched.append
    monkeypatch.setitem(sys.modules, "quickterm.elevation", elevation)

    assert client.post("/api/elevate", json={"profile": "api", "workspace": "dev"}).status_code == 200
    assert launched[-1]["cwd"] == str(root / "backend")

    # A system shell carries no profile, so the workspace root is all it has.
    assert client.post(
        "/api/elevate", json={"cmd": "cmd.exe", "name": "Command Prompt", "workspace": "dev"}
    ).status_code == 200
    assert launched[-1]["cwd"] == str(root)
    assert "workspace" not in launched[-1]
