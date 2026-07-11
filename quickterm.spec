# PyInstaller recipe for the standalone Windows release.

import os

import winpty
from PyInstaller.utils.hooks import collect_submodules


hiddenimports = collect_submodules("uvicorn") + collect_submodules("webview")
# Server handlers reach these via importlib.import_module(...) so tests can stub
# them; PyInstaller's static graph can't see a runtime string, so list them here
# or they go missing from the frozen build (a missing one 500s the endpoint).
hiddenimports += [
    "quickterm.opener",
    "quickterm.update",
    "quickterm.workspace",
    "quickterm.config",
    # Reached via importlib in server.py (/api/mcp/setup) and re-served by the
    # `QuickTerm.exe mcp` subcommand; auth is its lazy dependency for the token.
    "quickterm.mcp_server",
    "quickterm.auth",
]

# pywinpty spawns two helper executables at runtime to host the pseudoconsole
# (OpenConsole.exe for the ConPTY backend, winpty-agent.exe for the legacy one).
# PyInstaller follows the DLL imports of _winpty.pyd but never sees these spawned
# EXEs, so without this they are missing from the bundle and every shell dies
# instantly with 0xC000013A ("the console was closed"). They must sit next to
# conpty.dll/winpty.dll inside the winpty/ package directory.
_winpty_dir = os.path.dirname(winpty.__file__)
winpty_binaries = [
    (os.path.join(_winpty_dir, name), "winpty")
    for name in ("OpenConsole.exe", "winpty-agent.exe", "conpty.dll", "winpty.dll")
    if os.path.exists(os.path.join(_winpty_dir, name))
]

a = Analysis(
    ["quickterm/app.py"],
    pathex=[],
    binaries=winpty_binaries,
    datas=[("quickterm/frontend", "quickterm/frontend")],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["quickterm.pty_posix"],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
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
