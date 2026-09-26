"""Session attention and the current folder, as the manager and the reaper see them."""

import asyncio

import pytest

import quickterm.session_manager as session_manager
from quickterm.reaper import EXITED_UNREAD_RETENTION_S
from quickterm.session_manager import SessionManager
from tests.test_session_manager import _RecordingPty


@pytest.fixture
async def mgr(monkeypatch):
    monkeypatch.setattr(session_manager, "PtySession", _RecordingPty)
    monkeypatch.setattr(session_manager, "process_identities", lambda: [])
    manager = SessionManager(asyncio.get_running_loop())
    yield manager
    manager._sessions.clear()


def spawn(mgr, **kwargs):
    info = mgr.spawn(cmd="x.exe", **kwargs)
    return info, mgr.get(info.id), _RecordingPty.last


async def test_a_bell_raises_attention_and_more_output_does_not_clear_it(mgr):
    info, _, pty = spawn(mgr)
    assert mgr.session_attention(info.id) is None
    pty.on_output(b"waiting\x07")
    record = mgr.session_attention(info.id)
    assert record["kind"] == "bell"
    assert record["text"] is None
    assert record["age_seconds"] >= 0
    pty.on_output(b"still printing\r\n" * 10)
    assert mgr.session_attention(info.id)["kind"] == "bell"


async def test_a_notification_replaces_a_bell_and_carries_its_text(mgr):
    info, _, pty = spawn(mgr)
    pty.on_output(b"\x07")
    pty.on_output(b"\x1b]9;Approve the edit?\x1b\\")
    assert mgr.session_attention(info.id) == {
        "kind": "notify", "text": "Approve the edit?", "age_seconds": 0,
    }


async def test_seen_and_touch_clear_attention(mgr):
    info, _, pty = spawn(mgr)
    pty.on_output(b"\x07")
    mgr.mark_seen(info.id)
    assert mgr.session_attention(info.id) is None
    pty.on_output(b"\x07")
    mgr.touch(info.id)
    assert mgr.session_attention(info.id) is None
    with pytest.raises(KeyError):
        mgr.mark_seen("nope")


async def test_osc_folder_reports_set_current_cwd_and_keep_the_start_folder(mgr, tmp_path):
    info, _, pty = spawn(mgr, cwd=str(tmp_path))
    assert info.current_cwd is None
    pty.on_output(b"\x1b]9;9;C:\\elsewhere\x1b\\PS> ")
    assert info.current_cwd == "C:\\elsewhere"
    assert info.cwd == str(tmp_path)
    # A folder report is not attention.
    assert mgr.session_attention(info.id) is None


async def test_the_listener_hears_each_attention_on_the_loop(mgr):
    heard = []
    mgr.set_attention_listener(lambda info, record: heard.append((info.id, record.kind)))
    info, _, pty = spawn(mgr)
    pty.on_output(b"\x07")
    pty.on_output(b"plain")
    assert heard == [(info.id, "bell")]


async def test_a_failing_listener_never_reaches_the_reader(mgr):
    def boom(info, record):
        raise RuntimeError("notifier down")

    mgr.set_attention_listener(boom)
    info, _, pty = spawn(mgr)
    pty.on_output(b"\x07")
    assert mgr.session_attention(info.id)["kind"] == "bell"


async def test_an_exit_is_attention_only_for_a_terminal_someone_cared_about(mgr):
    untouched, _, pty = spawn(mgr)
    pty.on_exit(0)
    assert mgr.session_attention(untouched.id) is None

    # Opened once but never typed into or kept: as disposable as the reaper
    # already treats it.
    opened, session, pty = spawn(mgr)
    mgr.attach(opened.id).detach()
    pty.on_exit(3)
    assert mgr.session_attention(opened.id) is None

    kept, session, pty = spawn(mgr)
    mgr.attach(kept.id).detach()
    session.info.retained = True
    pty.on_exit(3)
    assert mgr.session_attention(kept.id) == {
        "kind": "exit", "text": "exited with code 3", "age_seconds": 0,
    }

    typed, session, pty = spawn(mgr)
    mgr.attach(typed.id).detach()
    session.info.touched = True
    pty.on_exit(0)
    assert mgr.session_attention(typed.id)["kind"] == "exit"


async def test_opening_an_exited_session_answers_its_attention(mgr):
    info, session, pty = spawn(mgr)
    mgr.attach(info.id).detach()
    session.info.retained = True
    pty.on_exit(1)
    mgr.acknowledge(info.id)  # the server's replay-only reattach
    assert mgr.session_attention(info.id) is None


async def test_attaching_a_live_session_does_not_answer_its_bell(mgr):
    # A workspace restore attaches every pane; that is not the user looking.
    info, _, pty = spawn(mgr)
    pty.on_output(b"\x07")
    mgr.attach(info.id).detach()
    assert mgr.session_attention(info.id)["kind"] == "bell"


async def test_an_exit_while_watched_or_killed_is_not_attention(mgr):
    watched, session, pty = spawn(mgr)
    session.info.touched = True
    attachment = mgr.attach(watched.id)
    pty.on_exit(1)
    assert mgr.session_attention(watched.id) is None
    attachment.detach()

    killed, session, pty = spawn(mgr)
    mgr.attach(killed.id).detach()
    session.info.retained = True
    assert mgr.kill(killed.id) is True
    # The backend reports the exit the kill caused, possibly before the
    # loop has run the kill's bookkeeping.
    pty.on_exit(1)
    assert mgr.session_attention(killed.id) is None


async def test_a_failed_kill_leaves_a_later_real_exit_reportable(mgr, monkeypatch):
    info, session, pty = spawn(mgr)
    mgr.attach(info.id).detach()
    session.info.touched = True
    monkeypatch.setattr(pty, "kill", lambda: False)
    assert mgr.kill(info.id) is False
    pty.on_exit(2)
    assert mgr.session_attention(info.id)["kind"] == "exit"


async def test_the_reaper_keeps_an_exited_session_with_attention(mgr):
    info, session, pty = spawn(mgr)
    mgr.attach(info.id).detach()
    session.info.retained = True
    pty.on_exit(0)
    assert mgr.reap_idle(300, set()) == []
    assert mgr.get(info.id) is not None
    # Seen: nothing holds it any more.
    mgr.mark_seen(info.id)
    assert mgr.reap_idle(300, set()) == [info.id]


async def test_the_attention_hold_on_an_exited_session_expires(mgr):
    info, session, pty = spawn(mgr)
    mgr.attach(info.id).detach()
    session.info.retained = True
    pty.on_exit(0)
    session.ended_at -= EXITED_UNREAD_RETENTION_S + 1
    assert mgr.reap_idle(300, set()) == [info.id]


async def test_the_reaper_spares_an_idle_live_session_that_asked_for_the_user(mgr):
    info, session, pty = spawn(mgr)
    pty.on_output(b"\x1b]777;notify;agent;waiting\x07")
    session.last_activity -= 600
    assert mgr.reap_idle(300, set()) == []
    mgr.mark_seen(info.id)
    assert mgr.reap_idle(300, set()) == [info.id]
