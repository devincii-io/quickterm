import asyncio

from quickterm.pty_session import PtySession


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
    sess, chunks, exited, codes = await _spawn("cmd.exe", ["/c", "echo hi"])
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
    sess, _, exited, codes = await _spawn("cmd.exe", ["/c", "exit 3"])
    await asyncio.wait_for(exited.wait(), timeout=15)
    assert codes == [3]
    assert sess.exit_code == 3


async def test_write_reaches_process():
    # cmd waits on stdin; write a command, expect its output
    sess, chunks, exited, _ = await _spawn("cmd.exe", ["/q", "/k"])
    await asyncio.sleep(0.5)
    assert sess.alive
    sess.write(b"echo marker_xyz\r\n")

    async def saw_marker() -> None:
        while b"marker_xyz" not in b"".join(chunks):
            await asyncio.sleep(0.05)

    await asyncio.wait_for(saw_marker(), timeout=10)
    sess.write(b"exit\r\n")
    await asyncio.wait_for(exited.wait(), timeout=15)


async def test_kill_terminates_tree():
    sess, _, exited, _ = await _spawn("cmd.exe", ["/q", "/k"])
    await asyncio.sleep(0.3)
    assert sess.alive
    sess.kill()
    await asyncio.wait_for(exited.wait(), timeout=15)
    assert sess.alive is False
    assert sess.exit_code is not None
