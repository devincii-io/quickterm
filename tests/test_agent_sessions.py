"""Recent Claude Code and Codex sessions, read from synthetic stores."""

from __future__ import annotations

import json
import os
import time

import pytest

from quickterm import agent_sessions

IDS = [f"0199a3b2-7c41-7d10-9e55-{i:012d}" for i in range(10)]
PROJECT = os.path.join("C:" + os.sep if os.name == "nt" else os.sep, "Users", "dev", "my.project")


def _jsonl(*records) -> str:
    return "\n".join(r if isinstance(r, str) else json.dumps(r) for r in records) + "\n"


@pytest.fixture
def claude_home(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude"))
    folder = tmp_path / "claude" / "projects" / agent_sessions.claude_slug(PROJECT)
    folder.mkdir(parents=True)
    return folder


def _touch(path, age_s):
    stamp = time.time() - age_s
    os.utime(path, (stamp, stamp))


def test_the_slug_replaces_every_non_alphanumeric_character():
    assert agent_sessions.claude_slug(r"C:\Users\devincii\Projects\personal\quickterm") == (
        "C--Users-devincii-Projects-personal-quickterm"
    )
    assert agent_sessions.claude_slug("/home/me/my_app.v2") == "-home-me-my-app-v2"


def test_claude_sessions_newest_first_with_titles(claude_home):
    titled = claude_home / f"{IDS[0]}.jsonl"
    titled.write_text(_jsonl(
        {"type": "user", "message": {"role": "user", "content": "first question"}},
        {"type": "ai-title", "aiTitle": "Old title"},
        "{corrupt",
        {"type": "ai-title", "aiTitle": "Fix   the\nlogin flow"},
    ), encoding="utf-8")
    asked = claude_home / f"{IDS[1]}.jsonl"
    asked.write_text(_jsonl(
        {"type": "user", "isMeta": True, "message": {"content": "Caveat: ignore"}},
        {"type": "user", "message": {"content": "<command-name>/clear</command-name>"}},
        {"type": "user", "message": {"content": [{"type": "tool_result"}, {"type": "text", "text": "x" * 300}]}},
    ), encoding="utf-8")
    empty = claude_home / f"{IDS[2]}.jsonl"
    empty.write_text("not json at all\n", encoding="utf-8")
    (claude_home / "notes.jsonl").write_text("{}")  # not a session id
    _touch(titled, 30)
    _touch(asked, 20)
    _touch(empty, 10)

    sessions = agent_sessions.claude_sessions(PROJECT, 20)
    assert [s["id"] for s in sessions] == [IDS[2], IDS[1], IDS[0]]
    assert sessions[2]["title"] == "Fix the login flow"
    assert sessions[1]["title"] == "x" * 120
    assert sessions[0]["title"] == f"session {IDS[2][:8]}"
    assert all(s["cwd"] == PROJECT and s["updated_at"].endswith("Z") for s in sessions)
    assert len(agent_sessions.claude_sessions(PROJECT, 2)) == 2


def test_claude_reads_at_most_the_cap_of_a_big_transcript(claude_home):
    big = claude_home / f"{IDS[3]}.jsonl"
    filler = _jsonl(*[{"type": "assistant", "pad": "y" * 1000}] * 600)
    big.write_text(
        _jsonl({"type": "user", "message": {"content": "start"}}) + filler
        + _jsonl({"type": "ai-title", "aiTitle": "Late title"}),
        encoding="utf-8",
    )
    assert big.stat().st_size > agent_sessions.READ_CAP
    (session,) = agent_sessions.claude_sessions(PROJECT, 5)
    assert session["title"] == "Late title"


def test_claude_without_a_project_folder_lists_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "none"))
    assert agent_sessions.claude_sessions(PROJECT, 5) == []


@pytest.mark.skipif(os.name != "nt", reason="drive letters are a Windows spelling")
def test_claude_matches_the_project_folder_case_insensitively_on_windows(claude_home):
    (claude_home / f"{IDS[4]}.jsonl").write_text(_jsonl({"type": "ai-title", "aiTitle": "t"}))
    assert [s["id"] for s in agent_sessions.claude_sessions(PROJECT.lower(), 5)] == [IDS[4]]


@pytest.fixture
def codex_home(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    (tmp_path / "codex").mkdir()
    return tmp_path / "codex"


def _rollout(home, day, stamp, session_id, cwd, *, raw=None):
    folder = home / "sessions" / "2026" / "10" / day
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"rollout-2026-10-{day}T{stamp}-{session_id}.jsonl"
    meta = {"type": "session_meta", "payload": {"id": session_id, "cwd": cwd, "timestamp": f"2026-10-{day}T10:00:00Z"}}
    path.write_text((raw if raw is not None else json.dumps(meta)) + "\n" + json.dumps({"type": "event"}) + "\n")
    return path


def test_codex_joins_the_index_with_rollouts_of_the_folder(codex_home):
    (codex_home / "session_index.jsonl").write_text(_jsonl(
        {"id": IDS[0], "thread_name": "old name", "updated_at": "2026-10-01T09:00:00Z"},
        "{broken",
        {"id": IDS[0], "thread_name": "Refactor parser", "updated_at": "2026-10-03T12:00:00Z"},
        {"id": IDS[1], "thread_name": "Elsewhere", "updated_at": "2026-10-04T00:00:00Z"},
        {"id": IDS[2], "thread_name": "Newer", "updated_at": 1_791_000_000_000},
    ))
    _rollout(codex_home, "01", "09-00-00", IDS[0], PROJECT)
    _rollout(codex_home, "02", "09-00-00", IDS[1], os.path.join(PROJECT, "other"))
    _rollout(codex_home, "03", "09-00-00", IDS[2], PROJECT.upper() if os.name == "nt" else PROJECT)
    _rollout(codex_home, "03", "10-00-00", IDS[3], PROJECT)  # not in the index
    _rollout(codex_home, "03", "11-00-00", "not-a-uuid", PROJECT)
    _rollout(codex_home, "03", "12-00-00", IDS[4], PROJECT, raw="{corrupt")

    sessions = agent_sessions.codex_sessions(PROJECT, 20)
    by_id = {s["id"]: s for s in sessions}
    assert set(by_id) == {IDS[0], IDS[2], IDS[3]}
    assert by_id[IDS[0]]["title"] == "Refactor parser"
    assert by_id[IDS[0]]["updated_at"] == "2026-10-03T12:00:00Z"
    assert by_id[IDS[2]]["updated_at"] == "2026-10-03T04:00:00Z"  # from epoch milliseconds
    assert by_id[IDS[3]]["title"] == f"session {IDS[3][:8]}"
    assert by_id[IDS[3]]["updated_at"] == "2026-10-03T10:00:00Z"
    assert [s["updated_at"] for s in sessions] == sorted((s["updated_at"] for s in sessions), reverse=True)


def test_codex_reads_id_and_cwd_from_a_first_line_longer_than_the_cap(codex_home):
    meta = {"type": "session_meta", "payload": {
        "id": IDS[5], "cwd": PROJECT, "instructions": "z" * (agent_sessions.META_CAP * 2),
    }}
    _rollout(codex_home, "04", "08-00-00", IDS[5], PROJECT, raw=json.dumps(meta))
    assert [s["id"] for s in agent_sessions.codex_sessions(PROJECT, 5)] == [IDS[5]]


def test_codex_hides_subagent_threads_and_non_interactive_runs(codex_home):
    def meta(session_id, **payload):
        return json.dumps({"type": "session_meta", "payload": {"id": session_id, "cwd": PROJECT, **payload}})

    _rollout(codex_home, "05", "01-00-00", IDS[0], PROJECT, raw=meta(IDS[0], source="cli"))
    _rollout(codex_home, "05", "02-00-00", IDS[1], PROJECT, raw=meta(IDS[1], source="vscode"))
    _rollout(codex_home, "05", "03-00-00", IDS[2], PROJECT, raw=meta(IDS[2]))  # older format
    _rollout(codex_home, "05", "04-00-00", IDS[3], PROJECT, raw=meta(
        IDS[3], source={"subagent": {"thread_spawn": {"parent_thread_id": IDS[0], "depth": 1}}},
    ))
    _rollout(codex_home, "05", "05-00-00", IDS[4], PROJECT, raw=meta(IDS[4], source="exec"))
    _rollout(codex_home, "05", "06-00-00", IDS[5], PROJECT, raw=meta(IDS[5], parent_thread_id=IDS[1]))
    # The same subagent shape cut off by the cap: the raw-text reading decides.
    long = agent_sessions.META_CAP * 2
    _rollout(codex_home, "05", "07-00-00", IDS[6], PROJECT, raw=meta(
        IDS[6], source={"subagent": {"thread_spawn": {"parent_thread_id": IDS[0]}}}, instructions="z" * long,
    ))
    _rollout(codex_home, "05", "08-00-00", IDS[7], PROJECT, raw=meta(IDS[7], source="cli", instructions="z" * long))
    assert {s["id"] for s in agent_sessions.codex_sessions(PROJECT, 20)} == {IDS[0], IDS[1], IDS[2], IDS[7]}


def test_claude_prefers_the_title_the_user_chose(claude_home):
    path = claude_home / f"{IDS[0]}.jsonl"
    path.write_text(_jsonl(
        {"type": "user", "message": {"content": "first question"}},
        {"type": "ai-title", "aiTitle": "Generated"},
        {"type": "custom-title", "customTitle": "Old name"},
        {"type": "custom-title", "customTitle": "Custom terminal emulator"},
    ), encoding="utf-8")
    assert agent_sessions.claude_sessions(PROJECT, 5)[0]["title"] == "Custom terminal emulator"


def test_deeply_nested_lines_are_skipped_not_raised(claude_home, codex_home):
    nested = "[" * 100_000
    (claude_home / f"{IDS[0]}.jsonl").write_text(_jsonl(
        nested, {"type": "user", "message": {"content": "still here"}},
    ), encoding="utf-8")
    (codex_home / "session_index.jsonl").write_text(_jsonl(nested, {"id": IDS[1], "thread_name": "Named"}))
    _rollout(codex_home, "06", "01-00-00", IDS[1], PROJECT)
    _rollout(codex_home, "06", "02-00-00", IDS[2], PROJECT, raw=nested)
    assert agent_sessions.sessions("claude-code", PROJECT, 5)[0]["title"] == "still here"
    assert [s["title"] for s in agent_sessions.sessions("codex", PROJECT, 5)] == ["Named"]


def test_an_unexpected_failure_lists_nothing(monkeypatch):
    def broken(cwd, limit):
        raise TypeError("format changed")

    monkeypatch.setattr(agent_sessions, "codex_sessions", broken)
    assert agent_sessions.sessions("codex", PROJECT, 5) == []


def test_codex_stops_at_the_limit_and_the_scan_cap(codex_home, monkeypatch):
    for i in range(6):
        _rollout(codex_home, f"{i + 1:02d}", "00-00-00", IDS[i], PROJECT)
    assert len(agent_sessions.codex_sessions(PROJECT, 3)) == 3
    monkeypatch.setattr(agent_sessions, "CODEX_SCAN_MAX", 2)
    # Only the two newest rollouts are looked at.
    assert {s["id"] for s in agent_sessions.codex_sessions(PROJECT, 10)} == {IDS[5], IDS[4]}


def test_codex_without_a_store_lists_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "missing"))
    assert agent_sessions.codex_sessions(PROJECT, 5) == []


def test_dispatch_by_type(claude_home, codex_home):
    assert agent_sessions.sessions("claude-code", PROJECT, 5) == []
    assert agent_sessions.sessions("codex", PROJECT, 5) == []
    with pytest.raises(ValueError):
        agent_sessions.sessions("bash", PROJECT, 5)
