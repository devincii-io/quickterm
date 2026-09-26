"""Terminal output signals: "needs you" and "where am I".

A PTY reader burst is scanned for the few sequences a program uses to ask for
the user or to say where its shell is:

- BEL (0x07) on its own, which is not the terminator of an OSC string;
- OSC 9 notifications (``ESC ] 9 ; text``), minus the ConEmu subcommands that
  share the number (9;4 progress, 9;9 current folder, and the others);
- OSC 777 ``notify;title;body`` and OSC 99 (kitty notifications);
- OSC 7 ``file://host/path`` and OSC 9;9 ``path`` for the current folder.

Claude Code and Codex use the first four when they wait for an approval or
finish a turn; shells with prompt integration emit the last two on every
prompt.

This runs once per reader burst on the event loop, so it never walks the
bytes in Python: two C-level ``bytes.find`` calls decide that a burst without
BEL or ``ESC ]`` holds nothing, and a burst that has them costs one loop turn
per OSC string, not per byte. Only the head of an OSC string split across
bursts is carried (``_HEAD_CAP``); an OSC 52 clipboard write of a megabyte
is followed to its terminator without being kept.
"""

from __future__ import annotations

import base64
import binascii
import os
import re
import socket
import time
from dataclasses import dataclass
from urllib.parse import unquote, urlsplit

# Longest OSC head worth keeping across bursts. Every string this module acts
# on (a folder, a notification) is useful well below it; anything longer is
# cut, never buffered without bound.
_HEAD_CAP = 4096
TEXT_MAX_CHARS = 200
CWD_MAX_CHARS = 4096

_ESC = 0x1B
_BEL = b"\x07"
_OSC = b"\x1b]"

# ConEmu's OSC 9 subcommands (9;1 sleep ... 9;12 prompt start) are not
# notifications. 9;4 is the progress bar winget and others draw on every
# update, 9;9 the folder a prompt reports, 9;12 a prompt mark: treating any of
# them as "needs you" would flag every shell on every prompt.
_CONEMU_SUBCOMMAND = re.compile(rb"^(?:[1-9]|1[0-2])(?:;|$)")
# C0, DEL and C1 controls. Stripped from anything shown to the user, so a
# notification cannot smuggle escape sequences into a tooltip or a balloon.
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]+")


@dataclass
class Signals:
    """What one burst said. ``attention`` is the latest ("bell" or "notify")."""

    attention: str | None = None
    text: str | None = None
    cwd: str | None = None


def clean_text(raw: str, limit: int = TEXT_MAX_CHARS) -> str:
    """Control characters out, whitespace collapsed, bounded."""
    text = " ".join(_CONTROL.sub(" ", raw).split())
    return text if len(text) <= limit else text[: limit - 3].rstrip() + "..."


def _decode(raw: bytes) -> str:
    return raw.decode("utf-8", "replace")


def _local_host_names() -> set[str]:
    names = {"", "localhost"}
    try:
        host = socket.gethostname().casefold()
    except OSError:
        return names
    names.add(host)
    names.add(host.split(".", 1)[0])
    return names


_LOCAL_NAMES: set[str] | None = None


def _is_local(host: str) -> bool:
    global _LOCAL_NAMES
    if _LOCAL_NAMES is None:
        _LOCAL_NAMES = _local_host_names()
    return host.casefold() in _LOCAL_NAMES


def osc7_path(url: str, *, windows: bool | None = None) -> str | None:
    """The folder an OSC 7 ``file://host/path`` URL names, or None.

    On Windows a ``/C:/...`` path becomes ``C:\\...`` and a host other than
    this machine becomes a UNC path. On POSIX the host is ignored: a shell
    reports its own hostname, which may be a container's or a remote's name
    for the very same folder.
    """
    windows = os.name == "nt" if windows is None else windows
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return None
    # kitty reports kitty-shell-cwd://, the same shape.
    if parts.scheme.casefold() not in ("file", "kitty-shell-cwd"):
        return None
    path = unquote(parts.path, errors="replace")
    if not path:
        return None
    if not windows:
        return path
    host = parts.hostname or ""
    if re.match(r"^/[A-Za-z]:(?:/|$)", path):
        drive_path = path[1:].replace("/", "\\")
        return drive_path if len(drive_path) > 2 else drive_path + "\\"
    if not _is_local(host):
        return "\\\\" + host + path.replace("/", "\\")
    # A local host with no drive letter is a WSL or MSYS shell reporting its
    # own POSIX folder. That is still where the terminal is.
    return path


def _clean_cwd(raw: str) -> str | None:
    text = _CONTROL.sub("", raw).strip()
    if len(text) >= 2 and text[0] == text[-1] == '"':
        text = text[1:-1].strip()
    if not text:
        return None
    return text[:CWD_MAX_CHARS]


def _kitty_notification(rest: bytes) -> str | None:
    """OSC 99 ``metadata ; payload``. None for a chunk that is not the last,
    and for the query and close forms, which ask for nothing."""
    meta_raw, _, payload = rest.partition(b";")
    meta: dict[str, str] = {}
    for item in _decode(meta_raw).split(":"):
        key, _, value = item.partition("=")
        if key:
            meta[key] = value
    if meta.get("d") == "0":
        return None
    if meta.get("p", "title") not in ("title", "body"):
        return None
    if meta.get("e") == "1":
        try:
            payload = base64.b64decode(payload, validate=False)
        except (binascii.Error, ValueError):
            payload = b""
    return clean_text(_decode(payload))


class SignalScanner:
    """Per-session scanner. ``feed`` takes every reader burst in order."""

    __slots__ = ("_esc_tail", "_head", "_in_osc")

    def __init__(self) -> None:
        self._in_osc = False
        self._head = bytearray()
        # The burst ended on ESC outside a string: it may open an OSC whose
        # "]" is the first byte of the next burst.
        self._esc_tail = False

    def feed(self, data: bytes) -> Signals | None:
        if not data:
            return None
        if not self._in_osc and not self._esc_tail:
            # The common case: plain output, answered by two C scans.
            osc = data.find(_OSC)
            if osc < 0 and data.find(_BEL) < 0 and data[-1] != _ESC:
                return None
        found: Signals | None = None
        start = 0
        if self._esc_tail:
            self._esc_tail = False
            if data[:1] == b"]":
                self._in_osc = True
                self._head.clear()
                start = 1
        if self._in_osc:
            end = self._terminator(data, start)
            if end < 0:
                self._keep(data[start:])
                return None
            self._keep(data[start:end])
            self._in_osc = False
            found = self._dispatch(bytes(self._head), found)
            self._head.clear()
            start = self._after(data, end)
        return self._scan(data, start, found)

    def _scan(self, data: bytes, pos: int, found: Signals | None) -> Signals | None:
        size = len(data)
        while pos < size:
            osc = data.find(_OSC, pos)
            limit = size if osc < 0 else osc
            if data.find(_BEL, pos, limit) >= 0:
                found = found or Signals()
                found.attention, found.text = "bell", None
            if osc < 0:
                if data[-1] == _ESC:
                    self._esc_tail = True
                return found
            body = osc + 2
            end = self._terminator(data, body)
            if end < 0:
                self._in_osc = True
                self._head.clear()
                self._keep(data[body:])
                return found
            # Slice the head only: an OSC 52 payload can be a megabyte.
            found = self._dispatch(data[body:min(end, body + _HEAD_CAP)], found)
            pos = self._after(data, end)
        return found

    @staticmethod
    def _terminator(data: bytes, start: int) -> int:
        """First BEL or ESC at or after ``start``. Any ESC ends the string:
        ESC \\ is the proper ST, and any other ESC starts a new sequence.

        ESC first, then BEL only up to it: a string ended by ST carries no
        BEL, and searching BEL first ran to the end of the burst for every
        such string, so a burst of OSC 8 hyperlinks cost quadratic time on
        the event loop."""
        esc = data.find(b"\x1b", start)
        bel = data.find(_BEL, start, esc if esc >= 0 else len(data))
        return bel if bel >= 0 else esc

    def _after(self, data: bytes, end: int) -> int:
        """Where scanning resumes after the string that ended at ``end``."""
        if data[end] != _ESC:
            return end + 1
        follow = data[end + 1 : end + 2]
        if follow == b"\\":
            return end + 2
        if follow == b"]":
            # Not ST: this ESC opens the next OSC, so scanning resumes on it.
            return end
        if not follow:
            # ST or a new OSC may complete in the next burst.
            self._esc_tail = True
        return end + 1

    def _keep(self, chunk: bytes) -> None:
        room = _HEAD_CAP - len(self._head)
        if room > 0:
            self._head += chunk[:room]

    def _dispatch(self, payload: bytes, found: Signals | None) -> Signals | None:
        number, sep, rest = payload.partition(b";")
        if not sep:
            return found
        if number == b"7":
            path = osc7_path(_decode(rest))
            if path:
                found = found or Signals()
                found.cwd = _clean_cwd(path)
        elif number == b"9":
            if rest.startswith(b"9;"):
                cwd = _clean_cwd(_decode(rest[2:]))
                if cwd:
                    found = found or Signals()
                    found.cwd = cwd
            elif not _CONEMU_SUBCOMMAND.match(rest):
                found = found or Signals()
                found.attention, found.text = "notify", clean_text(_decode(rest)) or None
        elif number == b"777":
            fields = rest.split(b";", 2)
            if fields[0] == b"notify":
                title = clean_text(_decode(fields[1])) if len(fields) > 1 else ""
                body = clean_text(_decode(fields[2])) if len(fields) > 2 else ""
                found = found or Signals()
                found.attention = "notify"
                found.text = clean_text(": ".join(part for part in (title, body) if part)) or None
        elif number == b"99":
            text = _kitty_notification(rest)
            if text is not None:
                found = found or Signals()
                found.attention, found.text = "notify", text or None
        return found


class NotifyThrottle:
    """At most one native notification per session per ``interval_s``.

    A shell that rings on every failed tab completion must not turn into a
    taskbar that never stops flashing or a stack of tray balloons.
    """

    def __init__(self, interval_s: float = 30.0, clock=time.monotonic) -> None:
        self._interval = interval_s
        self._clock = clock
        self._last: dict[str, float] = {}

    def allow(self, key: str) -> bool:
        now = self._clock()
        last = self._last.get(key)
        if last is not None and now - last < self._interval:
            return False
        self._last[key] = now
        if len(self._last) > 256:
            cutoff = now - self._interval
            self._last = {k: v for k, v in self._last.items() if v >= cutoff}
        return True
