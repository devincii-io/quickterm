import asyncio
import hashlib
import os
import threading
import time

import pytest

import quickterm.session_manager as session_manager
from quickterm.session_manager import SessionLimitError, SessionManager, SpawnError


class _RecordingPty:
    """Stand-in for PtySession that captures the environment it was handed."""

    last: "_RecordingPty | None" = None

    def __init__(self, cmd, args, cwd, env, cols, rows, loop, on_output, on_exit):
        self.cmd, self.env = cmd, env
        self.alive, self.exit_code, self.pid = True, None, 4242
        self.on_output, self.on_exit = on_output, on_exit
        self.thread = threading.get_ident()
        _RecordingPty.last = self

    def write(self, data):
        pass

    def resize(self, cols, rows):
        pass

    def kill(self):
        return True


async def test_spawn_preserves_profile_env_and_workspace_metadata(monkeypatch):
    monkeypatch.setattr(session_manager, "PtySession", _RecordingPty)
    mgr = SessionManager(asyncio.get_running_loop())
    info = mgr.spawn(cmd="x.exe", workspace="proj", env={"USER_SET": "1"})
    env = _RecordingPty.last.env
    assert "QUICKTERM_TOKEN" not in env
    assert "QUICKTERM_SESSION_ID" not in env
    assert env["USER_SET"] == "1"
    assert info.workspace == "proj"


async def test_sync_workspace_moves_and_unassigns_live_metadata(monkeypatch):
    monkeypatch.setattr(session_manager, "PtySession", _RecordingPty)
    mgr = SessionManager(asyncio.get_running_loop())
    first = mgr.spawn(cmd="x.exe", workspace="old")
    second = mgr.spawn(cmd="x.exe")

    mgr.sync_workspace("new", {first.id, second.id})
    assert first.workspace == "new"
    assert second.workspace == "new"

    mgr.sync_workspace("new", {second.id})
    assert first.workspace is None
    assert second.workspace == "new"


def _short(script: str) -> tuple[str, list[str]]:
    if os.name == "nt":
        return "cmd.exe", ["/c", script]
    return "/bin/sh", ["-c", script]


def _interactive() -> tuple[str, list[str]]:
    return ("cmd.exe", ["/q", "/k"]) if os.name == "nt" else ("/bin/sh", [])


async def _drain(att, timeout=15) -> bytes:
    """Collect chunks until the None sentinel."""
    out = bytearray()
    while True:
        item = await asyncio.wait_for(att.queue.get(), timeout=timeout)
        if item is None:
            return bytes(out)
        out += item


def _ring(session) -> bytes:
    """Replay bytes without the synthesized mode preamble."""
    chunks, _, _ = session.scrollback_chunks()
    return b"".join(chunks)[len(session._modes.preamble()):]


@pytest.fixture
async def manager():
    mgr = SessionManager(asyncio.get_running_loop())
    yield mgr
    mgr.shutdown()


@pytest.fixture
async def fake_manager(monkeypatch):
    monkeypatch.setattr(session_manager, "PtySession", _RecordingPty)
    monkeypatch.setattr(session_manager, "process_identities", lambda: [])
    mgr = SessionManager(asyncio.get_running_loop())
    yield mgr
    mgr._sessions.clear()


async def test_spawn_attach_output_and_sentinel(manager):
    cmd, args = _short("echo hi")
    info = manager.spawn(cmd=cmd, args=args, name="t1")
    assert info.alive and info.cols == 120 and info.rows == 30
    assert len(info.id) == 32
    att = manager.attach(info.id)
    out = await _drain(att)
    assert b"hi" in out
    sess = manager.get(info.id)
    assert sess.info.alive is False
    assert sess.info.exit_code == 0
    att.detach()


async def test_scrollback_and_late_attach(manager):
    cmd, args = _short("echo scrollme")
    info = manager.spawn(cmd=cmd, args=args, cols=90, rows=20)
    att = manager.attach(info.id)
    await _drain(att)
    chunks, cols, rows = manager.get(info.id).scrollback_chunks()
    assert b"scrollme" in b"".join(chunks)
    assert (cols, rows) == (90, 20)
    # attaching after exit yields an immediate sentinel
    late = manager.attach(info.id)
    assert await asyncio.wait_for(late.queue.get(), timeout=5) is None


async def test_scrollback_ring_truncates():
    mgr = SessionManager(asyncio.get_running_loop(), scrollback_bytes=64)
    try:
        script = (
            "for /l %i in (1,1,40) do @echo 0123456789"
            if os.name == "nt"
            else "i=0; while [ $i -lt 40 ]; do echo 0123456789; i=$((i+1)); done"
        )
        cmd, args = _short(script)
        info = mgr.spawn(cmd=cmd, args=args)
        att = mgr.attach(info.id)
        full = await _drain(att)
        assert len(full) > 64  # queue saw everything
        data = _ring(mgr.get(info.id))
        assert 0 < len(data) <= 64
        assert full.endswith(data)  # ring keeps the tail
    finally:
        mgr.shutdown()


async def test_scrollback_cap_updates_live_and_releases_old_bytes(fake_manager):
    mgr = fake_manager
    mgr.set_scrollback_bytes(128)
    info = mgr.spawn(cmd="x.exe")
    session = mgr.get(info.id)
    mgr._on_output(session, b"a" * 64 + b"b" * 64)
    assert len(_ring(session)) == 128

    mgr.set_scrollback_bytes(32)
    assert _ring(session) == b"b" * 32
    assert session._ring_bytes == 32


async def test_slow_subscriber_requests_clean_resync(fake_manager):
    mgr = fake_manager
    info = mgr.spawn(cmd="x.exe")
    att = mgr.attach(info.id)
    sess = mgr.get(info.id)
    # fill the queue to its byte bound, then push one more chunk
    sess._fanout(b"x" * session_manager.QUEUE_MAX_BYTES)
    assert att.overflowed is False
    sess._fanout(b"NEW")
    assert att.overflowed is True
    assert att.queue.qsize() == 1
    assert att.queue.get_nowait() is att.overflow_sentinel
    sess._fanout(None)  # an overflowed viewer gets nothing more
    assert att.queue.empty()


async def test_fast_consumer_streams_20_mb_without_overflow(fake_manager):
    """A reader that posts one callback per small read must not overflow a
    consumer that only awaits get(): the loop runs a whole batch of reader
    callbacks before the consumer wakes, which an 8-item queue could not hold."""
    mgr = fake_manager
    info = mgr.spawn(cmd="x.exe")
    session = mgr.get(info.id)
    att = mgr.attach(info.id)
    line = b"\x1b[38;5;196m0123456789\x1b[0m \xe2\x94\x80 abcdefghijklmnopqrstuvwxyz\r\n"
    chunk = (line * (4095 // len(line) + 1))[:4095]  # one POSIX pty read
    total = 20 * 1024 * 1024
    reads = total // len(chunk) + 1
    sent = hashlib.sha256()
    received = hashlib.sha256()
    got = 0

    async def consume():
        nonlocal got
        while True:
            item = await att.queue.get()
            if item is None:
                return
            assert item is not att.overflow_sentinel, "fast consumer overflowed"
            received.update(item)
            got += len(item)

    consumer = asyncio.ensure_future(consume())
    burst = 128  # reader callbacks the loop runs back to back: 512 KiB
    for start in range(0, reads, burst):
        for _ in range(min(burst, reads - start)):
            sent.update(chunk)
            session.pty.on_output(chunk)
        await asyncio.sleep(0)
    session.pty.on_exit(0)
    await asyncio.wait_for(consumer, timeout=30)
    assert att.overflowed is False
    assert got == reads * len(chunk)
    assert received.digest() == sent.digest()


async def test_background_output_is_reported_and_attach_acknowledges(fake_manager):
    mgr = fake_manager
    info = mgr.spawn(cmd="x.exe")
    first = mgr.attach(info.id)

    mgr._on_output(mgr.get(info.id), b"while open")
    assert mgr.session_activity(info.id)["background_output_bytes"] == 0

    first.detach()
    mgr._on_output(mgr.get(info.id), b"finished\r\n")
    activity = mgr.session_activity(info.id)
    assert activity["background_output_bytes"] == len(b"finished\r\n")
    assert activity["background_output_age_seconds"] == 0

    second = mgr.attach(info.id)
    assert mgr.session_activity(info.id)["background_output_bytes"] == 0
    assert mgr.session_activity(info.id)["background_output_age_seconds"] is None
    second.detach()


async def test_acknowledge_clears_unread_output_without_attaching(fake_manager):
    mgr = fake_manager
    info = mgr.spawn(cmd="x.exe")
    mgr.attach(info.id).detach()
    mgr._on_output(mgr.get(info.id), b"finished\r\n")
    mgr.acknowledge(info.id)
    activity = mgr.session_activity(info.id)
    assert activity["background_output_bytes"] == 0
    assert activity["background_output_age_seconds"] is None
    assert mgr.attachment_count(info.id) == 0
    mgr.acknowledge("no-such-id")  # no-op


async def test_initial_prompt_before_first_attach_is_not_unread(fake_manager):
    mgr = fake_manager
    info = mgr.spawn(cmd="x.exe")
    mgr._on_output(mgr.get(info.id), b"prompt> ")
    assert mgr.session_activity(info.id)["background_output_bytes"] == 0


async def test_write_does_not_touch_but_touch_does(fake_manager):
    mgr = fake_manager
    info = mgr.spawn(cmd="x.exe")
    session = mgr.get(info.id)
    session.last_activity -= 100
    mgr.write(info.id, b"\x1b[?1;2c")  # an xterm auto-reply arrives as input
    assert info.touched is False
    assert time.monotonic() - session.last_activity < 5  # still counts as activity

    session.last_activity -= 100
    mgr.touch(info.id)
    assert info.touched is True
    assert time.monotonic() - session.last_activity < 5


async def test_touch_ignores_unknown_and_exited_sessions(fake_manager):
    mgr = fake_manager
    info = mgr.spawn(cmd="x.exe")
    mgr._on_exit(mgr.get(info.id), 0)
    mgr.touch(info.id)
    assert info.touched is False
    mgr.touch("no-such-id")


async def test_idle_reaper_spares_attached_and_workspace_sessions(manager):
    cmd, args = _interactive()
    first = manager.spawn(cmd=cmd, args=args, name="idle")
    second = manager.spawn(cmd=cmd, args=args, name="protected")
    attached = manager.attach(first.id)
    manager.get(first.id).last_activity -= 600
    manager.get(second.id).last_activity -= 600
    assert manager.reap_idle(300, {second.id}) == []
    attached.detach()
    assert manager.reap_idle(300, {second.id}) == [first.id]


async def test_idle_reaper_spares_touched_sessions(manager):
    cmd, args = _interactive()
    info = manager.spawn(cmd=cmd, args=args, name="work")
    sess = manager.get(info.id)
    sess.info.touched = True
    sess.last_activity -= 600
    assert manager.reap_idle(300, set()) == []


async def test_idle_reaper_spares_explicitly_retained_sessions(manager):
    cmd, args = _interactive()
    info = manager.spawn(cmd=cmd, args=args, name="detached")
    sess = manager.get(info.id)
    sess.info.retained = True
    sess.last_activity -= 600
    assert manager.reap_idle(300, set()) == []
    assert sess.info.touched is False


class _SlowKillPty(_RecordingPty):
    """kill() blocks until the test releases it, like taskkill on a big tree."""

    started: threading.Event
    release: threading.Event
    result = True

    def kill(self):
        type(self).started.set()
        type(self).release.wait(10)
        return type(self).result


@pytest.fixture
def slow_kill(monkeypatch):
    class Pty(_SlowKillPty):
        started = threading.Event()
        release = threading.Event()
        result = True

    monkeypatch.setattr(session_manager, "PtySession", Pty)
    monkeypatch.setattr(session_manager, "process_identities", lambda: [])
    return Pty


async def _wait_for(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline, "condition never became true"
        await asyncio.sleep(0.01)


async def test_reaper_rechecks_each_session_right_before_its_kill(slow_kill):
    mgr = SessionManager(asyncio.get_running_loop())
    first = mgr.spawn(cmd="x.exe", name="a")
    second = mgr.spawn(cmd="x.exe", name="b")
    for sid in (first.id, second.id):
        mgr.get(sid).last_activity -= 600
    # app._reap_loop runs the pass in a worker thread
    reaping = asyncio.ensure_future(asyncio.to_thread(mgr.reap_idle, 300, set()))
    await _wait_for(slow_kill.started.is_set)
    # While the first kill is still running, the user opens b and types.
    att = mgr.attach(second.id)
    mgr.touch(second.id)
    slow_kill.release.set()
    assert await asyncio.wait_for(reaping, timeout=10) == [first.id]
    await asyncio.sleep(0)
    assert mgr.get(second.id).info.alive is True
    assert mgr.get(second.id).reaping is False
    att.detach()
    mgr._sessions.clear()


async def test_attach_refuses_a_session_the_reaper_is_killing(slow_kill):
    mgr = SessionManager(asyncio.get_running_loop())
    info = mgr.spawn(cmd="x.exe")
    mgr.get(info.id).last_activity -= 600
    reaping = asyncio.ensure_future(asyncio.to_thread(mgr.reap_idle, 300, set()))
    await _wait_for(slow_kill.started.is_set)
    assert mgr.get(info.id).reaping is True
    with pytest.raises(KeyError):
        mgr.attach(info.id)
    slow_kill.release.set()
    assert await asyncio.wait_for(reaping, timeout=10) == [info.id]
    mgr._sessions.clear()


async def test_failed_reaper_kill_releases_the_session(slow_kill):
    slow_kill.result = False
    slow_kill.release.set()
    mgr = SessionManager(asyncio.get_running_loop())
    info = mgr.spawn(cmd="x.exe")
    mgr.get(info.id).last_activity -= 600
    assert await asyncio.to_thread(mgr.reap_idle, 300, set()) == []
    assert mgr.get(info.id).reaping is False
    mgr.attach(info.id).detach()  # attachable again
    mgr._sessions.clear()


async def test_failed_kill_release_survives_a_stalled_loop(slow_kill, monkeypatch):
    """The release must not be a wait-then-cancel call: if the loop is busy
    past that wait, the claim would stay and every attach would answer 4404."""
    monkeypatch.setattr(session_manager, "_LOOP_CALL_TIMEOUT_S", 0.05)
    slow_kill.result = False
    mgr = SessionManager(asyncio.get_running_loop())
    info = mgr.spawn(cmd="x.exe")
    mgr.get(info.id).last_activity -= 600
    reaping = asyncio.ensure_future(asyncio.to_thread(mgr.reap_idle, 300, set()))
    await _wait_for(slow_kill.started.is_set)
    slow_kill.release.set()
    time.sleep(0.3)  # the loop stalls while the worker releases the claim
    assert await asyncio.wait_for(reaping, timeout=10) == []
    await asyncio.sleep(0)
    assert mgr.get(info.id).reaping is False
    mgr.attach(info.id).detach()
    mgr._sessions.clear()


def _finished_in_background(mgr, *, retained=False, touched=False, output=b"BUILD FAILED\r\n"):
    info = mgr.spawn(cmd="x.exe")
    session = mgr.get(info.id)
    mgr.attach(info.id).detach()
    info.retained, info.touched = retained, touched
    if output:
        mgr._on_output(session, output)
    mgr._on_exit(session, 1)
    return info, session


async def test_reaper_keeps_retained_exited_session_with_unread_output(fake_manager):
    mgr = fake_manager
    info, _ = _finished_in_background(mgr, retained=True)
    assert mgr.reap_idle(300, set()) == []
    assert mgr.get(info.id) is not None
    mgr.acknowledge(info.id)  # the server's replay-only reattach
    assert mgr.reap_idle(300, set()) == [info.id]


async def test_reaper_keeps_touched_exited_session_until_attached(fake_manager):
    mgr = fake_manager
    info, _ = _finished_in_background(mgr, touched=True)
    assert mgr.reap_idle(300, {info.id}) == []
    mgr.attach(info.id).detach()
    assert mgr.reap_idle(300, {info.id}) == [info.id]


async def test_reaper_drops_unread_exited_session_after_retention_ttl(fake_manager):
    mgr = fake_manager
    info, session = _finished_in_background(mgr, retained=True)
    session.ended_at -= session_manager.EXITED_UNREAD_RETENTION_S + 1
    assert mgr.reap_idle(300, set()) == [info.id]


async def test_reaper_drops_exited_sessions_nobody_cared_about(fake_manager):
    mgr = fake_manager
    never_attached = mgr.spawn(cmd="x.exe")
    mgr._on_output(mgr.get(never_attached.id), b"output nobody asked for")
    mgr._on_exit(mgr.get(never_attached.id), 0)
    untouched, _ = _finished_in_background(mgr)
    seen, _ = _finished_in_background(mgr, retained=True, output=b"")
    assert sorted(mgr.reap_idle(300, set())) == sorted(
        [never_attached.id, untouched.id, seen.id]
    )


async def test_kill_and_list_and_focus(manager):
    cmd, args = _interactive()
    info = manager.spawn(cmd=cmd, args=args, name="longlived")
    assert any(s.id == info.id for s in manager.list())
    att = manager.attach(info.id)
    await asyncio.sleep(0.3)
    assert manager.kill(info.id) is True
    await _drain(att)  # sentinel arrives on tree kill
    assert manager.get(info.id).info.alive is False
    await asyncio.sleep(1.2)  # grace period: session removed from registry
    assert manager.get(info.id) is None
    with pytest.raises(KeyError):
        manager.kill(info.id)  # gone: the caller answers 404, not 500


async def test_kill_marshals_state_change_from_worker_thread(manager):
    """FastAPI sync DELETE handlers invoke manager.kill outside the loop."""
    cmd, args = _interactive()
    info = manager.spawn(cmd=cmd, args=args, name="worker-kill")
    att = manager.attach(info.id)
    result: list[bool] = []
    done = threading.Event()

    def kill_from_worker():
        result.append(manager.kill(info.id))
        done.set()

    worker = threading.Thread(target=kill_from_worker)
    worker.start()
    while not done.is_set():
        await asyncio.sleep(0.01)
    worker.join(timeout=2)
    assert result == [True]
    await _drain(att)
    assert manager.get(info.id).info.alive is False


async def test_kill_of_unknown_session_raises_key_error(fake_manager):
    with pytest.raises(KeyError):
        fake_manager.kill("no-such-id")


@pytest.mark.parametrize("result", [False, None, 1])
async def test_only_a_true_backend_kill_counts_as_verified(monkeypatch, result):
    class _UnverifiedPty(_RecordingPty):
        def kill(self):
            return result

    monkeypatch.setattr(session_manager, "PtySession", _UnverifiedPty)
    mgr = SessionManager(asyncio.get_running_loop())
    info = mgr.spawn(cmd="x.exe")
    assert mgr.kill(info.id) is False
    await asyncio.sleep(0)
    assert mgr.get(info.id).info.alive is True
    # Avoid retrying the deliberately unkillable fake in manager.shutdown().
    mgr._sessions.clear()


async def test_live_session_limit_blocks_only_new_spawns():
    mgr = SessionManager(asyncio.get_running_loop(), max_sessions=1)
    try:
        cmd, args = _interactive()
        first = mgr.spawn(cmd=cmd, args=args, name="first")
        with pytest.raises(SessionLimitError, match="terminal limit reached"):
            mgr.spawn(cmd=cmd, args=args, name="blocked")
        assert mgr.get(first.id).info.alive is True

        mgr.set_max_sessions(0)
        second = mgr.spawn(cmd=cmd, args=args, name="second")
        assert mgr.get(second.id).info.alive is True
    finally:
        mgr.shutdown()


# ---- spawn failures and spawn_async ----


def _failing_pty(exc):
    class _FailingPty(_RecordingPty):
        def __init__(self, *args, **kwargs):
            raise exc

    return _FailingPty


async def test_missing_command_raises_spawn_error_with_path_hint(monkeypatch):
    monkeypatch.setattr(
        session_manager, "PtySession", _failing_pty(FileNotFoundError("command not found: nope"))
    )
    mgr = SessionManager(asyncio.get_running_loop())
    with pytest.raises(SpawnError) as caught:
        mgr.spawn(cmd="nope")
    assert str(caught.value) == (
        "command not found: nope. QuickTerm reads PATH when it starts; "
        "restart it after installing a program."
    )
    assert isinstance(caught.value, ValueError)
    assert isinstance(caught.value.__cause__, FileNotFoundError)
    assert mgr.list() == []


async def test_backend_os_error_raises_spawn_error_with_its_message(monkeypatch):
    monkeypatch.setattr(
        session_manager, "PtySession", _failing_pty(OSError("could not start x: no pty"))
    )
    mgr = SessionManager(asyncio.get_running_loop())
    with pytest.raises(SpawnError, match=r"^could not start x: no pty$"):
        mgr.spawn(cmd="x")
    with pytest.raises(SpawnError, match=r"^could not start x: no pty$"):
        await mgr.spawn_async(cmd="x")
    assert mgr.list() == []
    assert mgr._spawning == 0


async def test_real_missing_command_is_a_spawn_error(manager):
    with pytest.raises(SpawnError, match="command not found: definitely-not-a-real-command-xyz"):
        manager.spawn(cmd="definitely-not-a-real-command-xyz")
    with pytest.raises(SpawnError, match="restart it after installing"):
        await manager.spawn_async(cmd="definitely-not-a-real-command-xyz")


async def test_spawn_async_builds_the_pty_off_the_loop(fake_manager):
    mgr = fake_manager
    info = await mgr.spawn_async(cmd="x.exe", name="bg", workspace="proj", cols=90, rows=20)
    assert _RecordingPty.last.thread != threading.get_ident()
    session = mgr.get(info.id)
    assert session is not None and session.info is info
    assert (info.name, info.workspace, info.cols, info.rows) == ("bg", "proj", 90, 20)
    assert mgr._spawning == 0
    # Output posted before the registry insert still lands in the ring.
    _RecordingPty.last.on_output(b"early")
    assert _ring(session) == b"early"


async def test_spawn_async_counts_spawns_in_flight_against_the_limit(monkeypatch):
    gate = threading.Event()
    entered = threading.Event()

    class _BlockingPty(_RecordingPty):
        def __init__(self, *args, **kwargs):
            entered.set()
            gate.wait(10)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(session_manager, "PtySession", _BlockingPty)
    mgr = SessionManager(asyncio.get_running_loop(), max_sessions=1)
    first = asyncio.ensure_future(mgr.spawn_async(cmd="x.exe"))
    await _wait_for(entered.is_set)
    with pytest.raises(SessionLimitError):
        await mgr.spawn_async(cmd="x.exe")
    with pytest.raises(SessionLimitError):
        mgr.spawn(cmd="x.exe")
    gate.set()
    info = await asyncio.wait_for(first, timeout=10)
    assert mgr.get(info.id) is not None
    assert mgr._spawning == 0
    mgr._sessions.clear()


async def test_cancelled_spawn_async_still_registers_its_session(monkeypatch):
    gate = threading.Event()
    entered = threading.Event()

    class _BlockingPty(_RecordingPty):
        def __init__(self, *args, **kwargs):
            entered.set()
            gate.wait(10)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(session_manager, "PtySession", _BlockingPty)
    mgr = SessionManager(asyncio.get_running_loop())
    request = asyncio.ensure_future(mgr.spawn_async(cmd="x.exe"))
    await _wait_for(entered.is_set)
    request.cancel()
    gate.set()
    # The process exists, so it must be visible (and reapable), not orphaned.
    await _wait_for(lambda: len(mgr.list()) == 1)
    assert mgr._spawning == 0
    mgr._sessions.clear()
