"""Plain-text transcripts (quickterm/transcript.py) and the routes that serve them."""

from __future__ import annotations

import base64
import threading
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from quickterm import transcript
from quickterm.server import create_app
from tests.test_server import FakeConfig, FakeSessionManager

# --- plain text -------------------------------------------------------------


def lines(*chunks: bytes) -> list[str]:
    return transcript.plain_lines(chunks)


def test_colours_and_modes_vanish_mid_line():
    assert lines(b"\x1b[?25l\x1b[1;31mred\x1b[0m and \x1b[38;2;1;2;3mplain\x1b[m\r\n") == [
        "red and plain"
    ]


def test_a_sequence_split_across_chunks_mid_line_is_still_stripped():
    assert lines(b"foo\x1b[3", b"1mbar\x1b", b"]0;title\x07baz\r\n") == ["foobarbaz"]


def test_a_character_split_across_chunks_decodes_whole():
    euro = "€".encode()
    assert lines(b"price " + euro[:1], euro[1:] + b" 5\r\n") == ["price € 5"]


def test_invalid_utf8_is_replaced_not_fatal():
    assert lines(b"a\xffb\r\n") == ["a�b"]


def test_carriage_return_overwrites_like_a_progress_bar():
    assert lines(b"  10%\r  50%\r 100% done\r\n$ ") == [" 100% done", "$"]


def test_carriage_return_then_erase_line_replaces_a_longer_line():
    assert lines(b"downloading file.tar.gz\r\x1b[Kok\r\n") == ["ok"]


def test_erase_line_variants():
    assert lines(b"abcdef\x1b[3D\x1b[K\r\n") == ["abc"]
    assert lines(b"abcdef\x1b[3D\x1b[1KZ\r\n") == ["   Zef"]
    assert lines(b"abcdef\x1b[2Kxy\r\n") == ["      xy"]


def test_conpty_blank_runs_come_out_as_spaces():
    # ConPTY writes a run of blanks as erase-characters plus cursor-forward.
    assert lines(b"name\x1b[4X\x1b[4Cvalue\r\n") == ["name    value"]


def test_delete_and_insert_characters_edit_the_line():
    assert lines(b"hello world\r\x1b[5C\x1b[6P!\r\n") == ["hello!"]
    assert lines(b"ac\r\x1b[1C\x1b[1@b\r\n") == ["abc"]


def test_inserted_blanks_push_the_row_end_off_the_margin():
    # A known width keeps the row as wide as the terminal: what the insert
    # pushes past the margin is gone, as on screen.
    assert transcript.plain_lines([b"abcdef\r\x1b[2@\r\n"], cols=6) == ["  abcd"]


def test_hostile_inserts_cannot_grow_a_line_without_bound():
    # "x\r" plus a stream of ESC[4096@ grew one line by 4096 cells per
    # sequence and shifted all of them every time: 28 KB took 50 s.
    import time

    hostile = b"x\r" + b"\x1b[4096@" * 20_000
    for cols in (0, 120):
        started = time.monotonic()
        out = transcript.plain_lines([hostile, b"\r\n"], cols=cols)
        assert time.monotonic() - started < 5
        assert all(len(line) <= (cols or 4096) for line in out)
    # With a known width the inserts push the "x" off the margin, as on screen.
    assert transcript.plain_lines([hostile, b"\r\n"], cols=120) in ([], [""])


def test_backspace_and_tab():
    assert lines(b"abx\bc\r\n") == ["abc"]
    assert lines(b"a\tb\r\n") == ["a       b"]


def test_wide_characters_take_two_cells_when_overwritten():
    # "a" lands on the first half of the first wide character, which the
    # terminal then blanks; "b" fills that blank.
    assert lines("日本\rab\r\n".encode()) == ["ab本"]
    # Writing narrow text over the second half blanks the first half.
    assert lines("日本\r\x1b[1Cx\r\n".encode()) == [" x本"]
    # A wide character over two narrow ones.
    assert lines("abc\r日\r\n".encode()) == ["日c"]


def test_combining_marks_stay_with_their_base():
    assert lines("café ok\r\n".encode()) == ["café ok"]


def test_osc52_clipboard_payload_never_reaches_the_text():
    payload = base64.b64encode(b"secret clipboard").decode()
    bel = f"\x1b]52;c;{payload}\x07shown\r\n".encode()
    st = f"\x1b]52;c;{payload}\x1b\\shown\r\n".encode()
    assert lines(bel) == ["shown"]
    assert lines(st) == ["shown"]
    # Still arriving when the ring was snapshotted: nothing of it is text.
    assert lines(f"before\r\n\x1b]52;c;{payload}".encode()) == ["before"]
    hits = list(transcript.search_lines(lines(bel), transcript.query_pattern(payload[:8])))
    assert hits == []


def test_hyperlinks_keep_their_text_and_lose_their_target():
    assert lines(b"\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ here\r\n") == ["link here"]


def test_device_control_and_application_strings_are_dropped():
    sixel = b"\x1bPq#0;2;0;0;0#0!10~-\x1b\\"
    assert lines(b"img:" + sixel + b"end\x1b_apc payload\x1b\\\r\n") == ["img:end"]


def test_an_escape_inside_an_unterminated_string_starts_a_new_sequence():
    assert lines(b"\x1b]0;title\x1b[31mred\r\n") == ["red"]


def test_other_rows_end_the_line():
    assert lines(b"\x1b[1;1Hfirst\x1b[2;1Hsecond\x1b[3;5Hthird") == ["first", "second", "    third"]
    assert lines(b"one\r\ntwo\x1b[Aup\x1b[2Jcleared") == ["one", "two", "   up", "cleared"]
    # The top row has nothing above it: the cursor stays in the line.
    assert lines(b"one\x1b[Atwo") == ["onetwo"]


PROMPT = "PS C:\\Users\\devincii\\AppData\\Local\\Temp\\QuickTerm\\scratch> "


def test_conpty_psreadline_repaints_stay_one_line_on_a_wide_pane():
    # Captured from ConPTY: PSReadLine redraws the input after every key by
    # jumping back to where it starts on the prompt's row.
    raw = (
        PROMPT.encode()
        + b"\x1b[?25l\x1b[1;60H\x1b[93me\x1b[39;49m\x1b[0m\x1b[1;61H\x1b[?25h"
        + b"\x1b[?25l\x1b[1;60H\x1b[93mecho\x1b[39;49m \x1b[37mhi\x1b[39;49m\x1b[0m\x1b[1;67H"
        + b"\x1b[?25h\x1b[1;67H\r\n\x1b[0m\x1b[0mhi\r\n"
        + PROMPT.encode()
    )
    assert transcript.plain_lines((raw,), 120, 30) == [PROMPT + "echo hi", "hi", PROMPT.rstrip()]


def test_conpty_repaints_on_a_wrapped_prompt_stay_one_line():
    # The same in a 48-column pane: the 59-character prompt wraps, so the
    # redraw jumps to row 2, column 12, which is still the prompt's line.
    raw = (
        PROMPT.encode()
        + b"\x1b[?25l\x1b[2;12H\x1b[93me\x1b[39;49m\x1b[0m\x1b[2;13H\x1b[?25h"
        + b"\x1b[?25l\x1b[2;12H\x1b[93mecho\x1b[39;49m \x1b[37mbcast-$\x1b[39;49m\x1b[0m\x1b[2;24H"
        + b"\x1b[?25h\x1b[?25l\x1b[2;12H\x1b[2;10H\x1b[91m> \x1b[0m\x1b[93mecho\x1b[39;49m "
        + b"\x1b[37mbcast-$(\x1b[39;49m\x1b[0m\x1b[2;25H\x1b[?25h\x1b[2;25H\r\n"
        + b"\x1b[0m\x1b[0mbcast-42\r\n"
        + PROMPT.encode()
        + b"\x1b[?25l\x1b[5;12H\x1b[93mab\x1b[39;49m\x1b[0m\x1b[5;14H\x1b[?25h"
    )
    assert transcript.plain_lines((raw,), 48, 30) == [
        PROMPT + "echo bcast-$(",
        "bcast-42",
        PROMPT + "ab",
    ]


def test_a_carriage_return_on_a_wrapped_row_returns_to_that_row():
    # 10 columns: "0123456789" fills row one, "abc" is row two; the CR goes
    # back to the start of row two, not of the whole line.
    assert transcript.plain_lines((b"0123456789abc\rX\r\n",), 10, 5) == ["0123456789Xbc"]


def test_the_bottom_row_scrolls_instead_of_growing():
    # Three rows: after the screen is full, output keeps landing on row 3, so
    # a jump to row 3 is the current line and not a new one.
    raw = b"a\r\nb\r\nc\r\nd\r\n$ \x1b[3;3Hls"
    assert transcript.plain_lines((raw,), 20, 3) == ["a", "b", "c", "d", "$ ls"]


def test_the_alternate_screen_is_left_out():
    assert lines(b"$ vim\r\n\x1b[?1049h\x1b[Hbuffer text\x1b[?1049l$ done\r\n") == [
        "$ vim",
        "$ done",
    ]


def test_reset_leaves_the_alternate_screen():
    assert lines(b"\x1b[?1049hhidden\x1bcshown") == ["shown"]


def test_blank_lines_are_kept_inside_and_trimmed_at_the_end():
    assert lines(b"a\r\n\r\nb\r\n\r\n\r\n") == ["a", "", "b"]


def test_a_huge_cursor_forward_is_bounded():
    out = lines(b"x\x1b[999999999Cy")
    assert out[0].startswith("x") and out[0].endswith("y")
    assert len(out[0]) <= 4097


# --- search -----------------------------------------------------------------


def test_search_is_case_insensitive_and_reports_one_hit_per_line():
    pattern = transcript.query_pattern("error")
    hits = list(transcript.search_lines(["ok", "ERROR: one error", "Error"], pattern))
    assert hits == [transcript.Hit(1, "ERROR: one error", 0), transcript.Hit(2, "Error", 0)]


def test_search_treats_the_query_literally():
    pattern = transcript.query_pattern("a.c(")
    assert [h.line for h in transcript.search_lines(["abc(", "a.c(x"], pattern)] == [1]


def test_long_lines_are_cut_around_the_match():
    line = "x" * 1000 + "NEEDLE" + "y" * 1000
    [hit] = transcript.search_lines([line], transcript.query_pattern("needle"))
    assert len(hit.text) == transcript.RESULT_TEXT_CHARS
    assert hit.text[hit.start : hit.start + 6] == "NEEDLE"
    near_start = "NEEDLE" + "y" * 1000
    [hit] = transcript.search_lines([near_start], transcript.query_pattern("needle"))
    assert hit.start == 0 and hit.text.startswith("NEEDLE")
    near_end = "x" * 1000 + "NEEDLE"
    [hit] = transcript.search_lines([near_end], transcript.query_pattern("needle"))
    assert hit.text.endswith("NEEDLE") and hit.start == transcript.RESULT_TEXT_CHARS - 6


def test_a_match_longer_than_the_excerpt_starts_the_excerpt():
    line = "a" * 50 + "b" * 400
    text, start = transcript.excerpt(line, 50, 450)
    assert start == 0 and text == "b" * transcript.RESULT_TEXT_CHARS


# --- export -----------------------------------------------------------------


@pytest.mark.parametrize(
    "name,stem",
    [
        ("PowerShell", "PowerShell"),
        ('a<b>c:"d/e\\f|g?h*i', "a_b_c_d_e_f_g_h_i"),
        ("  . ", "terminal"),
        ("", "terminal"),
        ("CON", "_CON"),
        ("com1.log", "_com1.log"),
        ("tab\there", "tab here"),
        ("x" * 200, "x" * 60),
        ("Überblick", "Überblick"),
    ],
)
def test_file_names_are_legal_on_ntfs(name, stem):
    assert transcript.safe_stem(name) == stem


def test_export_prefers_downloads_and_falls_back_to_home(monkeypatch, tmp_path):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setattr(transcript, "_known_downloads", lambda: None)
    assert transcript.export_dir() == tmp_path / "QuickTerm"
    (tmp_path / "Downloads").mkdir()
    assert transcript.export_dir() == tmp_path / "Downloads" / "QuickTerm"
    # A Downloads folder the user moved elsewhere wins over ~/Downloads.
    moved = tmp_path / "D" / "Downloads"
    moved.mkdir(parents=True)
    monkeypatch.setattr(transcript, "_known_downloads", lambda: moved)
    assert transcript.export_dir() == moved / "QuickTerm"


def test_export_writes_plain_text_and_never_overwrites(tmp_path):
    folder = tmp_path / "out" / "QuickTerm"
    now = datetime(2026, 9, 26, 12, 30, 5, tzinfo=UTC)
    chunks = (b"\x1b[32mbuild\x1b[0m ok\r\n", b"\x1b]52;c;c2VjcmV0\x07done\r\n")
    first = transcript.export_transcript("My: build", chunks, folder=folder, now=now)
    second = transcript.export_transcript("My: build", chunks, folder=folder, now=now)
    assert first.name == "My_ build-20260926-123005.txt"
    assert second.name == "My_ build-20260926-123005-2.txt"
    assert first.read_text(encoding="utf-8").splitlines() == ["build ok", "done"]


def test_an_empty_ring_exports_an_empty_file(tmp_path):
    path = transcript.export_transcript("t", (), folder=tmp_path)
    assert path.read_bytes() == b""


# --- routes -----------------------------------------------------------------


@pytest.fixture
def manager() -> FakeSessionManager:
    return FakeSessionManager()


@pytest.fixture
def client(manager):
    cfg = FakeConfig()
    with TestClient(create_app(manager, cfg), base_url=f"http://127.0.0.1:{cfg.port}") as c:
        yield c


def test_search_route_returns_hits_from_every_session(client, manager):
    a = manager.add_session(b"$ make\r\n\x1b[31mError\x1b[0m: missing file\r\n", name="build")
    b = manager.add_session(
        (b"no match here\r\n", b"another ERROR line\r\n"),
        name="tests",
        workspace="proj",
        alive=False,
    )
    response = client.get("/api/search", params={"q": "error"})
    assert response.status_code == 200
    assert response.json() == [
        {
            "session_id": a.id,
            "name": "build",
            "workspace": None,
            "alive": True,
            "line": 1,
            "text": "Error: missing file",
            "start": 0,
        },
        {
            "session_id": b.id,
            "name": "tests",
            "workspace": "proj",
            "alive": False,
            "line": 1,
            "text": "another ERROR line",
            "start": 8,
        },
    ]


def test_search_route_honours_and_bounds_the_limit(client, manager):
    manager.add_session(b"hit\r\n" * 1500)
    assert len(client.get("/api/search", params={"q": "hit", "limit": 3}).json()) == 3
    assert len(client.get("/api/search", params={"q": "hit"}).json()) == 200
    assert len(client.get("/api/search", params={"q": "hit", "limit": 5000}).json()) == 1000
    assert len(client.get("/api/search", params={"q": "hit", "limit": 0}).json()) == 1


def test_search_route_never_matches_a_clipboard_payload(client, manager):
    payload = base64.b64encode(b"hunter2 password").decode()
    manager.add_session(f"\x1b]52;c;{payload}\x07prompt\r\n".encode())
    assert client.get("/api/search", params={"q": payload[:10]}).json() == []


def test_search_and_export_decode_off_the_event_loop(client, manager, monkeypatch, tmp_path):
    # The snapshot is read on the loop thread (where the registry is
    # mutated); decoding several MiB of rings must not stall every pane.
    threads: dict[str, int] = {}
    real_list, real_lines = manager.list, transcript.plain_lines

    def listing():
        threads["snapshot"] = threading.get_ident()
        return real_list()

    def decode(*args):
        threads["decode"] = threading.get_ident()
        return real_lines(*args)

    monkeypatch.setattr(manager, "list", listing)
    monkeypatch.setattr(transcript, "plain_lines", decode)
    monkeypatch.setattr(transcript, "export_dir", lambda: tmp_path)
    info = manager.add_session(b"needle\r\n")
    assert client.get("/api/search", params={"q": "needle"}).status_code == 200
    assert threads["decode"] != threads["snapshot"]
    del threads["decode"]
    assert client.post(f"/api/sessions/{info.id}/export").status_code == 200
    assert threads["decode"] != threads["snapshot"]


@pytest.mark.parametrize("q", ["", "   ", "x" * 1025, "ä" * 513])
def test_search_route_refuses_empty_and_oversized_queries(client, q):
    assert client.get("/api/search", params={"q": q}).status_code == 400


def test_search_route_accepts_a_query_of_exactly_one_kib(client):
    assert client.get("/api/search", params={"q": "x" * 1024}).status_code == 200


def test_export_route_writes_the_transcript(client, manager, monkeypatch, tmp_path):
    monkeypatch.setattr(transcript, "export_dir", lambda: tmp_path / "QuickTerm")
    info = manager.add_session(b"\x1b[1mhello\x1b[0m\r\n", name="shell")
    response = client.post(f"/api/sessions/{info.id}/export")
    assert response.status_code == 200
    path = Path(response.json()["path"])
    assert path.parent == tmp_path / "QuickTerm"
    assert path.name.startswith("shell-") and path.suffix == ".txt"
    assert path.read_text(encoding="utf-8").splitlines() == ["hello"]


def test_export_route_404s_for_an_unknown_session(client, monkeypatch, tmp_path):
    monkeypatch.setattr(transcript, "export_dir", lambda: tmp_path)
    assert client.post("/api/sessions/nope/export").status_code == 404
    assert list(tmp_path.iterdir()) == []


def test_export_route_reports_a_write_failure(client, manager, monkeypatch, tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("x")
    monkeypatch.setattr(transcript, "export_dir", lambda: blocker / "QuickTerm")
    info = manager.add_session(b"x\r\n")
    response = client.post(f"/api/sessions/{info.id}/export")
    assert response.status_code == 500
    assert "could not save the output" in response.json()["detail"]


@pytest.mark.skipif(__import__("os").name != "nt", reason="the Windows known-folder lookup")
def test_exports_go_to_the_folder_windows_calls_downloads():
    known = transcript._known_downloads()
    assert known is not None and known.is_dir()
