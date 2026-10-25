"""An agent launch's first prompt (`prompt` on POST /api/sessions), which
"Fix with Claude" in the right panel uses."""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from quickterm import agents, launch
from quickterm.config import AgentProfile, AgentSettings
from quickterm.server import create_app
from tests.test_server import FakeConfig, FakeSessionManager

CWD = os.path.join(os.sep, "work", "project")


def claude(mode="new") -> AgentProfile:
    return AgentProfile(name="claude-code", cmd="C:/bin/claude.exe", terminal_type="claude-code", agent_mode=mode)


def codex(mode="new") -> AgentProfile:
    return AgentProfile(name="codex", cmd="C:/bin/codex.exe", terminal_type="codex", agent_mode=mode)


def test_the_prompt_is_the_last_positional_argument():
    assert agents.resolve(claude(), CWD, prompt="Fix the failing test")[1] == ["Fix the failing test"]
    assert agents.resolve(claude("continue"), CWD, prompt="go on")[1] == ["--continue", "go on"]
    assert agents.resolve(codex(), CWD, prompt="Fix it\nnow")[1] == ["--cd", CWD, "Fix it\nnow"]


@pytest.mark.parametrize(("value", "message"), [
    (42, "prompt must be a string"),
    ("x" * (agents.PROMPT_MAX_CHARS + 1), "at most 16000"),
    ("a\0b", "NUL"),
    ("--dangerously-skip-permissions", "must not start with -"),
    ('say "hi"', "double quotes"),
])
def test_bad_prompts_are_refused(value, message):
    with pytest.raises(ValueError, match=message):
        agents.validate_prompt(value)


def test_a_blank_prompt_is_none_and_the_limit_is_inclusive():
    assert agents.validate_prompt("   ") is None
    assert agents.validate_prompt(None) is None
    assert agents.validate_prompt("y" * agents.PROMPT_MAX_CHARS) == "y" * agents.PROMPT_MAX_CHARS


def test_the_agents_mode_takes_no_prompt():
    with pytest.raises(ValueError, match="agents mode"):
        agents.resolve(claude("agents"), CWD, prompt="hello")


class Cfg:
    def __init__(self, cmd="C:/bin/claude.exe") -> None:
        self.agents = {"claude-code": AgentSettings(cmd=cmd, agent_mode="new"), "codex": AgentSettings()}
        self.shell = "cmd"


@pytest.mark.parametrize(("fields", "message"), [
    ({}, "prompt requires a Claude Code or Codex profile"),
    ({"profile": "claude-code", "args": []}, "prompt takes no cmd or args"),
    ({"profile": "claude-code", "prompt": "-x"}, "must not start with -"),
])
def test_launch_refuses_a_prompt_where_it_does_not_belong(tmp_path, fields, message):
    request = {"prompt": "fix it", **fields}
    with pytest.raises(launch.LaunchError, match=message) as caught:
        launch.resolve(Cfg(), request_cwd=str(tmp_path), **request)
    assert caught.value.status == 400


def test_a_remote_launch_carries_a_multiline_prompt_on_one_line(monkeypatch):
    from quickterm import ssh_config
    from tests.test_remote_workspace import SSH
    from tests.test_remote_workspace import resolve as resolve_remote

    # The stub test_remote_workspace.py applies to all its tests, so the test
    # needs no OpenSSH installed.
    monkeypatch.setattr(ssh_config, "openssh_path", lambda kind: SSH)

    spec = resolve_remote(profile="claude-code", agent_mode="new",
                          prompt="The hook failed.\r\n\nlint: x.py:1\nFix it.")
    assert spec.remote.command[-1] == "The hook failed. | lint: x.py:1 | Fix it."
    assert "\n" not in spec.args[-1]


@pytest.mark.skipif(os.name != "nt", reason="POSIX always launches the login shell, never cmd.exe")
def test_cmd_takes_at_most_7000_prompt_characters(tmp_path):
    folder = str(tmp_path)
    ok = launch.resolve(Cfg(), profile="claude-code", request_cwd=folder, prompt="x" * 7000)
    assert ok.args[-1] == "x" * 7000
    with pytest.raises(launch.LaunchError, match="too long for cmd.exe: at most 7000"):
        launch.resolve(Cfg(), profile="claude-code", request_cwd=folder, prompt="x" * 7001)


def test_a_batch_agent_takes_at_most_7000_prompt_characters_under_any_shell(tmp_path):
    shim = tmp_path / "claude.cmd"
    shim.write_text("@echo off\n", encoding="utf-8")
    cfg = Cfg(cmd=str(shim))
    cfg.shell = "powershell"
    with pytest.raises(launch.LaunchError, match="too long for cmd.exe"):
        launch.resolve(cfg, profile="claude-code", request_cwd=str(tmp_path), prompt="y" * 7001)
    # A batch file refuses a line break anyway, and says so briefly.
    with pytest.raises(launch.LaunchError, match="cmd.exe would reinterpret") as caught:
        launch.resolve(cfg, profile="claude-code", request_cwd=str(tmp_path), prompt="a\n" + "b" * 3000)
    assert len(str(caught.value)) < 200


def test_the_session_route_hands_the_prompt_to_claude(tmp_path, monkeypatch):
    manager = FakeSessionManager()
    with TestClient(create_app(manager, FakeConfig(shell="powershell")), base_url="http://127.0.0.1:8620") as client:
        response = client.post("/api/sessions", json={
            "profile": "claude-code", "agent_mode": "new", "cwd": str(tmp_path),
            "prompt": "The pre-commit hook failed.\nFix the cause; do not bypass hooks.",
        })
        assert response.status_code == 200, response.text
        assert manager.last_spawn["args"][-1] == "The pre-commit hook failed.\nFix the cause; do not bypass hooks."
        refused = client.post("/api/sessions", json={"cwd": str(tmp_path), "prompt": "hello"})
        assert refused.status_code == 400
