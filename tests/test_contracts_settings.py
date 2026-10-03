from pathlib import Path


FRONTEND_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js"
PANELS_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js" / "panels.js"
CONFIG_SYNC_JS = FRONTEND_JS / "config_sync.js"
KEYS_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js" / "keys.js"
PALETTE_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js" / "palette.js"
TERMINAL_SETTINGS_JS = (
    Path(__file__).parents[1] / "quickterm" / "frontend" / "js" / "panel_settings_terminals.js"
)
FOCUS_JS = FRONTEND_JS / "focus.js"


def test_destructive_confirmation_keeps_trigger_visible_and_clamps_to_viewport():
    source = PANELS_JS.read_text(encoding="utf-8")
    start = source.index("  _confirmNear(")
    end = source.index("\n  _field(", start)
    implementation = source[start:end]

    assert "button.hidden = true" not in implementation
    assert implementation.index("button.getBoundingClientRect()") < implementation.index(
        "button.disabled = true"
    )
    assert "window.innerHeight - boxRect.height - margin" in implementation
    assert "window.innerWidth - boxRect.width - margin" in implementation


def test_panels_coordinator_stays_split_into_section_modules():
    source = PANELS_JS.read_text(encoding="utf-8")
    assert len(source.splitlines()) < 600
    for module in (
        "panel_dashboard.js",
        "panel_help.js",
        "panel_settings_general.js",
        "panel_settings_appearance.js",
        "panel_settings_terminals.js",
        "panel_settings_snippets.js",
        "panel_settings_about.js",
    ):
        assert f'from "./{module}"' in source


def test_shortcuts_keep_detach_and_confirmed_kill_distinct():
    keys = KEYS_JS.read_text(encoding="utf-8")
    assert "n: actions.newTerminal" in keys
    assert "d: actions.closePane" in keys
    assert "w: actions.killSession" in keys

    palette = PALETTE_JS.read_text(encoding="utf-8")
    assert 'label: "new terminal", hint: "Alt+N"' in palette
    assert 'label: "detach pane", hint: "Alt+D"' in palette
    assert 'label: "kill session and close pane", hint: "Alt+W"' in palette


def test_claude_code_is_an_explicit_project_profile_type():
    source = TERMINAL_SETTINGS_JS.read_text(encoding="utf-8")
    assert 'kind === "claude-code"' in source
    assert 'value: "continue"' in source
    assert 'value: "resume"' in source
    assert 'value: "agents"' in source
    assert 'value: "new"' in source
    # No folder field of any kind: the workspace places every Claude session.
    assert 'profile.cwd' not in source
    assert 'profile.subpath' not in source


def test_every_folder_field_browses_in_app_and_still_reaches_the_native_dialog():
    # This used to assert the native pywebview dialog *was* the mechanism. It
    # cannot be: that dialog exists only in the installed app, so Browse was
    # dead in a plain browser, and opening it moves focus out of the document.
    # The invariant that matters is unchanged in shape: one shared control
    # behind every folder field. But the primary picker is now the in-app
    # browser, with the OS dialog kept as a secondary route.
    settings = TERMINAL_SETTINGS_JS.read_text(encoding="utf-8")
    shared = (FRONTEND_JS / "panel_shared.js").read_text(encoding="utf-8")
    dashboard = (FRONTEND_JS / "panel_dashboard.js").read_text(encoding="utf-8")
    browser = (FRONTEND_JS / "folder_browser.js").read_text(encoding="utf-8")
    app = (Path(__file__).parents[1] / "quickterm" / "app.py").read_text(encoding="utf-8")

    # One shared control backs every folder field, so a fix reaches all of them.
    assert "export function folderPickerControl" in shared
    assert 'folder-picker-control' in shared
    # Primary: the in-app browser, opened from whatever the field already holds.
    assert 'from "./folder_browser.js"' in shared
    assert "openFolderBrowser({" in shared
    assert "startPath: input.value || options.startIn" in shared
    # Browse must never be disabled again: that is what made it useless outside
    # the installed app.
    assert "browse.disabled = !nativeFolderPickerAvailable()" not in shared
    # Secondary: the OS dialog, still reachable, still only where it exists.
    assert 'class _DesktopApi:' in app
    assert 'js_api=desktop_api' in app
    assert "pick: pickNativeFolder" in shared
    assert "nativeBtn.hidden = !(native && native.available())" in browser
    # The modal owns the keyboard while it is open, or the focused terminal
    # pane re-asserts term.focus() a frame later and steals the path bar.
    assert 'claimFocus(FOCUS_OWNER)' in browser
    assert 'releaseFocus(FOCUS_OWNER)' in browser
    # Both places a workspace folder is chosen: naming a new one, and
    # repointing an existing card. Terminal settings has no folder field at all
    # now; the only other folder is scratch's, under Settings > General.
    assert "folderPickerControl(" in dashboard
    assert dashboard.count("folderPickerControl(") >= 2
    assert "folderPickerControl(" not in settings
    general = (FRONTEND_JS / "panel_settings_general.js").read_text(encoding="utf-8")
    assert "folderPickerControl(scratch," in general


def test_the_scratch_folder_is_a_setting_that_round_trips():
    # The form edits the draft and its partial save re-reads the resolved root.
    general = (FRONTEND_JS / "panel_settings_general.js").read_text(encoding="utf-8")
    sync = CONFIG_SYNC_JS.read_text(encoding="utf-8")
    panels = PANELS_JS.read_text(encoding="utf-8")
    assert "this._textInput(cfg.scratch_dir || \"\"" in general
    assert "cfg.scratch_dir = scratch.value.trim();" in general
    assert 'this._field("Scratch folder", scratchField,' in general
    assert "this.settingsDraft = JSON.parse(JSON.stringify(cfg));" in panels
    assert "settingsPatch(this.settingsDraft, this.settingsBaseline, fresh)" in panels
    assert "await api.putConfig(patch);" in panels
    assert "state.scratchRoot = fresh.scratch_dir || null;" in sync


def test_dashboard_refreshes_by_patching_instead_of_rebuilding():
    dashboard = (FRONTEND_JS / "panel_dashboard.js").read_text(encoding="utf-8")
    panels = PANELS_JS.read_text(encoding="utf-8")

    # The dashboard reloads itself every 5 s. Emptying the panel body and
    # rebuilding it destroyed whatever the user was in the middle of, including
    # the <input> the folder picker had captured before awaiting the chooser.
    assert 'from "./render.js"' in dashboard
    assert "patchList(" in dashboard
    assert 'this.bodyEl.textContent = ""' not in dashboard.split("function buildDashboard")[1]

    # The refresh used to pause only while focus sat inside the panel body. The
    # picker disables its Browse button before awaiting, a disabled button drops
    # focus to <body>, and the guard let the refresh through. Callers now take
    # an explicit counted lock instead.
    assert "this.bodyEl.contains(document.activeElement)" not in panels
    assert "holdDashboardRefresh()" in panels
    assert "this._dashBusy > 0" in panels
    assert "panel.holdDashboardRefresh()" in dashboard


def test_profile_cycle_uses_free_alt_shift_arrows_not_shell_ctrl_arrows():
    keys = KEYS_JS.read_text(encoding="utf-8")
    assert 'if (key === "arrowleft") return done(() => actions.cycleTerminal(-1));' in keys
    assert 'if (key === "arrowup") return done(() => actions.cycleTerminal(1));' in keys
    ctrl_layer = keys[keys.index("if (e.ctrlKey"):keys.index("if (!e.altKey")]
    assert "arrowleft" not in ctrl_layer
    assert "arrowright" not in ctrl_layer


def test_every_configurable_thing_carries_its_own_description():
    """No configured thing is a bare name plus a value.

    A profile and a snippet each declare what they are for, are searchable by
    it, and say what they actually run. This is the invariant the whole
    Settings rework exists for, so it is asserted rather than left to review.
    """
    terminals = TERMINAL_SETTINGS_JS.read_text(encoding="utf-8")
    snippets = (FRONTEND_JS / "panel_settings_snippets.js").read_text(encoding="utf-8")
    kit = (FRONTEND_JS / "panel_settings_kit.js").read_text(encoding="utf-8")

    for source in (terminals, snippets):
        assert 'from "./panel_settings_kit.js"' in source
        # A first-class field with its own label and hint, not a placeholder
        # bolted onto something else.
        assert 'this._field("Description"' in source
        # A row shows the description and a compact line of what it runs.
        assert "configDescription(" in source
        assert "configSummary(" in source
        # A problem is marked at the item. The footer check in panels.js
        # `_settings()` stays as the backstop that refuses the save.
        assert "configProblems(" in source
        # An empty state names what to make; a filter searches every field.
        assert "configEmpty({" in source
        assert "matchesQuery(" in source
        # A newly added item is created with the key its editor binds to.
        assert 'description: ""' in source

    assert "export const FILTER_THRESHOLD" in kit
    assert "export function configEmpty" in kit
    # Terminal profiles have a kind, so they are grouped by it.
    assert "configGroupHeading(" in terminals
    assert "inferTerminalType(profile) === kind" in terminals


def test_profile_card_is_a_name_a_command_and_one_more_disclosure():
    """A profile shows a name, a command and a start command; the rest is under More.

    The user found eight to twelve controls per card, each with a line of
    prose, too much for what is usually "PowerShell, then uv run dev". Every
    chooser on the card is a menu.js menu, and the menu has to close on
    Escape before the sheet's own Escape handler closes the whole sheet.
    """
    terminals = TERMINAL_SETTINGS_JS.read_text(encoding="utf-8")
    kit = (FRONTEND_JS / "panel_settings_kit.js").read_text(encoding="utf-8")
    panels_css = (
        Path(__file__).parents[1] / "quickterm" / "frontend" / "css" / "panels.css"
    ).read_text(encoding="utf-8")

    assert "this._select(" not in terminals
    assert "configChoice({" in terminals
    assert "configPurpose(" not in terminals
    assert 'make("div", "profile-more")' in terminals
    assert 'toggle.setAttribute("aria-expanded", String(open));' in terminals
    assert "moreStartsOpen(profile, kind, profileProblems(profile, cfg.profiles, kind))" in terminals
    # Typing re-infers the type in place; only an explicit type choice redraws.
    command_input = terminals[terminals.index('command.addEventListener("input", () => {'):]
    command_input = command_input[: command_input.index("\n        });\n")]
    assert "rerender()" not in command_input
    assert "syncKind();" in command_input

    assert 'import { closeMenu, toggleMenu } from "./menu.js";' in kit
    assert 'window.addEventListener("keydown", escape, true);' in kit
    assert "event.stopImmediatePropagation();" in kit
    assert ".qt-menu.in-panel { z-index: 105; }" in panels_css


def test_text_zoom_leaves_readline_undo_and_star_to_the_shell():
    """Ctrl+_ is readline's undo and Ctrl+* no zoom key; a code alone never zooms."""
    keys = KEYS_JS.read_text(encoding="utf-8")
    assert 'key === "_"' not in keys
    assert 'key === "*"' not in keys
    for code in ('e.code === "Minus"', 'e.code === "Digit0"', 'e.code === "Numpad0"'):
        line = next(line for line in keys.splitlines() if code in line)
        assert "unnamed" in line, line


def test_settings_infers_a_profile_type_for_display_only():
    """Loading Settings must not stamp the inferred type onto every profile.

    A hand-edited profile without a type launches as a plain command; the
    stamp saved it with the inferred type on the next Save and changed how it
    starts. Only the user's own choice in a card sets `terminal_type`.
    """
    panels = PANELS_JS.read_text(encoding="utf-8")
    assert "profile.terminal_type = inferTerminalType(profile)" not in panels
    assert "profile.terminal_type =" not in panels


def test_menus_draw_above_the_sheet_and_below_the_error_banner():
    css = (FRONTEND_JS.parent / "css" / "menu.css").read_text(encoding="utf-8")
    rule = css[css.index(".qt-menu {"):]
    rule = rule[: rule.index("}")]
    assert "z-index: 130;" in rule
    app_css = (FRONTEND_JS.parent / "css" / "app.css").read_text(encoding="utf-8")
    assert ".panel-overlay { position: fixed; inset: 0; z-index: 100;" in app_css
    assert "z-index: 140;" in app_css  # #app-error


def test_every_overlay_claims_the_keyboard_before_focusing_its_own_control():
    # A pane re-asserts term.focus() on a frame and on a timeout, so an overlay
    # that only focuses its input loses it again one frame later. Alt+K opened a
    # palette you could not type into for exactly this reason.
    # main.js used to own an overlay of its own (the quick-settings drawer);
    # it no longer has one, so only the palette and the panels are checked.
    assert FOCUS_JS.exists()
    for source in (PALETTE_JS, PANELS_JS):
        text = source.read_text(encoding="utf-8")
        assert 'from "./focus.js"' in text, source.name
        assert "claimFocus(" in text, source.name
        assert "releaseFocus(" in text, source.name
