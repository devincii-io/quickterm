"""Workspaces on an SSH host (CONTRACTS 4.3): the stored host, ws_exec over
ssh, the terminal and agent launches, the hook socket and token handshake,
remote git facts and the routes."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import subprocess
import threading
from dataclasses import dataclass, field

import pytest
from fastapi.testclient import TestClient

import quickterm.session_manager as session_manager
from quickterm import agent_hooks, git_info, launch, ssh_config, ws_exec
from quickterm import workspace as workspace_mod
from quickterm.config import AgentSettings, Profile
from quickterm.server import create_app
from quickterm.session_manager import SessionManager
from tests.test_server import FakeConfig, FakeSessionManager

SSH = r"C:\Windows\System32\OpenSSH\ssh.exe"
HOSTILE = "/srv/it's $(rm -rf ~); `x` \"q\""
TOKEN = "hooktoken-0123456789"


def box(**changes) -> Profile:
    values = dict(
        name="devbox", cmd="", terminal_type="ssh", ssh_client="openssh",
        ssh_host="devbox.example", ssh_user="dev", ssh_port=2222, ssh_key=r"C:\keys\id_ed25519",
    )
    values.update(changes)
    return Profile(**values)


@dataclass
class Cfg:
    profiles: list = field(default_factory=lambda: [box()])
    agents: dict = field(default_factory=lambda: {"claude-code": AgentSettings(), "codex": AgentSettings()})
    shell: str = "powershell"
    host: str = "127.0.0.1"
    port: int = 8620


@pytest.fixture(autouse=True)
def openssh(monkeypatch):
    monkeypatch.setattr(ssh_config, "openssh_path", lambda kind: SSH)
    monkeypatch.setattr(ws_exec, "_saved_profiles", lambda: [box(), box(name="putty-box", ssh_client=None)])
    ws_exec._exists_cache.clear()
    git_info._remote_cache.clear()


def shell_words(command: str) -> list[str]:
    """A command line as the shell reads its words, `;` and `&&` apart."""
    lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    return list(lexer)


# --- the stored workspace ---------------------------------------------------------


def test_a_remote_folder_is_a_posix_path_kept_as_typed():
    assert workspace_mod.normalize_remote_root(" /srv/app/ ") == "/srv/app"
    assert workspace_mod.normalize_remote_root("~") == "~"
    assert workspace_mod.normalize_remote_root("~/code/x") == "~/code/x"
    assert workspace_mod.normalize_remote_root("") is None
    for bad in ("relative/x", "C:\\x", "/a\nb", "/a\x00b", "/a\rb"):
        with pytest.raises(ValueError):
            workspace_mod.normalize_remote_root(bad)


def test_host_round_trips_and_a_local_file_has_no_key(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    monkeypatch.setattr(workspace_mod, "_NAMESPACE", None)
    workspace_mod.save_workspace(workspace_mod.Workspace("api", {}, path="/srv/api/", host="devbox"))
    workspace_mod.save_workspace(workspace_mod.Workspace("local", {}, path=str(tmp_path)))
    remote = workspace_mod.load_workspace("api")
    assert (remote.host, remote.path) == ("devbox", "/srv/api")
    assert workspace_mod.load_workspace("local").host is None
    raw = json.loads(workspace_mod._path_for("local").read_text(encoding="utf-8"))
    assert "host" not in raw


# --- ws_exec ------------------------------------------------------------------


def test_quoting_refuses_nul_and_line_breaks():
    for bad in ("a\0b", "a\nb", "a\rb"):
        with pytest.raises(ValueError):
            ws_exec.posix_quote(bad)
    assert ws_exec.folder_word("~/my code") == "~/'my code'"
    assert ws_exec.folder_word("~") == "~"
    assert shlex.split(ws_exec.folder_word(HOSTILE)) == [HOSTILE]


def test_remote_argv_is_batch_ssh_with_the_profile_and_a_quoted_cd():
    ws = workspace_mod.Workspace("api", {}, path=HOSTILE, host="devbox")
    argv = ws_exec.remote_argv(ws, ["git", "status", "--porcelain"])
    assert argv[0] == SSH
    assert argv[argv.index("-p") + 1] == "2222"
    assert argv[argv.index("-i") + 1] == r"C:\keys\id_ed25519"
    assert "BatchMode=yes" in argv and "ClearAllForwardings=yes" in argv
    assert argv[-2] == "dev@devbox.example"
    command = argv[-1]
    assert command.startswith("cd ")
    words = shlex.split(command)
    assert words[:2] == ["cd", HOSTILE]
    assert words[2:] == ["&&", "git", "status", "--porcelain"]


def test_run_passes_the_remote_argv_without_a_local_folder(monkeypatch):
    seen = {}

    def fake_run(argv, **kwargs):
        seen.update(argv=argv, **kwargs)
        return subprocess.CompletedProcess(argv, 0, "ok\n", "")

    monkeypatch.setattr(ws_exec.subprocess, "run", fake_run)
    ws = workspace_mod.Workspace("api", {}, path="/srv/api", host="devbox")
    assert ws_exec.run(ws, ["ls"], timeout=3).stdout == "ok\n"
    assert seen["argv"][-1] == "cd /srv/api && ls"
    assert "cwd" not in seen
    assert seen["stdin"] is subprocess.DEVNULL


def test_a_putty_or_unknown_profile_cannot_back_a_workspace():
    with pytest.raises(ws_exec.RemoteUnavailable, match="remote workspaces need an OpenSSH profile"):
        ws_exec.find_profile("putty-box")
    with pytest.raises(FileNotFoundError, match="no SSH profile"):
        ws_exec.run(workspace_mod.Workspace("x", {}, path="/x", host="nobody"), ["ls"])


def test_folder_check_reports_what_ssh_said(monkeypatch):
    answers = iter([
        subprocess.CompletedProcess([], 0, "", ""),
        # Login noise from the host's shell profile does not hide the answer.
        subprocess.CompletedProcess([], 1, "", "warning from a shell profile\n"),
        subprocess.CompletedProcess([], 255, "", "dev@devbox: Permission denied (publickey).\n"),
    ])
    calls = []

    def fake_run(argv, **kwargs):
        calls.append(argv)
        return next(answers)

    monkeypatch.setattr(ws_exec.subprocess, "run", fake_run)
    assert ws_exec.check_folder("devbox", "/srv/a b") == (True, "")
    assert calls[0][-1] == "test -d '/srv/a b'"
    assert ws_exec.check_folder("devbox", "/nope") == (False, "/nope is not a folder on devbox")
    ok, message = ws_exec.check_folder("devbox", "/srv/x")
    assert not ok and "Permission denied" in message


def test_exists_never_calls_a_failed_login_missing(monkeypatch):
    monkeypatch.setattr(ws_exec.subprocess, "run",
                        lambda argv, **kw: subprocess.CompletedProcess(argv, 255, "", "timeout"))
    assert ws_exec.exists(workspace_mod.Workspace("x", {}, path="/srv/x", host="devbox")) is True
    monkeypatch.setattr(ws_exec.subprocess, "run",
                        lambda argv, **kw: subprocess.CompletedProcess(argv, 1, "", ""))
    assert ws_exec.exists(workspace_mod.Workspace("y", {}, path="/srv/y", host="devbox")) is False


# --- terminal launches -----------------------------------------------------------


def resolve(**kwargs) -> launch.LaunchSpec:
    target = launch.RemoteTarget(host="devbox", path=kwargs.pop("path", HOSTILE))
    return launch.resolve(Cfg(), remote=target, **kwargs)


def test_a_plain_terminal_is_ssh_t_with_a_quoted_cd_and_the_login_shell():
    spec = resolve()
    assert spec.cmd == SSH
    assert spec.args[0] == "-p" and "-t" in spec.args
    assert spec.args[-2] == "dev@devbox.example"
    assert shell_words(spec.args[-1])[:3] == ["cd", HOSTILE, ";"]
    assert spec.args[-1].endswith('; exec "$SHELL" -l')
    assert spec.cwd is None and spec.agent is None and spec.remote is not None
    assert spec.name == "devbox"


def test_a_requested_local_shell_starts_the_remote_one():
    assert resolve(shell="git-bash").args == resolve().args


def test_a_split_starts_where_the_remote_shell_is():
    spec = resolve(request_cwd="/srv/api/src")
    assert shell_words(spec.args[-1])[:2] == ["cd", "/srv/api/src"]
    # A Windows folder from a local pane is no place on the host.
    assert shell_words(resolve(request_cwd=r"C:\Users\x").args[-1])[:2] == ["cd", HOSTILE]


def test_claude_runs_on_the_host_in_its_login_shell_then_the_shell():
    spec = resolve(profile="claude-code")
    assert spec.agent == "claude" and spec.name == "Claude Code"
    script = spec.args[-1]
    assert '"${SHELL:-/bin/sh}" -lc' in script
    assert script.endswith('; exec "$SHELL" -l')
    assert spec.remote.command[0] == "claude"
    assert "--continue" in spec.remote.command


def test_a_windows_agent_path_falls_back_to_the_cli_name():
    cfg = Cfg()
    cfg.agents["codex"] = AgentSettings(cmd=r"C:\npm\codex.cmd")
    spec = launch.resolve(cfg, profile="codex", remote=launch.RemoteTarget("devbox", "/srv/x"))
    assert spec.remote.command[0] == "codex"
    assert spec.remote.command[1:3] == ("--cd", "/srv/x")


def test_a_putty_host_is_refused_with_the_contract_message():
    with pytest.raises(launch.LaunchError, match="remote workspaces need an OpenSSH profile"):
        launch.resolve(Cfg(profiles=[box(ssh_client="putty")]), remote=launch.RemoteTarget("devbox", "/x"))


def test_remote_capable_profiles():
    assert launch.remote_start(Profile(name="dev", cmd="bash", terminal_type="bash", start_command="npm run dev")) == "npm run dev"
    assert launch.remote_start(Profile(name="top", cmd="htop", terminal_type="custom", args=["-d", "5"])) == "htop -d 5"
    assert launch.remote_start(Profile(name="w", cmd=r"C:\x\tool.exe", terminal_type="custom")) is None
    assert launch.remote_start(Profile(name="ps", cmd="pwsh.exe", terminal_type="powershell-core", start_command="x")) is None
    assert launch.remote_start(Profile(name="wsl", cmd="wsl.exe", terminal_type="wsl", start_command="x")) is None


# --- the hook socket and the token -----------------------------------------------


class _Pty:
    last = None

    def __init__(self, cmd, args, cwd, env, cols, rows, loop, on_output, on_exit):
        self.cmd, self.args, self.cwd, self.env = cmd, args, cwd, env
        self.alive, self.exit_code, self.pid = True, None, 4242
        self.on_output = on_output
        self.written = []
        self.secrets = []
        _Pty.last = self

    def write(self, data):
        self.written.append(data)

    def write_secret(self, data, secret):
        self.secrets.append(secret)
        self.written.append(data)

    def resize(self, cols, rows):
        pass

    def kill(self):
        return True


async def spawn_agent(monkeypatch, profile="claude-code", notify=None):
    monkeypatch.setattr(session_manager, "PtySession", _Pty)
    monkeypatch.setattr(agent_hooks, "_codex_user_notify", lambda: [] if notify is None else notify)
    mgr = SessionManager(asyncio.get_running_loop())
    mgr.set_agent_hooks(8741, TOKEN)
    spec = resolve(profile=profile)
    info = mgr.spawn(**spec.spawn_kwargs())
    return mgr, info, _Pty.last


async def test_an_agent_gets_the_socket_forward_and_never_the_token_in_argv(monkeypatch):
    mgr, info, pty = await spawn_agent(monkeypatch)
    args = pty.args
    forward = args[args.index("-R") + 1]
    socket, _, rest = forward.partition(":")
    assert re.fullmatch(r"/tmp/quickterm-[0-9a-f]{16}\.sock", socket)
    assert rest == "127.0.0.1:8741"
    assert "ExitOnForwardFailure=no" in args
    assert args.index("-R") < args.index("dev@devbox.example")
    assert all(TOKEN not in arg for arg in [pty.cmd, *args])
    script = shlex.split(args[-1])
    assert script[:3] == ["exec", "sh", "-c"]
    body = script[3]
    assert f"QUICKTERM_SESSION_ID={info.id}" in body
    assert f"QUICKTERM_HOOK_SOCKET={socket}" in body
    assert "export QUICKTERM_HOOK_TOKEN QUICKTERM_SESSION_ID QUICKTERM_HOOK_SOCKET" in body
    assert "trap 'rm -f \"$QUICKTERM_HOOK_SOCKET\"' EXIT HUP TERM" in body
    # Ready first (ssh has logged in), then echo off, then the token request.
    ready = body.index("printf '\\033]7770;quickterm-ready;")
    assert ready < body.index("stty -echo") < body.index("printf '\\033]7770;quickterm-hook;")
    # The inline settings carry the hooks; the session's folder is on the host.
    assert "--settings" in body and "--unix-socket" in body
    assert info.cwd == HOSTILE


async def test_the_token_is_typed_once_when_the_marker_shows(monkeypatch):
    mgr, info, pty = await spawn_agent(monkeypatch)
    session = mgr.get(info.id)
    marker = session.hook_marker
    assert marker is not None and marker.startswith(b"\x1b]7770;quickterm-hook;")
    half = len(marker) // 2
    pty.on_output(b"banner " + marker[:half])
    assert pty.written == []
    pty.on_output(marker[half:] + b" more")
    answer = f"{session.hook_nonce}:{TOKEN}\r".encode()
    assert pty.written == [answer]
    assert pty.secrets == [TOKEN.encode()]
    # A later marker, from anything that runs afterwards, gets nothing.
    pty.on_output(marker)
    assert pty.written == [answer]
    # The token was never part of the nonce the host sees.
    assert TOKEN.encode() not in marker


async def test_a_password_typed_at_the_ssh_prompt_goes_through_at_once(monkeypatch):
    mgr, info, pty = await spawn_agent(monkeypatch)
    pty.on_output(b"dev@devbox's password: ")
    mgr.write(info.id, b"secret\r")
    mgr.write(info.id, b"yes\r")
    assert pty.written == [b"secret\r", b"yes\r"]


async def test_input_after_login_waits_in_order_and_follows_the_token(monkeypatch):
    mgr, info, pty = await spawn_agent(monkeypatch)
    session = mgr.get(info.id)
    ready = session.ready_marker
    assert ready is not None and ready.startswith(b"\x1b]7770;quickterm-ready;")
    pty.on_output(b"motd " + ready[:5])
    pty.on_output(ready[5:])
    mgr.write(info.id, b"fix the bug")
    mgr.write(info.id, b"\x1b[A")  # an arrow key waits too, behind the text
    mgr.write(info.id, b"\x1b[200~pasted\x1b[201~")
    mgr.write(info.id, b"\r")
    # The terminal's own replies pass at once.
    mgr.write(info.id, b"\x1b[?1;2c")
    mgr.write(info.id, b"\x1b[12;40R")
    assert pty.written == [b"\x1b[?1;2c", b"\x1b[12;40R"]
    pty.on_output(session.hook_marker)
    assert pty.written[2:] == [
        f"{session.hook_nonce}:{TOKEN}\r".encode(),
        b"fix the bug", b"\x1b[A", b"\x1b[200~pasted\x1b[201~", b"\r",
    ]
    mgr.write(info.id, b"x")
    assert pty.written[-1] == b"x"


async def test_the_hold_ends_at_its_deadline_and_past_its_size_in_order(monkeypatch):
    mgr, info, pty = await spawn_agent(monkeypatch)
    session = mgr.get(info.id)
    pty.on_output(session.ready_marker)
    mgr.write(info.id, b"early\r")
    assert pty.written == []
    session.hold_until = 1.0  # the deadline, counted from the ready marker, has passed
    mgr.write(info.id, b"late")
    assert pty.written == [b"early\r", b"late"]
    # The marker still gets its answer afterwards.
    pty.on_output(session.hook_marker)
    assert pty.written[-1] == f"{session.hook_nonce}:{TOKEN}\r".encode()

    mgr, info, pty = await spawn_agent(monkeypatch)
    session = mgr.get(info.id)
    pty.on_output(session.ready_marker)
    big = b"p" * (session_manager.HOOK_HOLD_BYTES - 10)
    mgr.write(info.id, b"first")
    mgr.write(info.id, big)
    assert pty.written == []
    mgr.write(info.id, b"x" * 20)
    assert pty.written == [b"first", big, b"x" * 20]


def test_the_input_log_shows_the_token_redacted():
    loop = asyncio.new_event_loop()
    try:
        from quickterm.pty_base import PtyBase

        base = PtyBase(loop, lambda data: None, lambda code: None)
        base.write_secret(b"abc:" + TOKEN.encode() + b"\r", TOKEN.encode())
        assert base.redact(b"xx abc:" + TOKEN.encode() + b"\r") == b"xx abc:<hook token>\r"
        assert base.redact(b"plain") == b"plain"
    finally:
        loop.close()


@pytest.mark.skipif(__import__("os").name != "nt", reason="ConPTY backend")
def test_conpty_debug_log_never_shows_the_token(monkeypatch, caplog):
    import logging

    from quickterm import pty_session

    class Console:
        def write(self, data):
            return True

    class Fake:
        _pid = 7
        _console = Console()

        def redact(self, data):
            return data.replace(TOKEN.encode(), b"<hook token>")

    monkeypatch.setattr(pty_session, "_DEBUG_IO", True)
    with caplog.at_level(logging.INFO, logger=pty_session.log.name):
        assert pty_session.PtySession._do_write(Fake(), b"n:" + TOKEN.encode() + b"\r")
    assert TOKEN not in caplog.text and "<hook token>" in caplog.text


async def test_without_hooks_there_is_no_forward_and_no_handshake(monkeypatch):
    monkeypatch.setattr(session_manager, "PtySession", _Pty)
    mgr = SessionManager(asyncio.get_running_loop())
    spec = resolve(profile="claude-code")
    info = mgr.spawn(**spec.spawn_kwargs())
    assert "-R" not in _Pty.last.args
    assert mgr.get(info.id).hook_marker is None


async def test_a_plain_remote_shell_gets_no_forward(monkeypatch):
    monkeypatch.setattr(session_manager, "PtySession", _Pty)
    mgr = SessionManager(asyncio.get_running_loop())
    mgr.set_agent_hooks(8741, TOKEN)
    mgr.spawn(**resolve().spawn_kwargs())
    assert "-R" not in _Pty.last.args


async def test_codex_notify_only_without_a_local_notify(monkeypatch):
    _mgr, _info, pty = await spawn_agent(monkeypatch, profile="codex")
    assert "notify=" in pty.args[-1]
    _mgr, _info, pty = await spawn_agent(monkeypatch, profile="codex", notify=["notify-send"])
    assert "notify=" not in pty.args[-1]


def test_remote_claude_settings_post_through_the_socket_with_the_token_on_stdin():
    args = agent_hooks.remote_claude_args(["--continue"], 8741)
    assert args[:2] == ["--continue", "--settings"]
    settings = json.loads(args[2])
    assert set(settings["hooks"]) == set(agent_hooks.CLAUDE_EVENTS)
    command = settings["hooks"]["Stop"][0]["hooks"][0]["command"]
    assert settings["hooks"]["Stop"][0]["hooks"][0]["async"] is True
    assert '--unix-socket "$QUICKTERM_HOOK_SOCKET"' in command
    assert "-H @-" in command and "-m 2" in command
    assert '"$QUICKTERM_HOOK_TOKEN"' in command and "printf" in command
    assert "http://127.0.0.1:8741/api/sessions/$QUICKTERM_SESSION_ID/agent-event?agent=claude" in command
    assert "statusLine" not in settings
    # A launch with settings of its own keeps them and gets no hooks.
    assert agent_hooks.remote_claude_args(["--settings=/x.json"], 1) == ["--settings=/x.json"]
    assert agent_hooks.remote_claude_args(["agents", "--cwd", "/x"], 1) == ["agents", "--cwd", "/x"]


def _posix_sh() -> str | None:
    import shutil
    from pathlib import Path

    found = shutil.which("sh")
    if found and "system32" not in found.lower():
        return found
    git_sh = Path(r"C:\Program Files\Git\usr\bin\sh.exe")
    return str(git_sh) if git_sh.is_file() else None


@pytest.mark.skipif(_posix_sh() is None, reason="no POSIX sh")
def test_the_remote_scripts_are_valid_shell():
    sh = _posix_sh()
    hook = agent_hooks.remote_hook_command("claude", 8741)
    codex = agent_hooks.remote_hook_command("codex", 8741, body='"$1"')
    remote = resolve(profile="claude-code").remote
    hooks = launch.RemoteHooks("sid", "/tmp/quickterm-0123456789abcdef.sock", 8741, "00ff")
    with_hooks = launch.remote_script(remote, hooks)
    inner = shlex.split(with_hooks)[3]
    for script in (hook, codex, launch.remote_script(remote), with_hooks, inner, resolve().args[-1]):
        done = subprocess.run([sh, "-n", "-c", script], capture_output=True, check=False)
        assert done.returncode == 0, (script, done.stderr)
    # Without the socket the hook does nothing and succeeds.
    done = subprocess.run([sh, "-c", hook], input=b"{}", capture_output=True, check=False,
                          env={"QUICKTERM_HOOK_SOCKET": "/nonexistent"})
    assert done.returncode == 0


# --- git over ssh ----------------------------------------------------------------


def test_remote_git_lines_become_git_info():
    assert git_info.parse_remote("main\n/srv/app\n/srv/app/.git\n") == {
        "branch": "main", "head": None, "worktree": False, "main_path": None,
    }
    assert git_info.parse_remote("fix\n/srv/app-fix\n/srv/app/.git\n") == {
        "branch": "fix", "head": None, "worktree": True, "main_path": "/srv/app",
    }
    assert git_info.parse_remote("HEAD\n/srv/app\n/srv/app/.git\n", "abc1234")["head"] == "abc1234"
    assert git_info.parse_remote("fatal: not a git repository\n") is None


def test_remote_git_info_is_cached_and_never_waits_on_a_request(monkeypatch):
    calls = []
    gate = threading.Event()

    def fake_run(ws, argv, **kwargs):
        calls.append(argv)
        gate.wait(5)
        return subprocess.CompletedProcess(argv, 0, "dev\n/srv/app\n/srv/app/.git\n", "")

    monkeypatch.setattr(ws_exec, "run", fake_run)
    ws = workspace_mod.Workspace("api", {}, path="/srv/app", host="devbox")
    assert git_info.remote_git_info(ws) is None  # answered at once, refresh started
    gate.set()
    for _ in range(100):
        if git_info._remote_cache:
            break
        threading.Event().wait(0.02)
    assert git_info.remote_git_info(ws)["branch"] == "dev"
    assert len(calls) == 1
    assert calls[0][:2] == ["git", "rev-parse"] and "--git-common-dir" in calls[0]


# --- routes ----------------------------------------------------------------------


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    monkeypatch.setattr(workspace_mod, "_NAMESPACE", None)
    cfg = FakeConfig()
    cfg.profiles = [box(), box(name="putty-box", ssh_client="putty")]
    with TestClient(create_app(FakeSessionManager(), cfg), base_url="http://127.0.0.1:8620") as c:
        yield c


def test_put_validates_the_host_and_reads_the_folder_on_it(client, monkeypatch):
    monkeypatch.setattr(git_info, "remote_git_info", lambda ws: {"branch": "dev", "head": None,
                                                                 "worktree": False, "main_path": None})
    monkeypatch.setattr(ws_exec, "cached_exists", lambda ws: True)
    ok = client.put("/api/workspaces/api", json={"layout": {}, "host": "devbox", "path": "/srv/api/"})
    assert ok.status_code == 204
    body = client.get("/api/workspaces/api").json()
    assert (body["host"], body["path"], body["path_exists"]) == ("devbox", "/srv/api", True)
    assert body["git"]["branch"] == "dev"
    # A layout autosave without the key keeps the host and folder.
    assert client.put("/api/workspaces/api", json={"layout": {"type": "pane"}}).status_code == 204
    assert client.get("/api/workspaces/api").json()["host"] == "devbox"
    refused = client.put("/api/workspaces/p", json={"layout": {}, "host": "putty-box", "path": "/x"})
    assert refused.status_code == 400
    assert refused.json()["detail"] == "remote workspaces need an OpenSSH profile"
    bad = client.put("/api/workspaces/q", json={"layout": {}, "host": "devbox", "path": "rel/x"})
    assert bad.status_code == 400


def test_remote_check_route(client, monkeypatch):
    monkeypatch.setattr(ws_exec, "check_folder",
                        lambda host, path, profiles=None: (False, f"{path} is not a folder on {host}"))
    answer = client.post("/api/workspaces/remote-check", json={"host": "devbox", "path": "/nope"})
    assert answer.json() == {"ok": False, "message": "/nope is not a folder on devbox"}
    assert client.post("/api/workspaces/remote-check", json={"host": "putty-box", "path": "/x"}).status_code == 400
    assert client.post("/api/workspaces/remote-check", json={"host": "devbox", "path": "/a\nb"}).status_code == 400


@pytest.mark.skipif(os.name != "nt", reason="administrator terminals exist only on Windows")
def test_no_administrator_terminal_on_a_remote_workspace(client, monkeypatch):
    monkeypatch.setattr(git_info, "remote_git_info", lambda ws: None)
    monkeypatch.setattr(ws_exec, "cached_exists", lambda ws: True)
    assert client.put("/api/workspaces/api", json={"layout": {}, "host": "devbox", "path": "/srv/api"}).status_code == 204
    launched = []
    monkeypatch.setattr("quickterm.elevation.launch", lambda spec: launched.append(spec))
    refused = client.post("/api/elevate", json={"workspace": "api"})
    assert refused.status_code == 400
    assert "remote workspace" in refused.json()["detail"]
    assert launched == []


def test_env_travels_as_an_env_prefix_on_a_host_and_never_takes_a_bad_name():
    assert ws_exec._with_env(["git", "status"], {"GIT_TERMINAL_PROMPT": "0", "GIT_DIR": None}) == [
        "env", "GIT_TERMINAL_PROMPT=0", "-u", "GIT_DIR", "git", "status",
    ]
    with pytest.raises(ValueError):
        ws_exec._with_env(["git"], {"A=B; rm": "x"})


def test_env_on_this_computer_sets_and_removes_whatever_the_spelling(monkeypatch):
    monkeypatch.setattr(ws_exec.os, "environ", {"Git_Dir": "C:/elsewhere/.git", "PATH": "p"})
    merged = ws_exec._local_env({"GIT_DIR": None, "GIT_TERMINAL_PROMPT": "0"})
    assert merged == {"PATH": "p", "GIT_TERMINAL_PROMPT": "0"}


# --- the token line and the agent's end, through a real POSIX shell ------------


@pytest.mark.skipif(_posix_sh() is None, reason="no POSIX sh")
def test_typed_lines_never_become_the_token_and_the_token_never_reaches_the_agent():
    from pathlib import Path

    sh = _posix_sh()
    probe = 'printf "token=%s\\n" "$QUICKTERM_HOOK_TOKEN"; IFS= read -r x; printf "agent-read=%s\\n" "$x"'
    remote = launch.RemoteLaunch(
        host="devbox", program=SSH, options=("dev@devbox",), target="dev@devbox",
        folder=None, command=("sh", "-c", probe), agent="claude",
    )
    hooks = launch.RemoteHooks("sid", "/nonexistent/quickterm-x.sock", 8741, "00ff00ff00ff00ff")
    inner = shlex.split(launch.remote_script(remote, hooks))[3]
    typed = b"fix the bug\r\nhalf" + launch.hook_answer(hooks.nonce, TOKEN) + b"\nfor the agent\n"
    done = subprocess.run(
        [sh, "-c", inner], input=typed, capture_output=True, check=False, timeout=30,
        env={"SHELL": Path(sh).as_posix(), "PATH": str(Path(sh).parent)},
    )
    out = done.stdout.decode()
    assert f"token={TOKEN}\n" in out, (out, done.stderr)
    assert "agent-read=for the agent" in out
    assert TOKEN not in out.replace(f"token={TOKEN}", "")


def test_the_remote_script_reports_the_agent_start_and_end():
    remote = resolve(profile="codex").remote
    hooks = launch.RemoteHooks("sid", "/tmp/quickterm-0123456789abcdef.sock", 8741, "ab" * 8)
    inner = shlex.split(launch.remote_script(remote, hooks))[3]
    start = inner.index(agent_hooks.AGENT_START)
    agent = inner.index('"${SHELL:-/bin/sh}" -lc')
    end = inner.index(agent_hooks.AGENT_EXIT)
    assert start < agent < end < inner.rindex('"${SHELL:-/bin/sh}" -l')
    assert '"agent":"codex"' in inner


def test_agent_start_and_exit_events():
    started = agent_hooks.apply(None, "codex", agent_hooks.AGENT_START, {}, 1.0)
    assert (started.state.kind, started.state.state) == ("codex", "idle")
    done = agent_hooks.apply(started.state, "codex", "agent-turn-complete", {}, 2.0).state
    # A start that arrives after the agent already reported keeps that state.
    assert agent_hooks.apply(done, "codex", agent_hooks.AGENT_START, {}, 3.0).state is done
    assert agent_hooks.apply(done, "codex", agent_hooks.AGENT_EXIT, {}, 4.0).state is None
    assert agent_hooks.parse_body(
        {"agent": "codex", "event": agent_hooks.AGENT_EXIT, "payload": {}}, None,
    )[1] == agent_hooks.AGENT_EXIT


async def test_a_remote_session_names_its_host(monkeypatch):
    _mgr, info, _pty = await spawn_agent(monkeypatch)
    assert info.host == "devbox"
