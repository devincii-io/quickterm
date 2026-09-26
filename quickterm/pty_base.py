"""Plumbing shared by the ConPTY (pty_session.py) and POSIX (pty_posix.py) backends."""

from __future__ import annotations

import os


def merge_environment(override: dict[str, str] | None) -> dict[str, str]:
    """The child's environment: QuickTerm's own, with the profile override on top.

    Windows names are case-insensitive, and CPython upper-cases the keys of
    ``os.environ`` there. A plain ``dict.update`` with a profile ``Path`` (the
    spelling the Windows dialog shows) therefore added a second entry behind
    ``PATH``, and every lookup returned the inherited value first.
    """
    merged = dict(os.environ)
    if os.name == "nt":
        for key in override or {}:
            folded = key.casefold()
            for existing in [k for k in merged if k.casefold() == folded]:
                del merged[existing]
    else:
        # The emulator is always xterm.js, whatever terminal started the
        # backend (an IDE console exports TERM=dumb, tmux its own name).
        merged["TERM"] = "xterm-256color"
        merged["COLORTERM"] = "truecolor"
    merged.update(override or {})
    return merged
