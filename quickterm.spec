# PyInstaller recipe for the installed/portable Windows app folder.

import hashlib
import os
import sys

import winpty
from PyInstaller.utils.hooks import collect_submodules

sys.path.insert(0, os.path.join(SPECPATH, "scripts"))
from fetch_putty import PUTTY_SHA256, VENDOR_DIR  # noqa: E402


hiddenimports = collect_submodules("uvicorn") + collect_submodules("webview")
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

# pywinpty spawns two helper executables at runtime to host the pseudoconsole
# (OpenConsole.exe for the ConPTY backend, winpty-agent.exe for the legacy one).
# PyInstaller follows the DLL imports of _winpty.pyd but never sees these spawned
# EXEs, so without this they are missing from the bundle and every shell dies
# instantly with 0xC000013A ("the console was closed"). They must sit next to
# conpty.dll/winpty.dll inside the winpty/ package directory.
_winpty_dir = os.path.dirname(winpty.__file__)
_winpty_names = ("OpenConsole.exe", "winpty-agent.exe", "conpty.dll", "winpty.dll")
_missing_winpty = [name for name in _winpty_names if not os.path.exists(os.path.join(_winpty_dir, name))]
if _missing_winpty:
    raise RuntimeError(f"release build missing required pywinpty helpers: {_missing_winpty}")
winpty_binaries = [(os.path.join(_winpty_dir, name), "winpty") for name in _winpty_names]

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
        f"({'; '.join(_putty_problems)}) — run: python scripts/fetch_putty.py"
    )
putty_binaries = [(str(VENDOR_DIR / name), "putty") for name in PUTTY_SHA256]

a = Analysis(
    ["quickterm/app.py"],
    pathex=[],
    binaries=winpty_binaries + putty_binaries,
    datas=[("quickterm/frontend", "quickterm/frontend")],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["quickterm.pty_posix"],
    noarchive=False,
    optimize=1,
)
# PyInstaller also discovers these two DLL dependencies and places copies at
# `_internal/`, but pywinpty loads them beside `_winpty.pyd` in
# `_internal/winpty/`. Keep the package-local copies above and drop the unused
# root duplicates (about 2.5 MB installed).
a.binaries = [
    entry for entry in a.binaries
    if entry[0].replace("\\", "/").lower() not in {"winpty.dll", "conpty.dll"}
]
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
