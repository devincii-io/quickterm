"""Open URLs / local paths with the OS default handler (terminal Ctrl+click),
and open a folder in the file manager or VS Code (sidebar buttons, Alt+Shift+E
and Alt+Shift+C).

Only two shapes are accepted by open_target: http(s) URLs and existing local
paths. Anything else raises ValueError (the server maps it to 400).
Executable-ish files are revealed in the file manager instead of run: a
program printing a path to a .exe must not be able to lure a click into
executing it.
"""

from __future__ import annotations

import os
import re
import shutil
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


# ---- folders -----------------------------------------------------------------

FOLDER_APPS = ("explorer", "vscode")


def find_vscode() -> str | None:
    """Path of the VS Code executable, or None when it is not installed.

    On Windows `shutil.which("code")` finds the `code.cmd` shim, a batch file.
    cmd.exe re-parses a batch file's arguments, so a folder name containing
    `&` or `"` could run something. The pane's directory comes from the shell's
    OSC 7 report, which any program running in the terminal can forge, so the
    shim is never launched: its install folder holds the real Code.exe, and
    that is what is run.
    """
    if sys.platform == "win32":
        candidates: list[Path] = []
        shim = shutil.which("code")
        if shim:
            candidates.append(Path(shim).resolve().parent.parent / "Code.exe")
        local = os.environ.get("LocalAppData")
        if local:
            candidates.append(Path(local) / "Programs" / "Microsoft VS Code" / "Code.exe")
        program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
        candidates.append(Path(program_files) / "Microsoft VS Code" / "Code.exe")
        for candidate in candidates:
            if candidate.is_file():
                return str(candidate)
        return None
    found = shutil.which("code")
    if found:
        return found
    if sys.platform == "darwin":
        bundled = Path("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")
        if bundled.is_file():
            return str(bundled)
    return None


def _show_folder(folder: Path) -> None:
    if sys.platform == "win32":
        os.startfile(str(folder))  # noqa: S606 - a directory, so Explorer
        return
    subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(folder)])


def open_folder(path: str, app: str) -> dict:
    """Open the existing directory `path` in `app` ("explorer" or "vscode").

    Returns {"action": app}. Raises ValueError for an unknown app, an empty
    path or a path that is not a directory; FileNotFoundError when the path
    does not exist; LookupError when VS Code is not installed.
    """
    if app not in FOLDER_APPS:
        raise ValueError(f"unknown app: {app!r}")
    cleaned = (path or "").strip().strip('"').strip("'")
    if not cleaned:
        raise ValueError("empty path")
    folder = Path(os.path.expanduser(cleaned))
    if not folder.exists():
        raise FileNotFoundError(cleaned)
    if not folder.is_dir():
        raise ValueError("not a folder")
    if app == "vscode":
        code = find_vscode()
        if not code:
            raise LookupError("VS Code was not found on this computer")
        # Absolute image and an explicit cwd, for the same reason explorer.exe
        # is spelled out above: never let CreateProcess search for the program.
        subprocess.Popen([code, str(folder)], cwd=str(folder))
        return {"action": "vscode"}
    _show_folder(folder)
    return {"action": "explorer"}
