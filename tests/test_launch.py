"""The one launch resolver, and the app-side launches that go through it."""

from __future__ import annotations

import os
import shutil
import sys
import types
from dataclasses import dataclass, field

import pytest

from quickterm import launch
from quickterm import workspace as real_workspace
from quickterm.config import AgentSettings


def _agents() -> dict:
    return {
        "claude-code": AgentSettings(cmd="claude.exe", agent_mode="agents"),
        "codex": AgentSettings(cmd="C:/bin/codex.exe", agent={"model": "gpt-6"}),
    }


@dataclass
class Cfg:
    agents: dict = field(default_factory=_agents)
    shell: str = "cmd"
    host: str = "127.0.0.1"
    port: int = 8620


def test_agents_need_a_folder():
    with pytest.raises(launch.LaunchError, match="Claude Code profile requires a project folder"):
        launch.resolve(Cfg(), profile="claude-code")
    with pytest.raises(launch.LaunchError, match="Codex profile requires a project folder"):
        launch.resolve(Cfg(), profile="codex")


# --- agent launch requests ---------------------------------------------------

SESSION = "0199a3b2-7c41-7d10-9e55-2f1a3c4b5d6e"


def test_legacy_claude_mode_still_overrides_with_its_old_messages(tmp_path):
    cfg = Cfg()
    spec = launch.resolve(cfg, profile="claude-code", claude_mode="continue", request_cwd=str(tmp_path))
    assert spec.args == ["--continue"]
    with pytest.raises(launch.LaunchError) as caught:
        launch.resolve(cfg, profile="claude-code", claude_mode="fork", request_cwd=str(tmp_path))
    assert str(caught.value) == "claude_mode must be new, continue, resume, or agents"
    with pytest.raises(launch.LaunchError) as caught:
        launch.resolve(cfg, profile="codex", claude_mode="fork", request_cwd=str(tmp_path))
    assert str(caught.value) == "claude_mode requires a Claude Code profile"
    with pytest.raises(launch.LaunchError) as caught:
        launch.resolve(cfg, cmd="cmd.exe", claude_mode="new")
    assert str(caught.value) == "claude_mode requires a profile"


def test_agent_mode_overrides_either_agent_and_agrees_with_its_alias(tmp_path):
    cfg = Cfg()
    folder = str(tmp_path)
    assert launch.resolve(cfg, profile="claude-code", agent_mode="new", request_cwd=folder).args == []
    assert launch.resolve(
        cfg, profile="claude-code", agent_mode="resume", claude_mode="resume", request_cwd=folder,
    ).args == ["--resume"]
    assert launch.resolve(cfg, profile="codex", agent_mode="continue", request_cwd=folder).args == [
        "resume", "--last", "--cd", folder, "--model", "gpt-6",
    ]
    # The agent's own mode when the request names none: Claude's agents.
    assert launch.resolve(cfg, profile="claude-code", request_cwd=folder).args == ["agents", "--cwd", folder]


@pytest.mark.parametrize(("profile", "fields", "message"), [
    ("claude-code", {"agent_mode": "new", "claude_mode": "continue"}, "agent_mode and claude_mode disagree"),
    ("claude-code", {"agent_mode": "fork"}, "agent_mode must be new, continue, resume, or agents"),
    ("codex", {"agent_mode": "later"}, "agent_mode must be new, continue, resume, fork, or agents"),
    ("claude-code", {"agent_session": "not-a-uuid"}, "agent_session must be a session id"),
    ("claude-code", {"agent_session": SESSION, "agent_mode": "continue"}, "agent_session needs resume or fork"),
    ("claude-code", {"agent_session": SESSION, "agent_mode": "new"}, "agent_session needs resume or fork"),
    ("codex", {"agent_session": SESSION, "agent_mode": "agents"}, "agent_session needs resume or fork"),
    (None, {"agent_mode": "new"}, "agent_mode requires a Claude Code or Codex profile"),
    (None, {"agent_session": SESSION}, "agent_mode requires a Claude Code or Codex profile"),
])
def test_agent_request_errors(tmp_path, profile, fields, message):
    with pytest.raises(launch.LaunchError, match=message) as caught:
        launch.resolve(Cfg(), profile=profile, cmd="x", request_cwd=str(tmp_path), **fields)
    assert caught.value.status == 400


def test_a_session_id_resumes_that_session_and_codex_can_fork_it(tmp_path):
    cfg = Cfg()
    folder = str(tmp_path)
    assert launch.resolve(cfg, profile="claude-code", agent_session=SESSION, request_cwd=folder).args == [
        "--resume", SESSION,
    ]
    assert launch.resolve(cfg, profile="codex", agent_session=SESSION, request_cwd=folder).args == [
        "resume", SESSION, "--cd", folder, "--model", "gpt-6",
    ]
    assert launch.resolve(
        cfg, profile="codex", agent_mode="fork", agent_session=SESSION, request_cwd=folder,
    ).args[:2] == ["fork", SESSION]


def test_an_agent_launch_folder_is_the_workspace_root(tmp_path):
    spec = launch.resolve(Cfg(), profile="codex", workspace_root=str(tmp_path))
    assert spec.cwd == str(tmp_path)
    assert spec.cmd == "C:/bin/codex.exe"
    assert spec.args[:2] == ["--cd", str(tmp_path)]
    assert spec.name == "Codex" and spec.profile == "codex"


# --- resolve(): the whole request ------------------------------------------


def test_request_folder_beats_the_workspace_root_beats_nothing(tmp_path):
    request_dir = tmp_path / "request"
    root = tmp_path / "root"
    request_dir.mkdir()
    root.mkdir()
    cfg = Cfg()
    spec = launch.resolve(cfg, cmd="sh", request_cwd=str(request_dir), workspace_root=str(root))
    assert spec.cwd == str(request_dir)
    assert launch.resolve(cfg, cmd="sh", workspace_root=str(root)).cwd == str(root)
    assert launch.resolve(cfg, cmd="sh").cwd is None


def test_a_missing_request_folder_names_the_terminal(tmp_path):
    with pytest.raises(launch.LaunchError) as caught:
        launch.resolve(Cfg(), profile="claude-code", request_cwd=str(tmp_path / "gone"))
    assert str(caught.value).startswith('Terminal "claude-code": starting folder does not exist')
    assert caught.value.status == 400


@pytest.mark.parametrize("name", ["nope", "Windows PowerShell", "server"])
def test_any_profile_but_the_agents_is_a_404(name):
    with pytest.raises(launch.LaunchError) as caught:
        launch.resolve(Cfg(), profile=name)
    assert caught.value.status == 404
    assert str(caught.value) == f"unknown profile: {name}"


def test_agent_env_is_validated_and_request_env_adds_to_it(tmp_path):
    cfg = Cfg()
    cfg.agents["claude-code"].env = {"A": "1"}
    folder = str(tmp_path)
    assert launch.resolve(cfg, profile="claude-code", request_cwd=folder).env == {"A": "1"}
    assert launch.resolve(
        cfg, profile="claude-code", env={"B": "2", "A": "3"}, request_cwd=folder,
    ).env == {"A": "3", "B": "2"}
    with pytest.raises(launch.LaunchError, match="invalid env"):
        launch.resolve(cfg, cmd="sh", env={"BAD=NAME": "x"})


def test_nothing_is_added_to_the_path_any_more():
    assert launch.resolve(Cfg(), cmd="sh", env={"Path": "mine"}).env == {"Path": "mine"}
    assert launch.resolve(Cfg(), cmd="sh").env == {}


def test_label_is_profile_then_name_then_command(tmp_path):
    cfg = Cfg()
    assert launch.resolve(cfg, profile="codex", name="given", request_cwd=str(tmp_path)).label == "codex"
    assert launch.resolve(cfg, cmd="sh", name="given").label == "given"
    assert launch.resolve(cfg, cmd=" sh ").label == "sh"


@pytest.mark.skipif(os.name != "nt", reason="the current-folder lookup is Windows behaviour")
def test_hardened_process_no_longer_finds_programs_in_the_launch_folder(monkeypatch, tmp_path):
    from quickterm import app as app_mod

    launch_dir = tmp_path / "Downloads"
    launch_dir.mkdir()
    (launch_dir / "claude.exe").write_bytes(b"")
    home = tmp_path / "home"
    home.mkdir()
    empty_path = tmp_path / "bin"
    empty_path.mkdir()
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("PATH", str(empty_path))
    monkeypatch.delenv("NoDefaultCurrentDirectoryInExePath", raising=False)
    monkeypatch.chdir(launch_dir)
    # The hazard: an Explorer launch leaves the process in that folder, and a
    # planted claude.exe there wins over PATH.
    assert shutil.which("claude") is not None
    environment = dict(os.environ)

    app_mod._harden_program_lookup()

    assert os.path.samefile(os.getcwd(), home)
    assert shutil.which("claude") is None
    # Nothing leaks into what the app starts: an environment variable would
    # reach every terminal and the relaunched app after an update.
    assert dict(os.environ) == environment


# --- app launches: the elevated first terminal --------------------------------


class _Manager:
    def __init__(self, fail: Exception | None = None) -> None:
        self.spawned: list[dict] = []
        self.fail = fail

    async def spawn_async(self, **kwargs):
        if self.fail is not None:
            raise self.fail
        self.spawned.append(kwargs)
        return types.SimpleNamespace(id="s1", **kwargs)


def test_profile_autostart_and_hotkeys_are_gone():
    from quickterm import app as app_mod

    assert not hasattr(app_mod, "_spawn_autostart")
    assert not hasattr(app_mod, "_profile_callback")


async def test_the_elevated_first_terminal_is_resolved_and_checked(tmp_path):
    from quickterm import app as app_mod

    server = types.SimpleNamespace(started=True)
    manager = _Manager()
    cfg = Cfg()
    spec = {"cmd": "cmd.exe", "args": ["/K"], "cwd": str(tmp_path), "env": {}, "name": "Administrator - cmd"}
    await app_mod._after_ready(server, manager, cfg, launch_window=False, initial_launch=spec)
    assert manager.spawned[0]["cwd"] == str(tmp_path)
    assert manager.spawned[0]["name"] == "Administrator - cmd"
    assert manager.spawned[0]["env"] == {}

    gone = dict(spec, cwd=str(tmp_path / "gone"))
    await app_mod._after_ready(server, _Manager(), cfg, launch_window=False, initial_launch=gone)
    assert "starting folder does not exist" in cfg.launch_error


async def test_a_failed_elevated_terminal_names_it():
    from quickterm import app as app_mod
    from quickterm.session_manager import SpawnError

    server = types.SimpleNamespace(started=True)
    cfg = Cfg()
    spec = {"cmd": "missing-xyz", "args": [], "cwd": None, "env": {}, "name": "Tools"}
    await app_mod._after_ready(
        server, _Manager(SpawnError("command not found: missing-xyz")), cfg,
        launch_window=False, initial_launch=spec,
    )
    assert cfg.launch_error == 'Terminal "Tools": command not found: missing-xyz'


def test_an_elevated_instance_uses_its_own_workspace_folder_before_touching_scratch(monkeypatch):
    from quickterm import app as app_mod

    calls: list[tuple] = []
    monkeypatch.setattr(real_workspace, "set_namespace", lambda name: calls.append(("ns", name)))
    monkeypatch.setattr(real_workspace, "delete_workspace", lambda name: calls.append(("del", name)))
    # The real %APPDATA% may hold temporary scratch-view files; they are not
    # what this test is about.
    monkeypatch.setattr(real_workspace, "list_workspaces", lambda: [])
    monkeypatch.setitem(sys.modules, "quickterm.workspace", real_workspace)

    app_mod._prepare_workspaces(elevated=True)
    assert calls == [("ns", "elevated"), ("del", "scratch")]

    calls.clear()
    app_mod._prepare_workspaces(elevated=False)
    assert calls == [("del", "scratch")]


def test_the_reaper_protects_every_referenced_session(monkeypatch):
    from quickterm import app as app_mod

    monkeypatch.setattr(real_workspace, "referenced_session_ids", lambda: {"a", ".b"})
    seen = {}

    class Manager:
        def reap_idle(self, timeout, protected):
            seen.update(timeout=timeout, protected=protected)
            return []

    app_mod._reap_pass(Manager(), 300)
    assert seen == {"timeout": 300, "protected": {"a", ".b"}}
