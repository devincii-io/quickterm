import re
from pathlib import Path

ROOT = Path(__file__).parents[1]
FRONTEND_JS = ROOT / "quickterm" / "frontend" / "js"
FRONTEND_CSS = ROOT / "quickterm" / "frontend" / "css"
PANELS_JS = FRONTEND_JS / "panels.js"
CONFIG_SYNC_JS = FRONTEND_JS / "config_sync.js"
KEYS_JS = FRONTEND_JS / "keys.js"
PALETTE_JS = FRONTEND_JS / "palette.js"
CONNECTIONS_JS = FRONTEND_JS / "panel_connections.js"
SNIPPETS_JS = FRONTEND_JS / "panel_settings_snippets.js"
ABOUT_JS = FRONTEND_JS / "panel_settings_about.js"
CONFIG_LIST_JS = FRONTEND_JS / "config_list.js"
SHORTCUT_INPUT_JS = FRONTEND_JS / "shortcut_input.js"
FOCUS_JS = FRONTEND_JS / "focus.js"

SETTINGS_SOURCES = (
    "panels.js",
    "panel_settings_general.js",
    "panel_settings_window.js",
    "panel_settings_shortcuts.js",
    "panel_settings_about.js",
    "panel_settings_kit.js",
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_destructive_confirmation_keeps_trigger_visible_and_clamps_to_viewport():
    source = read(PANELS_JS)
    start = source.index("  _confirmNear(")
    end = source.index("\n  _field(", start)
    implementation = source[start:end]
    # Settings, the dashboard and the sidebar share one confirmation box.
    assert 'import { confirmNear } from "./confirm_popover.js";' in source
    assert "{ keyboard = false } = {}" in implementation
    assert "confirmNear(button, {" in implementation
    assert "keyboard, owner: \"confirm\"" in implementation

    popover = read(FRONTEND_JS / "confirm_popover.js")
    assert "trigger.hidden = true" not in popover
    opener = popover[popover.index("export function confirmNear("):]
    assert opener.index("trigger.getBoundingClientRect()") < opener.index("trigger.disabled = true")
    assert "viewport.height - boxSize.height - margin" in popover
    assert "viewport.width - boxSize.width - margin" in popover
    # AGENTS.md: Cancel owns the initial focus when a pointer opened the bar;
    # only the keyboard path lands on the destructive button.
    assert 'return keyboard ? "confirm" : "cancel";' in popover
    assert '(initialFocus(keyboard) === "confirm" ? confirm : cancel).focus()' in popover
    assert opener.index("claimFocus(owner);") < opener.index("(initialFocus(keyboard)")


def test_panels_coordinator_stays_split_into_section_modules():
    source = read(PANELS_JS)
    assert len(source.splitlines()) < 600
    for module in (
        "panel_dashboard.js",
        "panel_help.js",
        "panel_settings_general.js",
        "panel_settings_appearance.js",
        "panel_settings_window.js",
        "panel_settings_shortcuts.js",
        "panel_connections.js",
        "panel_settings_snippets.js",
        "panel_settings_about.js",
    ):
        assert f'from "./{module}"' in source
    # The card editor is gone; its pure rules live in profile_model.js.
    assert not (FRONTEND_JS / "panel_settings_terminals.js").exists()
    assert "export function runLine" in read(FRONTEND_JS / "profile_model.js")


def test_shortcuts_keep_detach_and_confirmed_kill_distinct():
    keys = read(KEYS_JS)
    assert "n: actions.newTerminal" in keys
    assert "d: actions.closePane" in keys
    assert "w: actions.killSession" in keys

    palette = read(PALETTE_JS)
    assert 'label: "new terminal", hint: "Alt+N"' in palette
    assert 'label: "detach pane", hint: "Alt+D"' in palette
    assert 'label: "kill session and close pane", hint: "Alt+W"' in palette


def test_agents_are_explicit_profile_types_with_schema_driven_options():
    connections = read(CONNECTIONS_JS)
    fields = read(FRONTEND_JS / "panel_agent_fields.js")
    assert '{ id: "claude-code", label: "Claude Code", group: "Agents", cmd: "claude" }' in connections
    assert '{ id: "codex", label: "Codex", group: "Agents", cmd: "codex" }' in connections
    # The options come from GET /api/system/agents through the api namespace;
    # the frontend names no CLI flag of its own.
    assert "getAgentCatalog?.()" in connections
    assert 'import * as api from "./api.js";' in connections
    for flag in ("permission_mode", "approve_for_me", "--model", "bypassPermissions"):
        assert flag not in fields, flag
        assert flag not in connections, flag
    # No folder field of any kind: the workspace places every agent session.
    assert "profile.cwd" not in connections
    assert "profile.subpath" not in connections


def test_every_folder_field_browses_in_app_and_still_reaches_the_native_dialog():
    # One shared control backs every folder field. The primary picker is the
    # in-app browser; the native dialog is a secondary route where it exists.
    shared = read(FRONTEND_JS / "panel_shared.js")
    dashboard = read(FRONTEND_JS / "panel_dashboard.js")
    browser = read(FRONTEND_JS / "folder_browser.js")
    app = read(ROOT / "quickterm" / "app.py")

    assert "export function folderPickerControl" in shared
    assert "folder-picker-control" in shared
    assert 'from "./folder_browser.js"' in shared
    assert "openFolderBrowser({" in shared
    assert "startPath: input.value || options.startIn" in shared
    assert "browse.disabled = !nativeFolderPickerAvailable()" not in shared
    assert "class _DesktopApi:" in app
    assert "js_api=desktop_api" in app
    assert "pick: pickNativeFolder" in shared
    assert "nativeBtn.hidden = !(native && native.available())" in browser
    assert "claimFocus(FOCUS_OWNER)" in browser
    assert "releaseFocus(FOCUS_OWNER)" in browser
    # Workspace folders are chosen on the dashboard. Terminal configs have no
    # folder at all; the only other folder is scratch's, under Advanced.
    assert dashboard.count("folderPickerControl(") >= 2
    assert "folderPickerControl(" not in read(CONNECTIONS_JS)
    assert "folderPickerControl(scratch," in read(ABOUT_JS)


def test_the_scratch_folder_is_a_setting_that_round_trips():
    advanced = read(ABOUT_JS)
    sync = read(CONFIG_SYNC_JS)
    panels = read(PANELS_JS)
    assert 'this._textInput(cfg.scratch_dir || ""' in advanced
    assert "cfg.scratch_dir = scratch.value.trim();" in advanced
    assert 'this._field("Scratch folder", scratchField,' in advanced
    assert "this.settingsDraft = JSON.parse(JSON.stringify(cfg));" in panels
    assert "settingsPatch(this.settingsDraft, this.settingsBaseline, fresh)" in panels
    assert "await api.putConfig(patch);" in panels
    assert "state.scratchRoot = fresh.scratch_dir || null;" in sync


def test_dashboard_refreshes_by_patching_instead_of_rebuilding():
    dashboard = read(FRONTEND_JS / "panel_dashboard.js")
    panels = read(PANELS_JS)

    assert 'from "./render.js"' in dashboard
    assert "patchList(" in dashboard
    assert 'this.bodyEl.textContent = ""' not in dashboard.split("function buildDashboard")[1]
    assert "this.bodyEl.contains(document.activeElement)" not in panels
    assert "holdDashboardRefresh()" in panels
    assert "this._dashBusy > 0" in panels
    assert "panel.holdDashboardRefresh()" in dashboard
    # "open workspace" is the wording; the app maps it to open or focus a view.
    assert '"Open workspace"' in dashboard
    assert "panel.app.loadWorkspace(" in dashboard


def test_profile_cycle_uses_free_alt_shift_arrows_not_shell_ctrl_arrows():
    keys = read(KEYS_JS)
    assert 'if (key === "arrowleft") return done(() => actions.cycleTerminal(-1));' in keys
    assert 'if (key === "arrowup") return done(() => actions.cycleTerminal(1));' in keys
    ctrl_layer = keys[keys.index("if (e.ctrlKey") : keys.index("if (!e.altKey")]
    assert "arrowleft" not in ctrl_layer
    assert "arrowright" not in ctrl_layer


def test_every_configurable_thing_carries_its_own_description():
    """Terminals and snippets each declare what they are for and say what they run.

    Both are a master-detail list: a compact row with the problem marker, and
    an editor with a Description field. A problem is marked at the item; the
    footer check stays as the backstop that refuses the save.
    """
    for source in (read(CONNECTIONS_JS), read(SNIPPETS_JS)):
        assert 'from "./config_list.js"' in source
        assert "renderConfigList({" in source
        assert '"Description"' in source
        assert "configProblems(" in source
        assert "configEmpty({" in source
        assert re.search(r"\bproblems[,:]", source)
        assert "summary:" in source
        assert "itemDirty(this.savedSnapshots," in source
    assert 'description: ""' in read(CONNECTIONS_JS)
    assert 'description: ""' in read(SNIPPETS_JS)
    assert "settingsProblems(this.settingsDraft" in read(PANELS_JS)


def test_config_pages_are_rows_and_a_side_editor_not_cards():
    """No tile grid and no card per item: rows patched in place beside one editor."""
    config_list = read(CONFIG_LIST_JS)
    kit = read(FRONTEND_JS / "panel_settings_kit.js")
    panels_css = read(FRONTEND_CSS / "panels.css")
    connections_css = read(FRONTEND_CSS / "connections.css")

    assert "patchList(rowsEl, shown," in config_list
    assert "setText(p.name, title)" in config_list
    assert 'NARROW_QUERY = "(max-width: 820px)"' in config_list
    # Typing patches the row; only a change of selection draws the editor.
    select = config_list[config_list.index("function select(") :]
    select = select[: select.index("\n  }\n")]
    assert "if (item !== current)" in select
    for source in (read(CONNECTIONS_JS), read(SNIPPETS_JS)):
        assert 'make("article"' not in source
        assert "rerender()" not in source
    for selector in (".terminal-profile-card", ".profile-main", ".profile-more", ".snippet-card", ".connection-type"):
        assert selector not in panels_css, selector
        assert selector not in connections_css, selector
    # Menus opened from the sheet close on Escape before the sheet does.
    assert 'import { closeMenu, toggleMenu } from "./menu.js";' in kit
    assert 'window.addEventListener("keydown", escape, true);' in kit
    assert "event.stopImmediatePropagation();" in kit
    assert ".qt-menu.in-panel { z-index: 105; }" in panels_css


def test_one_save_persists_everything():
    connections = read(CONNECTIONS_JS)
    panels = read(PANELS_JS)
    assert "putConfig" not in connections
    assert "Save connection" not in connections
    assert panels.count("api.putConfig(") == 1
    # The editors' Save and Ctrl+S in the sheet reach the same method.
    assert "this._saveSettings?.()" in connections
    assert "this._saveSettings?.()" in read(SNIPPETS_JS)
    assert 'event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "s"' in panels
    assert '"ctrl+s"' not in read(KEYS_JS)


def test_no_native_select_anywhere_in_the_frontend():
    for path in FRONTEND_JS.glob("*.js"):
        text = read(path)
        assert 'make("select"' not in text, path.name
        assert 'createElement("select")' not in text, path.name
        assert "this._select(" not in text, path.name
    assert "_select(" not in read(PANELS_JS)


def test_every_settings_field_stamps_its_search_id():
    panels = read(PANELS_JS)
    field = panels[panels.index("  _field(") :]
    field = field[: field.index("\n  }\n")]
    assert "field.dataset.setting = id" in field
    index = read(FRONTEND_JS / "settings_index.js")
    ids = re.findall(r'\{ id: "([^"]+)", tab:', index)
    assert len(ids) > 20
    sources = "\n".join(read(FRONTEND_JS / name) for name in SETTINGS_SOURCES)
    for setting in ids:
        stamped = f'"{setting}"' in sources
        if setting.startswith("overlay.") and not stamped:
            stamped = f'["{setting.split(".", 1)[1]}",' in read(FRONTEND_JS / "panel_settings_window.js")
        assert stamped, setting
    for method in ("async showSetting(id)", "async showConfig(kind, name = null)", "settingEntries()"):
        assert method in panels


def test_shortcut_capture_claims_the_keyboard_and_pauses_global_hotkeys():
    source = read(SHORTCUT_INPUT_JS)
    assert 'import { claimFocus, releaseFocus } from "./focus.js";' in source
    assert 'import * as api from "./api.js";' in source
    assert "api.suspendHotkeys?.(on)" in source
    start = source[source.index("  const start = () => {") :]
    start = start[: start.index("\n  };\n")]
    assert start.index('claimFocus("shortcut")') < start.index("button.focus()")
    assert 'window.addEventListener("keydown", onKey, true)' in start
    assert "event.stopImmediatePropagation();" in source
    assert 'releaseFocus("shortcut")' in source
    # The in-app layer is registered first, so it must step aside by itself.
    assert 'focusOwners().includes("shortcut")' in read(KEYS_JS)
    assert "capturing: captureActive()" in read(PANELS_JS)


def test_text_zoom_leaves_readline_undo_and_star_to_the_shell():
    """Ctrl+_ is readline's undo and Ctrl+* no zoom key; a code alone never zooms."""
    keys = read(KEYS_JS)
    assert 'key === "_"' not in keys
    assert 'key === "*"' not in keys
    for code in ('e.code === "Minus"', 'e.code === "Digit0"', 'e.code === "Numpad0"'):
        line = next(line for line in keys.splitlines() if code in line)
        assert "unnamed" in line, line


def test_settings_infers_a_profile_type_for_display_only():
    """Loading Settings must not stamp the inferred type onto every profile.

    A hand-edited profile without a type launches as a plain command; the
    stamp saved it with the inferred type on the next Save and changed how it
    starts. Only an edit of a type-bound field in the editor sets it.
    """
    panels = read(PANELS_JS)
    assert "profile.terminal_type = inferTerminalType(profile)" not in panels
    assert "profile.terminal_type =" not in panels
    connections = read(CONNECTIONS_JS)
    assert "if (!profile.terminal_type) profile.terminal_type = kind;" in connections


def test_menus_draw_above_the_sheet_and_below_the_error_banner():
    css = read(FRONTEND_CSS / "menu.css")
    rule = css[css.index(".qt-menu {") :]
    rule = rule[: rule.index("}")]
    assert "z-index: 130;" in rule
    app_css = read(FRONTEND_CSS / "app.css")
    assert ".panel-overlay { position: fixed; inset: 0; z-index: 100;" in app_css
    assert "z-index: 140;" in app_css  # #app-error


def test_every_overlay_claims_the_keyboard_before_focusing_its_own_control():
    # A pane re-asserts term.focus() on a frame and on a timeout, so an overlay
    # that only focuses its input loses it again one frame later. Alt+K opened a
    # palette you could not type into for exactly this reason.
    assert FOCUS_JS.exists()
    for source in (PALETTE_JS, PANELS_JS, SHORTCUT_INPUT_JS):
        text = read(source)
        assert 'from "./focus.js"' in text, source.name
        assert "claimFocus(" in text, source.name
        assert "releaseFocus(" in text, source.name
