"""The output scanner behind "needs you" and the current folder."""

from __future__ import annotations

import base64

import pytest

from quickterm import signals
from quickterm.signals import NotifyThrottle, SignalScanner, clean_text, osc7_path


def feed_all(*chunks: bytes) -> list:
    scanner = SignalScanner()
    return [scanner.feed(chunk) for chunk in chunks]


def one(data: bytes):
    return SignalScanner().feed(data)


def test_plain_output_finds_nothing():
    assert one(b"hello world\r\n" * 100) is None
    assert one(b"\x1b[31mred\x1b[0m") is None
    assert one(b"") is None


def test_a_lone_bell_is_attention():
    found = one(b"done\x07")
    assert found.attention == "bell"
    assert found.text is None
    assert found.cwd is None


def test_a_bell_that_ends_an_osc_title_is_not_attention():
    assert one(b"\x1b]0;my title\x07prompt> ") is None
    assert one(b"\x1b]2;title\x1b\\") is None
    # An OSC 8 hyperlink carries two BEL-terminated strings.
    assert one(b"\x1b]8;;https://x\x07link\x1b]8;;\x07") is None


def test_a_bell_after_an_osc_string_still_counts():
    found = one(b"\x1b]0;title\x07then\x07")
    assert found.attention == "bell"


def test_osc9_is_a_notification_with_its_text():
    found = one(b"\x1b]9;Claude needs your permission\x07")
    assert found.attention == "notify"
    assert found.text == "Claude needs your permission"
    found = one(b"\x1b]9;3 tests failed\x1b\\")
    assert found.text == "3 tests failed"


@pytest.mark.parametrize("payload", [
    b"4;1;50",   # progress
    b"4;0",
    b"12",       # prompt mark
    b"1;500",    # sleep
    b"3;tab title",
])
def test_conemu_subcommands_are_not_notifications(payload):
    assert one(b"\x1b]9;" + payload + b"\x07") is None


def test_osc9_9_reports_the_current_folder():
    found = one(b'\x1b]9;9;"C:\\Users\\dev\\project"\x1b\\')
    assert found.attention is None
    assert found.cwd == "C:\\Users\\dev\\project"
    assert one(b"\x1b]9;9;C:\\work\x07").cwd == "C:\\work"


def test_osc777_notify_joins_title_and_body():
    found = one(b"\x1b]777;notify;Codex;Turn complete\x07")
    assert found.attention == "notify"
    assert found.text == "Codex: Turn complete"
    assert one(b"\x1b]777;notify;Only title\x07").text == "Only title"
    # Other 777 subcommands are not notifications.
    assert one(b"\x1b]777;precmd\x07") is None


def test_osc99_kitty_notification():
    assert one(b"\x1b]99;;Build finished\x1b\\").text == "Build finished"
    encoded = base64.b64encode("Grüße".encode()).decode().encode()
    assert one(b"\x1b]99;e=1;" + encoded + b"\x1b\\").text == "Grüße"
    # A chunk that says more is coming, and a close request, ask for nothing.
    assert one(b"\x1b]99;i=1:d=0;Title\x1b\\") is None
    assert one(b"\x1b]99;i=1:p=close;\x1b\\") is None


def test_notification_text_is_stripped_of_controls_and_bounded():
    found = one(b"\x1b]9;two\r\nlines\there\x7f\x07")
    assert found.text == "two lines here"
    # ESC ends the string, so an injected sequence never reaches the text.
    assert one(b"\x1b]9;bad\x1b[31m red").text == "bad"
    long = one(b"\x1b]9;" + b"x" * 1000 + b"\x07")
    assert len(long.text) == signals.TEXT_MAX_CHARS
    assert long.text.endswith("...")
    assert clean_text("a\tb\r\nc\x9bd") == "a b c d"


def test_latest_signal_wins_within_a_burst():
    found = one(b"\x1b]9;first\x07 \x07")
    assert found.attention == "bell"
    assert found.text is None
    found = one(b"\x07\x1b]9;second\x07")
    assert found.attention == "notify"
    assert found.text == "second"


def test_an_osc_split_across_bursts_is_joined():
    results = feed_all(b"out\x1b]9;wait", b"ing for you", b"\x07more")
    assert results[0] is None
    assert results[1] is None
    assert results[2].attention == "notify"
    assert results[2].text == "waiting for you"


def test_an_osc_opened_by_an_esc_at_the_end_of_a_burst():
    results = feed_all(b"text\x1b", b"]9;split intro\x07")
    assert results[0] is None
    assert results[1].text == "split intro"


def test_an_st_split_across_bursts_does_not_leak_a_bell():
    results = feed_all(b"\x1b]0;title\x1b", b"\\plain")
    assert results == [None, None]


def test_a_title_bel_in_the_next_burst_is_still_a_terminator():
    assert feed_all(b"\x1b]0;long ti", b"tle\x07") == [None, None]


def test_a_huge_osc_string_is_followed_without_being_kept():
    scanner = SignalScanner()
    assert scanner.feed(b"\x1b]52;c;" + b"A" * 200_000) is None
    assert len(scanner._head) <= signals._HEAD_CAP
    assert scanner.feed(b"B" * 200_000) is None
    assert len(scanner._head) <= signals._HEAD_CAP
    # The clipboard write ends; a later bell is a bell again.
    assert scanner.feed(b"\x07") is None
    assert scanner.feed(b"\x07").attention == "bell"


def test_an_esc_inside_an_osc_ends_it_and_starts_the_next_sequence():
    found = one(b"\x1b]0;broken\x1b]9;real\x07")
    assert found.text == "real"


def test_osc7_on_windows_maps_drive_paths_and_unc():
    assert osc7_path("file://localhost/C:/Users/dev%20x/p", windows=True) == "C:\\Users\\dev x\\p"
    assert osc7_path("file:///D:/", windows=True) == "D:\\"
    assert osc7_path("file:///D:", windows=True) == "D:\\"
    assert osc7_path("file://fileserver/share/dir", windows=True) == "\\\\fileserver\\share\\dir"
    # A local POSIX path (WSL, MSYS) stays as the shell said it.
    assert osc7_path("file:///home/dev", windows=True) == "/home/dev"
    assert osc7_path("https://example.com/x", windows=True) is None
    assert osc7_path("file://", windows=True) is None


def test_osc7_on_posix_ignores_the_host():
    assert osc7_path("file://some-box/home/dev/%C3%BC", windows=False) == "/home/dev/ü"
    assert osc7_path("kitty-shell-cwd://h/tmp", windows=False) == "/tmp"


def test_osc7_with_this_machines_name_is_local(monkeypatch):
    monkeypatch.setattr(signals, "_LOCAL_NAMES", {"", "localhost", "mybox"})
    assert osc7_path("file://MYBOX/C:/x", windows=True) == "C:\\x"
    assert osc7_path("file://mybox/srv", windows=True) == "/srv"


def test_osc7_in_a_burst_sets_the_folder(monkeypatch):
    monkeypatch.setattr(signals.os, "name", "posix")
    found = one(b"\x1b]7;file://host/home/dev/project\x1b\\$ ")
    assert found.cwd == "/home/dev/project"
    assert found.attention is None


def test_notify_throttle_allows_once_per_interval_per_key():
    now = [100.0]
    throttle = NotifyThrottle(30, clock=lambda: now[0])
    assert throttle.allow("a") is True
    assert throttle.allow("a") is False
    assert throttle.allow("b") is True
    now[0] += 29
    assert throttle.allow("a") is False
    now[0] += 2
    assert throttle.allow("a") is True
