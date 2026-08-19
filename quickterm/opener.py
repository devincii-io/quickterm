"""Open URLs / local paths with the OS default handler (terminal Ctrl+click).

Only two shapes are accepted: http(s) URLs and existing local paths. Anything
else raises ValueError (the server maps it to 400). Executable-ish files are
revealed in the file manager instead of run: a program printing a path to a
.exe must not be able to lure a click into executing it.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import webbrowser
from pathlib import Path

_SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*://", re.IGNORECASE)
# Ctrl+click may be induced by untrusted terminal output. Open only file types
# that are conventionally passive; reveal every other file in Explorer/Finder
# so executable-capable extensions (.cpl/.msc/.chm/.url/...) never launch.
_OPEN_EXTS = {
    ".txt", ".md", ".log", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini",
    ".cfg", ".conf", ".csv", ".tsv", ".pdf", ".png", ".jpg", ".jpeg",
    ".gif", ".webp", ".bmp", ".ico",
}


def open_target(target: str) -> dict:
    """Open `target` (http(s) URL or existing local path). Returns what was
    done: {"action": "url" | "opened" | "revealed"}. Raises ValueError for
    anything that is neither, FileNotFoundError for a missing path.
    """
    cleaned = (target or "").strip().strip('"').strip("'")
    if not cleaned:
        raise ValueError("empty target")
    # URI schemes are case-insensitive (RFC 3986). Terminal link providers can
    # preserve the spelling printed by a tool, so accept HTTPS:// just like a
    # browser does instead of misclassifying it as an unsupported scheme.
    if cleaned.lower().startswith(("http://", "https://")):
        webbrowser.open(cleaned)
        return {"action": "url"}
    if _SCHEME.match(cleaned):
        raise ValueError("only http/https URLs can be opened")
    path = Path(os.path.expanduser(cleaned))
    if not path.exists():
        raise FileNotFoundError(cleaned)
    if sys.platform == "win32":
        if path.is_file() and path.suffix.lower() not in _OPEN_EXTS:
            # Absolute path and an explicit safe cwd: a bare "explorer" leaves
            # lpApplicationName NULL, so CreateProcess searches the current
            # directory before System32 (SafeProcessSearchMode is off by
            # default). QuickTerm never chdirs, and the Explorer "Open
            # QuickTerm here" verb starts it in the folder the user clicked,
            # which an elevated instance then inherits.
            explorer = os.path.join(
                os.environ.get("SystemRoot", r"C:\Windows"), "explorer.exe"
            )
            subprocess.Popen([explorer, f"/select,{path}"], cwd=os.environ.get("SystemRoot", r"C:\Windows"))
            return {"action": "revealed"}
        os.startfile(str(path))  # noqa: S606 - deliberate: user's own click
        return {"action": "opened"}
    if path.is_file() and path.suffix.lower() not in _OPEN_EXTS:
        subprocess.Popen(["xdg-open", str(path.parent)])
        return {"action": "revealed"}
    subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(path)])
    return {"action": "opened"}
