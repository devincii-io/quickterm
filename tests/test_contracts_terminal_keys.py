"""Find in terminal, the recent-terminals list and the workspace keys (4.3).

The search addon is vendored like the other xterm addons: the exact release
that shipped with xterm 6.0.0, its licence next to it, loaded by index.html
and packaged with the frontend folder. The keys it adds are listed where
AGENTS.md, Help and Settings read them from.
"""

import re
from pathlib import Path

ROOT = Path(__file__).parents[1]
FRONTEND = ROOT / "quickterm" / "frontend"
VENDOR = FRONTEND / "vendor"
JS = FRONTEND / "js"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_the_search_addon_is_vendored_with_its_licence_and_pinned():
    addon = read(VENDOR / "addon-search.js")
    assert addon.startswith("!function(e,t)"), "the UMD lib build, as the other addons"
    assert "SearchAddon" in addon
    licence = read(VENDOR / "addon-search.LICENSE")
    assert "The xterm.js authors" in licence
    assert "Permission is hereby granted" in licence
    contracts = read(ROOT / "docs" / "CONTRACTS.md")
    assert "`@xterm/addon-search@0.16.0`" in contracts
    assert "`@xterm/xterm@6.0.0`" in contracts


def test_index_loads_the_addon_after_xterm_and_the_new_stylesheets():
    html = read(FRONTEND / "index.html")
    scripts = re.findall(r'<script src="(/vendor/[^"]+)"', html)
    assert scripts[0] == "/vendor/xterm.js"
    assert "/vendor/addon-search.js" in scripts
    for sheet in ("/css/switcher.css", "/css/pane_find.css"):
        assert f'href="{sheet}"' in html
        assert (FRONTEND / sheet.lstrip("/")).is_file()


def test_the_frozen_build_ships_the_whole_frontend_folder():
    spec = read(ROOT / "quickterm.spec")
    assert 'datas=[("quickterm/frontend", "quickterm/frontend")]' in spec


def test_the_new_keys_are_claimed_listed_and_documented():
    keys = read(JS / "keys.js")
    # By physical digit: the layout's shifted symbol is never the digit.
    assert r"/^Digit([1-9])$/.exec(e.code" in keys
    assert '"alt+pagedown", "alt+pageup"' in keys
    assert '"ctrl+tab", "ctrl+shift+tab"' in keys
    assert 'e.key === "Control"' in keys
    # The pane owns Ctrl+Shift+F; plain Ctrl+F is readline's forward-char.
    pane = read(JS / "pane.js")
    assert 'e.shiftKey && (key === "f" || e.code === "KeyF")' in pane
    agents = read(ROOT / "AGENTS.md")
    for claimed in ("Ctrl+Shift+1..9", "Alt+PageDown/PageUp", "Ctrl+Tab", "Ctrl+Shift+F"):
        assert claimed in agents, claimed
    help_panel = read(JS / "panel_help.js")
    assert "SHORTCUTS.map" in help_panel, "Help renders every row of SHORTCUTS"


def test_window_keys_reach_views_through_the_shell():
    shell = read(JS / "shell.js")
    assert "window.quicktermChrome.windowKeys = windowKeys;" in shell
    assert "...windowKeys," in shell
    # The focused terminal is recorded on every refresh a view asks for.
    assert "noteFocus();" in shell
    keys = read(JS / "keys.js")
    assert "quicktermChrome?.windowKeys?.[name]" in keys


def test_the_overlays_hand_the_keyboard_back():
    switcher = read(JS / "switcher.js")
    assert 'claimFocus(OWNER);' in switcher and 'releaseFocus(OWNER);' in switcher
    # Released before the chosen terminal is shown, or it could not take focus.
    commit = switcher[switcher.index("function commit()"):switcher.index("function cancel()")]
    assert commit.index("teardown();") < commit.index("choose(id)")
    find = read(JS / "pane_find.js")
    assert 'const OWNER = "pane-find";' in find
    assert "this.pane.focusSoon()" in find
