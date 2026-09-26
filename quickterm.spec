# PyInstaller recipe for the installed/portable Windows app folder.

import hashlib
import importlib.util
import os
import sys

from PyInstaller.utils.hooks import collect_submodules

sys.path.insert(0, os.path.join(SPECPATH, "scripts"))
from fetch_putty import PUTTY_SHA256, VENDOR_DIR  # noqa: E402


# The server explicitly selects these protocol implementations. Avoid bundling
# Uvicorn's development reloader, alternate parsers and every optional loop;
# they add roughly a megabyte and are never reachable in the desktop app.
hiddenimports = collect_submodules("webview") + [
    "uvicorn.lifespan.on",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.websockets_sansio_impl",
]
# Server handlers reach these via importlib.import_module(...) so tests can stub
# them; PyInstaller's static graph can't see a runtime string, so list them here
# or they go missing from the frozen build (a missing one 500s the endpoint).
hiddenimports += [
    "quickterm.opener",
    "quickterm.update",
    "quickterm.assets",
    "quickterm.workspace",
    "quickterm.config",
    "quickterm.auth",
]

# The ConPTY host: conpty.dll starts OpenConsole.exe from its own folder, so
# both go to `conpty/` together (quickterm/conpty.py loads them from there).
# QuickTerm takes them from the pywinpty wheel without importing pywinpty, so
# PyInstaller never sees them on its own; without OpenConsole.exe every shell
# dies at once with 0xC000013A ("the console was closed").
_winpty_spec = importlib.util.find_spec("winpty")
_conpty_dir = list(_winpty_spec.submodule_search_locations)[0] if _winpty_spec else ""
_conpty_names = ("OpenConsole.exe", "conpty.dll")
_missing_conpty = [name for name in _conpty_names if not os.path.isfile(os.path.join(_conpty_dir, name))]
if _missing_conpty:
    raise RuntimeError(f"release build missing the ConPTY host from pywinpty: {_missing_conpty}")
conpty_binaries = [(os.path.join(_conpty_dir, name), "conpty") for name in _conpty_names]

# Bundled PuTTY console tools (ssh/sftp terminal types + on-PATH pscp). Pinned
# and hash-verified: a missing or tampered exe fails the build, it never ships.
_putty_problems = []
for _name, _expected in PUTTY_SHA256.items():
    _path = VENDOR_DIR / _name
    if not _path.is_file():
        _putty_problems.append(f"{_name}: missing")
    elif hashlib.sha256(_path.read_bytes()).hexdigest() != _expected.lower():
        _putty_problems.append(f"{_name}: SHA-256 mismatch")
if _putty_problems:
    raise RuntimeError(
        "PuTTY tools not ready for release build "
        f"({'; '.join(_putty_problems)}). Run: python scripts/fetch_putty.py"
    )
putty_binaries = [(str(VENDOR_DIR / name), "putty") for name in PUTTY_SHA256]

a = Analysis(
    ["quickterm/app.py"],
    pathex=[],
    binaries=conpty_binaries + putty_binaries,
    datas=[("quickterm/frontend", "quickterm/frontend")],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "quickterm.pty_posix",
        "winpty",  # only its two ConPTY files ship, above
        "httptools",
        "watchfiles",
        "yaml",
        "uvicorn.loops.uvloop",
        "uvicorn.protocols.http.httptools_impl",
        "uvicorn.protocols.websockets.wsproto_impl",
    ],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="QuickTerm",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX mangles the pseudoconsole helpers (OpenConsole.exe/conpty.dll) and the
    # WebView2 loader, which breaks terminal spawning and the native window.
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon="quickterm/resources/quickterm.ico",
)

# Install as a real application folder instead of a self-extracting one-file
# executable. Each one-file QuickTerm process otherwise expands another ~38 MB
# private _MEI runtime into %TEMP%; multiple windows can look like a 200 MB app
# and pay that extraction cost at every cold launch.
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="QuickTerm",
)
