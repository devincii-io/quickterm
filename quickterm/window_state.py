"""The primary window's remembered bounds, kept apart from config.json.

Bounds change on every drag, so they stay out of the settings file and its
history. Values are pywebview logical units, the same space as
`webview.create_window(x=, y=, width=, height=)` and `webview.screens()`.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any, Iterable

# A window must keep at least this much of itself on a screen, both ways, or it
# is treated as lost (its monitor was unplugged) and opens at the default spot.
MIN_VISIBLE = 64
_KEYS = ("x", "y", "width", "height")


def state_path() -> Path:
    from quickterm.config import config_dir

    return config_dir() / "window_state.json"


def _int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _clean(raw: Any) -> dict | None:
    if not isinstance(raw, dict):
        return None
    values = {key: _int(raw.get(key)) for key in _KEYS}
    if any(value is None for value in values.values()):
        return None
    if values["width"] <= 0 or values["height"] <= 0:
        return None
    values["maximized"] = raw.get("maximized") is True
    return values


def load(path: Path | None = None) -> dict | None:
    """The saved bounds, or None for a missing, unreadable or corrupt file."""
    target = path or state_path()
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return _clean(raw)


def save(bounds: dict, path: Path | None = None) -> None:
    """Write the bounds atomically. Invalid bounds are ignored."""
    clean = _clean(bounds)
    if clean is None:
        return
    target = path or state_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    from quickterm import config

    fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(clean))
        config.replace_file(temp_name, target)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def _overlap(start: int, length: int, other_start: int, other_length: int) -> int:
    return min(start + length, other_start + other_length) - max(start, other_start)


def clamp_to_screens(bounds: dict | None, screens: Iterable[Any]) -> dict | None:
    """`bounds` when the rectangle overlaps some screen by at least
    MIN_VISIBLE pixels in both directions, else None.

    Screens are `{x, y, width, height}` mappings or objects with those
    attributes (pywebview's `Screen`).
    """
    clean = _clean(bounds)
    if clean is None:
        return None
    for screen in screens or ():
        get = screen.get if isinstance(screen, dict) else lambda key, s=screen: getattr(s, key, None)
        box = [_int(get(key)) for key in _KEYS]
        if any(value is None for value in box):
            continue
        sx, sy, sw, sh = box
        if (
            _overlap(clean["x"], clean["width"], sx, sw) >= MIN_VISIBLE
            and _overlap(clean["y"], clean["height"], sy, sh) >= MIN_VISIBLE
        ):
            return clean
    return None
