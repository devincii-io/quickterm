"""Agent catalog, ssh_config hosts and agent session routes, plus the inventory entries."""

from __future__ import annotations

import os
import sys
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from quickterm import agent_sessions, agents, putty_tools, ssh_config
from quickterm.api import system as system_routes
from quickterm.server import create_app
from tests.test_server import FakeConfig, FakeSessionManager

BASE = "http://127.0.0.1:8620"
SESSION = "0199a3b2-7c41-7d10-9e55-2f1a3c4b5d6e"


@pytest.fixture
def client():
    with TestClient(create_app(FakeSessionManager(), FakeConfig()), base_url=BASE) as c:
        yield c


@pytest.fixture
def workspaces(monkeypatch, tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    store = {
        "dev": types.SimpleNamespace(name="dev", path=str(root)),
        "gone": types.SimpleNamespace(name="gone", path=str(tmp_path / "deleted")),
        "bare": types.SimpleNamespace(name="bare", path=None),
    }
    mod = types.ModuleType("quickterm.workspace")
    mod.load_workspace = store.get
    mod.resolve_start_dir = lambda path: path if path and Path(path).is_dir() else None
    monkeypatch.setitem(sys.modules, "quickterm.workspace", mod)
    return root


# --- GET /api/system/agents -----------------------------------------------------


def test_agent_catalog_shape(client, tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    body = client.get("/api/system/agents").json()
    assert [t["id"] for t in body["types"]] == ["claude-code", "codex"]
    for entry in body["types"]:
        assert {"id", "label", "executable", "available", "modes", "default_mode", "options"} <= set(entry)
        assert all({"value", "label", "detail"} <= set(mode) for mode in entry["modes"])
        for option in entry["options"]:
            assert {"key", "label", "kind", "hint", "advanced"} <= set(option)
            if option["kind"] in ("choice", "combo"):
                assert isinstance(option["choices"], list)


def test_agent_catalog_is_cached_for_a_minute_and_fresh_rescans(client, monkeypatch):
    scans = []

    def catalog():
        scans.append(1)
        return {"types": [], "scan": len(scans)}

    monkeypatch.setattr(agents, "catalog", catalog)
    assert client.get("/api/system/agents").json()["scan"] == 1
    assert client.get("/api/system/agents").json()["scan"] == 1
    assert client.get("/api/system/agents?fresh=true").json()["scan"] == 2
    assert client.get("/api/system/agents").json()["scan"] == 2
    # The shell inventory keeps its own cache entry.
    monkeypatch.setattr(system_routes, "_terminal_inventory", lambda: {"types": [], "inv": True})
    assert client.get("/api/system/terminals").json()["inv"] is True
    assert client.get("/api/system/agents").json()["scan"] == 2


# --- GET /api/system/ssh-hosts ----------------------------------------------------


def test_ssh_hosts_lists_the_parsed_config(client, tmp_path, monkeypatch):
    config = tmp_path / "config"
    monkeypatch.setattr(ssh_config, "config_path", lambda: config)
    monkeypatch.setattr(ssh_config, "openssh_path", lambda kind: None)
    assert client.get("/api/system/ssh-hosts").json() == {
        "path": str(config), "exists": False, "openssh": None, "hosts": [],
    }
    config.write_text("Host devbox\n  HostName 10.0.0.5\n  User deploy\n  Port 2222\n")
    monkeypatch.setattr(ssh_config, "openssh_path", lambda kind: tmp_path / f"{kind}.exe")
    body = client.get("/api/system/ssh-hosts").json()
    assert body["exists"] is True
    assert body["openssh"] == str(tmp_path / "ssh.exe")
    assert body["hosts"] == [{
        "alias": "devbox", "hostname": "10.0.0.5", "user": "deploy", "port": 2222,
        "identity_file": None, "proxy_jump": None,
    }]


def test_ssh_host_resolves_through_ssh(client, monkeypatch, tmp_path):
    config = tmp_path / "config"
    config.write_text("Host devbox\n")
    monkeypatch.setattr(ssh_config, "config_path", lambda: config)
    monkeypatch.setattr(ssh_config, "openssh_path", lambda kind: tmp_path / "ssh.exe")
    monkeypatch.setattr(ssh_config.subprocess, "run", lambda argv, **kw: types.SimpleNamespace(
        returncode=0, stdout=b"hostname 10.0.0.5\nuser deploy\nport 22\nidentityfile ~/.ssh/k\nproxyjump bastion\n",
    ))
    response = client.get("/api/system/ssh-hosts/devbox")
    assert response.status_code == 200
    assert response.json() == {
        "alias": "devbox", "hostname": "10.0.0.5", "user": "deploy", "port": 22,
        "identity_files": [os.path.expanduser("~/.ssh/k")], "proxy_jump": "bastion",
    }


@pytest.mark.parametrize("alias", ["-oProxyCommand=calc", "two%20words", "a%3Bb"])
def test_ssh_host_refuses_an_alias_that_could_be_an_option(client, monkeypatch, alias):
    monkeypatch.setattr(ssh_config.subprocess, "run", lambda *a, **k: pytest.fail("ssh must not run"))
    assert client.get(f"/api/system/ssh-hosts/{alias}").status_code == 400


def test_ssh_host_unknown_to_both_ssh_and_the_parser_is_404(client, monkeypatch, tmp_path):
    monkeypatch.setattr(ssh_config, "openssh_path", lambda kind: None)
    monkeypatch.setattr(ssh_config, "config_path", lambda: tmp_path / "config")
    assert client.get("/api/system/ssh-hosts/nowhere").status_code == 404


def test_ssh_host_not_in_the_config_is_404_even_with_ssh_present(client, monkeypatch, tmp_path):
    monkeypatch.setattr(ssh_config, "openssh_path", lambda kind: tmp_path / "ssh.exe")
    monkeypatch.setattr(ssh_config, "config_path", lambda: tmp_path / "config")
    monkeypatch.setattr(ssh_config.subprocess, "run", lambda *a, **k: pytest.fail("ssh must not run"))
    assert client.get("/api/system/ssh-hosts/nosuchhostxyz").status_code == 404


# --- GET /api/agent-sessions ------------------------------------------------------


@pytest.fixture
def recorded(monkeypatch):
    calls = []

    def sessions(kind, cwd, limit):
        calls.append((kind, cwd, limit))
        return [{"id": SESSION, "title": "t", "updated_at": "2026-10-03T12:00:00Z", "cwd": cwd}]

    monkeypatch.setattr(agent_sessions, "sessions", sessions)
    return calls


def test_agent_sessions_for_a_workspace_use_its_root(client, workspaces, recorded):
    response = client.get("/api/agent-sessions?type=codex&workspace=dev")
    assert response.status_code == 200
    assert response.json() == {"sessions": [
        {"id": SESSION, "title": "t", "updated_at": "2026-10-03T12:00:00Z", "cwd": str(workspaces)},
    ]}
    assert recorded == [("codex", str(workspaces), 20)]


def test_agent_sessions_for_a_folder(client, recorded, tmp_path):
    client.get("/api/agent-sessions", params={"type": "claude-code", "cwd": str(tmp_path)})
    assert recorded == [("claude-code", str(tmp_path), 20)]


def test_agent_sessions_limit_is_clamped(client, recorded, tmp_path):
    for limit, expected in (("0", 1), ("-5", 1), ("500", 100), ("7", 7)):
        client.get("/api/agent-sessions", params={"type": "codex", "cwd": str(tmp_path), "limit": limit})
        assert recorded[-1][2] == expected


def test_agent_sessions_errors(client, workspaces, recorded):
    assert client.get("/api/agent-sessions?type=bash&cwd=/x").status_code == 400
    assert client.get("/api/agent-sessions?cwd=/x").status_code == 400
    assert client.get("/api/agent-sessions?type=codex").status_code == 400
    assert client.get("/api/agent-sessions?type=codex&workspace=nope").status_code == 404
    # A workspace whose folder is gone, or that has none, simply has no sessions.
    for name in ("gone", "bare"):
        response = client.get(f"/api/agent-sessions?type=codex&workspace={name}")
        assert response.status_code == 200
        assert response.json() == {"sessions": []}
    assert recorded == []


def test_an_unreadable_store_is_an_empty_list(client, tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "missing"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "missing"))
    for kind in ("codex", "claude-code"):
        response = client.get("/api/agent-sessions", params={"type": kind, "cwd": str(tmp_path)})
        assert response.json() == {"sessions": []}


# --- token gating -----------------------------------------------------------------


@pytest.mark.parametrize("path", [
    "/api/system/agents", "/api/system/ssh-hosts", "/api/system/ssh-hosts/devbox",
    "/api/agent-sessions?type=codex&cwd=/x",
])
def test_the_new_routes_need_the_token(path, monkeypatch, tmp_path):
    monkeypatch.setattr(ssh_config, "openssh_path", lambda kind: None)
    monkeypatch.setattr(ssh_config, "config_path", lambda: tmp_path / "config")
    with TestClient(create_app(FakeSessionManager(), FakeConfig(), "s3cret"), base_url=BASE) as c:
        assert c.get(path).status_code == 403
        assert c.get(path, headers={"X-QuickTerm-Token": "s3cret"}).status_code != 403


# --- the inventory ----------------------------------------------------------------


def _types(inventory: dict) -> dict[str, dict]:
    return {entry["id"]: entry for entry in inventory["types"]}


@pytest.fixture
def clients(monkeypatch, tmp_path):
    monkeypatch.setattr(agents, "codex_executable", lambda: str(tmp_path / "codex.exe"))
    monkeypatch.setattr(ssh_config, "openssh_path", lambda kind: tmp_path / "OpenSSH" / f"{kind}.exe")
    monkeypatch.setattr(putty_tools, "plink_path", lambda: tmp_path / "putty" / "plink.exe")
    monkeypatch.setattr(putty_tools, "psftp_path", lambda: tmp_path / "putty" / "psftp.exe")
    def no_wsl(*_args, **_kwargs):
        raise OSError("not asked in tests")

    monkeypatch.setattr(system_routes.subprocess, "run", no_wsl)
    return tmp_path


@pytest.mark.skipif(os.name != "nt", reason="the Windows inventory probes Windows paths")
def test_windows_inventory_lists_codex_and_both_ssh_clients(clients):
    types_ = _types(system_routes._terminal_inventory())
    assert types_["codex"] == {
        "id": "codex", "label": "Codex CLI", "executable": str(clients / "codex.exe"), "available": True,
    }
    assert types_["ssh"] == {
        "id": "ssh", "label": "SSH", "executable": str(clients / "putty" / "plink.exe"), "available": True,
        "openssh": str(clients / "OpenSSH" / "ssh.exe"), "putty": str(clients / "putty" / "plink.exe"),
    }
    assert types_["sftp"]["label"] == "SFTP"
    assert types_["sftp"]["openssh"] == str(clients / "OpenSSH" / "sftp.exe")
    assert types_["sftp"]["putty"] == str(clients / "putty" / "psftp.exe")


def test_posix_inventory_lists_codex_and_openssh(clients, monkeypatch):
    monkeypatch.setattr(system_routes.shutil, "which", lambda name: None)
    types_ = _types(system_routes._posix_inventory())
    assert types_["codex"]["available"] is True
    assert types_["ssh"] == {
        "id": "ssh", "label": "SSH", "executable": str(clients / "OpenSSH" / "ssh.exe"), "available": True,
        "openssh": str(clients / "OpenSSH" / "ssh.exe"), "putty": None,
    }
    monkeypatch.setattr(ssh_config, "openssh_path", lambda kind: None)
    assert _types(system_routes._posix_inventory())["sftp"]["available"] is False
