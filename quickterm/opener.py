"""Open URLs / local paths with the OS default handler (terminal Ctrl+click).

Only two shapes are accepted: http(s) URLs and existing local paths. Anything
else raises ValueError (the server maps it to 400). Executable-ish files are
revealed in the file manager instead of run — a program printing a path to a
.exe must not be able to lure a click into executing it.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import webbrowser
from pathlib import Path

_SCHEME = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*://")
# Never launch these on click; reveal them in the file manager instead.
_REVEAL_EXTS = {
    ".exe", ".bat", ".cmd", ".com", ".scr", ".ps1", ".psm1", ".vbs", ".vbe",
    ".js", ".jse", ".wsf", ".wsh", ".msi", ".msp", ".lnk", ".jar", ".hta",
    ".reg", ".sh",
}


def open_target(target: str) -> dict:
    """Open `target` (http(s) URL or existing local path). Returns what was
    done: {"action": "url" | "opened" | "revealed"}. Raises ValueError for
    anything that is neither, FileNotFoundError for a missing path.
    """
    cleaned = (target or "").strip().strip('"').strip("'")
    if not cleaned:
        raise ValueError("empty target")
    if cleaned.startswith(("http://", "https://")):
        webbrowser.open(cleaned)
        return {"action": "url"}
    if _SCHEME.match(cleaned):
        raise ValueError("only http/https URLs can be opened")
    path = Path(os.path.expanduser(cleaned))
    if not path.exists():
        raise FileNotFoundError(cleaned)
    if sys.platform == "win32":
        if path.is_file() and path.suffix.lower() in _REVEAL_EXTS:
            subprocess.Popen(["explorer", f"/select,{path}"])
            return {"action": "revealed"}
        os.startfile(str(path))  # noqa: S606 - deliberate: user's own click
        return {"action": "opened"}
    if path.is_file() and path.suffix.lower() in _REVEAL_EXTS:
        subprocess.Popen(["xdg-open", str(path.parent)])
        return {"action": "revealed"}
    subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(path)])
    return {"action": "opened"}
