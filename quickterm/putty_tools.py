"""Locate the bundled PuTTY console tools (plink/pscp/psftp).

The binaries are pinned and hash-verified at fetch/build time (see
scripts/fetch_putty.py and quickterm.spec), never downloaded at runtime.
Frozen builds carry them in <_internal>/putty; dev runs use the repo-root
vendor/putty/ populated by the fetch script. Everything degrades to None when
the tools are absent (e.g. a pip install) — callers surface "not found".
"""

from __future__ import annotations

import sys
from pathlib import Path

_TOOL_NAMES = ("plink.exe", "pscp.exe", "psftp.exe")


def tools_dir() -> Path | None:
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "putty"
    else:
        base = Path(__file__).resolve().parent.parent / "vendor" / "putty"
    if all((base / name).is_file() for name in _TOOL_NAMES):
        return base
    return None


def _tool_path(name: str) -> Path | None:
    base = tools_dir()
    return base / name if base else None


def plink_path() -> Path | None:
    return _tool_path("plink.exe")


def pscp_path() -> Path | None:
    return _tool_path("pscp.exe")


def psftp_path() -> Path | None:
    return _tool_path("psftp.exe")
