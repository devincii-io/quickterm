"""Agent usage: Claude's limits from the status line chain, Codex's from rollouts."""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from quickterm import agent_hooks, statusline_chain, usage
from quickterm.server import create_app
from tests.test_server import FakeConfig, FakeSessionManager

TOKEN = "s3cret"
BASE = "http://127.0.0.1:8620"

LIMITS = {
    "five_hour": {"used_percentage": 32.5, "resets_at": 1795459716},
    "seven_day": {"used_percentage": 12, "resets_at": 1795900000},
}


# --- Claude's store -----------------------------------------------------------


def test_claude_limits_keep_the_latest_windows():
    store = usage.ClaudeLimits(clock=lambda: 1000.4)
    assert store.snapshot() is None
    assert store.record(LIMITS)
    assert store.snapshot() == {
        "windows": [
            {"id": "five_hour", "used_percent": 32.5, "resets_at": 1795459716},
            {"id": "seven_day", "used_percent": 12.0, "resets_at": 1795900000},
        ],
        "updated_at": 1000,
    }


def test_claude_limits_ignore_what_holds_no_window():
    store = usage.ClaudeLimits(clock=lambda: 5.0)
    store.record({"five_hour": {"used_percentage": 3, "resets_at": "2026-10-25T12:00:00Z"}})
    before = store.snapshot()
    assert before["windows"] == [{"id": "five_hour", "used_percent": 3.0, "resets_at": 1792929600}]
    for junk in (None, [], {}, {"five_hour": {"used_percentage": True}},
                 {"seven_day": {"used_percentage": "12"}}, {"other": {"used_percentage": 1}}):
        assert not store.record(junk)
    assert store.snapshot() == before


def test_a_window_without_a_reset_time_keeps_null():
    store = usage.ClaudeLimits()
    store.record({"seven_day": {"used_percentage": 7, "resets_at": "soon"}})
    assert store.snapshot()["windows"] == [{"id": "seven_day", "used_percent": 7.0, "resets_at": None}]


def test_claude_limits_survive_a_restart_in_their_file(tmp_path):
    path = tmp_path / "claude-usage.json"
    store = usage.ClaudeLimits(clock=lambda: 1000.0)
    store.attach_file(path)
    assert store.snapshot() is None and not store.needs_save()
    assert store.record(LIMITS) and store.needs_save()
    store.save()
    assert not store.needs_save()
    again = usage.ClaudeLimits(clock=lambda: 2000.0)
    again.attach_file(path)
    assert again.snapshot() == store.snapshot()
    assert not again.needs_save(), "loading is no change"


def test_an_unchanged_report_never_writes(tmp_path):
    path = tmp_path / "claude-usage.json"
    now = [1000.0]
    store = usage.ClaudeLimits(clock=lambda: now[0])
    store.attach_file(path)
    store.record(LIMITS)
    store.save()
    marker = path.read_text(encoding="utf-8")
    now[0] = 1060.0
    store.record(LIMITS)
    assert not store.needs_save()
    store.save()
    assert path.read_text(encoding="utf-8") == marker, "the file keeps updated_at 1000"
    assert store.snapshot()["updated_at"] == 1060, "memory still has the latest report"
    moved = {**LIMITS, "five_hour": {"used_percentage": 33, "resets_at": 1795459716}}
    store.record(moved)
    assert store.needs_save()
    reset = {**LIMITS, "seven_day": {"used_percentage": 12, "resets_at": 1795900001}}
    store.record(reset)
    assert store.needs_save(), "a new reset time counts as a change"


def test_without_a_file_nothing_is_saved(tmp_path):
    store = usage.ClaudeLimits()
    store.record(LIMITS)
    assert not store.needs_save()
    store.save()
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("text", [
    "", "not json", "[]", '{"windows": []}', '{"windows": [{"id": "x", "used_percent": 1}]}',
    '{"windows": [{"id": "five_hour", "used_percent": "1"}], "updated_at": 5}',
    '{"windows": [{"id": "five_hour", "used_percent": 1, "resets_at": 0}], "updated_at": 5}',
    '{"windows": [{"id": "five_hour", "used_percent": 1}]}',
])
def test_a_broken_file_starts_empty(tmp_path, text):
    path = tmp_path / "claude-usage.json"
    path.write_text(text, encoding="utf-8")
    store = usage.ClaudeLimits()
    store.attach_file(path)
    assert store.snapshot() is None
    store.record(LIMITS)
    assert store.needs_save()
    store.save()
    assert json.loads(path.read_text(encoding="utf-8"))["windows"][1]["id"] == "seven_day"


def test_the_usage_file_lives_in_the_config_folder(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    assert usage.claude_usage_file() == tmp_path / "quickterm" / "claude-usage.json"


# --- Codex's rollouts ---------------------------------------------------------


def _token_count(primary, secondary=None, plan="go", ts="2026-10-24T18:48:37.568Z"):
    return json.dumps({
        "timestamp": ts,
        "type": "event_msg",
        "payload": {
            "type": "token_count",
            "info": {"total_token_usage": {"input_tokens": 19550}},
            "rate_limits": {
                "limit_id": "codex", "limit_name": None, "primary": primary,
                "secondary": secondary, "credits": {"has_credits": False},
                "plan_type": plan, "rate_limit_reached_type": None,
            },
        },
    })


def _rollout(root: Path, day: str, name: str, lines: list[str], mtime: int) -> Path:
    folder = root / "sessions" / day
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"rollout-{name}.jsonl"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.utime(path, (mtime, mtime))
    return path


PRIMARY = {"used_percent": 0.0, "window_minutes": 43200, "resets_at": 1795459716}


def test_codex_reads_the_last_token_count_of_the_newest_rollout(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    _rollout(tmp_path, "2026/10/23", "old", [_token_count({**PRIMARY, "used_percent": 90})], 100)
    _rollout(tmp_path, "2026/10/24", "new", [
        _token_count({**PRIMARY, "used_percent": 1}),
        json.dumps({"type": "event_msg", "payload": {"type": "agent_message", "message": "hi"}}),
        _token_count(PRIMARY, {"used_percent": 4.5, "window_minutes": 300, "resets_at": 1795000000}),
        json.dumps({"type": "response_item", "payload": {"type": "message"}}),
    ], 200)
    assert usage.CodexReader().read() == {
        "windows": [
            {"id": "primary", "used_percent": 0.0, "window_minutes": 43200, "resets_at": 1795459716},
            {"id": "secondary", "used_percent": 4.5, "window_minutes": 300, "resets_at": 1795000000},
        ],
        "plan": "go",
        "updated_at": 1792867717,
    }


def test_codex_falls_back_to_an_older_rollout_and_handles_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    reader = usage.CodexReader()
    assert reader.read() is None
    _rollout(tmp_path, "2026/10/23", "old", [_token_count(PRIMARY)], 100)
    # A session that has not reported limits yet, and a null rate_limits.
    _rollout(tmp_path, "2026/10/24", "fresh", [
        json.dumps({"type": "event_msg", "payload": {"type": "token_count", "rate_limits": None}}),
    ], 200)
    assert reader.read()["windows"][0]["window_minutes"] == 43200


def test_codex_reads_only_the_tail_and_skips_the_cut_line(tmp_path):
    path = tmp_path / "rollout-x.jsonl"
    filler = json.dumps({"type": "response_item", "payload": {"text": "x" * 1000}})
    path.write_text(
        _token_count({**PRIMARY, "used_percent": 50}) + "\n" + "\n".join([filler] * 300) + "\n",
        encoding="utf-8",
    )
    assert path.stat().st_size > usage.CODEX_TAIL_BYTES
    assert usage.read_rollout_tail(path) is None
    assert usage.read_rollout_tail(path, tail=path.stat().st_size)["windows"][0]["used_percent"] == 50


def test_codex_reset_countdown_from_older_builds(tmp_path):
    line = _token_count({"used_percent": 3, "window_minutes": 300, "resets_in_seconds": 600},
                        ts="2026-10-24T18:00:00Z")
    found = usage.parse_rollout_line(line.encode(), 0)
    assert found["windows"][0]["resets_at"] == 1792864800 + 600


def test_codex_answers_are_cached_by_path_and_mtime(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    path = _rollout(tmp_path, "2026/10/24", "a", [_token_count(PRIMARY)], 200)
    reads = []
    real = usage.read_rollout_tail
    monkeypatch.setattr(usage, "read_rollout_tail", lambda p: reads.append(p) or real(p))
    reader = usage.CodexReader()
    reader.read()
    reader.read()
    assert reads == [path]
    path.write_text(_token_count({**PRIMARY, "used_percent": 9}) + "\n", encoding="utf-8")
    os.utime(path, (300, 300))
    assert reader.read()["windows"][0]["used_percent"] == 9
    assert len(reads) == 2


# --- the status line chain ----------------------------------------------------


@pytest.fixture
def claude_home(tmp_path, monkeypatch):
    home = tmp_path / "claude"
    home.mkdir()
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(home))
    monkeypatch.delenv(statusline_chain.GUARD_ENV, raising=False)
    return home


def _settings(folder: Path, name: str, command: str | None) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    body = {"model": "x"} if command is None else {"statusLine": {"type": "command", "command": command}}
    (folder / name).write_text(json.dumps(body), encoding="utf-8")


def test_the_users_command_comes_from_user_then_project_then_local(claude_home, tmp_path):
    project = tmp_path / "proj"
    status = {"workspace": {"project_dir": str(project)}, "cwd": str(tmp_path)}
    assert statusline_chain.user_command(status) is None
    _settings(claude_home, "settings.json", "user-line")
    assert statusline_chain.user_command(status) == "user-line"
    _settings(project / ".claude", "settings.json", "project-line")
    assert statusline_chain.user_command(status) == "project-line"
    _settings(project / ".claude", "settings.local.json", None)
    assert statusline_chain.user_command(status) == "project-line"
    _settings(project / ".claude", "settings.local.json", "local-line")
    assert statusline_chain.user_command(status) == "local-line"


def test_quickterms_own_command_is_never_run_again(claude_home, tmp_path):
    own = agent_hooks.statusline_command()
    assert own and statusline_chain.is_own_command(own)
    _settings(claude_home, "settings.json", own)
    assert statusline_chain.user_command({"cwd": str(tmp_path)}) is None
    _settings(claude_home, "settings.json", '"C:/Program Files/QuickTerm/QuickTerm.exe" --statusline')
    assert statusline_chain.user_command({"cwd": str(tmp_path)}) is None
    # The flag alone is somebody else's program.
    _settings(claude_home, "settings.json", "mytool --statusline")
    assert statusline_chain.user_command({"cwd": str(tmp_path)}) == "mytool --statusline"


def _run_chain(monkeypatch, stdin: bytes):
    out = io.BytesIO()
    monkeypatch.setattr(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(stdin)))
    monkeypatch.setattr(sys, "stdout", SimpleNamespace(buffer=out, flush=lambda: None))
    assert statusline_chain.run([]) == 0
    return out.getvalue()


def test_the_chain_reports_and_passes_the_users_output_through(claude_home, tmp_path, monkeypatch):
    _settings(claude_home, "settings.json", "theirs")
    posted, ran = [], []
    monkeypatch.setattr(statusline_chain, "report", posted.append)

    def fake_user(command, data):
        ran.append((command, data))
        return b"\x1b[36mmodel\x1b[0m \xe2\x97\x8f 5h 32%\n"

    monkeypatch.setattr(statusline_chain, "run_user", fake_user)
    stdin = json.dumps({"cwd": str(tmp_path), "rate_limits": LIMITS}).encode()
    assert _run_chain(monkeypatch, stdin) == b"\x1b[36mmodel\x1b[0m \xe2\x97\x8f 5h 32%\n"
    assert ran == [("theirs", stdin)]
    assert posted == [LIMITS]


def test_the_chain_prints_nothing_without_a_status_line_and_survives_junk(claude_home, monkeypatch):
    posted = []
    monkeypatch.setattr(statusline_chain, "report", posted.append)
    monkeypatch.setattr(statusline_chain, "run_user", lambda *a: pytest.fail("ran a command"))
    assert _run_chain(monkeypatch, b"not json") == b""
    assert posted == [None]


def test_the_chain_stops_inside_its_own_child(claude_home, monkeypatch):
    monkeypatch.setenv(statusline_chain.GUARD_ENV, "1")
    monkeypatch.setattr(statusline_chain, "report", lambda *_: pytest.fail("reported"))
    assert _run_chain(monkeypatch, json.dumps({"rate_limits": LIMITS}).encode()) == b""


def test_run_user_feeds_stdin_and_marks_the_child(tmp_path):
    script = tmp_path / "echo_status.py"
    script.write_text(
        "import os, sys\n"
        "data = sys.stdin.buffer.read()\n"
        f"sys.stdout.buffer.write(data[::-1] + os.environ.get({statusline_chain.GUARD_ENV!r}, '').encode())\n",
        encoding="utf-8",
    )
    command = f'"{Path(sys.executable).as_posix()}" "{script.as_posix()}"'
    assert statusline_chain.run_user(command, b"abc") == b"cba1"
    assert statusline_chain.run_user('"/no/such/program-xyz"', b"abc") == b""


def test_report_posts_the_event_with_the_hook_token(monkeypatch):
    sent = []

    class Opener:
        def open(self, request, timeout):
            sent.append((request, timeout))
            return SimpleNamespace(close=lambda: None)

    monkeypatch.setattr(statusline_chain.urllib.request, "build_opener", lambda *a: Opener())
    monkeypatch.setenv("QUICKTERM_SESSION_ID", "s 1")
    monkeypatch.setenv("QUICKTERM_PORT", "8701")
    monkeypatch.setenv("QUICKTERM_HOOK_TOKEN", "hook")
    statusline_chain.report(LIMITS)
    statusline_chain.report(None)
    [(request, timeout)] = sent
    assert request.full_url == "http://127.0.0.1:8701/api/sessions/s%201/agent-event?agent=claude"
    assert request.get_header("X-quickterm-hook-token") == "hook"
    assert json.loads(request.data) == {"hook_event_name": "QuickTermRateLimits", "rate_limits": LIMITS}
    assert timeout == statusline_chain.POST_TIMEOUT_S
    monkeypatch.delenv("QUICKTERM_SESSION_ID")
    statusline_chain.report(LIMITS)
    assert len(sent) == 1


def test_main_dispatches_the_flag(monkeypatch):
    from quickterm import app

    seen = []
    monkeypatch.setattr(sys, "argv", ["QuickTerm", "--statusline", "x"])
    monkeypatch.setattr(statusline_chain, "run", lambda argv: seen.append(argv) or 0)
    with pytest.raises(SystemExit) as exit_info:
        app.main()
    assert exit_info.value.code == 0 and seen == [["x"]]


@pytest.mark.skipif(os.name != "nt", reason="the Windows command line as Claude runs it")
def test_the_command_runs_the_chain_end_to_end(claude_home, tmp_path):
    """The command QuickTerm injects really runs the chain and the user's line."""
    script = tmp_path / "mine.py"
    script.write_text("import sys; sys.stdin.read(); print('MINE')\n", encoding="utf-8")
    _settings(claude_home, "settings.json", f'"{Path(sys.executable).as_posix()}" "{script.as_posix()}"')
    env = {**os.environ, "PYTHONPATH": os.pathsep.join(sys.path)}
    env.pop("QUICKTERM_SESSION_ID", None)
    done = subprocess.run(
        agent_hooks.statusline_command(), input=json.dumps({"cwd": str(tmp_path)}).encode(),
        capture_output=True, env=env, timeout=30, check=False, cwd=tmp_path,
    )
    assert done.returncode == 0
    assert done.stdout.strip() == b"MINE"


# --- the launch -----------------------------------------------------------------


@pytest.fixture
def usable_curl(monkeypatch):
    monkeypatch.setattr(agent_hooks, "curl_usable", lambda: True)


def test_claude_launches_get_the_status_line(tmp_path, usable_curl):
    args = agent_hooks.launch_args("claude", "claude.exe", [], None, tmp_path)
    settings = json.loads(Path(args[-1].split("=", 1)[1]).read_text(encoding="utf-8"))
    assert settings["statusLine"] == {"type": "command", "command": agent_hooks.statusline_command()}
    assert "--statusline" in settings["statusLine"]["command"]


def test_a_users_own_settings_status_line_is_kept(tmp_path, usable_curl):
    own = {"statusLine": {"type": "command", "command": "mine"}}
    args = agent_hooks.launch_args("claude", "claude.exe", [f"--settings={json.dumps(own)}"],
                                   str(tmp_path), tmp_path / "hooks")
    merged = json.loads(Path(args[-1].split("=", 1)[1]).read_text(encoding="utf-8"))
    assert merged["statusLine"] == own["statusLine"]
    plain = json.dumps({"model": "opus"})
    args = agent_hooks.launch_args("claude", "claude.exe", [f"--settings={plain}"],
                                   str(tmp_path), tmp_path / "hooks")
    merged = json.loads(Path(args[-1].split("=", 1)[1]).read_text(encoding="utf-8"))
    assert "--statusline" in merged["statusLine"]["command"]


def test_no_status_line_without_hooks(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_hooks, "curl_usable", lambda: False)
    assert agent_hooks.launch_args("claude", "claude.exe", ["--continue"], None, tmp_path) == ["--continue"]


def test_an_unsafe_program_path_gets_no_status_line(monkeypatch):
    monkeypatch.setattr(sys, "executable", "C:/a%b/python.exe")
    assert agent_hooks.statusline_command() is None
    settings = {}
    agent_hooks._add_status_line(settings)
    assert settings == {}


# --- the routes -----------------------------------------------------------------


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    manager = FakeSessionManager()
    app = create_app(manager, FakeConfig(), TOKEN)
    ctx = next(m.kwargs["ctx"] for m in app.user_middleware if "ctx" in m.kwargs)
    with TestClient(app, base_url=BASE) as test_client:
        yield test_client, manager, ctx, tmp_path / "codex"


def test_the_event_stores_numbers_and_never_touches_agent_state(client):
    test_client, manager, ctx, _ = client
    info = manager.add_session()
    url = f"/api/sessions/{info.id}/agent-event?agent=claude"
    hook = {"X-QuickTerm-Hook-Token": ctx.hook_token}
    body = {"hook_event_name": "QuickTermRateLimits", "rate_limits": LIMITS}
    assert test_client.post(url, json=body, headers=hook).status_code == 204
    assert not hasattr(manager, "agent_events")
    assert test_client.post("/api/sessions/nope/agent-event?agent=claude", json=body,
                            headers=hook).status_code == 404
    # The hook token opens the event, not the usage route.
    assert test_client.get("/api/usage", headers=hook).status_code == 403
    answer = test_client.get("/api/usage", headers={"X-QuickTerm-Token": TOKEN}).json()
    assert [w["id"] for w in answer["claude"]["windows"]] == ["five_hour", "seven_day"]
    assert answer["claude"]["windows"][0]["used_percent"] == 32.5
    assert answer["codex"] is None


def test_a_reported_change_is_stored_off_the_loop(client):
    test_client, manager, ctx, tmp_path = client
    from quickterm.api import usage as api_usage

    stored = tmp_path / "claude-usage.json"
    api_usage.claude_limits(test_client.app).attach_file(stored)
    info = manager.add_session()
    url = f"/api/sessions/{info.id}/agent-event?agent=claude"
    hook = {"X-QuickTerm-Hook-Token": ctx.hook_token}
    body = {"hook_event_name": "QuickTermRateLimits", "rate_limits": LIMITS}
    assert test_client.post(url, json=body, headers=hook).status_code == 204
    assert json.loads(stored.read_text(encoding="utf-8"))["windows"][0]["used_percent"] == 32.5


def test_usage_reports_codex_and_null_claude(client):
    test_client, _, _, codex = client
    _rollout(codex, "2026/10/24", "a", [_token_count(PRIMARY)], 200)
    answer = test_client.get("/api/usage", headers={"X-QuickTerm-Token": TOKEN}).json()
    assert answer["claude"] is None
    assert answer["codex"]["plan"] == "go"
    assert answer["codex"]["windows"] == [
        {"id": "primary", "used_percent": 0.0, "window_minutes": 43200, "resets_at": 1795459716}
    ]


def test_the_frozen_entry_answers_the_chains_before_its_heavy_imports():
    # app.py is the frozen build's entry script; Claude runs the status line on
    # every update, so the chain must not wait for uvicorn and the server.
    source = (Path(__file__).resolve().parents[1] / "quickterm" / "app.py").read_text(encoding="utf-8")
    early = source.index('sys.argv[1:2] in (["--statusline"], ["--codex-notify"])')
    assert early < source.index("import asyncio")
    assert early < source.index("from uvicorn")


def test_the_entry_script_runs_the_chain_without_loading_the_app():
    root = Path(__file__).resolve().parents[1]
    probe = (
        "import runpy, sys; sys.argv = ['app.py', '--statusline'];"
        "\ntry:\n    runpy.run_path(r'%s', run_name='__main__')\n"
        "except SystemExit as exc:\n    print(exc.code, 'uvicorn' in sys.modules)\n"
    ) % (root / "quickterm" / "app.py")
    env = {**os.environ, "QUICKTERM_STATUSLINE_CHAIN": "1", "PYTHONPATH": os.pathsep.join(sys.path)}
    done = subprocess.run(
        [sys.executable, "-c", probe], input="{}", capture_output=True, text=True, env=env, timeout=30,
    )
    assert done.stdout.split() == ["0", "False"], done.stderr
