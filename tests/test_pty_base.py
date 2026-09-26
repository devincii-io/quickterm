"""Plumbing both PTY backends share (issues #20, #31, #41, #43)."""

import asyncio
import os
import threading
import time
from types import SimpleNamespace

import pytest

from quickterm import pty_base
from quickterm.pty_base import PtyBase, merge_environment, path_value


def _fake_os(monkeypatch, name, environ):
    monkeypatch.setattr(pty_base, "os", SimpleNamespace(name=name, environ=dict(environ)))


def test_windows_merge_replaces_path_whatever_its_spelling(monkeypatch):
    # CPython upper-cases os.environ keys on Windows, the profile says "Path".
    _fake_os(monkeypatch, "nt", {"PATH": r"C:\Windows\System32", "TEMP": r"C:\t"})

    merged = merge_environment({"Path": r"C:\tools;C:\Windows\System32"})

    assert [k for k in merged if k.casefold() == "path"] == ["Path"]
    assert merged["Path"] == r"C:\tools;C:\Windows\System32"
    assert merged["TEMP"] == r"C:\t"
    assert path_value(merged) == r"C:\tools;C:\Windows\System32"
    # Windows leaves TERM alone: ConPTY and the profile decide.
    assert "TERM" not in merged


def test_windows_path_lookup_without_any_path_defers_to_shutil(monkeypatch):
    _fake_os(monkeypatch, "nt", {"TEMP": r"C:\t"})
    assert path_value(merge_environment({})) is None


def test_posix_merge_pins_the_terminal_type_below_the_profile(monkeypatch):
    _fake_os(monkeypatch, "posix", {"PATH": "/bin", "TERM": "dumb", "path": "x"})

    merged = merge_environment({})
    assert merged["TERM"] == "xterm-256color"
    assert merged["COLORTERM"] == "truecolor"
    # POSIX names are case-sensitive: nothing is folded.
    assert merged["path"] == "x"
    assert path_value(merged) == "/bin"

    assert merge_environment({"TERM": "vt100"})["TERM"] == "vt100"


@pytest.mark.skipif(os.name != "nt", reason="real os.environ case folding is Windows-only")
def test_real_windows_environment_merges_case_insensitively(monkeypatch):
    monkeypatch.setenv("QT_MERGE_PROBE", "inherited")
    merged = merge_environment({"qt_merge_probe": "profile"})
    assert [k for k in merged if k.casefold() == "qt_merge_probe"] == ["qt_merge_probe"]
    assert merged["qt_merge_probe"] == "profile"


def _wait_for(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline, "condition not reached in time"
        time.sleep(0.005)


class FakePty(PtyBase):
    """A PtyBase whose raw write can be held, to fill the queue on purpose."""

    def __init__(self, loop=None) -> None:
        super().__init__(loop, lambda _d: None, lambda _c: None)
        self.writes: list[bytes] = []
        self.release = threading.Event()
        self.entered = threading.Event()
        self.fail = False

    def _do_write(self, data: bytes) -> bool:
        self.entered.set()
        self.release.wait(5)
        self.writes.append(data)
        return not self.fail


def test_queued_input_is_coalesced_into_one_write():
    pty = FakePty()
    pty._start_writer("test-writer")
    pty.write(b"first")
    assert pty.entered.wait(2)  # the writer now holds "first"
    for i in range(10):
        pty.write(b"k%d" % i)
    pty.release.set()
    _wait_for(lambda: len(pty.writes) == 2)
    assert pty.writes == [b"first", b"".join(b"k%d" % i for i in range(10))]


def test_a_single_write_is_capped_near_the_coalescing_limit():
    pty = FakePty()
    pty.release.set()
    big = b"x" * (200 * 1024)
    for _ in range(3):
        pty.write(big)
    pty._start_writer("test-writer")
    _wait_for(lambda: sum(map(len, pty.writes)) == len(big) * 3)
    assert b"".join(pty.writes) == big * 3
    assert len(pty.writes) == 2  # 200 KiB + 200 KiB crosses 256 KiB, the third waits


def test_full_queue_raises_buffer_error_and_stop_still_ends_the_writer():
    pty = FakePty()
    pty._start_writer("test-writer")
    pty.write(b"held")
    assert pty.entered.wait(2)
    for _ in range(pty_base.WRITE_QUEUE_ITEMS):
        pty.write(b"q")
    with pytest.raises(BufferError):
        pty.write(b"one too many")

    pty._stop_writer()  # no room for the stop token; the flag must do it
    pty.release.set()
    pty._writer.join(2)
    assert not pty._writer.is_alive()
    assert pty.writes == [b"held"]  # nothing is written to a stopped PTY

    pty.write(b"after stop")  # dropped, not queued and not raised
    assert pty._write_q.qsize() <= pty_base.WRITE_QUEUE_ITEMS


def test_a_dead_pty_closes_input():
    pty = FakePty()
    pty.fail = True
    pty.release.set()
    pty._start_writer("test-writer")
    pty.write(b"lost")
    pty._writer.join(2)
    assert not pty._writer.is_alive()
    assert pty._input_closed.is_set()
    pty.write(b"ignored")
    assert pty._write_q.empty()


def test_post_tolerates_a_closed_loop():
    loop = asyncio.new_event_loop()
    loop.close()
    pty = FakePty(loop)
    pty._post(lambda _arg: None, 1)  # must not raise
