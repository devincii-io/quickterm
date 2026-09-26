import asyncio
import ctypes
import logging
import os
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest

from quickterm import process_usage

if os.name == "nt":
    from ctypes import wintypes

    import winpty

    import quickterm.pty_session as pty_module
    from quickterm.pty_session import PtySession
else:
    from quickterm.pty_posix import PtySession

windows_only = pytest.mark.skipif(os.name != "nt", reason="ConPTY backend")
# Upper bound for a real child to start, print or exit. It only limits how long
# a failing test waits; a passing one returns as soon as the event happens. A
# machine busy with other work took over 5 s to start cmd.exe, and the old
# 5-15 s bounds turned that into random failures.
_SLOW_S = 60
posix_only = pytest.mark.skipif(os.name == "nt", reason="POSIX backend")


@windows_only
def test_raw_io_debug_requires_exact_opt_in(monkeypatch):
    monkeypatch.setenv("QUICKTERM_DEBUG_IO", "0")
    assert pty_module._debug_io_enabled() is False
    monkeypatch.setenv("QUICKTERM_DEBUG_IO", "1")
    assert pty_module._debug_io_enabled() is True


@windows_only
def test_gui_host_console_is_allocated_hidden_and_reused(monkeypatch):
    calls: list[object] = []
    windows = iter([0, 1234])

    class GetConsoleWindow:
        restype = None

        def __call__(self):
            calls.append("get")
            return next(windows)

    fake_windll = SimpleNamespace(
        kernel32=SimpleNamespace(
            GetConsoleWindow=GetConsoleWindow(),
            AllocConsole=lambda: calls.append("alloc") or 1,
        ),
        user32=SimpleNamespace(
            ShowWindow=lambda window, mode: calls.append(("hide", window, mode))
        ),
    )
    monkeypatch.setattr(pty_module.ctypes, "windll", fake_windll)
    monkeypatch.setattr(pty_module, "_HOST_CONSOLE_READY", False)

    pty_module._ensure_host_console()
    pty_module._ensure_host_console()

    assert calls == ["get", "alloc", "get", ("hide", 1234, 0)]


@windows_only
def test_write_failure_is_available_in_debug_log(caplog):
    class BrokenPty:
        def write(self, _text):
            raise RuntimeError("write broke")

    session = object.__new__(PtySession)
    session._pid = 4242
    session._pty = BrokenPty()
    with caplog.at_level(logging.DEBUG, logger="quickterm.pty_session"):
        session._do_write(b"hello")
    assert "PTY write failed for process 4242" in caplog.text
    assert "write broke" in caplog.text


def _short(script: str) -> tuple[str, list[str]]:
    if os.name == "nt":
        return "cmd.exe", ["/c", script]
    return "/bin/sh", ["-c", script]


def _interactive() -> tuple[str, list[str], bytes]:
    if os.name == "nt":
        return "cmd.exe", ["/q", "/k"], b"\r\n"
    return "/bin/sh", [], b"\n"


async def _spawn(cmd, args, cols=80, rows=25):
    loop = asyncio.get_running_loop()
    chunks: list[bytes] = []
    exited = asyncio.Event()
    codes: list[int] = []

    def on_exit(code: int) -> None:
        codes.append(code)
        exited.set()

    sess = PtySession(
        cmd, args, None, {}, cols, rows, loop,
        on_output=chunks.append, on_exit=on_exit,
    )
    return sess, chunks, exited, codes


async def test_echo_output_exit_and_resize():
    cmd, args = _short("echo hi")
    sess, chunks, exited, codes = await _spawn(cmd, args)
    assert sess.pid > 0
    sess.resize(100, 40)  # live resize
    await asyncio.wait_for(exited.wait(), timeout=_SLOW_S)
    out = b"".join(chunks)
    assert b"hi" in out
    assert codes == [0]
    assert sess.exit_code == 0
    assert sess.alive is False
    sess.resize(80, 25)  # after death: no-op, no raise


async def test_nonzero_exit_code():
    cmd, args = _short("exit 3")
    sess, _, exited, codes = await _spawn(cmd, args)
    await asyncio.wait_for(exited.wait(), timeout=_SLOW_S)
    assert codes == [3]
    assert sess.exit_code == 3


async def test_write_reaches_process():
    cmd, args, newline = _interactive()
    sess, chunks, exited, _ = await _spawn(cmd, args)
    await asyncio.sleep(0.5)
    assert sess.alive
    sess.write(b"echo marker_xyz" + newline)

    async def saw_marker() -> None:
        while b"marker_xyz" not in b"".join(chunks):
            await asyncio.sleep(0.05)

    await asyncio.wait_for(saw_marker(), timeout=_SLOW_S)
    sess.write(b"exit" + newline)
    await asyncio.wait_for(exited.wait(), timeout=_SLOW_S)


async def test_kill_terminates_tree():
    cmd, args, _ = _interactive()
    sess, _, exited, _ = await _spawn(cmd, args)
    await asyncio.sleep(0.3)
    assert sess.alive
    sess.kill()
    await asyncio.wait_for(exited.wait(), timeout=_SLOW_S)
    assert sess.alive is False
    assert sess.exit_code is not None


@posix_only
async def test_kill_reports_verified_termination():
    """kill() returns True only once the process is really gone.

    The EPERM case, where it must return False, is in test_pty_posix.py.
    """
    loop = asyncio.get_running_loop()
    session = PtySession(
        "sleep", ["5"], None, {}, 80, 24, loop,
        on_output=lambda data: None, on_exit=lambda code: None,
    )
    try:
        assert session.kill() is True
        assert session.alive is False
    finally:
        if session.alive:
            session.kill()


@posix_only
async def test_resize_after_exit_does_not_touch_a_recycled_descriptor():
    """The watcher closes the fd and clears it; resize must not use a stale one."""
    loop = asyncio.get_running_loop()
    exited = asyncio.Event()
    session = PtySession(
        "true", [], None, {}, 80, 24, loop,
        on_output=lambda data: None, on_exit=lambda code: exited.set(),
    )
    await asyncio.wait_for(exited.wait(), timeout=_SLOW_S)
    assert session.alive is False
    assert session._fd == -1
    session.resize(120, 40)  # must be a silent no-op, not an ioctl on a reused fd


@windows_only
def test_taskkill_runs_by_absolute_path():
    command = pty_module._taskkill_command(4242)
    system32 = os.path.join(os.environ["SystemRoot"], "System32")
    assert os.path.isabs(command[0])
    assert os.path.normcase(command[0]) == os.path.normcase(os.path.join(system32, "taskkill.exe"))
    assert command[1:] == ["/T", "/F", "/PID", "4242"]


@windows_only
def test_winpty_spawn_failure_is_an_os_error(monkeypatch):
    class FailingPty:
        def __init__(self, cols, rows):
            pass

        def spawn(self, *args, **kwargs):
            raise winpty.WinptyError("the directory name is invalid")

    monkeypatch.setattr(pty_module.winpty, "PTY", FailingPty)
    loop = asyncio.new_event_loop()
    try:
        with pytest.raises(OSError, match="could not start cmd.exe: the directory name"):
            PtySession(
                "cmd.exe", [], None, {}, 80, 24, loop,
                on_output=lambda _d: None, on_exit=lambda _c: None,
            )
    finally:
        loop.close()


def test_missing_command_is_file_not_found():
    loop = asyncio.new_event_loop()
    try:
        with pytest.raises(FileNotFoundError, match="command not found: no-such-cmd-qt"):
            PtySession(
                "no-such-cmd-qt", [], None, {}, 80, 24, loop,
                on_output=lambda _d: None, on_exit=lambda _c: None,
            )
    finally:
        loop.close()


async def _session_with_child(script="import time; time.sleep(30)", count=1):
    """An interactive shell running a long foreground Python child."""
    cmd, args, newline = _interactive()
    sess, chunks, exited, _ = await _spawn(cmd, args)
    await asyncio.sleep(0.3)
    sess.write(f'"{sys.executable}" -c "{script}"'.encode() + newline)
    deadline = time.monotonic() + _SLOW_S
    while True:
        identities = process_usage.process_identities()
        below = process_usage.descendants(identities, sess.pid)
        if len(below) >= count:
            return sess, exited, below, identities
        assert time.monotonic() < deadline, "the child never started"
        await asyncio.sleep(0.05)


async def test_kill_verifies_the_whole_tree():
    sess, exited, below, _ = await _session_with_child()
    assert sess.kill() is True
    if os.name == "nt":
        alive = {pid for pid, _parent in process_usage.process_identities()}
        assert not (below & alive)
    else:
        # Killed children may linger as zombies until reaped; they are not alive.
        assert process_usage.session_process_groups(sess.pid) == {}
    await asyncio.wait_for(exited.wait(), timeout=_SLOW_S)


@windows_only
async def test_kill_reports_a_descendant_that_survives_and_a_retry_verifies_it(monkeypatch):
    """#38 and the retry after a failed kill.

    A descendant taskkill could not stop went unnoticed once the root died;
    one whose parent exited during the kill was dropped from verification;
    and a retry passed on the dead root alone while the descendant ran on.
    """
    # The grandchild is detached from the console, so closing the ConPTY does
    # not take it down with the root; only an explicit kill does.
    spawner = (
        "import subprocess,sys,time;"
        " subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],creationflags=8);"
        " time.sleep(30)"
    )
    sess, exited, below, identities = await _session_with_child(spawner, count=2)
    (grandchild,) = [pid for pid, parent in identities if pid in below and parent != sess.pid]
    real_terminate = pty_module._k32.TerminateProcess
    real_identities = process_usage.process_identities
    get_pid = ctypes.WinDLL("kernel32").GetProcessId
    get_pid.argtypes = (wintypes.HANDLE,)
    get_pid.restype = wintypes.DWORD
    snapshots = []

    def terminate_all_but_grandchild(handle, code):
        if get_pid(handle) == grandchild:
            return 1  # pretend, like an elevated child that denies us
        return real_terminate(handle, code)

    def parent_exits_after_the_first_snapshot():
        # From the second snapshot on, the grandchild's parent is gone and it
        # is no longer below the root, which taskkill /T cannot see either.
        table = real_identities()
        snapshots.append(table)
        if len(snapshots) == 1:
            return table
        return [(pid, 0 if pid == grandchild else parent) for pid, parent in table]

    monkeypatch.setattr(pty_module.subprocess, "run", lambda *a, **k: None)
    monkeypatch.setattr(pty_module._k32, "TerminateProcess", terminate_all_but_grandchild)
    monkeypatch.setattr(process_usage, "process_identities", parent_exits_after_the_first_snapshot)
    monkeypatch.setattr(pty_module, "_KILL_WAIT_S", 0.3)
    monkeypatch.setattr(pty_module, "_TERMINATE_WAIT_S", 0.3)
    try:
        assert sess.kill() is False
        await asyncio.wait_for(exited.wait(), timeout=_SLOW_S)  # the root is gone
        assert sess.alive is False
        assert sess.kill() is False  # the grandchild is not
        monkeypatch.undo()
        assert sess.kill() is True
        assert grandchild not in {pid for pid, _parent in process_usage.process_identities()}
    finally:
        monkeypatch.undo()
        subprocess.run(pty_module._taskkill_command(grandchild), capture_output=True)


@windows_only
async def test_kill_never_addresses_a_root_known_to_be_dead(monkeypatch):
    """The root's PID must not be reopened or passed to taskkill once it exited.

    The watcher used to close the root handle before flagging the exit, and
    kill() reopened the root by PID number: a PID reused in between would
    have had an unrelated process tree killed.
    """
    # Hold the watcher back so the root is dead but not yet flagged dead.
    monkeypatch.setattr(PtySession, "_watch_exit", lambda self: None)
    calls = []
    monkeypatch.setattr(pty_module.subprocess, "run", lambda *a, **k: calls.append(a))
    cmd, args = _short("exit 0")
    sess, _, _, _ = await _spawn(cmd, args)
    try:
        assert pty_module._k32.WaitForSingleObject(sess._hproc, int(_SLOW_S * 1000)) == 0
        assert sess.alive is True  # nobody has told the session yet
        assert sess.kill() is True
        assert calls == []
    finally:
        sess._proc_dead.set()
        try:
            sess._pty.cancel_io()
        except winpty.WinptyError:
            pass
        pty_module._k32.CloseHandle(sess._hproc)


@windows_only
async def test_failed_kill_keeps_the_terminal_usable(monkeypatch):
    cmd, args, newline = _interactive()
    sess, chunks, exited, _ = await _spawn(cmd, args)
    await asyncio.sleep(0.3)
    monkeypatch.setattr(pty_module.subprocess, "run", lambda *a, **k: None)
    monkeypatch.setattr(pty_module._k32, "TerminateProcess", lambda handle, code: 1)
    monkeypatch.setattr(pty_module, "_KILL_WAIT_S", 0.2)
    monkeypatch.setattr(pty_module, "_TERMINATE_WAIT_S", 0.2)
    try:
        assert sess.kill() is False
    finally:
        monkeypatch.undo()
    assert sess.alive
    sess.write(b"echo still_here_42" + newline)

    async def saw_marker() -> None:
        while b"still_here_42\r\n" not in b"".join(chunks):
            await asyncio.sleep(0.05)

    await asyncio.wait_for(saw_marker(), timeout=_SLOW_S)
    assert sess.kill() is True
    await asyncio.wait_for(exited.wait(), timeout=_SLOW_S)


@windows_only
async def test_kill_passes_a_safe_working_directory(monkeypatch):
    """#11: taskkill must not start in QuickTerm's (possibly untrusted) cwd."""
    calls = []
    real_run = subprocess.run

    def recording_run(command, **kwargs):
        calls.append((command, kwargs))
        return real_run(command, **kwargs)

    monkeypatch.setattr(pty_module.subprocess, "run", recording_run)
    cmd, args, _ = _interactive()
    sess, _, exited, _ = await _spawn(cmd, args)
    await asyncio.sleep(0.3)
    assert sess.kill() is True
    (command, kwargs), = calls
    assert os.path.isabs(command[0])
    assert os.path.normcase(kwargs["cwd"]) == os.path.normcase(os.environ["SystemRoot"])
    await asyncio.wait_for(exited.wait(), timeout=_SLOW_S)
