import asyncio
import logging
import os
from types import SimpleNamespace

if os.name == "nt":
    import quickterm.pty_session as pty_module
    from quickterm.pty_session import PtySession
else:
    from quickterm.pty_posix import PtySession


def test_raw_io_debug_requires_exact_opt_in(monkeypatch):
    if os.name != "nt":
        return
    monkeypatch.setenv("QUICKTERM_DEBUG_IO", "0")
    assert pty_module._debug_io_enabled() is False
    monkeypatch.setenv("QUICKTERM_DEBUG_IO", "1")
    assert pty_module._debug_io_enabled() is True


def test_gui_host_console_is_allocated_hidden_and_reused(monkeypatch):
    if os.name != "nt":
        return

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


def test_write_failure_is_available_in_debug_log(caplog):
    if os.name != "nt":
        return

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
    await asyncio.wait_for(exited.wait(), timeout=15)
    out = b"".join(chunks)
    assert b"hi" in out
    assert codes == [0]
    assert sess.exit_code == 0
    assert sess.alive is False
    sess.resize(80, 25)  # after death: no-op, no raise


async def test_nonzero_exit_code():
    cmd, args = _short("exit 3")
    sess, _, exited, codes = await _spawn(cmd, args)
    await asyncio.wait_for(exited.wait(), timeout=15)
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

    await asyncio.wait_for(saw_marker(), timeout=10)
    sess.write(b"exit" + newline)
    await asyncio.wait_for(exited.wait(), timeout=15)


async def test_kill_terminates_tree():
    cmd, args, _ = _interactive()
    sess, _, exited, _ = await _spawn(cmd, args)
    await asyncio.sleep(0.3)
    assert sess.alive
    sess.kill()
    await asyncio.wait_for(exited.wait(), timeout=15)
    assert sess.alive is False
    assert sess.exit_code is not None
