"""Paths in a hook payload are never opened unless they lie in the agent's own
folder on a local disk, and never for a terminal on an SSH host.

Anything in a terminal holds the hook token, a remote host included. A UNC
transcript path would make Windows log on to that host with the user's
NetNTLM hash, so every refused path below must be refused from its text,
before anything is opened."""

from __future__ import annotations

import asyncio
import builtins
import io
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import quickterm.session_manager as session_manager
from quickterm import agent_hooks, agent_sessions
from quickterm.agent_hooks import apply, transcript_answer, turn_details
from quickterm.server import create_app
from quickterm.session_manager import SessionManager
from tests.test_server import FakeConfig
from tests.test_session_manager import _RecordingPty

CLAUDE_ID = "3f2c1d7e-9a8b-4c6d-8e7f-0a1b2c3d4e5f"
BASE = "http://127.0.0.1:8620"


@pytest.fixture
def claude_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude"))
    (tmp_path / "claude" / "projects" / "p").mkdir(parents=True)
    return tmp_path / "claude"


@pytest.fixture
def nothing_is_opened(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError(f"opened {args[:1]}")

    monkeypatch.setattr(builtins, "open", refuse)
    monkeypatch.setattr(io, "open", refuse)
    monkeypatch.setattr(Path, "open", refuse)
    monkeypatch.setattr(Path, "is_file", refuse)
    monkeypatch.setattr(os.path, "exists", refuse)


def _refused(path: str) -> None:
    assert agent_sessions.claude_transcript(path) is None
    assert transcript_answer(path) is None
    assert agent_sessions.claude_title(path) is None
    payload = {"transcript_path": path, "session_id": CLAUDE_ID}
    assert turn_details("claude", "Stop", payload) == (payload, None)


@pytest.mark.parametrize("path", [
    r"\\attacker\s\x.jsonl",
    "//attacker/s/x.jsonl",
    r"\\?\UNC\attacker\s\x.jsonl",
    r"\\.\pipe\x.jsonl",
    "\\/attacker/s/x.jsonl",
])
def test_network_paths_are_refused_without_touching_anything(claude_dir, nothing_is_opened, path):
    _refused(path)


def test_a_path_outside_claudes_projects_folder_is_refused(claude_dir, tmp_path, nothing_is_opened):
    _refused(str(tmp_path / "elsewhere" / "x.jsonl"))
    _refused(str(claude_dir / "x.jsonl"))
    # A way out of the folder that only looks like it is inside.
    _refused(str(claude_dir / "projects" / ".." / ".." / "x.jsonl"))
    _refused(str(claude_dir / "projects" / "p" / "x.txt"))
    _refused("projects/p/x.jsonl")


@pytest.mark.skipif(os.name != "nt", reason="drive letters are Windows")
def test_a_mapped_network_drive_is_refused(monkeypatch, nothing_is_opened):
    drive_types = {"Z:\\": 4, "C:\\": 3}  # DRIVE_REMOTE, DRIVE_FIXED
    monkeypatch.setattr(agent_sessions, "_drive_type", lambda drive: drive_types.get(drive, 0))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", r"Z:\home\.claude")
    _refused(r"Z:\home\.claude\projects\p\x.jsonl")
    # Even a lower-case letter, and a drive Windows does not know.
    _refused(r"z:\home\.claude\projects\p\x.jsonl")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", r"Q:\.claude")
    _refused(r"Q:\.claude\projects\p\x.jsonl")


def test_a_transcript_in_claudes_own_folder_is_read(claude_dir):
    path = claude_dir / "projects" / "p" / f"{CLAUDE_ID}.jsonl"
    path.write_text('{"type": "ai-title", "aiTitle": "Mine"}\n', encoding="utf-8")
    assert agent_sessions.claude_transcript(str(path)) == str(path)
    assert agent_sessions.claude_title(str(path)) == "Mine"


def test_a_network_folder_is_never_kept_for_the_resume_command():
    for cwd in (r"\\attacker\s", "//attacker/s"):
        state = apply(None, "claude", "SessionStart", {"session_id": CLAUDE_ID, "cwd": cwd}, 1.0).state
        assert state.cwd is None
    state = apply(None, "claude", "SessionStart", {"cwd": r"C:\work\repo"}, 1.0).state
    assert state.cwd == r"C:\work\repo"


@pytest.fixture
async def mgr(monkeypatch):
    monkeypatch.setattr(session_manager, "PtySession", _RecordingPty)
    manager = SessionManager(asyncio.get_running_loop())
    yield manager
    manager.shutdown()


async def test_a_terminal_on_an_ssh_host_gets_no_local_reads(mgr, claude_dir, monkeypatch):
    def no_reads(*args):
        raise AssertionError("read a file a remote hook named")

    monkeypatch.setattr(agent_hooks, "turn_details", no_reads)
    info = mgr.spawn(cmd="ssh.exe", name="Claude Code")
    mgr.get(info.id).remote = True
    assert mgr.is_remote(info.id) and mgr.is_remote("unknown")
    app = create_app(mgr, FakeConfig(), "tok")
    ctx = next(m.kwargs["ctx"] for m in app.user_middleware if "ctx" in m.kwargs)
    with TestClient(app, base_url=BASE) as client:
        client.headers["X-QuickTerm-Hook-Token"] = ctx.hook_token
        url = f"/api/sessions/{info.id}/agent-event"
        for payload in (
            {"transcript_path": r"\\attacker\s\x.jsonl"},
            {"transcript_path": "/home/me/.claude/projects/p/x.jsonl", "last_assistant_message": "Done."},
        ):
            body = {"agent": "claude", "event": "Stop", "payload": payload}
            assert client.post(url, json=body).status_code == 204
    # What the payload carried still counts.
    assert mgr.session_agent(info.id)["last_answer"] == "Done."
    assert info.name == "Claude Code"
