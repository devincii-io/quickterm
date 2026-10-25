"""Agent state from Claude Code and Codex hooks: the launch, the state, the route."""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from dataclasses import dataclass, field

import pytest
from fastapi.testclient import TestClient

import quickterm.session_manager as session_manager
from quickterm import agent_hooks, launch
from quickterm.agent_hooks import LATE_S, apply, describe, parse_body, seen
from quickterm.server import create_app
from quickterm.session_manager import SessionManager
from tests.test_server import FakeConfig, FakeSessionManager
from tests.test_session_manager import _RecordingPty

TOKEN = "s3cret"
BASE = "http://127.0.0.1:8620"


@pytest.fixture(autouse=True)
def usable_curl(monkeypatch):
    # Hermetic: the launch tests must not depend on this machine's curl.
    monkeypatch.setattr(agent_hooks, "curl_usable", lambda: True)


# --- state -------------------------------------------------------------------


def run(events, agent="claude", start=None, t0=100.0, step=5.0):
    """Fold (event, payload) pairs, LATE_S apart unless told otherwise."""
    state, now, outcome = start, t0, None
    for event, payload in events:
        outcome = apply(state, agent, event, payload, now)
        state = outcome.state
        now += step
    return state, outcome, now


def test_a_claude_turn_moves_through_working_waiting_and_done():
    state, outcome, now = run([
        ("SessionStart", {"source": "startup"}),
        ("UserPromptSubmit", {"prompt": "fix\nthe   build"}),
        ("PreToolUse", {"tool_name": "Bash"}),
    ])
    assert (state.state, state.prompt, state.tool) == ("working", "fix the build", "Bash")
    state, outcome, now = run([("PermissionRequest", {"tool_name": "Edit"})], start=state, t0=now)
    assert state.state == "waiting"
    assert outcome.waiting == "permission to use Edit"
    state, outcome, now = run([("PostToolUse", {"tool_name": "Edit"})], start=state, t0=now)
    assert (state.state, state.tool) == ("working", None)
    state, _, now = run([("Stop", {"last_assistant_message": "All green."})], start=state, t0=now)
    assert (state.state, state.message, state.prompt) == ("done", "All green.", "fix the build")
    assert seen(state, now).state == "idle"
    state, _, _ = run([("UserPromptSubmit", {"prompt": "next"})], start=state, t0=now)
    assert (state.prompt, state.message) == ("next", None)


def test_texts_are_cleaned_and_bounded():
    state, _, _ = run([("UserPromptSubmit", {"prompt": "x\x1b[31m" + "y" * 500})])
    assert len(state.prompt) <= 200 and "\x1b" not in state.prompt


def test_a_permission_notification_waits_and_an_idle_one_does_not():
    working, _, now = run([("UserPromptSubmit", {"prompt": "p"})])
    idle, outcome, _ = run(
        [("Notification", {"notification_type": "idle_prompt", "message": "waiting"})],
        start=working, t0=now,
    )
    assert idle is working and outcome.waiting is None
    waiting, outcome, _ = run(
        [("Notification", {"notification_type": "permission_prompt",
                           "message": "Claude needs your permission to use Bash"})],
        start=working, t0=now,
    )
    assert waiting.state == "waiting"
    assert outcome.waiting == "Claude needs your permission to use Bash"
    # A second notice while already waiting raises nothing new.
    _, again, _ = run([("PermissionRequest", {"tool_name": "Bash"})], start=waiting, t0=now + 5)
    assert again.waiting is None


def test_stop_failure_fails_with_the_error():
    state, _, _ = run([
        ("UserPromptSubmit", {"prompt": "p"}),
        ("StopFailure", {"error": "rate_limit", "last_assistant_message": "API Error: Rate limit"}),
    ])
    assert (state.state, state.message) == ("failed", "API Error: Rate limit")
    assert seen(state, 0).state == "idle"


def test_late_tool_events_do_not_undo_done_or_waiting():
    done, _, now = run([("UserPromptSubmit", {"prompt": "p"}), ("Stop", {})])
    late = apply(done, "claude", "PostToolUse", {"tool_name": "Bash"}, done.changed + LATE_S / 2)
    assert late.state is done
    later = apply(done, "claude", "PreToolUse", {"tool_name": "Bash"}, done.changed + LATE_S + 0.1)
    assert later.state.state == "working"
    waiting = apply(done, "claude", "PermissionRequest", {}, done.changed + 0.1)
    assert waiting.state is done


def test_subagents_come_and_go():
    state, _, now = run([
        ("UserPromptSubmit", {"prompt": "p"}),
        ("SubagentStart", {"agent_id": "a1", "agent_type": "Explore"}),
        ("SubagentStart", {"agent_id": "a2", "agent_type": None}),
        ("SubagentStart", {"agent_type": "no id"}),
    ])
    assert [s.id for s in state.subagents] == ["a1", "a2"]
    out = describe(state, now)
    assert out["subagents"][0] == {"id": "a1", "type": "Explore", "description": None,
                                   "age_seconds": int(now - state.subagents[0].started)}
    state, _, _ = run([("SubagentStop", {"agent_id": "a1"})], start=state, t0=now)
    assert [s.id for s in state.subagents] == ["a2"]


def test_a_compaction_mid_turn_keeps_the_state_and_a_new_session_resets_it():
    working, _, now = run([("UserPromptSubmit", {"prompt": "p"}), ("PreToolUse", {"tool_name": "Bash"})])
    assert apply(working, "claude", "SessionStart", {"source": "compact"}, now).state is working
    for source in ("startup", "resume", "clear", "fork"):
        fresh = apply(working, "claude", "SessionStart", {"source": source}, now).state
        assert (fresh.state, fresh.prompt) == ("idle", None)
    assert apply(None, "claude", "SessionStart", {"source": "compact"}, now).state.state == "idle"


def test_session_end_clears_and_unknown_events_change_nothing():
    state, _, now = run([("UserPromptSubmit", {"prompt": "p"})])
    assert apply(state, "claude", "PreCompact", {}, now).state is state
    assert apply(state, "claude", "SessionEnd", {}, now).state is None


def test_codex_turn_complete_is_done_with_its_message():
    state, _, _ = run([
        ("agent-turn-complete", {"type": "agent-turn-complete", "input-messages": ["a", "b"],
                                 "last-assistant-message": "hi"}),
    ], agent="codex")
    assert (state.kind, state.state, state.prompt, state.message) == ("codex", "done", "b", "hi")
    assert apply(state, "codex", "something-else", {}, 0).state is state


def test_describe_matches_the_contract():
    state, _, now = run([("UserPromptSubmit", {"prompt": "p"}), ("PreToolUse", {"tool_name": "Read"})])
    out = describe(state, now)
    assert set(out) == {"kind", "state", "prompt", "message", "tool", "subagents", "age_seconds"}
    assert out["tool"] == "Read" and out["kind"] == "claude"
    stopped, _, _ = run([("Stop", {})], start=state, t0=now)
    assert describe(stopped, now)["tool"] is None
    assert describe(None, now) is None


def test_parse_body_takes_the_envelope_or_raw_hook_json():
    assert parse_body({"agent": "claude", "event": "Stop", "payload": {"a": 1}}, None) == (
        "claude", "Stop", {"a": 1})
    raw = {"type": "agent-turn-complete", "last-assistant-message": "x"}
    assert parse_body(raw, "codex") == ("codex", "agent-turn-complete", raw)
    hook = {"hook_event_name": "Stop"}
    assert parse_body(hook, "claude") == ("claude", "Stop", hook)
    for bad, query in (
        ([], None), ({"agent": "bash", "event": "Stop"}, None), ({"agent": "claude"}, "x"),
        ({"agent": "claude", "event": "", "payload": {}}, None),
        ({"agent": "claude", "event": "Stop", "payload": []}, None), (raw, None),
    ):
        with pytest.raises(ValueError):
            parse_body(bad, query)


# --- launch ------------------------------------------------------------------


def test_files_are_static_and_hook_every_event(tmp_path):
    agent_hooks.ensure_files(tmp_path)
    settings = json.loads((tmp_path / "claude-settings.json").read_text(encoding="utf-8"))
    assert set(settings["hooks"]) == set(agent_hooks.CLAUDE_EVENTS)
    for event, entries in settings["hooks"].items():
        hook = entries[0]["hooks"][0]
        assert hook["type"] == "command" and hook["async"] is True
        assert f'-K "{(tmp_path / f"claude-{event}.curl").as_posix()}"' in hook["command"]
        config = (tmp_path / f"claude-{event}.curl").read_text(encoding="utf-8")
        assert f'\\"event\\":\\"{event}\\"' in config and "payload@-" in config
        assert "{{QUICKTERM_SESSION_ID:url}}" in config and "{{QUICKTERM_HOOK_TOKEN}}" in config
    codex = (tmp_path / "codex-notify.curl").read_text(encoding="utf-8")
    assert "agent-event?agent=codex" in codex and "expand-data" not in codex
    before = (tmp_path / "claude-settings.json").stat().st_mtime_ns
    agent_hooks.ensure_files(tmp_path)
    assert (tmp_path / "claude-settings.json").stat().st_mtime_ns == before


def test_claude_gets_the_settings_file(tmp_path):
    args = agent_hooks.launch_args("claude", "claude.exe", ["--continue"], None, tmp_path)
    assert args == ["--continue", f"--settings={(tmp_path / 'claude-settings.json').as_posix()}"]


def test_a_users_own_settings_are_merged_not_replaced(tmp_path):
    own = {"model": "opus", "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "mine"}]}]}}
    project = tmp_path / "proj"
    project.mkdir()
    (project / "my.json").write_text(json.dumps(own), encoding="utf-8")
    base = tmp_path / "hooks"
    for given in (["--settings=my.json"], ["--settings", "my.json"],
                  [f"--settings={json.dumps(own)}"]):
        args = agent_hooks.launch_args("claude", "claude.exe", ["--resume", *given, "--verbose"],
                                       str(project), base)
        assert args[:2] == ["--resume", "--verbose"] and len(args) == 3
        merged = json.loads(open(args[2].split("=", 1)[1], encoding="utf-8").read())
        assert merged["model"] == "opus"
        assert merged["hooks"]["Stop"][0]["hooks"][0]["command"] == "mine"
        assert len(merged["hooks"]["Stop"]) == 2
        assert set(merged["hooks"]) == set(agent_hooks.CLAUDE_EVENTS)


def test_unreadable_user_settings_and_agents_mode_stay_as_they_are(tmp_path):
    for args in (["--settings=missing.json"], ["--settings={not json"], ["agents", "--cwd", "x"]):
        assert agent_hooks.launch_args("claude", "claude.exe", args, str(tmp_path), tmp_path) == args


def test_codex_chains_the_users_own_notify(tmp_path, monkeypatch):
    home = tmp_path / "codex"
    home.mkdir()
    monkeypatch.setenv("CODEX_HOME", str(home))
    base = tmp_path / "hooks"
    (home / "config.toml").write_text('notify = ["C:/x/mine.exe", "turn-ended"]\n', encoding="utf-8")
    args = agent_hooks.launch_args("codex", "codex.exe", ["--cd", "x"], None, base)
    assert args[0] == "-c" and args[2:] == ["--cd", "x"]
    notify = json.loads(args[1].split("=", 1)[1])
    flag = notify.index("--codex-notify")
    assert notify[flag + 1:] == ["C:/x/mine.exe", "turn-ended"]
    assert notify[0] == sys.executable
    # A notify that is not a list of strings is left to Codex untouched.
    (home / "config.toml").write_text('notify = "mine.exe"\n', encoding="utf-8")
    assert agent_hooks.launch_args("codex", "codex.exe", ["--cd", "x"], None, base) == ["--cd", "x"]
    (home / "config.toml").write_text("notify = [\n", encoding="utf-8")
    assert agent_hooks.launch_args("codex", "codex.exe", ["--cd", "x"], None, base) == ["--cd", "x"]


def test_codex_notify_runs_theirs_then_reports(monkeypatch):
    from quickterm import codex_notify

    started, posted = [], []
    monkeypatch.setattr(codex_notify.subprocess, "Popen", lambda argv, **kw: started.append(argv))

    class Opener:
        def open(self, request, timeout):
            posted.append((request.full_url, request.get_header("X-quickterm-hook-token"), request.data))
            raise OSError("down")  # a QuickTerm that is gone must not fail the notifier

    monkeypatch.setattr(codex_notify.urllib.request, "build_opener", lambda *a: Opener())
    monkeypatch.setenv("QUICKTERM_SESSION_ID", "abc")
    monkeypatch.setenv("QUICKTERM_PORT", "8642")
    monkeypatch.setenv("QUICKTERM_HOOK_TOKEN", "tok")
    payload = '{"type":"agent-turn-complete"}'
    assert codex_notify.run(["mine.exe", "turn-ended", payload]) == 0
    assert started == [["mine.exe", "turn-ended", payload]]
    assert posted == [("http://127.0.0.1:8642/api/sessions/abc/agent-event?agent=codex", "tok", payload.encode())]
    monkeypatch.delenv("QUICKTERM_SESSION_ID")
    assert codex_notify.run([payload]) == 0
    assert len(posted) == 1 and len(started) == 1


def test_codex_gets_the_curl_notify_without_one_of_its_own(tmp_path, monkeypatch):
    home = tmp_path / "codex"
    home.mkdir()
    monkeypatch.setenv("CODEX_HOME", str(home))
    base = tmp_path / "hooks"
    args = agent_hooks.launch_args("codex", "codex.exe", ["resume", "--last"], None, base)
    assert args[0] == "-c" and args[2:] == ["resume", "--last"]
    key, value = args[1].split("=", 1)
    assert key == "notify"
    assert json.loads(value)[1:] == ["-K", (base / "codex-notify.curl").as_posix(), "--data-binary"]
    assert agent_hooks.launch_args("codex", "codex.cmd", ["--cd", "x"], None, base) == ["--cd", "x"]
    assert agent_hooks.launch_args("codex", "codex.exe", ["agents"], None, base) == ["agents"]


def test_merged_settings_files_do_not_pile_up(tmp_path):
    base = tmp_path / "hooks"
    last = None
    for n in range(agent_hooks.MERGED_KEEP + 4):
        last = agent_hooks.launch_args(
            "claude", "claude.exe", [f'--settings={{"env": {{"N": "{n}"}}}}'], None, base
        )
    kept = sorted(base.glob("claude-settings-*.json"))
    assert len(kept) == agent_hooks.MERGED_KEEP
    assert last[-1].split("=", 1)[1] in {p.as_posix() for p in kept}


def test_parallel_launches_all_get_hooks(tmp_path):
    # Several agent panes restoring at once build in worker threads that all
    # write the same files; none may lose its hooks to a collision.
    import threading

    base = tmp_path / "hooks"
    results: list[list[str]] = []

    def worker(n):
        for i in range(4):
            given = [f'--settings={{"env": {{"N": "{n % 2}"}}}}'] if i % 2 else ["--continue"]
            results.append(agent_hooks.launch_args("claude", "claude.exe", given, None, base))

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(results) == 32
    assert all(r[-1].startswith("--settings=") and "hooks" in r[-1] for r in results)
    assert not list(base.glob("*.tmp"))


def test_a_write_that_loses_a_race_accepts_the_same_text(tmp_path, monkeypatch):
    target = tmp_path / "f.curl"

    def racing_replace(src, dst):
        target.write_text("same", encoding="utf-8")
        raise PermissionError("in use")

    monkeypatch.setattr(agent_hooks.os, "replace", racing_replace)
    agent_hooks._write_if_changed(target, "same")
    with pytest.raises(PermissionError):
        agent_hooks._write_if_changed(target, "other")
    assert not list(tmp_path.glob("*.tmp"))


def test_a_bare_name_that_is_a_batch_shim_gets_the_cmd_guard(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_hooks.shutil, "which", lambda name: f"C:/npm/{name}.cmd")
    odd = tmp_path / "R&D"
    assert agent_hooks.launch_args("claude", "claude", [], None, odd) == []
    assert agent_hooks.launch_args("codex", "codex", ["--cd", "x"], None, tmp_path) == ["--cd", "x"]
    assert agent_hooks.launch_args("claude", "claude", [], None, tmp_path)[0].startswith("--settings=")


def test_an_old_or_missing_curl_turns_hooks_off(tmp_path, monkeypatch):
    monkeypatch.undo()  # the real curl_usable, over a fake curl
    calls = []

    def fake_run(argv, **kwargs):
        calls.append(argv)
        out = {"old": b"curl 7.79.1 (Windows) libcurl/7.79.1\r\n", "new": b"curl 8.13.0 (Windows)\r\n"}
        if argv[0] not in out:
            raise FileNotFoundError(argv[0])
        return subprocess.CompletedProcess(argv, 0, out[argv[0]], b"")

    monkeypatch.setattr(agent_hooks.subprocess, "run", fake_run)
    monkeypatch.setattr(agent_hooks, "_curl_checked", {})
    for program, usable in (("old", False), ("new", True), ("gone", False)):
        monkeypatch.setattr(agent_hooks, "curl_program", lambda p=program: p)
        assert agent_hooks.curl_usable() is usable
        result = agent_hooks.launch_args("claude", "claude.exe", [], None, tmp_path / program)
        assert bool(result) is usable
    assert len(calls) == 3  # asked once per program
    assert agent_hooks._parse_curl_version("curl 8.3.0 (x)") == (8, 3, 0)
    assert agent_hooks._parse_curl_version("nonsense") is None


def test_a_folder_a_shell_would_rewrite_gets_no_hooks(tmp_path):
    odd = tmp_path / "a$b"
    assert agent_hooks.launch_args("claude", "claude.exe", [], None, odd) == []
    assert not odd.exists()


@dataclass
class Prof:
    name: str
    cmd: str
    terminal_type: str
    args: list = field(default_factory=list)
    env: dict = field(default_factory=dict)
    agent: dict = field(default_factory=dict)
    agent_mode: str | None = "new"
    start_command: str | None = None


@dataclass
class Cfg:
    profiles: list


def test_resolve_marks_agent_launches_only(tmp_path):
    cfg = Cfg([Prof("c", "claude.exe", "claude-code"), Prof("x", "codex.exe", "codex"),
               Prof("sh", "cmd.exe", "command-prompt")])
    folder = str(tmp_path)
    assert launch.resolve(cfg, profile="c", request_cwd=folder).spawn_kwargs()["agent"] == "claude"
    assert launch.resolve(cfg, profile="x", request_cwd=folder).agent == "codex"
    assert launch.resolve(cfg, profile="c", cmd="other.exe", request_cwd=folder).agent is None
    assert launch.resolve(cfg, profile="c", args=[], request_cwd=folder).agent is None
    assert "agent" not in launch.resolve(cfg, profile="sh").spawn_kwargs()


# --- the session manager -------------------------------------------------------


@pytest.fixture
async def mgr(monkeypatch, tmp_path):
    monkeypatch.setattr(session_manager, "PtySession", _RecordingPty)
    monkeypatch.setattr(session_manager, "process_identities", lambda: [])
    monkeypatch.setattr(agent_hooks, "hooks_dir", lambda: tmp_path / "hooks")
    manager = SessionManager(asyncio.get_running_loop())
    yield manager
    manager._sessions.clear()


async def test_every_terminal_carries_the_hook_variables(mgr, tmp_path):
    plain = mgr.spawn(cmd="x.exe", agent="claude", cwd=str(tmp_path))
    assert _RecordingPty.last.args == []  # no hook target yet, so no hooks
    mgr.set_agent_hooks(8642, "hooktok")
    info = await mgr.spawn_async(cmd="x.exe", env={"QUICKTERM_SESSION_ID": "forged"})
    assert {k: v for k, v in _RecordingPty.last.env.items() if k.startswith("QUICKTERM_")} == {
        "QUICKTERM_SESSION_ID": info.id, "QUICKTERM_PORT": "8642", "QUICKTERM_HOOK_TOKEN": "hooktok",
    }
    assert _RecordingPty.last.args == [] and plain.id != info.id
    mgr.spawn(cmd="claude.exe", args=["--continue"], agent="claude", cwd=str(tmp_path))
    settings = (tmp_path / "hooks" / "claude-settings.json").as_posix()
    assert _RecordingPty.last.args == ["--continue", f"--settings={settings}"]


async def test_waiting_raises_notify_attention_only_when_nothing_else_did(mgr):
    info = mgr.spawn(cmd="claude.exe")
    pty = _RecordingPty.last
    mgr.agent_event(info.id, "claude", "UserPromptSubmit", {"prompt": "p"})
    assert mgr.session_attention(info.id) is None
    mgr.agent_event(info.id, "claude", "PermissionRequest", {"tool_name": "Bash"})
    assert mgr.session_attention(info.id)["kind"] == "notify"
    assert mgr.session_attention(info.id)["text"] == "permission to use Bash"
    assert mgr.session_agent(info.id)["state"] == "waiting"
    mgr.touch(info.id)  # typing answers the attention, never the agent state
    assert mgr.session_agent(info.id)["state"] == "waiting"
    pty.on_output(b"\x07")
    mgr.agent_event(info.id, "claude", "PostToolUse", {})  # late: dropped
    mgr.agent_event(info.id, "claude", "Notification", {"notification_type": "permission_prompt"})
    assert mgr.session_attention(info.id)["kind"] == "bell"


async def test_seen_turns_done_into_idle_and_exit_clears_the_agent(mgr):
    info = mgr.spawn(cmd="claude.exe")
    pty = _RecordingPty.last
    mgr.agent_event(info.id, "claude", "Stop", {"last_assistant_message": "ok"})
    assert mgr.session_agent(info.id)["state"] == "done"
    mgr.mark_seen(info.id)
    assert mgr.session_agent(info.id)["state"] == "idle"
    with pytest.raises(KeyError):
        mgr.agent_event("nope", "claude", "Stop", {})
    pty.on_exit(0)
    assert mgr.session_agent(info.id) is None
    mgr.agent_event(info.id, "claude", "UserPromptSubmit", {"prompt": "late"})
    assert mgr.session_agent(info.id) is None
    assert mgr.session_agent("nope") is None


# --- the route -------------------------------------------------------------------


@pytest.fixture
def hooked():
    manager = FakeSessionManager()
    app = create_app(manager, FakeConfig(), TOKEN)
    ctx = next(m.kwargs["ctx"] for m in app.user_middleware if "ctx" in m.kwargs)
    with TestClient(app, base_url=BASE) as client:
        client.headers["X-QuickTerm-Hook-Token"] = ctx.hook_token
        yield client, manager, ctx


def test_create_app_hands_the_hook_target_to_the_manager(hooked):
    _, manager, ctx = hooked
    assert manager.hook_env == {"port": 8620, "token": ctx.hook_token}
    assert ctx.hook_token != TOKEN


def test_no_hooks_for_an_elevated_backend_or_one_not_on_loopback_v4():
    for kwargs, cfg in (({"elevated": True}, FakeConfig()), ({}, FakeConfig(host="::1"))):
        manager = FakeSessionManager()
        create_app(manager, cfg, TOKEN, **kwargs)
        assert not hasattr(manager, "hook_env")
    manager = FakeSessionManager()
    create_app(manager, FakeConfig(host="0.0.0.0"), TOKEN)
    assert manager.hook_env["port"] == 8620


def test_the_route_records_an_envelope_and_raw_codex_json(hooked):
    client, manager, _ = hooked
    info = manager.add_session()
    url = f"/api/sessions/{info.id}/agent-event"
    body = {"agent": "claude", "event": "Stop", "payload": {"last_assistant_message": "x"}}
    assert client.post(url, json=body).status_code == 204
    raw = {"type": "agent-turn-complete", "last-assistant-message": "y"}
    assert client.post(url + "?agent=codex", json=raw).status_code == 204
    assert manager.agent_events == [
        (info.id, "claude", "Stop", body["payload"]),
        (info.id, "codex", "agent-turn-complete", raw),
    ]


def test_the_route_refuses_bad_bodies_and_unknown_sessions(hooked):
    client, manager, _ = hooked
    info = manager.add_session()
    url = f"/api/sessions/{info.id}/agent-event"
    assert client.post(url, content=b"{nope").status_code == 400
    assert client.post(url, content=b"\xff\xfe").status_code == 400
    assert client.post(url, json={"agent": "vim", "event": "x"}).status_code == 400
    big = {"agent": "claude", "event": "PostToolUse", "payload": {"x": "a" * (256 * 1024)}}
    assert client.post(url, json=big).status_code == 400
    assert client.post("/api/sessions/nope/agent-event",
                       json={"agent": "claude", "event": "Stop"}).status_code == 404
    assert not hasattr(manager, "agent_events")


def test_the_list_carries_the_agent_field(hooked):
    client, manager, _ = hooked
    info = manager.add_session()
    other = manager.add_session()
    manager.agents = {info.id: {"kind": "claude", "state": "working"}}
    client.headers["X-QuickTerm-Token"] = TOKEN
    items = {item["id"]: item for item in client.get("/api/sessions").json()}
    assert items[info.id]["agent"] == {"kind": "claude", "state": "working"}
    assert items[other.id]["agent"] is None
