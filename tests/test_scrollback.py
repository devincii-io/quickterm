"""Scrollback ring: bounded by bytes, a front that always starts cleanly, and
the DEC private modes that a replay has to restore."""

import random

import pytest

from quickterm.scrollback import ScrollbackRing


def _new(cap: int) -> ScrollbackRing:
    return ScrollbackRing(cap, 80, 24)


def _replay(s: ScrollbackRing) -> bytes:
    chunks, _, _ = s.snapshot()
    return b"".join(chunks)


def _retained(s: ScrollbackRing) -> bytes:
    """The retained ring without the synthesized mode preamble."""
    return _replay(s)[len(s.preamble()):]


# ---- deque scrollback ring ----


def test_ring_keeps_tail_within_cap():
    s = _new(10)
    s.record(b"abcde", 80, 24)
    s.record(b"fghij", 80, 24)
    s.record(b"klmno", 80, 24)
    chunks, cols, rows = s.snapshot()
    assert b"".join(chunks) == b"fghijklmno"  # last cap bytes only
    assert (cols, rows) == (80, 24)


def test_ring_oversized_single_chunk_trims_front():
    s = _new(4)
    s.record(b"0123456789", 80, 24)
    assert _replay(s) == b"6789"


def test_ring_partial_trim_of_oldest_chunk():
    s = _new(6)
    s.record(b"aaaaaa", 80, 24)  # exactly cap
    s.record(b"bb", 80, 24)      # overflow 2 -> trim 2 from the front of the oldest chunk
    assert _replay(s) == b"aaaabb"
    assert len(s) == 6


def test_ring_records_current_size_even_for_empty_write():
    s = _new(100)
    s.record(b"", 111, 22)  # no data, but size still refreshed
    _, cols, rows = s.snapshot()
    assert (cols, rows) == (111, 22)


def test_scrollback_chunk_snapshot_avoids_full_join():
    s = _new(100)
    s.record(b"abc", 80, 24)
    s.record(b"def", 80, 24)
    chunks, cols, rows = s.snapshot()
    assert chunks == (b"abc", b"def")
    assert (cols, rows) == (80, 24)


# ---- resizes replay at their place in the stream ----


def test_replay_puts_each_resize_between_the_output_around_it():
    s = _new(100)
    s.record(b"at 80", 80, 24)
    s.resize(120, 30)
    s.record(b"at 120", 120, 30)
    s.record(b"at 60", 60, 20)  # output that arrives with a new size marks it too
    assert s.replay() == ((b"at 80", (120, 30), b"at 120", (60, 20), b"at 60"), 80, 24)
    # snapshot() keeps its meaning: the chunks and the size now.
    assert s.snapshot() == ((b"at 80", b"at 120", b"at 60"), 60, 20)


def test_resizes_without_output_between_them_collapse_into_the_last():
    s = _new(100)
    s.record(b"a", 80, 24)
    for cols in range(81, 120):  # a splitter drag
        s.resize(cols, 24)
    s.resize(100, 24)
    assert s.replay() == ((b"a", (100, 24)), 80, 24)
    s.resize(80, 24)  # dragged back: nothing to replay
    assert s.replay() == ((b"a",), 80, 24)


def test_a_resize_after_the_last_output_is_replayed_last():
    s = _new(100)
    s.record(b"a", 80, 24)
    s.resize(100, 40)
    assert s.replay() == ((b"a", (100, 40)), 80, 24)


def test_resizes_that_leave_with_the_trimmed_front_become_the_start_size():
    s = _new(4)
    s.record(b"aa", 80, 24)
    s.resize(100, 30)
    s.record(b"bb", 100, 30)
    s.resize(120, 40)
    s.record(b"cc", 120, 40)  # "aa" leaves, and with it the need for (100, 30)
    assert s.replay() == ((b"bb", (120, 40), b"cc"), 100, 30)
    s.record(b"dd", 120, 40)
    assert s.replay() == ((b"cc", b"dd"), 120, 40)


def test_a_resize_on_an_empty_ring_is_just_the_start_size():
    s = _new(100)
    s.resize(100, 30)
    s.record(b"a", 100, 30)
    assert s.replay() == ((b"a",), 100, 30)


def test_replay_starts_with_the_mode_preamble_at_the_start_size():
    s = _new(8)
    s.record(b"\x1b[?2004h", 80, 24)
    s.resize(100, 30)
    s.record(b"abcdefgh", 100, 30)  # the mode sequence leaves the ring
    steps, cols, rows = s.replay()
    assert steps == (b"\x1b[?2004h", b"abcdefgh")
    assert (cols, rows) == (100, 30)


def test_replay_slices_a_partly_trimmed_front_chunk():
    s = _new(6)
    s.record(b"aaaaaa", 80, 24)
    s.resize(90, 24)
    s.record(b"bb", 90, 24)
    assert s.replay() == ((b"aaaa", (90, 24), b"bb"), 80, 24)


# ---- the ring front never starts inside a sequence ----


def test_trim_inside_csi_skips_to_the_end_of_the_sequence():
    s = _new(16)
    s.record(b"\x1b[38;5;196mred text here", 80, 24)  # 25 bytes: the cut lands in the CSI
    assert _replay(s) == b"red text here"


def test_trim_inside_osc_skips_past_its_terminator():
    s = _new(20)
    s.record(b"\x1b]0;a long window title\x07prompt> ", 80, 24)
    assert _replay(s) == b"prompt> "
    s = _new(20)
    s.record(b"\x1b]0;a long window title\x1b\\prompt> ", 80, 24)
    assert _replay(s) == b"prompt> "


def test_trim_inside_utf8_character_skips_continuation_bytes():
    s = _new(8)
    s.record("───".encode(), 80, 24)  # three 3-byte box characters
    ring = _replay(s)
    assert ring == "──".encode()
    ring.decode("utf-8")  # no partial character at the front


def test_trim_across_chunk_boundary_finds_the_enclosing_sequence():
    s = _new(12)
    s.record(b"text\x1b[38;5", 80, 24)  # the CSI starts in this chunk...
    s.record(b";196mhello", 80, 24)     # ...and ends in the next one
    s.record(b" world", 80, 24)
    assert _replay(s) == b"hello world"


def test_ring_front_always_lands_on_a_token_boundary():
    """Record a tokenized stream in random chunk sizes; after every trim the
    retained ring must begin exactly where some token began."""
    rng = random.Random(1604)
    tokens = [
        b"a", b"Z", b" ", b"\r", b"\n", "é".encode(), "─".encode(), "\U0001f600".encode(),
        b"\x1b[0m", b"\x1b[38;5;196m", b"\x1b[?2004h", b"\x1b[?1000;1006l", b"\x1b[2J",
        b"\x1b]0;window title\x07", b"\x1b]8;;https://example.com/x\x1b\\", b"\x1b7", b"\x1b(B",
    ]
    stream = [rng.choice(tokens) for _ in range(20000)]
    boundaries = {0}
    offset = 0
    for token in stream:
        offset += len(token)
        boundaries.add(offset)
    data = b"".join(stream)
    for cap in (37, 256, 1000):
        s = _new(cap)
        pos = 0
        while pos < len(data):
            size = rng.randint(1, 300)
            s.record(data[pos : pos + size], 80, 24)
            pos += size
            ring = _retained(s)
            front = min(pos, len(data)) - len(ring)
            assert data[front : front + len(ring)] == ring
            assert front in boundaries, (cap, front, ring[:24])


def test_ring_front_is_never_inside_a_long_string():
    """Like the fuzz above, with strings longer than the 4 KiB resync window
    (OSC 52 clipboard writes, sixel, inline images). An empty ring is fine
    while such a string is still arriving; payload replayed as text is not."""
    rng = random.Random(5202)
    short = [b"a", b"b", b" ", b"\r", b"\n", "─".encode(), b"\x1b[0m", b"\x1b[?2004h", b"\x1b]0;t\x07"]

    def long_string():
        body = bytes(rng.choice(b"ABCDEFGHIJKLMNOPQRSTUVWXYZ+/=") for _ in range(rng.randint(4000, 12000)))
        return rng.choice([
            b"\x1b]52;c;" + body + b"\x07",
            b"\x1b]52;c;" + body + b"\x1b\\",
            b"\x1bPq" + body + b"\x07more\x1b\\",  # BEL does not end a DCS
            b"\x1b_G" + body + b"\x1b\\",
        ])

    stream = [long_string() if rng.random() < 0.01 else rng.choice(short) for _ in range(12000)]
    boundaries = {0}
    offset = 0
    for token in stream:
        offset += len(token)
        boundaries.add(offset)
    data = b"".join(stream)
    for cap in (37, 3000, 64 * 1024):
        s = _new(cap)
        pos = 0
        while pos < len(data):
            size = rng.randint(1, 2000)
            s.record(data[pos : pos + size], 80, 24)
            pos = min(pos + size, len(data))
            ring = _retained(s)
            front = pos - len(ring)
            assert data[front:pos] == ring
            assert not ring or front in boundaries, (cap, front, ring[:24])


@pytest.mark.parametrize("terminator", [b"\x07", b"\x1b\\"])
@pytest.mark.parametrize("cut_kib", [2, 6, 9])
def test_trim_inside_a_long_osc_52_skips_the_whole_payload(terminator, cut_kib):
    prefix = b"$ yank\r\n"
    osc = b"\x1b]52;c;" + b"QUJD" * 2560 + terminator  # a 10 KiB clipboard write
    s = _new(64 * 1024)
    s.record(prefix + osc[:4000], 80, 24)
    s.record(osc[4000:], 80, 24)  # the string straddles a chunk boundary
    s.record(b"prompt> ", 80, 24)
    s.set_cap(len(s) - len(prefix) - cut_kib * 1024)
    assert _replay(s) == b"prompt> "


def test_dcs_payload_bel_does_not_end_the_string():
    s = _new(1000)
    s.record(b"\x1bPq" + b"#0;2;0;0;0" * 600 + b"\x07still sixel\x1b\\after", 80, 24)
    s.set_cap(100)
    assert _replay(s) == b"after"


def test_unterminated_string_empties_the_ring_until_it_ends():
    s = _new(64)
    s.record(b"\x1b]52;c;" + b"QUJD" * 100, 80, 24)  # over the cap, no terminator yet
    assert _replay(s) == b""
    s.record(b"QUJD" * 4, 80, 24)  # below the cap, but still payload
    assert _replay(s) == b""
    s.record(b"QUJD\x07prompt> ", 80, 24)
    assert _replay(s) == b"prompt> "
    s.record(b"ls\r\n", 80, 24)
    assert _replay(s) == b"prompt> ls\r\n"


def test_cut_right_after_the_esc_that_opens_a_string():
    s = _new(10000)
    s.record(b"x" * 16 + b"\x1b", 80, 24)  # the trimmed bytes end with this ESC
    s.record(b"]52;c;" + b"QUJD" * 1500 + b"\x07tail", 80, 24)
    s.set_cap(len(s) - 17)
    assert _replay(s) == b"tail"


def test_string_ended_by_a_plain_esc_keeps_that_esc_as_the_front():
    s = _new(10000)
    s.record(b"\x1b]52;c;" + b"QUJD" * 1500 + b"\x1b[1mbold", 80, 24)
    s.set_cap(100)
    assert _replay(s) == b"\x1b[1mbold"
    assert s._modes.state == 0


def test_oversized_mode_parameters_do_not_break_recording():
    s = _new(10000)
    s.record(b"\x1b[?" + b"9" * 5000 + b"h" + b"\x1b[?2004h", 80, 24)
    s.record(b"k" * 32, 80, 24)
    s.set_cap(16)  # the whole first chunk leaves in one span
    assert s.preamble() == b"\x1b[?2004h"
    assert _retained(s) == b"k" * 16


def test_trim_at_a_clean_boundary_drops_nothing_extra():
    s = _new(10)
    s.record(b"\x1b[1mbold\x1b[0m", 80, 24)
    s.record(b"0123456789", 80, 24)
    assert _replay(s) == b"0123456789"


def test_set_scrollback_cap_uses_the_same_safe_trim():
    s = _new(1000)
    s.record(b"\x1b[?2004h\x1b[38;5;196mred\x1b[0m plain tail", 80, 24)
    s.set_cap(20)
    assert _retained(s) == b"red\x1b[0m plain tail"
    assert s.preamble() == b"\x1b[?2004h"


# ---- DEC private modes survive the trim ----


def test_modes_set_before_the_trimmed_region_are_restored_by_the_preamble():
    s = _new(32)
    s.record(b"\x1b[?1049h\x1b[?2004h\x1b[?1000;1006h\x1b[?1h\x1b[?25l", 80, 24)
    s.record(b"x" * 64, 80, 24)
    chunks, _, _ = s.snapshot()
    assert chunks[0] == b"\x1b[?1h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?1049h\x1b[?2004h"
    assert b"".join(chunks[1:]) == b"x" * 32


def test_mode_set_then_reset_is_not_restored():
    s = _new(8)
    s.record(b"\x1b[?2004h\x1b[?1000h", 80, 24)
    s.record(b"\x1b[?2004l\x1b[?1000l", 80, 24)
    s.record(b"y" * 16, 80, 24)
    assert s.snapshot()[0] == (b"y" * 8,)


def test_mouse_modes_replace_each_other_like_xterm():
    s = _new(8)
    s.record(b"\x1b[?1003h\x1b[?1000h\x1b[?1015h\x1b[?1006h", 80, 24)
    s.record(b"z" * 16, 80, 24)
    assert s.preamble() == b"\x1b[?1000h\x1b[?1006h"


def test_ris_clears_every_tracked_mode():
    s = _new(8)
    s.record(b"\x1b[?1049h\x1b[?2004h\x1b[?25l", 80, 24)
    s.record(b"\x1bc", 80, 24)
    s.record(b"\x1b[?1h", 80, 24)
    s.record(b"w" * 16, 80, 24)
    assert s.preamble() == b"\x1b[?1h"


def test_mode_sequence_split_across_chunks_is_tracked():
    s = _new(8)
    s.record(b"ab\x1b[?20", 80, 24)
    s.record(b"04h", 80, 24)
    s.record(b"cd\x1b", 80, 24)
    s.record(b"[?1049h", 80, 24)
    s.record(b"q" * 32, 80, 24)
    assert s.preamble() == b"\x1b[?1049h\x1b[?2004h"


def test_ris_split_across_chunks_is_tracked():
    s = _new(8)
    s.record(b"\x1b[?2004h\x1b", 80, 24)
    s.record(b"c", 80, 24)
    s.record(b"q" * 32, 80, 24)
    assert s.preamble() == b""


def test_untracked_and_synchronized_output_modes_are_not_replayed():
    s = _new(8)
    s.record(b"\x1b[?2026h\x1b[?9001h\x1b[?7727h", 80, 24)
    s.record(b"v" * 16, 80, 24)
    assert s.preamble() == b""


def test_scrollback_without_trim_has_no_preamble():
    s = _new(1000)
    s.record(b"\x1b[?1049h\x1b[?2004hhello", 80, 24)
    assert s.snapshot()[0] == (b"\x1b[?1049h\x1b[?2004hhello",)
