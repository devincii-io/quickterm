"""Workspace locations (CONTRACTS 4.5): this PC, a WSL distribution or an SSH
destination. Parsing, ws_exec in WSL, WSL terminals and agents with their
hooks, GET /api/locations, the folder browser's WSL start, the routes."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import quickterm.session_manager as session_manager
from quickterm import agent_hooks, browse, launch, shells, ssh_config, ws_exec
from quickterm import workspace as workspace_mod
from quickterm.api import system as system_routes
from quickterm.config import AgentSettings
from quickterm.server import create_app
from quickterm.session_manager import SessionManager
from tests.test_remote_workspace import _Pty
from tests.test_server import FakeConfig, FakeSessionManager

WSL = r"C:\Windows\System32\wsl.exe"
SSH = r"C:\Windows\System32\OpenSSH\ssh.exe"
TOKEN = "hooktoken-0123456789"


@pytest.fixture(autouse=True)
def programs(monkeypatch):
    monkeypatch.setattr(shells, "wsl_program", lambda: WSL)
    monkeypatch.setattr(ssh_config, "openssh_path", lambda kind: SSH)
    ws_exec._exists_cache.clear()


# --- the stored location -----------------------------------------------------------


@pytest.mark.parametrize(("value", "kind"), [
    (None, "local"),
    ("", "local"),
    ("wsl:Ubuntu-24.04", "wsl"),
    ("devbox", "ssh"),
    ("dev@devbox.example", "ssh"),
    ("ssh://dev@devbox.example:2222", "ssh"),
    ("SSH://[fe80::1%eth0]:22", "ssh"),
    ("10.0.0.5", "ssh"),
])
def test_a_location_is_this_pc_wsl_or_an_ssh_destination(value, kind):
    host = workspace_mod.normalize_host(value)
    assert workspace_mod.location_kind(host) == kind
    assert workspace_mod.wsl_distro(host) == ("Ubuntu-24.04" if kind == "wsl" else None)


@pytest.mark.parametrize(("value", "message"), [
    ("-oProxyCommand=calc", "must not start with -"),
    ("two words", "must not contain spaces"),
    ("dev\tbox", "control characters"),
    ("box\n", None),  # a trailing line break is trimmed like any whitespace
    ("a" * 201, "at most 200"),
    ("wsl:", "wsl:<distribution name>"),
    ("wsl:-d", "wsl:<distribution name>"),
    ("wsl:a b", "wsl:<distribution name>"),
    ("ssh://box:99999", "ssh://"),
    ("ssh://box/path", "ssh://"),
    ("@box", "host alias or"),
    ("user@", "host alias or"),
    (3, "string or null"),
])
def test_a_location_that_could_pass_as_an_option_is_refused(value, message):
    if message is None:
        assert workspace_mod.normalize_host(value) == "box"
        return
    with pytest.raises(ValueError, match=message):
        workspace_mod.normalize_host(value)


def test_a_wsl_workspace_round_trips_with_a_posix_folder(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    monkeypatch.setattr(workspace_mod, "_NAMESPACE", None)
    workspace_mod.save_workspace(workspace_mod.Workspace("w", {}, path="~/code/app/", host="wsl:Ubuntu"))
    saved = workspace_mod.load_workspace("w")
    assert (saved.host, saved.path) == ("wsl:Ubuntu", "~/code/app")


# --- ws_exec in WSL ----------------------------------------------------------------


def wsl_ws(path="/srv/app b") -> workspace_mod.Workspace:
    return workspace_mod.Workspace("w", {}, path=path, host="wsl:Ubuntu")


def test_wsl_argv_hands_linux_the_words_as_they_are():
    argv = ws_exec.remote_argv(wsl_ws(), ["git", "log", "--format=%s $HOME `x`"])
    assert argv[:7] == [WSL, "-d", "Ubuntu", "--cd", "/srv/app b", "--exec", "sh"]
    # The guard refuses to run in / when --cd could not get there; the words
    # are only ever "$@" to it.
    assert argv[7] == "-c" and argv[8] == ws_exec._WSL_GUARD
    assert argv[9:] == ["/srv/app b", "git", "log", "--format=%s $HOME `x`"]


def test_wsl_without_a_folder_starts_at_home_and_slash_needs_no_guard():
    assert ws_exec.remote_argv(wsl_ws(None), ["ls"])[3:5] == ["--cd", "~"]
    assert ws_exec.remote_argv(wsl_ws("/"), ["ls"]) == [WSL, "-d", "Ubuntu", "--cd", "/", "--exec", "ls"]


def test_run_in_wsl_puts_env_first_and_asks_wsl_for_utf8(monkeypatch):
    seen = {}

    def fake_run(argv, **kwargs):
        seen.update(argv=argv, **kwargs)
        return subprocess.CompletedProcess(argv, 0, "ok\n", "")

    monkeypatch.setattr(ws_exec.subprocess, "run", fake_run)
    assert ws_exec.run(wsl_ws(), ["git", "status"], env=ws_exec.GIT_ENV, input="x").stdout == "ok\n"
    assert seen["argv"][10:] == [
        "env", "-u", "GIT_DIR", "-u", "GIT_WORK_TREE", "-u", "GIT_INDEX_FILE", "-u", "GIT_COMMON_DIR",
        "GIT_TERMINAL_PROMPT=0", "git", "status",
    ]
    assert seen["env"]["WSL_UTF8"] == "1"
    assert seen["input"] == "x" and "cwd" not in seen


def test_without_wsl_a_wsl_workspace_is_unavailable(monkeypatch):
    monkeypatch.setattr(shells, "wsl_program", lambda: None)
    with pytest.raises(ws_exec.RemoteUnavailable, match="WSL is not installed"):
        ws_exec.run(wsl_ws(), ["ls"])


def test_the_wsl_folder_check(monkeypatch):
    answers = iter([
        subprocess.CompletedProcess([], 0, "", ""),
        subprocess.CompletedProcess([], 1, "", "chdir(/nope) failed 2\n/nope is not a folder\n"),
        subprocess.CompletedProcess([], 4294967295, "", "There is no distribution with the supplied name.\n"),
    ])
    calls = []

    def fake_run(argv, **kwargs):
        calls.append(argv)
        return next(answers)

    monkeypatch.setattr(ws_exec.subprocess, "run", fake_run)
    assert ws_exec.check_folder("wsl:Ubuntu", "~/x") == (True, "")
    assert calls[0][:5] == [WSL, "-d", "Ubuntu", "--cd", "~/x"] and calls[0][-1] == "true"
    assert ws_exec.check_folder("wsl:Ubuntu", "/nope") == (False, "/nope is not a folder in WSL: Ubuntu")
    assert ws_exec.check_folder("wsl:Gone", "/x") == (False, "There is no distribution with the supplied name.")


def test_the_ssh_folder_check_goes_to_the_destination(monkeypatch):
    calls = []

    def fake_run(argv, **kwargs):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(ws_exec.subprocess, "run", fake_run)
    assert ws_exec.check_folder("me@box", "~/a b") == (True, "")
    assert calls[0][0] == SSH and calls[0][-2:] == ["me@box", "test -d ~/'a b'"]
    assert "BatchMode=yes" in calls[0]


# --- terminals in a WSL workspace ----------------------------------------------------


@dataclass
class Cfg:
    agents: dict = field(default_factory=lambda: {"claude-code": AgentSettings(), "codex": AgentSettings()})
    shell: str = "powershell"


def resolve(path="/srv/app", **kwargs) -> launch.LaunchSpec:
    return launch.resolve(Cfg(), remote=launch.RemoteTarget("wsl:Ubuntu", path), **kwargs)


def test_a_plain_terminal_is_the_distributions_login_shell_in_the_folder():
    spec = resolve()
    assert (spec.cmd, spec.args) == (WSL, ["-d", "Ubuntu", "--cd", "/srv/app"])
    assert (spec.cwd, spec.wsl, spec.terminal_type, spec.name) == ("/srv/app", "Ubuntu", "wsl", "WSL: Ubuntu")
    assert spec.wrap is None and spec.remote is None and spec.agent is None
    # The shell setting does not apply there.
    assert resolve(shell="cmd").args == spec.args
    assert resolve(path=None).args[-1] == "~"


def test_a_split_starts_where_the_wsl_shell_is():
    assert resolve(request_cwd="/srv/app/src").args[-1] == "/srv/app/src"
    assert resolve(request_cwd=r"C:\Users\x").args[-1] == "/srv/app"


def test_an_agent_runs_from_the_distributions_path_inside_the_wsl_wrap():
    spec = resolve(profile="claude-code")
    assert spec.cmd == "claude" and spec.args == ["--continue"]
    assert spec.wrap == shells.Wrap("wsl:Ubuntu", WSL, "claude")
    assert (spec.agent, spec.wsl, spec.cwd, spec.name) == ("claude", "Ubuntu", "/srv/app", "Claude Code")
    codex = resolve(profile="codex", agent_mode="agents")
    assert (codex.cmd, codex.args) == ("codex", ["agents"])
    # A prompt keeps its line breaks: no remote shell reads it again.
    assert resolve(profile="claude-code", agent_mode="new", prompt="a\nb").args == ["a\nb"]


@pytest.fixture
def hooks(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    monkeypatch.setenv("SystemRoot", r"C:\Windows")
    monkeypatch.setattr(agent_hooks, "curl_usable", lambda: True)
    monkeypatch.setattr(agent_hooks, "_codex_user_notify", lambda: [])
    monkeypatch.setattr(session_manager, "PtySession", _Pty)
    return tmp_path / "quickterm" / "hooks"


async def _spawn(spec: launch.LaunchSpec, *, hooks_on: bool = True):
    mgr = SessionManager(asyncio.get_running_loop())
    if hooks_on:
        mgr.set_agent_hooks(8741, TOKEN)
    info = mgr.spawn(**spec.spawn_kwargs())
    return mgr, info, _Pty.last


async def test_a_wsl_plain_terminal_starts_its_pty_here_and_shows_the_linux_folder(hooks):
    mgr, info, pty = await _spawn(resolve())
    assert (pty.cmd, pty.args) == (WSL, ["-d", "Ubuntu", "--cd", "/srv/app"])
    assert pty.cwd != "/srv/app" and Path(pty.cwd).is_absolute()
    assert info.cwd == "/srv/app" and info.host is None
    assert mgr.is_remote(info.id)
    assert "QUICKTERM_CURL" not in pty.env


WINDOWS = pytest.mark.skipif(os.name != "nt", reason="WSL interop exists only on Windows")


@WINDOWS
async def test_a_wsl_claude_reports_through_curl_exe_with_the_token_only_in_its_env(hooks):
    mgr, info, pty = await _spawn(resolve(profile="claude-code"))
    assert pty.args[:5] == ["-d", "Ubuntu", "--cd", "/srv/app", "--exec"]
    assert pty.args[5:7] == ["bash", "-lc"]
    script = pty.args[7]
    assert script.startswith("claude --continue --settings ")
    assert script.endswith(f"; {shells.AGENT_EXIT_PRINTF}; exec bash -l")
    assert all(TOKEN not in arg for arg in [pty.cmd, *pty.args])
    assert pty.env["QUICKTERM_HOOK_TOKEN"] == TOKEN and pty.env["QUICKTERM_SESSION_ID"] == info.id
    assert pty.env["QUICKTERM_CURL"] == str(Path(r"C:\Windows") / "System32" / "curl.exe")
    names = pty.env["WSLENV"].split(":")
    assert {"QUICKTERM_PORT", "QUICKTERM_SESSION_ID", "QUICKTERM_HOOK_TOKEN", "QUICKTERM_CURL/p"} <= set(names)
    # The hooks run the Windows curl configs a local launch uses.
    assert (hooks / "claude-Stop.curl").is_file()
    assert info.agent_shell == "wsl:Ubuntu"
    assert mgr.is_remote(info.id), "paths in its hooks are Linux paths"


def test_the_wsl_hook_settings_name_the_windows_curl_configs(tmp_path):
    args = agent_hooks.wsl_claude_args(["--continue"], tmp_path)
    assert args[:2] == ["--continue", "--settings"]
    settings = json.loads(args[2])
    assert set(settings["hooks"]) == set(agent_hooks.CLAUDE_EVENTS)
    stop = settings["hooks"]["Stop"][0]["hooks"][0]
    assert stop["async"] is True
    assert stop["command"] == (
        f'[ -x "$QUICKTERM_CURL" ] && "$QUICKTERM_CURL" -K {(tmp_path / "claude-Stop.curl").as_posix()}; exit 0'
    )
    assert agent_hooks.wsl_claude_args(["--settings=/x.json"], tmp_path) == ["--settings=/x.json"]
    assert agent_hooks.wsl_claude_args(["agents", "--cwd", "."], tmp_path) == ["agents", "--cwd", "."]


def test_a_wsl_codex_gets_a_notify_only_without_one_of_its_own(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_hooks, "_codex_user_notify", lambda: [])
    args = agent_hooks.wsl_codex_args(["resume", "--last"], tmp_path)
    assert args[0] == "-c" and args[1].startswith("notify=['sh','-c',")
    assert "--data-binary @-" in args[1] and args[2:] == ["resume", "--last"]
    monkeypatch.setattr(agent_hooks, "_codex_user_notify", lambda: ["notify-send"])
    assert agent_hooks.wsl_codex_args(["resume"], tmp_path) == ["resume"]


def test_wslenv_keeps_the_users_own_entries(monkeypatch):
    monkeypatch.setenv("WSLENV", "USERPROFILE/p:QUICKTERM_PORT/u")
    env = agent_hooks.wsl_env({})
    assert env["WSLENV"].split(":") == [
        "USERPROFILE/p", "QUICKTERM_PORT/u", "QUICKTERM_SESSION_ID", "QUICKTERM_HOOK_TOKEN", "QUICKTERM_CURL/p",
    ]
    assert agent_hooks.wsl_env({"wslenv": "A"})["WSLENV"].startswith("A:QUICKTERM_PORT")


async def test_no_hooks_without_curl_or_without_a_hook_environment(hooks, monkeypatch):
    _mgr, _info, pty = await _spawn(resolve(profile="claude-code"), hooks_on=False)
    assert "--settings" not in pty.args[7] and "QUICKTERM_CURL" not in pty.env
    monkeypatch.setattr(agent_hooks, "curl_usable", lambda: False)
    _mgr, _info, pty = await _spawn(resolve(profile="claude-code"))
    assert pty.args[7].startswith("claude --continue; ")
    assert "--settings" not in pty.args[7] and "QUICKTERM_CURL" not in pty.env


@WINDOWS
async def test_an_agent_with_the_wsl_shell_in_a_local_workspace_gets_the_hooks_too(hooks, tmp_path):
    cfg = Cfg(shell="wsl:Ubuntu")
    spec = launch.resolve(cfg, profile="codex", agent_mode="new", request_cwd=str(tmp_path))
    _mgr, _info, pty = await _spawn(spec)
    assert pty.args[pty.args.index("-lc") + 1].startswith("codex -c ")
    assert "QUICKTERM_CURL/p" in pty.env["WSLENV"]


# --- routes ------------------------------------------------------------------------


def test_locations_list_this_pc_each_distribution_and_each_ssh_alias(monkeypatch):
    monkeypatch.setattr(system_routes, "_terminal_inventory", lambda: {
        "types": [], "installs": [], "shells": [], "wsl_distributions": ["Ubuntu", "bad name"],
    })
    monkeypatch.setattr(ssh_config, "hosts", lambda path=None: [
        {"alias": "devbox", "hostname": "devbox.example", "user": "dev"},
        {"alias": "plain", "hostname": None, "user": None},
        {"alias": "named", "hostname": "10.0.0.5", "user": None},
        {"alias": "-oProxyCommand=x", "hostname": "x", "user": None},
    ])
    with TestClient(create_app(FakeSessionManager(), FakeConfig()), base_url="http://127.0.0.1:8620") as c:
        body = c.get("/api/locations").json()
    assert body == {"locations": [
        {"id": None, "kind": "local", "label": "This PC", "detail": None, "browse": None},
        {"id": "wsl:Ubuntu", "kind": "wsl", "label": "WSL: Ubuntu", "detail": None,
         "browse": "\\\\wsl.localhost\\Ubuntu\\home"},
        {"id": "devbox", "kind": "ssh", "label": "devbox", "detail": "dev@devbox.example", "browse": None},
        {"id": "plain", "kind": "ssh", "label": "plain", "detail": None, "browse": None},
        {"id": "named", "kind": "ssh", "label": "named", "detail": "10.0.0.5", "browse": None},
    ]}


def test_locations_need_the_token():
    with TestClient(create_app(FakeSessionManager(), FakeConfig(), "s3cret"),
                    base_url="http://127.0.0.1:8620") as c:
        assert c.get("/api/locations").status_code == 403


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    monkeypatch.setattr(workspace_mod, "_NAMESPACE", None)
    with TestClient(create_app(FakeSessionManager(), FakeConfig()), base_url="http://127.0.0.1:8620") as c:
        yield c


def test_a_wsl_workspace_saves_checks_and_reads_without_waiting(client, monkeypatch):
    monkeypatch.setattr("quickterm.git_info.remote_git_info", lambda ws: None)
    monkeypatch.setattr(ws_exec, "cached_exists", lambda ws: True)
    ok = client.put("/api/workspaces/lin", json={"layout": {}, "host": "wsl:Ubuntu", "path": "/home/me/app/"})
    assert ok.status_code == 204
    body = client.get("/api/workspaces/lin").json()
    assert (body["host"], body["path"], body["path_exists"]) == ("wsl:Ubuntu", "/home/me/app", True)
    bad = client.put("/api/workspaces/x", json={"layout": {}, "host": "wsl:a b", "path": "/x"})
    assert bad.status_code == 400 and "wsl:<distribution name>" in bad.json()["detail"]
    windows_path = client.put("/api/workspaces/y", json={"layout": {}, "host": "wsl:Ubuntu", "path": r"C:\x"})
    assert windows_path.status_code == 400
    monkeypatch.setattr(ws_exec, "check_folder", lambda host, path: (False, f"{path} is not a folder in {host}"))
    answer = client.post("/api/workspaces/remote-check", json={"host": "wsl:Ubuntu", "path": "/nope"})
    assert answer.json() == {"ok": False, "message": "/nope is not a folder in wsl:Ubuntu"}


@pytest.mark.skipif(os.name != "nt", reason="administrator terminals exist only on Windows")
def test_no_administrator_terminal_in_a_wsl_workspace(client, monkeypatch):
    assert client.put(
        "/api/workspaces/lin", json={"layout": {}, "host": "wsl:Ubuntu", "path": "/srv"}
    ).status_code == 204
    launched = []
    monkeypatch.setattr("quickterm.elevation.launch", lambda spec: launched.append(spec))
    for body in ({"workspace": "lin"}, {"workspace": "lin", "profile": "claude-code"}):
        refused = client.post("/api/elevate", json=body)
        assert refused.status_code == 400
        assert refused.json()["detail"] == "administrator terminals are not available in a WSL or SSH workspace"
    assert launched == []


# --- the folder browser and a stopped distribution --------------------------------


def test_a_wsl_share_names_its_distribution():
    assert browse.wsl_share_distro(r"\\wsl.localhost\Ubuntu\home\me") == "Ubuntu"
    assert browse.wsl_share_distro(r"\\wsl$\Debian") == "Debian"
    assert browse.wsl_share_distro("//wsl.localhost/Ubuntu/") == "Ubuntu"
    assert browse.wsl_share_distro(r"\\server\share") is None
    assert browse.wsl_share_distro(r"C:\wsl.localhost") is None
    assert browse.wsl_share_distro(None) is None


def test_a_stopped_distribution_is_started_once_and_listed_again(monkeypatch):
    listings = iter([browse.BrowseError("no such folder", missing=True), {"path": "listed"}])

    def fake_list(path):
        item = next(listings)
        if isinstance(item, Exception):
            raise item
        return item

    started = []

    def fake_run(argv, **kwargs):
        started.append((argv, kwargs["timeout"]))
        return subprocess.CompletedProcess(argv, 0, b"", b"")

    monkeypatch.setattr(browse, "_list_dirs", fake_list)
    monkeypatch.setattr(browse.subprocess, "run", fake_run)
    assert browse.list_dirs(r"\\wsl.localhost\Ubuntu\home") == {"path": "listed"}
    assert started == [([WSL, "-d", "Ubuntu", "--exec", "true"], 20)]


def test_no_start_for_other_paths_and_the_first_error_when_it_fails(monkeypatch):
    def missing(path):
        raise browse.BrowseError(f"no such folder: {path}", missing=True)

    started = []
    monkeypatch.setattr(browse, "_list_dirs", missing)
    monkeypatch.setattr(browse.subprocess, "run", lambda argv, **kw: started.append(argv) or
                        subprocess.CompletedProcess(argv, 1, b"", b""))
    with pytest.raises(browse.BrowseError, match="no such folder"):
        browse.list_dirs(r"C:\nope")
    assert started == []
    with pytest.raises(browse.BrowseError, match=r"no such folder: \\\\wsl\$\\Gone"):
        browse.list_dirs(r"\\wsl$\Gone")
    assert len(started) == 1


def test_the_route_starts_the_distribution_off_the_loop(monkeypatch):
    import threading

    threads = []

    def fake_list(path):
        threads.append(threading.current_thread() is threading.main_thread())
        return {"path": path, "name": "home", "parent": None, "dirs": [], "roots": [], "truncated": False}

    monkeypatch.setattr(browse, "list_dirs", fake_list)
    with TestClient(create_app(FakeSessionManager(), FakeConfig()), base_url="http://127.0.0.1:8620") as c:
        assert c.get("/api/fs/dirs", params={"path": r"\\wsl.localhost\Ubuntu\home"}).status_code == 200
    assert threads == [False]


def test_background_checks_leave_a_stopped_wsl_distribution_asleep(monkeypatch):
    calls = []

    def fake_run(argv, **kwargs):
        calls.append(argv)
        running = "Ubuntu\r\n".encode("utf-16-le")
        return subprocess.CompletedProcess(argv, 0, stdout=running, stderr=b"")

    monkeypatch.setattr(ws_exec.subprocess, "run", fake_run)
    monkeypatch.setattr(ws_exec, "_running", None)
    awake = workspace_mod.Workspace(name="a", layout=None, host="wsl:Ubuntu", path="/srv")
    stopped = workspace_mod.Workspace(name="b", layout=None, host="wsl:Debian", path="/srv")
    local = workspace_mod.Workspace(name="c", layout=None, path="C:/x")
    assert not ws_exec.asleep(awake)
    assert ws_exec.asleep(stopped)
    assert not ws_exec.asleep(local)
    assert len(calls) == 1, "the running list is cached"
    assert calls[0][1:] == ["--list", "--running", "--quiet"]

    # With none running wsl.exe exits non-zero with a sentence on stdout.
    monkeypatch.setattr(ws_exec, "_running", None)
    monkeypatch.setattr(ws_exec.subprocess, "run", lambda argv, **kwargs: subprocess.CompletedProcess(
        argv, 1, stdout="There are no running distributions.".encode("utf-16-le"), stderr=b""))
    assert ws_exec.asleep(awake)
