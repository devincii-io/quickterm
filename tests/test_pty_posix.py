"""POSIX PTY backend under load and on kill (issues #9, #10, #12 to #15, #22, #41)."""

import asyncio
import os
import time

import pytest

pytestmark = pytest.mark.skipif(os.name == "nt", reason="POSIX PTY backend")

if os.name != "nt":
    from quickterm import process_usage, pty_posix
    from quickterm.pty_posix import PtySession


class Recorder:
    """Collects callbacks in order, so a test can check what came last."""

    def __init__(self) -> None:
        self.events: list[tuple[str, object]] = []
        self.exited = asyncio.Event()

    def on_output(self, data: bytes) -> None:
        self.events.append(("out", data))

    def on_exit(self, code: int) -> None:
        self.events.append(("exit", code))
        self.exited.set()

    @property
    def chunks(self) -> list[bytes]:
        return [data for kind, data in self.events if kind == "out"]

    @property
    def output(self) -> bytes:
        return b"".join(self.chunks)

    async def wait_for(self, marker: bytes, timeout: float = 5.0) -> None:
        deadline = time.monotonic() + timeout
        while marker not in self.output:
            if time.monotonic() > deadline:
                raise AssertionError(f"{marker!r} not in {self.output[-400:]!r}")
            await asyncio.sleep(0.02)


def _spawn(cmd, args, rec, env=None, cwd=None):
    return PtySession(
        cmd, args, cwd, env or {}, 80, 24, asyncio.get_running_loop(),
        on_output=rec.on_output, on_exit=rec.on_exit,
    )


def _cleanup(session) -> None:
    if session.alive:
        session.kill()


async def _wait_until(predicate, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached in time")
        await asyncio.sleep(0.02)


@pytest.mark.parametrize(
    "script",
    ["stty raw -echo; sleep 1", "sleep 1"],
    ids=["raw-mode", "canonical"],
)
async def test_a_child_that_never_reads_blocks_neither_resize_nor_exit(script):
    """#9: the writer used to hold the fd lock inside a blocking write(2)."""
    rec = Recorder()
    session = _spawn("/bin/sh", ["-c", script], rec)
    try:
        await asyncio.sleep(0.2)  # let stty switch modes before the flood
        line = b"x" * 1023 + b"\n"
        for _ in range(32):  # 2 MB in 32 queue items
            session.write(line * 64)
        await asyncio.sleep(0.3)  # the input buffer is full by now

        started = time.monotonic()
        session.resize(100, 40)
        assert time.monotonic() - started < 0.1

        await asyncio.wait_for(rec.exited.wait(), timeout=5)
        assert session.alive is False
        await _wait_until(lambda: not session._writer.is_alive(), timeout=2)
    finally:
        _cleanup(session)


async def test_exit_is_reported_while_a_background_job_holds_the_terminal():
    """#14: exit used to wait for EOF, i.e. for the background job to end."""
    rec = Recorder()
    started = time.monotonic()
    # set -m gives the job its own process group, as an interactive shell
    # does; otherwise the hangup at the shell's exit would end it at once.
    session = _spawn("/bin/sh", ["-c", "set -m; sleep 5 & echo job=$!; exit 4"], rec)
    try:
        await asyncio.wait_for(rec.exited.wait(), timeout=3)
        assert time.monotonic() - started < 1.5
        assert session.exit_code == 4
        assert rec.events[-1] == ("exit", 4)
    finally:
        _cleanup(session)
        for word in rec.output.split():
            if word.startswith(b"job="):
                try:
                    os.kill(int(word[4:]), 9)
                except (ProcessLookupError, ValueError):
                    pass


async def test_on_exit_is_posted_once_after_the_final_output():
    rec = Recorder()
    session = _spawn("/bin/sh", ["-c", "printf last_words"], rec)
    await asyncio.wait_for(rec.exited.wait(), timeout=5)
    await asyncio.sleep(0.2)  # a second on_exit would have arrived by now
    assert [kind for kind, _ in rec.events].count("exit") == 1
    assert rec.events[-1] == ("exit", 0)
    assert b"last_words" in rec.output
    assert session._fd == -1  # the watcher closed the master after the last read


async def test_a_second_session_does_not_inherit_the_first_sessions_master():
    """#15: pty.fork returns an inheritable master."""
    first = Recorder()
    a = _spawn("/bin/sh", ["-c", "sleep 5"], first)
    second = Recorder()
    b = None
    try:
        assert os.get_inheritable(a._fd) is False
        b = _spawn("/bin/sh", ["-c", "ls -l /proc/$$/fd"], second)
        await asyncio.wait_for(second.exited.wait(), timeout=5)
        assert b"/dev/pts/" in second.output  # the listing ran
        assert b"ptmx" not in second.output
    finally:
        _cleanup(a)
        if b is not None:
            _cleanup(b)


async def test_yes_output_arrives_in_coalesced_chunks():
    """#10: one callback per read(2) (at most ~4 KiB from a pty) flooded the fan-out."""
    rec = Recorder()
    session = _spawn("/bin/sh", ["-c", "yes | head -c 4000000"], rec)
    try:
        await asyncio.wait_for(rec.exited.wait(), timeout=15)
    finally:
        _cleanup(session)
    total = sum(len(chunk) for chunk in rec.chunks)
    assert total >= 4_000_000  # ONLCR makes every "\n" a "\r\n"
    assert max(len(chunk) for chunk in rec.chunks) <= pty_posix.READ_COALESCE_BYTES
    assert total / len(rec.chunks) > 2 * 4096


async def test_kill_takes_down_background_and_hup_ignoring_jobs(tmp_path):
    """#12: only the leader's process group was signalled, and jobs have their own."""
    rec = Recorder()
    session = _spawn("bash", ["--norc", "--noprofile", "-i"], rec, cwd=str(tmp_path))
    try:
        await asyncio.sleep(0.3)
        session.write(b"sleep 60 &\n")
        session.write(b"sh -c 'trap \"\" HUP; exec sleep 61'\n")

        def job_groups() -> set[int]:
            members = process_usage.session_process_groups(session.pid) or {}
            return set(members.values())

        await _wait_until(lambda: len(job_groups()) >= 3)  # bash + two jobs

        started = time.monotonic()
        assert session.kill() is True
        assert time.monotonic() - started < 2.0
        assert session.alive is False
        assert process_usage.session_process_groups(session.pid) == {}
        await asyncio.wait_for(rec.exited.wait(), timeout=3)
    finally:
        _cleanup(session)


async def test_kill_that_is_denied_reports_failure_and_keeps_input_working(monkeypatch):
    """#13 and #22: EPERM must not count as a kill, and the writer must survive it."""
    rec = Recorder()
    session = _spawn("/bin/sh", [], rec)
    try:
        await asyncio.sleep(0.3)

        def denied(*_args):
            raise PermissionError(1, "Operation not permitted")

        monkeypatch.setattr(pty_posix.os, "killpg", denied)
        monkeypatch.setattr(pty_posix.os, "kill", denied)
        monkeypatch.setattr(pty_posix, "_KILL_VERIFY_S", 0.3)

        assert session.kill() is False
        monkeypatch.undo()

        assert session.alive is True
        assert session._writer.is_alive()
        session.write(b"echo still_here_42\n")
        await rec.wait_for(b"still_here_42\r\n")
        assert session.kill() is True
    finally:
        _cleanup(session)


async def test_kill_without_proc_falls_back_to_the_leaders_group(monkeypatch):
    rec = Recorder()
    session = _spawn("/bin/sh", ["-c", "sleep 30"], rec)
    try:
        monkeypatch.setattr(process_usage, "session_process_groups", lambda _sid: None)
        assert session.kill() is True
        assert session.alive is False
        assert session.exit_code == 128 + 9
    finally:
        _cleanup(session)


async def test_sessions_advertise_xterm_whatever_started_the_backend(monkeypatch):
    """#41: TERM=dumb from an IDE console used to reach every shell."""
    monkeypatch.setenv("TERM", "dumb")
    monkeypatch.delenv("COLORTERM", raising=False)
    rec = Recorder()
    _spawn("/bin/sh", ["-c", 'echo "[$TERM $COLORTERM]"'], rec)
    await asyncio.wait_for(rec.exited.wait(), timeout=5)
    assert b"[xterm-256color truecolor]" in rec.output

    override = Recorder()
    _spawn("/bin/sh", ["-c", 'echo "[$TERM]"'], override, env={"TERM": "vt100"})
    await asyncio.wait_for(override.exited.wait(), timeout=5)
    assert b"[vt100]" in override.output


def test_missing_command_is_a_file_not_found_error():
    loop = asyncio.new_event_loop()
    try:
        with pytest.raises(FileNotFoundError, match="command not found: no-such-cmd-qt"):
            PtySession(
                "no-such-cmd-qt", [], None, {}, 80, 24, loop,
                on_output=lambda _d: None, on_exit=lambda _c: None,
            )
    finally:
        loop.close()


async def test_a_kill_retry_after_a_failed_kill_verifies_the_whole_session(monkeypatch, tmp_path):
    """The shell dies in a failed kill; a retry must not pass on the dead shell alone."""
    rec = Recorder()
    session = _spawn("bash", ["--norc", "--noprofile", "-i"], rec, cwd=str(tmp_path))
    try:
        await asyncio.sleep(0.3)
        session.write(b"sh -c 'trap \"\" HUP; exec sleep 60' &\n")

        def job_groups() -> set[int]:
            members = process_usage.session_process_groups(session.pid) or {}
            return set(members.values()) - {session.pid}

        await _wait_until(lambda: len(job_groups()) == 1)
        (job,) = job_groups()
        real_killpg = os.killpg

        def job_refuses(group, sig):
            if group == job:
                raise PermissionError(1, "Operation not permitted")  # a sudo child
            real_killpg(group, sig)

        monkeypatch.setattr(pty_posix.os, "killpg", job_refuses)
        monkeypatch.setattr(pty_posix, "_KILL_VERIFY_S", 0.3)
        assert session.kill() is False
        await asyncio.wait_for(rec.exited.wait(), timeout=3)  # the shell is gone
        assert session.alive is False
        assert session.kill() is False  # the job is not
        assert job_groups() == {job}

        monkeypatch.undo()
        assert session.kill() is True
        assert process_usage.session_process_groups(session.pid) == {}
    finally:
        monkeypatch.undo()
        _cleanup(session)
        for pid in (process_usage.session_process_groups(session.pid) or {}):
            os.kill(pid, 9)


async def test_a_shell_that_exited_on_its_own_leaves_its_jobs_alone():
    rec = Recorder()
    session = _spawn("/bin/sh", ["-c", "set -m; sleep 30 & echo job=$!; exit 0"], rec)
    await asyncio.wait_for(rec.exited.wait(), timeout=3)
    job = int(rec.output.split(b"job=")[1].split()[0])
    try:
        assert session.kill() is True
        assert job in (process_usage.session_process_groups(session.pid) or {})
    finally:
        os.kill(job, 9)
