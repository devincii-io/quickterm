# PyInstaller recipe for the standalone Windows release.

from PyInstaller.utils.hooks import collect_submodules


hiddenimports = collect_submodules("uvicorn")

a = Analysis(
    ["quickterm/app.py"],
    pathex=[],
    binaries=[],
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
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
