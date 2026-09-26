"""Plain text from a terminal's recorded output: the search and export backend.

The ring holds raw PTY bytes, so the text a user saw has to be recovered from
them. This is not a terminal emulator. It keeps one logical line at a time and
the screen rows it covers, which is enough for what a transcript is read for:
escape sequences disappear, a carriage return lets the next text overwrite the
row (prompts, progress bars), cursor-forward counts as spaces (ConPTY writes
runs of blanks that way), and a cursor move stays in the line while it lands
on one of the line's own rows. That last rule is what ConPTY needs: with
PSReadLine it repaints the whole input after every key by jumping back to the
row and column where the input starts, and a prompt longer than the pane
wraps, so the jump lands on the line's second row. Any other row ends the
line. Full-screen programs draw on the alternate screen, which has no
scrollback in xterm either, so text written there is left out: a search hit
inside `vim` could never be scrolled to.

Pure and synchronous; callers run it through `asyncio.to_thread`.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

MAX_QUERY_BYTES = 1024
RESULT_TEXT_CHARS = 300
# A hostile or broken program can ask for a cursor-forward of 2**31 columns.
_MAX_COLUMN = 4096
_TAB = 8

# One token per match, tried in this order. String sequences (OSC and the
# DCS/SOS/PM/APC family) end at BEL or ST; an ESC that is not part of ST ends
# the string early, as it does in a VT parser, and starts a new sequence. An
# unterminated string at the end of the ring swallows the rest, so a half
# received OSC 52 clipboard payload never shows up as text.
_TOKENS = re.compile(
    r"(?P<osc>\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?)"
    r"|(?P<string>\x1b[P_^X][^\x07\x1b]*(?:\x07|\x1b\\)?)"
    r"|(?P<csi>\x1b\[(?P<params>[0-?]*)[ -/]*(?P<final>[@-~])?)"
    r"|(?P<esc>\x1b[ -/]*(?P<esc_final>[0-~])?)"
    r"|(?P<text>[^\x00-\x1f\x7f-\x9f]+)"
    r"|(?P<control>[\x00-\x1f\x7f-\x9f])"
)
_ALT_SCREEN_MODES = {"47", "1047", "1049"}
_RESERVED_STEMS = {"con", "prn", "aux", "nul"} | {
    f"{kind}{n}" for kind in ("com", "lpt") for n in range(1, 10)
}


def _width(ch: str) -> int:
    if unicodedata.category(ch) in ("Mn", "Me", "Cf"):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1


class _Lines:
    """The current logical line as cells plus a cursor, and every finished line.

    `top` is the screen row (1-based) the line starts on and `row` how many
    rows below it the cursor is, so an absolute cursor position can be told
    apart as "this line" or "somewhere else". With a known width a line wraps
    like the terminal wrapped it; without one every line is a single row.

    A wide character takes two cells: its own and an empty continuation cell,
    so a carriage return followed by narrow text overwrites it the way the
    terminal did instead of shifting everything after it.
    """

    def __init__(self, cols: int = 0, rows: int = 0) -> None:
        self.done: list[str] = []
        self.cells: list[str] = []
        self.col = 0
        self.alt = False
        self.cols = max(0, cols)
        self.rows = max(0, rows)
        self.top = 1
        self.row = 0

    def text(self) -> str:
        return "".join(self.cells).rstrip(" ")

    def cursor_row(self) -> int:
        return self.top + self.row

    def _row_start(self) -> int:
        return self.row * self.cols

    def _row_end(self) -> int:
        return self._row_start() + self.cols if self.cols else len(self.cells)

    def _last_row(self) -> int:
        if not self.cols or not self.cells:
            return self.row
        return max(self.row, (len(self.cells) - 1) // self.cols)

    def _clamp_screen_row(self, row: int) -> int:
        row = max(1, row)
        return min(row, self.rows) if self.rows else row

    def newline(self) -> None:
        self.done.append(self.text())
        self.top = self._clamp_screen_row(self.cursor_row() + 1)
        self.cells = []
        self.col = 0
        self.row = 0

    def break_line(self, top: int | None = None) -> None:
        # The cursor left this line's rows. Only a line that holds something
        # is kept, or every repaint would add blank lines.
        if self.text():
            self.done.append(self.text())
        self.top = self._clamp_screen_row(self.cursor_row() if top is None else top)
        self.cells = []
        self.col = 0
        self.row = 0

    def goto(self, row: int, col: int) -> None:
        """Absolute cursor position: screen row (1-based), column (0-based)."""
        row = self._clamp_screen_row(row)
        if self.top <= row <= self.top + self._last_row():
            self.row = row - self.top
        else:
            self.break_line(row)
        self.move_in_row(col)

    def move_in_row(self, col: int) -> None:
        # The terminal stops the cursor at the right margin; without a known
        # width only the sanity bound applies.
        start = self._row_start()
        width = min(self.cols, _MAX_COLUMN + 1) if self.cols else _MAX_COLUMN + 1
        self.col = start + max(0, min(col, width - 1))

    def column_in_row(self) -> int:
        return self.col - self._row_start()

    def _free(self, index: int) -> None:
        # Overwriting either half of a wide character leaves the other half
        # blank, as the terminal does.
        cells = self.cells
        if index >= len(cells):
            return
        if cells[index] == "" and index > 0:
            cells[index - 1] = " "
        elif index + 1 < len(cells) and cells[index + 1] == "":
            cells[index + 1] = " "

    def put(self, text: str) -> None:
        cells = self.cells
        if self.col == len(cells) and text.isascii():
            cells.extend(text)
            self.col += len(text)
            if self.cols:
                self.row = max(self.row, (self.col - 1) // self.cols)
            return
        for ch in text:
            width = _width(ch)
            if width == 0:
                lead = min(self.col, len(cells)) - 1
                while lead > 0 and cells[lead] == "":
                    lead -= 1
                if lead >= 0:
                    cells[lead] += ch
                continue
            col = self.col
            # Writing past the end of a row wraps onto the next one.
            if self.cols and col >= (self.row + 1) * self.cols:
                self.row = col // self.cols
            if col > len(cells):
                cells.extend(" " * (col - len(cells)))
            self._free(col)
            if width == 2:
                self._free(col + 1)
            if col < len(cells):
                cells[col] = ch
            else:
                cells.append(ch)
            if width == 2:
                if col + 1 < len(cells):
                    cells[col + 1] = ""
                else:
                    cells.append("")
            self.col = col + width

    def _blank(self, start: int, end: int) -> None:
        """Erase cells [start, end) of this line; at the end, drop them."""
        cells = self.cells
        end = min(end, len(cells))
        if start >= end:
            return
        self._free(start)
        self._free(end - 1)
        if end == len(cells):
            del cells[start:]
        else:
            cells[start:end] = [" "] * (end - start)

    def erase_line(self, mode: int) -> None:
        if mode == 0:
            self._blank(self.col, self._row_end())
        elif mode == 1:
            self._blank(self._row_start(), self.col + 1)
            # Blanks before the cursor must stay: text written next lands after them.
            if len(self.cells) < self.col:
                self.cells.extend(" " * (self.col - len(self.cells)))
        elif mode == 2:
            self._blank(self._row_start(), self._row_end())

    def erase_chars(self, count: int) -> None:
        cells = self.cells
        start, end = self.col, min(self.col + count, len(cells))
        if start >= end:
            return
        self._free(start)
        self._free(end - 1)
        cells[start:end] = [" "] * (end - start)

    def delete_chars(self, count: int) -> None:
        if self.col >= len(self.cells):
            return
        self._free(self.col)
        self._free(min(self.col + count, len(self.cells)) - 1)
        del self.cells[self.col : self.col + count]

    def insert_blanks(self, count: int) -> None:
        if self.col < len(self.cells):
            self._free(self.col)
            self.cells[self.col : self.col] = [" "] * count


def _numbers(params: str) -> list[int]:
    out = []
    for part in params.split(";"):
        digits = part.split(":", 1)[0]
        out.append(int(digits) if digits.isdigit() else 0)
    return out


def _csi(lines: _Lines, params: str, final: str) -> None:
    if params[:1] in ("<", "=", ">", "?"):
        if params[:1] == "?" and final in ("h", "l"):
            if _ALT_SCREEN_MODES.intersection(params[1:].split(";")):
                lines.alt = final == "h"
        return
    if lines.alt:
        return
    numbers = _numbers(params)
    first = numbers[0]
    count = max(1, first)
    here = lines.column_in_row()
    if final in ("C", "a"):
        lines.move_in_row(here + count)
    elif final == "D":
        lines.move_in_row(here - count)
    elif final in ("G", "`"):
        lines.move_in_row(count - 1)
    elif final in ("H", "f"):
        lines.goto(count, (numbers[1] if len(numbers) > 1 else 1) - 1)
    elif final == "d":
        lines.goto(count, here)
    elif final == "A":
        lines.goto(lines.cursor_row() - count, here)
    elif final == "B":
        lines.goto(lines.cursor_row() + count, here)
    elif final == "E":
        lines.goto(lines.cursor_row() + count, 0)
    elif final == "F":
        lines.goto(lines.cursor_row() - count, 0)
    elif final == "K":
        lines.erase_line(first)
    elif final == "X":
        lines.erase_chars(count)
    elif final == "P":
        lines.delete_chars(count)
    elif final == "@":
        lines.insert_blanks(min(count, _MAX_COLUMN))
    elif final == "J" and first in (2, 3):
        lines.break_line()


def _control(lines: _Lines, ch: str) -> None:
    if lines.alt:
        return
    if ch in "\n\x0b\x0c":
        lines.newline()
    elif ch == "\r":
        lines.move_in_row(0)
    elif ch == "\b":
        lines.move_in_row(lines.column_in_row() - 1)
    elif ch == "\t":
        lines.move_in_row((lines.column_in_row() // _TAB + 1) * _TAB)


def plain_lines(chunks: Iterable[bytes], cols: int = 0, rows: int = 0) -> list[str]:
    """The transcript as lines of plain text, trailing blank lines removed.

    `cols` and `rows` are the terminal size the ring was recorded at
    (`Session.scrollback_chunks()` returns them); with them, prompts that
    wrapped and cursor jumps back into them come out as one line. The chunks
    are joined before decoding, so a character or an escape sequence split
    across two chunks comes out whole.
    """
    data = b"".join(chunks).decode("utf-8", errors="replace")
    lines = _Lines(cols, rows)
    for match in _TOKENS.finditer(data):
        kind = match.lastgroup
        if kind == "text":
            if not lines.alt:
                lines.put(match.group("text"))
        elif kind == "csi":
            final = match.group("final")
            if final:
                _csi(lines, match.group("params"), final)
        elif kind == "control":
            _control(lines, match.group("control"))
        elif kind == "esc":
            final = match.group("esc_final")
            if final == "c":
                # RIS resets the terminal, the alternate screen included.
                lines.alt = False
                lines.break_line(1)
            elif final in ("D", "E") and not lines.alt:
                lines.newline()
        # osc and string tokens carry no visible text.
    if lines.text():
        lines.done.append(lines.text())
    out = lines.done
    while out and not out[-1]:
        out.pop()
    return out


def query_pattern(query: str) -> re.Pattern[str]:
    """Case-insensitive literal match. A regex, not lower(), so offsets stay
    those of the original line even where lowercasing changes a length."""
    return re.compile(re.escape(query), re.IGNORECASE)


def excerpt(line: str, start: int, end: int) -> tuple[str, int]:
    """The line cut to RESULT_TEXT_CHARS around [start, end); the match's
    offset within the cut text."""
    if len(line) <= RESULT_TEXT_CHARS:
        return line, start
    if end - start >= RESULT_TEXT_CHARS:
        return line[start : start + RESULT_TEXT_CHARS], 0
    begin = start - (RESULT_TEXT_CHARS - (end - start)) // 2
    begin = max(0, min(begin, len(line) - RESULT_TEXT_CHARS))
    return line[begin : begin + RESULT_TEXT_CHARS], start - begin


@dataclass(frozen=True)
class Hit:
    line: int
    text: str
    start: int


def search_lines(lines: list[str], pattern: re.Pattern[str]) -> Iterator[Hit]:
    """The first match on every matching line, in line order."""
    for index, line in enumerate(lines):
        found = pattern.search(line)
        if found:
            text, start = excerpt(line, found.start(), found.end())
            yield Hit(index, text, start)


def export_dir() -> Path:
    home = Path.home()
    downloads = home / "Downloads"
    return (downloads if downloads.is_dir() else home) / "QuickTerm"


def safe_stem(name: str) -> str:
    """A file name part that is legal on NTFS and says which terminal it was."""
    stem = re.sub(r"\s+", " ", name or "")
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]+', "_", stem).strip(" .")[:60].strip(" .")
    if not stem:
        return "terminal"
    if stem.split(".", 1)[0].lower() in _RESERVED_STEMS:
        stem = f"_{stem}"
    return stem


def export_transcript(
    name: str,
    chunks: Iterable[bytes],
    cols: int = 0,
    rows: int = 0,
    *,
    folder: Path | None = None,
    now: datetime | None = None,
) -> Path:
    """Write the plain transcript to `<folder>/<name>-<UTC stamp>.txt`.

    Never overwrites: a second export in the same second gets a suffix.
    """
    lines = plain_lines(chunks, cols, rows)
    target = folder if folder is not None else export_dir()
    target.mkdir(parents=True, exist_ok=True)
    stamp = (now or datetime.now(UTC)).strftime("%Y%m%d-%H%M%S")
    base = f"{safe_stem(name)}-{stamp}"
    body = "\n".join(lines) + "\n" if lines else ""
    for attempt in range(1, 1000):
        path = target / (f"{base}.txt" if attempt == 1 else f"{base}-{attempt}.txt")
        try:
            # Text mode: the platform's line endings, so Notepad on an old
            # Windows build shows lines too.
            with path.open("x", encoding="utf-8") as handle:
                handle.write(body)
        except FileExistsError:
            continue
        return path
    raise FileExistsError(f"no free file name for {base}.txt in {target}")
