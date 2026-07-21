import asyncio
import os

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
