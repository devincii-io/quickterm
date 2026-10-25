"""What the board's Agents tab is built from: the last prompt and answer, the
time of the last event, the column rules, and the conversation's title."""

from __future__ import annotations

import asyncio
import json
import time

import pytest
from fastapi.testclient import TestClient

import quickterm.session_manager as session_manager
from quickterm import agent_hooks, agent_sessions
from quickterm.agent_hooks import (
    IDLE_AFTER_S,
    LAST_TEXT_LIMIT,
    apply,
    board_column,
    describe,
    seen,
    transcript_answer,
    turn_details,
)
from quickterm.server import create_app
from quickterm.session_manager import SessionManager
from tests.test_server import FakeConfig
from tests.test_session_manager import _RecordingPty

BASE = "http://127.0.0.1:8620"
CLAUDE_ID = "3f2c1d7e-9a8b-4c6d-8e7f-0a1b2c3d4e5f"
CODEX_ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"


def fold(events, agent="claude", start=None, t0=100.0, step=5.0):
    state, now = start, t0
    for event, payload in events:
        state = apply(state, agent, event, payload, now).state
        now += step
    return state, now - step


# --- what is stored ----------------------------------------------------------------


def test_claude_stores_the_prompt_the_answer_and_the_event_time():
    state, now = fold([
        ("SessionStart", {"source": "startup", "session_id": CLAUDE_ID, "cwd": r"C:\work\repo"}),
        ("UserPromptSubmit", {"prompt": "fix\n the   build"}),
        ("PreToolUse", {"tool_name": "Bash"}),
        ("Stop", {"last_assistant_message": "Done.\nAll tests pass."}),
    ])
    assert (state.last_prompt, state.last_answer) == ("fix the build", "Done. All tests pass.")
    assert state.last_event == now
    assert (state.conversation, state.cwd) == (CLAUDE_ID, r"C:\work\repo")
    # A new prompt starts a new turn: the old answer no longer belongs to it.
    state, _ = fold([("UserPromptSubmit", {"prompt": "next"})], start=state, t0=now + 5)
    assert (state.last_prompt, state.last_answer) == ("next", None)


def test_codex_stores_the_last_input_and_the_answer():
    state, now = fold([
        ("agent-turn-complete", {"type": "agent-turn-complete", "thread-id": CODEX_ID,
                                 "cwd": "/home/me/repo", "input-messages": ["first", "second"],
                                 "last-assistant-message": "Renamed it."}),
    ], agent="codex")
    assert (state.last_prompt, state.last_answer, state.last_event) == ("second", "Renamed it.", now)
    assert (state.conversation, state.cwd) == (CODEX_ID, "/home/me/repo")


def test_prompt_and_answer_keep_their_first_300_characters():
    long = "word " * 200
    state, _ = fold([("UserPromptSubmit", {"prompt": long}), ("Stop", {"last_assistant_message": long})])
    assert len(state.last_prompt) <= LAST_TEXT_LIMIT and len(state.last_answer) <= LAST_TEXT_LIMIT
    assert state.last_prompt == long[:LAST_TEXT_LIMIT].strip()
    # The sidebar tooltip keeps its own, shorter cut.
    assert len(state.prompt) <= agent_hooks.TEXT_LIMIT
    codex, _ = fold([("agent-turn-complete", {"input-messages": ["x" * 1000],
                                              "last-assistant-message": "\x1b[31m" + "y" * 1000})],
                    agent="codex")
    assert codex.last_prompt == "x" * LAST_TEXT_LIMIT
    assert "\x1b" not in codex.last_answer and len(codex.last_answer) <= LAST_TEXT_LIMIT


def test_an_id_that_could_not_be_a_conversation_is_not_kept():
    state, _ = fold([("SessionStart", {"session_id": "x; rm -rf ~", "cwd": "C:\\a\nb"})])
    assert (state.conversation, state.cwd) == (None, None)


def test_describe_reports_the_event_time_in_utc():
    state, now = fold([("UserPromptSubmit", {"prompt": "p"})])
    out = describe(state, now + 90, wall=1_800_000_090.0)
    assert out["last_event_at"] == "2027-01-15T08:00:00Z"
    assert out["event_age_seconds"] == 90
    assert (out["last_prompt"], out["board"]) == ("p", "working")


# --- the columns ----------------------------------------------------------------


def test_columns_follow_the_turn():
    fresh, now = fold([("SessionStart", {"source": "startup"})])
    assert board_column(fresh, now) == "idle"
    working, now = fold([("UserPromptSubmit", {"prompt": "p"})], start=fresh, t0=now + 5)
    assert board_column(working, now) == "working"
    waiting, now = fold([("PermissionRequest", {"tool_name": "Bash"})], start=working, t0=now + 5)
    assert board_column(waiting, now) == "needs-you"
    done, now = fold([("PostToolUse", {}), ("Stop", {})], start=waiting, t0=now + 5)
    assert board_column(done, now) == "done"
    # Looking at it does not move it to Idle: it finished a turn a moment ago.
    assert board_column(seen(done, now), now) == "done"
    assert board_column(None, now) is None


def test_thirty_quiet_minutes_make_an_agent_idle_unless_it_waits():
    working, now = fold([("UserPromptSubmit", {"prompt": "p"})])
    assert board_column(working, now + IDLE_AFTER_S - 1) == "working"
    assert board_column(working, now + IDLE_AFTER_S) == "idle"
    done, now = fold([("Stop", {})], start=working, t0=now + 5)
    assert board_column(done, now + IDLE_AFTER_S) == "idle"
    waiting, now = fold([("PermissionRequest", {})], start=working, t0=now + 5)
    assert board_column(waiting, now + 10 * IDLE_AFTER_S) == "needs-you"


def test_a_parent_whose_subagent_waits_for_permission_needs_you():
    state, now = fold([
        ("UserPromptSubmit", {"prompt": "p"}),
        ("SubagentStart", {"agent_id": "a1", "agent_type": "Explore"}),
        ("SubagentStart", {"agent_id": "a2", "agent_type": "Plan"}),
        ("PermissionRequest", {"agent_id": "a1", "tool_name": "Bash"}),
        # Its sibling keeps working, which moves the state back to working.
        ("PreToolUse", {"agent_id": "a2", "tool_name": "Read"}),
    ])
    assert state.state == "working"
    assert [s.waiting for s in state.subagents] == [True, False]
    assert board_column(state, now) == "needs-you"
    assert board_column(state, now + 10 * IDLE_AFTER_S) == "needs-you"
    assert describe(state, now)["subagents"][0]["waiting"] is True
    # The subagent got its answer: its next tool call says so.
    state, now = fold([("PostToolUse", {"agent_id": "a1", "tool_name": "Bash"})], start=state, t0=now + 5)
    assert board_column(state, now) == "working"
    waiting, now = fold([("PermissionRequest", {"agent_id": "a2"})], start=state, t0=now + 5)
    stopped, now = fold([("SubagentStop", {"agent_id": "a2"})], start=waiting, t0=now + 5)
    assert not any(s.waiting for s in stopped.subagents)


def test_an_idle_notification_is_no_event():
    working, now = fold([("UserPromptSubmit", {"prompt": "p"})])
    later = apply(working, "claude", "Notification", {"notification_type": "idle_prompt"}, now + 60)
    assert later.state is working


# --- the transcript --------------------------------------------------------------


@pytest.fixture
def projects(tmp_path, monkeypatch):
    """Claude's own projects folder, the only place a transcript is read from."""
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude"))
    folder = tmp_path / "claude" / "projects" / "C--work-repo"
    folder.mkdir(parents=True)
    return folder


def _line(record) -> str:
    return json.dumps(record) + "\n"


def _assistant(text):
    return {"type": "assistant", "message": {"role": "assistant",
                                             "content": [{"type": "text", "text": text}]}}


def test_the_answer_comes_from_the_end_of_the_transcript(projects):
    path = projects / f"{CLAUDE_ID}.jsonl"
    with path.open("w", encoding="utf-8") as handle:
        handle.write(_line(_assistant("an old answer")))
        handle.write(_line({"type": "user", "message": {"content": "next"}}))
        handle.write(_line(_assistant("The newest answer.")))
        handle.write(_line({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Bash", "input": {}}]}}))
        handle.write(_line({"type": "system", "subtype": "stop_hook_summary"}))
    assert transcript_answer(str(path)) == "The newest answer."


def test_only_the_tail_of_a_big_transcript_is_read(projects):
    path = projects / "big.jsonl"
    with path.open("w", encoding="utf-8") as handle:
        handle.write(_line(_assistant("only at the start")))
        handle.write(_line({"type": "user", "message": {"content": "x" * 4096}}) * 40)
    # The one answer lies before the tail, so it is never seen.
    assert transcript_answer(str(path), cap=8192) is None
    with path.open("a", encoding="utf-8") as handle:
        handle.write(_line(_assistant("at the end " + "z" * 1000)))
    found = transcript_answer(str(path), cap=8192)
    assert found.startswith("at the end") and len(found) <= LAST_TEXT_LIMIT


def test_a_transcript_path_that_is_not_one_is_not_read(projects):
    other = projects / "notes.txt"
    other.write_text(_line(_assistant("secret")), encoding="utf-8")
    assert transcript_answer(str(other)) is None
    assert transcript_answer("relative.jsonl") is None
    assert transcript_answer(None) is None
    assert transcript_answer(str(projects / "missing.jsonl")) is None


def test_a_stop_without_its_answer_reads_the_transcript(projects):
    path = projects / f"{CLAUDE_ID}.jsonl"
    path.write_text(
        _line({"type": "ai-title", "aiTitle": "Fix the login form"})
        + _line(_assistant("Fixed it.")),
        encoding="utf-8",
    )
    payload = {"transcript_path": str(path), "session_id": CLAUDE_ID}
    filled, title = turn_details("claude", "Stop", payload)
    assert filled["last_assistant_message"] == "Fixed it." and title == "Fix the login form"
    carried = {**payload, "last_assistant_message": "From the hook."}
    kept, _ = turn_details("claude", "Stop", carried)
    assert kept is carried
    untouched, title = turn_details("claude", "PreToolUse", payload)
    assert untouched is payload and title is None


# --- the conversation's title ------------------------------------------------------


def test_claude_title_prefers_the_users_own(projects):
    path = projects / "t.jsonl"
    path.write_text(
        _line({"type": "user", "message": {"content": "the first prompt"}})
        + _line({"type": "ai-title", "aiTitle": "Generated"})
        + _line({"type": "custom-title", "customTitle": "Mine"})
        + _line({"type": "ai-title", "aiTitle": "Generated again"}),
        encoding="utf-8",
    )
    assert agent_sessions.claude_title(str(path)) == "Mine"
    untitled = projects / "u.jsonl"
    untitled.write_text(_line({"type": "user", "message": {"content": "only a prompt"}}), encoding="utf-8")
    # The first prompt is the card's job, not the pane's title.
    assert agent_sessions.claude_title(str(untitled)) is None
    summary = projects / "s.jsonl"
    summary.write_text(_line({"type": "summary", "summary": "Older summary"}), encoding="utf-8")
    assert agent_sessions.claude_title(str(summary)) == "Older summary"


def test_codex_title_is_the_thread_name(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    (tmp_path / "session_index.jsonl").write_text(
        _line({"id": CODEX_ID, "thread_name": "Speed up the parser"}), encoding="utf-8")
    assert agent_sessions.codex_thread_name(CODEX_ID) == "Speed up the parser"
    payload = {"type": "agent-turn-complete", "thread-id": CODEX_ID}
    assert turn_details("codex", "agent-turn-complete", payload) == (payload, "Speed up the parser")
    assert agent_sessions.codex_thread_name("other") is None


# --- the session manager and the route ---------------------------------------------


@pytest.fixture
async def mgr(monkeypatch):
    monkeypatch.setattr(session_manager, "PtySession", _RecordingPty)
    manager = SessionManager(asyncio.get_running_loop())
    yield manager
    manager.shutdown()


async def test_the_name_follows_the_title_until_a_person_renames(mgr):
    info = mgr.spawn(cmd="claude.exe", name="Claude Code")
    mgr.agent_event(info.id, "claude", "UserPromptSubmit", {"prompt": "p"})
    mgr.set_agent_title(info.id, "Fix the login form")
    assert info.name == "Fix the login form"
    assert mgr.session_agent(info.id)["title"] == "Fix the login form"
    # The agent leaves: the pane is a shell again and says so.
    mgr.agent_event(info.id, "claude", "SessionEnd", {})
    assert info.name == "Claude Code"
    mgr.agent_event(info.id, "claude", "SessionStart", {"source": "startup"})
    mgr.mark_named(info.id)
    info.name = "mine"
    mgr.set_agent_title(info.id, "Another title")
    assert info.name == "mine"
    mgr.agent_event(info.id, "claude", "SessionEnd", {})
    assert info.name == "mine"


async def test_the_route_fills_the_answer_and_names_the_terminal(mgr, projects):
    path = projects / f"{CLAUDE_ID}.jsonl"
    path.write_text(_line({"type": "custom-title", "customTitle": "Release notes"})
                    + _line(_assistant("Wrote them.")), encoding="utf-8")
    info = mgr.spawn(cmd="claude.exe", name="Claude Code")
    app = create_app(mgr, FakeConfig(), "tok")
    ctx = next(m.kwargs["ctx"] for m in app.user_middleware if "ctx" in m.kwargs)
    with TestClient(app, base_url=BASE) as client:
        client.headers["X-QuickTerm-Hook-Token"] = ctx.hook_token
        url = f"/api/sessions/{info.id}/agent-event"
        for event, payload in (
            ("UserPromptSubmit", {"prompt": "write the notes", "session_id": CLAUDE_ID}),
            ("Stop", {"transcript_path": str(path), "session_id": CLAUDE_ID}),
        ):
            body = {"agent": "claude", "event": event, "payload": payload}
            assert client.post(url, json=body).status_code == 204
        client.headers["X-QuickTerm-Token"] = "tok"
        row = next(item for item in client.get("/api/sessions?metrics=false").json()
                   if item["id"] == info.id)
    assert row["name"] == "Release notes"
    agent = row["agent"]
    assert (agent["last_prompt"], agent["last_answer"]) == ("write the notes", "Wrote them.")
    assert (agent["board"], agent["conversation_id"], agent["title"]) == ("done", CLAUDE_ID, "Release notes")
    assert agent["last_event_at"].endswith("Z")


async def test_a_title_written_after_the_stop_is_picked_up(mgr, projects, monkeypatch):
    # Claude writes a new conversation's title a moment after its first turn.
    from quickterm.api import sessions as session_routes

    monkeypatch.setattr(session_routes, "TITLE_RETRY_S", (0.2, 0.2))
    path = projects / f"{CLAUDE_ID}.jsonl"
    path.write_text(_line(_assistant("4.")), encoding="utf-8")
    info = mgr.spawn(cmd="claude.exe", name="Claude Code")
    app = create_app(mgr, FakeConfig(), "tok")
    ctx = next(m.kwargs["ctx"] for m in app.user_middleware if "ctx" in m.kwargs)
    with TestClient(app, base_url=BASE) as client:
        client.headers["X-QuickTerm-Hook-Token"] = ctx.hook_token
        body = {"agent": "claude", "event": "Stop",
                "payload": {"transcript_path": str(path), "session_id": CLAUDE_ID}}
        assert client.post(f"/api/sessions/{info.id}/agent-event", json=body).status_code == 204
        assert info.name == "Claude Code"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(_line({"type": "ai-title", "aiTitle": "Basic arithmetic"}))
        for _ in range(50):
            if info.name != "Claude Code":
                break
            time.sleep(0.05)
    assert info.name == "Basic arithmetic"


async def test_a_rename_through_the_route_wins_over_the_title(mgr):
    info = mgr.spawn(cmd="claude.exe", name="Claude Code")
    mgr.agent_event(info.id, "claude", "UserPromptSubmit", {"prompt": "p"})
    with TestClient(create_app(mgr, FakeConfig(), "tok"), base_url=BASE) as client:
        client.headers["X-QuickTerm-Token"] = "tok"
        assert client.patch(f"/api/sessions/{info.id}", json={"name": "api work"}).status_code == 200
    mgr.set_agent_title(info.id, "Generated")
    assert info.name == "api work"
