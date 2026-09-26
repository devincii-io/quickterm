"""Plain text from a terminal's recorded output: the search and export backend.

The ring holds raw PTY bytes, so the text a user saw has to be recovered from
them. This is not a terminal emulator. It models one line at a time, which is
enough for what a transcript is read for: escape sequences disappear, a
carriage return lets the next text overwrite the line (prompts, progress bars),
cursor-forward counts as spaces (ConPTY writes runs of blanks that way), and
anything that moves to another row ends the current line. Full-screen programs
draw on the alternate screen, which has no scrollback in xterm either, so text
written there is left out: a search hit inside `vim` could never be scrolled to.

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
    """The current line as cells plus a cursor, and every finished line.

    A wide character takes two cells: its own and an empty continuation cell,
    so a carriage return followed by narrow text overwrites it the way the
    terminal did instead of shifting everything after it.
    """

    def __init__(self) -> None:
        self.done: list[str] = []
        self.cells: list[str] = []
        self.col = 0
        self.alt = False

    def text(self) -> str:
        return "".join(self.cells).rstrip(" ")

    def newline(self) -> None:
        self.done.append(self.text())
        self.cells = []
        self.col = 0

    def break_line(self) -> None:
        # A move to another row. Only a line that holds something is kept, or
        # every repaint would add blank lines.
        if self.text():
            self.done.append(self.text())
        self.cells = []
        self.col = 0

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

    def erase_line(self, mode: int) -> None:
        cells = self.cells
        if mode == 0:
            self._free(self.col)
            del cells[self.col :]
        elif mode == 1:
            end = min(self.col + 1, len(cells))
            if end:
                self._free(end - 1)
            cells[:end] = [" "] * end
        elif mode == 2:
            cells.clear()

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

    def move_to(self, col: int) -> None:
        self.col = max(0, min(col, _MAX_COLUMN))


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
    if final in ("C", "a"):
        lines.move_to(lines.col + count)
    elif final == "D":
        lines.move_to(lines.col - count)
    elif final in ("G", "`"):
        lines.move_to(count - 1)
    elif final == "K":
        lines.erase_line(first)
    elif final == "X":
        lines.erase_chars(count)
    elif final == "P":
        lines.delete_chars(count)
    elif final == "@":
        lines.insert_blanks(min(count, _MAX_COLUMN))
    elif final in ("H", "f"):
        lines.break_line()
        lines.move_to((numbers[1] if len(numbers) > 1 else 1) - 1)
    elif final in ("A", "B", "E", "F", "d") or (final == "J" and first in (2, 3)):
        lines.break_line()


def _control(lines: _Lines, ch: str) -> None:
    if lines.alt:
        return
    if ch in "\n\x0b\x0c":
        lines.newline()
    elif ch == "\r":
        lines.col = 0
    elif ch == "\b":
        lines.move_to(lines.col - 1)
    elif ch == "\t":
        lines.move_to((lines.col // _TAB + 1) * _TAB)


def plain_lines(chunks: Iterable[bytes]) -> list[str]:
    """The transcript as lines of plain text, trailing blank lines removed.

    The chunks are joined before decoding, so a character or an escape
    sequence split across two chunks comes out whole.
    """
    data = b"".join(chunks).decode("utf-8", errors="replace")
    lines = _Lines()
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
                lines.break_line()
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
    *,
    folder: Path | None = None,
    now: datetime | None = None,
) -> Path:
    """Write the plain transcript to `<folder>/<name>-<UTC stamp>.txt`.

    Never overwrites: a second export in the same second gets a suffix.
    """
    lines = plain_lines(chunks)
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
