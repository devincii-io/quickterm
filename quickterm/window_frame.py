"""The native title bar and border in the theme's colours.

pywebview's window keeps Windows' own caption, so a theme change recoloured
everything but the strip above it. Windows 11 lets a program set a window's
caption, caption text and border colour (DWMWA_CAPTION_COLOR and friends);
Windows 10 knows only the dark-mode flag, and older builds none of them, so
every attribute is best effort and a refusal is ignored.

The theme is one setting for every window, so the viewer colours all of its
own top-level QuickTerm windows at once instead of tracking which window
asked.
"""

from __future__ import annotations

import logging
import os
import re
import sys
from typing import Any

log = logging.getLogger(__name__)

DWMWA_USE_IMMERSIVE_DARK_MODE = 20
DWMWA_BORDER_COLOR = 34
DWMWA_CAPTION_COLOR = 35
DWMWA_TEXT_COLOR = 36

_HEX = re.compile(r"^#([0-9A-Fa-f]{6})$")
TITLE = "QuickTerm"


def colorref(value: str) -> int:
    """`#RRGGBB` as a Win32 COLORREF (0x00BBGGRR). ValueError otherwise."""
    match = _HEX.match(value if isinstance(value, str) else "")
    if match is None:
        raise ValueError(f"not a #RRGGBB colour: {value!r}")
    rgb = int(match.group(1), 16)
    red, green, blue = rgb >> 16, (rgb >> 8) & 0xFF, rgb & 0xFF
    return (blue << 16) | (green << 8) | red


def frame_attributes(colors: Any) -> list[tuple[int, int]]:
    """The (attribute, value) pairs for `colors`: a dict with `caption`,
    `text`, `border` (#RRGGBB) and `light` (bool). ValueError on a bad one."""
    if not isinstance(colors, dict):
        raise ValueError("frame colours must be an object")
    light = colors.get("light")
    if not isinstance(light, bool):
        raise ValueError("light must be true or false")
    return [
        # Dark mode first: on Windows 10 it is the only one that applies, and
        # on 11 it picks the caption buttons' glyph colour.
        (DWMWA_USE_IMMERSIVE_DARK_MODE, 0 if light else 1),
        (DWMWA_CAPTION_COLOR, colorref(colors.get("caption"))),
        (DWMWA_TEXT_COLOR, colorref(colors.get("text"))),
        (DWMWA_BORDER_COLOR, colorref(colors.get("border"))),
    ]


def _title_is_ours(title: str) -> bool:
    # "QuickTerm" and the elevated "QuickTerm - Administrator".
    return title == TITLE or title.startswith(f"{TITLE} - ")


def own_windows() -> list[int]:
    """This process's top-level QuickTerm windows. Empty off Windows."""
    if sys.platform != "win32":
        return []
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    found: list[int] = []
    me = os.getpid()

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def visit(hwnd, _lparam):
        pid = wintypes.DWORD(0)
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value != me:
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length:
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buf, length + 1)
            if _title_is_ours(buf.value):
                found.append(int(hwnd))
        return True

    user32.EnumWindows(visit, 0)
    return found


def apply(colors: Any, hwnds: list[int] | None = None) -> int:
    """Colour the frames of `hwnds` (default: this process's QuickTerm
    windows). Returns how many windows took at least one attribute.
    ValueError for bad colours; never raises for a refusing Windows."""
    attributes = frame_attributes(colors)
    if sys.platform != "win32":
        return 0
    import ctypes
    from ctypes import wintypes

    set_attribute = ctypes.windll.dwmapi.DwmSetWindowAttribute
    set_attribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
    set_attribute.restype = ctypes.c_long
    done = 0
    for hwnd in own_windows() if hwnds is None else hwnds:
        took = False
        for attribute, value in attributes:
            data = wintypes.DWORD(value)
            # S_OK is 0; an older build answers E_INVALIDARG for what it lacks.
            if set_attribute(hwnd, attribute, ctypes.byref(data), ctypes.sizeof(data)) == 0:
                took = True
        done += took
    return done
