"""Workspace setup at launch: a shell's start command and the environment
every terminal of a workspace gets (CONTRACTS.md, 4.5 wave 2)."""

from __future__ import annotations

import asyncio
import os
import shlex
import subprocess
from dataclasses import dataclass, field

import pytest
from fastapi.testclient import TestClient

import quickterm.session_manager as session_manager
from quickterm import launch, shells, ssh_config, ws_exec
from quickterm import workspace as workspace_mod
from quickterm.config import AgentSettings
from quickterm.server import create_app
from quickterm.session_manager import SessionManager
from tests.test_remote_workspace import _posix_sh, _Pty
from tests.test_server import FakeConfig, FakeSessionManager

# PowerShell, cmd and WSL argv only exist on Windows.
WINDOWS_ONLY = pytest.mark.skipif(os.name != "nt", reason="Windows shells")

WSL = r"C:\Windows\System32\wsl.exe"
SSH = r"C:\Windows\System32\OpenSSH\ssh.exe"
PS = r"C:\Program Files\PowerShell\7\pwsh.exe"
CWD = r"C:\work"
HOSTILE = "it's $(rm -rf ~); `x` \"q\" %PATH%"


@dataclass
class Cfg:
    agents: dict = field(default_factory=lambda: {
        "claude-code": AgentSettings(cmd="claude.exe", env={"FROM_SETTINGS": "s", "SHARED": "settings"}),
        "codex": AgentSettings(cmd="C:/bin/codex.exe"),
    })
    shell: str = "powershell"
    host: str = "127.0.0.1"
    port: int = 8620


@pytest.fixture(autouse=True)
def programs(monkeypatch):
    monkeypatch.setattr(shells, "wsl_program", lambda: WSL)
    monkeypatch.setattr(ssh_config, "openssh_path", lambda kind: SSH)
    monkeypatch.setattr(shells, "pwsh_program", lambda: PS)
    monkeypatch.setattr(shells, "git_bash_program", lambda: r"C:\Git\bin\bash.exe")
    monkeypatch.delenv("WSLENV", raising=False)
    ws_exec._exists_cache.clear()


# --- the argv of a shell that runs a command first ------------------------------------


def test_powershell_runs_the_command_and_stays():
    assert shells.interactive("powershell", PS, CWD, command="npm run dev") == (
        PS, ["-NoLogo", "-NoExit", "-Command", "npm run dev"], CWD,
    )
    # With QuickTerm's integration the boot line comes first.
    _cmd, args, _cwd = shells.interactive(
        "powershell", PS, CWD, shells.Integration(), command="npm run dev",
    )
    assert args == ["-NoLogo", "-NoExit", "-Command", f"{shells.PS_BOOT}\nnpm run dev"]


def test_cmd_runs_the_command_after_k_in_the_quotes_it_strips():
    assert shells.interactive("cmd", "cmd.exe", CWD, command="npm run dev") == (
        "cmd.exe", ["/k", '"npm run dev"'], CWD,
    )


@pytest.mark.parametrize("bad", ['echo "x"', "a & b", "a | b", "a > f", "echo %PATH%", "a^b", "hi!"])
def test_cmd_refuses_what_it_would_parse_again(bad):
    with pytest.raises(ValueError, match="cmd.exe"):
        shells.interactive("cmd", "cmd.exe", CWD, command=bad)


def test_git_bash_and_posix_evaluate_the_command_then_become_a_login_shell():
    assert shells.interactive("git-bash", "bash.exe", CWD, command="make watch &") == (
        "bash.exe", ["-lc", "eval 'make watch &'; exec bash -l"], CWD,
    )
    assert shells.interactive("", "/usr/bin/zsh", "/w", command="ls # c") == (
        "/usr/bin/zsh", ["-lc", "eval 'ls # c'; exec /usr/bin/zsh -l"], "/w",
    )


def test_a_local_wsl_shell_runs_the_command_through_exec_bash():
    assert shells.interactive("wsl:Ubuntu", WSL, CWD, command="make") == (
        WSL,
        ["-d", "Ubuntu", "--cd", CWD, "--exec", "bash", "-lc",
         "eval make; exec \"${SHELL:-bash}\" -l"],
        None,
    )


@pytest.mark.skipif(_posix_sh() is None, reason="no POSIX sh")
def test_the_posix_command_text_is_valid_shell_whatever_the_command():
    sh = _posix_sh()
    for command in ("make watch &", "ls # comment", HOSTILE, "a; b && c"):
        text = shells.posix_then_shell(command, "bash")
        done = subprocess.run([sh, "-n", "-c", text], capture_output=True, check=False)
        assert done.returncode == 0, (text, done.stderr)


# --- resolving a request with a command ---------------------------------------------------


@WINDOWS_ONLY
def test_a_plain_local_shell_carries_the_command_for_the_integration(tmp_path):
    spec = launch.resolve(Cfg(), command="  npm test ", request_cwd=str(tmp_path))
    assert spec.command == "npm test"
    assert spec.args == ["-NoLogo", "-NoExit", "-Command", "npm test"]
    assert spec.spawn_kwargs()["command"] == "npm test"
    assert "command" not in launch.resolve(Cfg(), request_cwd=str(tmp_path)).spawn_kwargs()


def test_the_command_is_for_a_plain_shell_only(tmp_path):
    for extra in ({"profile": "claude-code"}, {"cmd": "sh"}, {"args": []}):
        with pytest.raises(launch.LaunchError, match="plain shell"):
            launch.resolve(Cfg(), command="ls", request_cwd=str(tmp_path), **extra)
    with pytest.raises(launch.LaunchError, match="one line"):
        launch.resolve(Cfg(), command="a\nb")


@WINDOWS_ONLY
def test_a_cmd_command_cmd_would_reinterpret_is_a_launch_error(tmp_path):
    cfg = Cfg(shell="cmd")
    with pytest.raises(launch.LaunchError, match="cmd.exe"):
        launch.resolve(cfg, command="a & b", request_cwd=str(tmp_path))


# --- the environment ---------------------------------------------------------------------


def test_env_order_is_settings_then_workspace_then_terminal(tmp_path):
    spec = launch.resolve(
        Cfg(), profile="claude-code", request_cwd=str(tmp_path),
        workspace_env={"SHARED": "workspace", "WS": "w"}, env={"WS": "terminal", "OWN": "o"},
    )
    assert spec.env == {"FROM_SETTINGS": "s", "SHARED": "workspace", "WS": "terminal", "OWN": "o"}
    plain = launch.resolve(Cfg(), request_cwd=str(tmp_path), workspace_env={"A": "1"}, env={"B": "2"})
    assert plain.env == {"A": "1", "B": "2"}


async def test_quickterm_variables_win_in_the_pty(tmp_path, monkeypatch):
    monkeypatch.setattr(session_manager, "PtySession", _Pty)
    mgr = SessionManager(asyncio.get_running_loop())
    mgr.set_agent_hooks(8741, "token")
    # The API refuses such names; the manager still never lets one through.
    spec = launch.resolve(Cfg(), cmd="sh", env={"QUICKTERM_PORT": "1", "QUICKTERM_SESSION_ID": "x"})
    info = mgr.spawn(**spec.spawn_kwargs())
    assert _Pty.last.env["QUICKTERM_PORT"] == "8741"
    assert _Pty.last.env["QUICKTERM_SESSION_ID"] == info.id


@pytest.mark.skipif(os.name != "nt", reason="the integration is Windows-only")
async def test_the_integrated_shell_keeps_its_command(tmp_path, monkeypatch):
    monkeypatch.setattr(session_manager, "PtySession", _Pty)
    mgr = SessionManager(asyncio.get_running_loop())
    spec = launch.resolve(Cfg(), command="npm test", request_cwd=str(tmp_path), workspace_env={"A": "1"})
    mgr.spawn(**spec.spawn_kwargs())
    assert _Pty.last.args == ["-NoLogo", "-NoExit", "-Command", f"{shells.PS_BOOT}\nnpm test"]
    assert _Pty.last.env["A"] == "1"


def test_wslenv_lists_the_workspace_names_and_keeps_its_own(monkeypatch):
    assert shells.with_wslenv({"A": "1"}, ["A"]) == {"A": "1", "WSLENV": "A"}
    monkeypatch.setenv("WSLENV", "USERPROFILE/p:a")
    assert shells.with_wslenv({"A": "1", "B": "2"}, ["A", "B"])["WSLENV"] == "USERPROFILE/p:a:B"
    assert shells.with_wslenv({"wslenv": "X", "B": "2"}, ["B"]) == {"B": "2", "WSLENV": "X:B"}


def wsl(**kwargs) -> launch.LaunchSpec:
    return launch.resolve(Cfg(), remote=launch.RemoteTarget("wsl:Ubuntu", "/srv/app"), **kwargs)


def test_a_wsl_workspace_shell_gets_its_env_through_wslenv_and_runs_the_command():
    spec = wsl(workspace_env={"API": "x"}, env={"ONE": "y"}, command="make")
    assert spec.cmd == WSL
    assert spec.args == ["-d", "Ubuntu", "--cd", "/srv/app", "--exec", "bash", "-lc",
                         "eval make; exec \"${SHELL:-bash}\" -l"]
    assert spec.env == {"API": "x", "ONE": "y", "WSLENV": "API:ONE"}
    assert wsl().env == {}


def test_a_wsl_agent_gets_the_workspace_env_through_wslenv():
    spec = wsl(profile="claude-code", workspace_env={"API": "x"})
    # The agent runs in Linux, so the settings' variables go there too.
    assert spec.env["API"] == "x" and spec.env["FROM_SETTINGS"] == "s"
    assert set(spec.env["WSLENV"].split(":")) == {"API", "FROM_SETTINGS", "SHARED"}


@WINDOWS_ONLY
def test_a_local_wsl_shell_lists_the_names_too(tmp_path):
    spec = launch.resolve(Cfg(shell="wsl:Ubuntu"), workspace_env={"API": "x"}, request_cwd=str(tmp_path))
    assert spec.env == {"API": "x", "WSLENV": "API"}
    agent = launch.resolve(Cfg(shell="wsl:Ubuntu"), profile="claude-code", request_cwd=str(tmp_path),
                           workspace_env={"API": "x"})
    assert agent.env["WSLENV"] == "API:FROM_SETTINGS:SHARED"
    # Not on Windows' own shells.
    assert "WSLENV" not in launch.resolve(Cfg(), workspace_env={"API": "x"}, request_cwd=str(tmp_path)).env


# --- SSH -----------------------------------------------------------------------------------


def ssh(**kwargs) -> launch.LaunchSpec:
    return launch.resolve(Cfg(), remote=launch.RemoteTarget("devbox", "/srv/app"), **kwargs)


def test_an_ssh_shell_exports_the_env_quoted_then_runs_the_command():
    spec = ssh(workspace_env={"API": HOSTILE}, env={"ONE": "1"}, command="make watch")
    script = spec.args[-1]
    assert script == (
        f"cd /srv/app; export API={shlex.quote(HOSTILE)}; export ONE=1; "
        "\"${SHELL:-/bin/sh}\" -lc 'make watch'; exec \"$SHELL\" -l"
    )
    # Nothing of it reaches the local ssh's own environment.
    assert spec.env == {}
    assert ssh().args[-1] == 'cd /srv/app; exec "$SHELL" -l'


def test_an_ssh_agent_exports_the_env_with_and_without_hooks():
    spec = ssh(profile="claude-code", workspace_env={"API": "v"})
    assert "export API=v; " in spec.args[-1]
    # The settings' own variables do not travel to the host.
    assert "FROM_SETTINGS" not in spec.args[-1]
    hooks = launch.RemoteHooks("sid", "/tmp/quickterm-0123456789abcdef.sock", 8741, "00ff")
    inner = shlex.split(launch.remote_script(spec.remote, hooks))[3]
    assert "export API=v" in inner.split("; ")


def test_an_ssh_value_with_a_line_break_is_refused():
    with pytest.raises(launch.LaunchError, match="line break"):
        ssh(workspace_env={"API": "a\nb"})


@pytest.mark.skipif(_posix_sh() is None, reason="no POSIX sh")
def test_the_ssh_scripts_with_env_are_valid_shell():
    sh = _posix_sh()
    plain = ssh(workspace_env={"API": HOSTILE}, command="make & # x").args[-1]
    agent = ssh(profile="codex", workspace_env={"API": HOSTILE}).remote
    hooks = launch.RemoteHooks("sid", "/tmp/quickterm-0123456789abcdef.sock", 8741, "00ff")
    with_hooks = launch.remote_script(agent, hooks)
    for script in (plain, launch.remote_script(agent), with_hooks, shlex.split(with_hooks)[3]):
        done = subprocess.run([sh, "-n", "-c", script], capture_output=True, check=False)
        assert done.returncode == 0, (script, done.stderr)
    done = subprocess.run([sh, "-c", plain.replace('exec "$SHELL" -l', "printf %s \"$API\"")
                           .replace("\"${SHELL:-/bin/sh}\" -lc 'make & # x'", ":")],
                          capture_output=True, check=False)
    assert done.stdout.decode() == HOSTILE


# --- the route -----------------------------------------------------------------------------


@pytest.fixture
def appdata(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    monkeypatch.setattr(workspace_mod, "_NAMESPACE", None)


@pytest.fixture
def manager():
    return FakeSessionManager()


@pytest.fixture
def client(manager, appdata):
    with TestClient(create_app(manager, FakeConfig()), base_url="http://127.0.0.1:8620") as c:
        yield c


def test_post_sessions_adds_the_workspace_env_and_checks_the_terminals(client, manager, tmp_path):
    workspace_mod.save_workspace(workspace_mod.Workspace(
        name="api", layout={}, path=str(tmp_path), env={"API": "w", "SHARED": "w"},
    ))
    response = client.post("/api/sessions", json={
        "workspace": "api", "cmd": "sh", "env": {"SHARED": "t"},
    })
    assert response.status_code == 200, response.text
    assert manager.last_spawn["env"] == {"API": "w", "SHARED": "t"}
    for bad in ({"QUICKTERM_PORT": "1"}, {"WSLENV": "x"}, {"1": "x"}):
        response = client.post("/api/sessions", json={"workspace": "api", "cmd": "sh", "env": bad})
        assert response.status_code == 400
        assert "invalid env" in response.json()["detail"]


@WINDOWS_ONLY
def test_post_sessions_takes_a_command_and_agent_options(client, manager, tmp_path):
    response = client.post("/api/sessions", json={"command": "dir", "cwd": str(tmp_path), "shell": "cmd"})
    assert response.status_code == 200, response.text
    assert manager.last_spawn["command"] == "dir"
    assert manager.last_spawn["args"] == ["/k", '"dir"']
    response = client.post("/api/sessions", json={"command": "a & b", "cwd": str(tmp_path), "shell": "cmd"})
    assert response.status_code == 400
    response = client.post("/api/sessions", json={
        "profile": "claude-code", "cwd": str(tmp_path), "agent": {"model": "opus"},
    })
    assert response.status_code == 200, response.text
    assert "--model=opus" in manager.last_spawn["args"]
    response = client.post("/api/sessions", json={
        "profile": "claude-code", "cwd": str(tmp_path), "agent": {"nonsense": "1"},
    })
    assert response.status_code == 400
    response = client.post("/api/sessions", json={"cwd": str(tmp_path), "agent": {"model": "opus"}})
    assert response.status_code == 400
