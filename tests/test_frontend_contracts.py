from pathlib import Path


FRONTEND_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js"
PANELS_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js" / "panels.js"
MAIN_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js" / "main.js"
PANE_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js" / "pane.js"
KEYS_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js" / "keys.js"
PALETTE_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js" / "palette.js"
TERMINAL_SETTINGS_JS = (
    Path(__file__).parents[1] / "quickterm" / "frontend" / "js" / "panel_settings_terminals.js"
)
LAUNCHER_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js" / "launcher.js"


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


def test_kill_all_closes_only_backend_verified_sessions():
    source = MAIN_JS.read_text(encoding="utf-8")
    start = source.index("    killAllSessions: async () =>")
    end = source.index("\n    moveSessionHere,", start)
    implementation = source[start:end]

    assert "new Set(result?.killed_ids || [])" in implementation
    assert "!killedIds.has(pane.session.id)" in implementation
    assert "result?.failed_ids || []" in implementation
    assert "workspaceSessionIds.clear()" not in implementation


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


def test_pane_uses_the_tested_attach_protocol_state_machine():
    source = PANE_JS.read_text(encoding="utf-8")
    assert 'from "./pane_protocol.js"' in source
    assert "new PaneAttachProtocol(" in source
    assert "this._protocol.canSendInput()" in source


def test_pane_focus_is_reasserted_after_async_attach_without_stealing_it_back():
    source = PANE_JS.read_text(encoding="utf-8")
    assert 'if (this._disposed || !this.term || !this.el.classList.contains("focused")) return;' in source
    assert "requestAnimationFrame(focus)" in source
    assert "setTimeout(focus, 0)" in source
    assert source.count("this.focusSoon();") >= 3


def test_shortcuts_keep_detach_and_confirmed_kill_distinct():
    keys = KEYS_JS.read_text(encoding="utf-8")
    assert "n: actions.newTerminal" in keys
    assert "d: actions.closePane" in keys
    assert "w: actions.killSession" in keys

    palette = PALETTE_JS.read_text(encoding="utf-8")
    assert 'label: "new terminal", hint: "Alt+N"' in palette
    assert 'label: "detach pane", hint: "Alt+D"' in palette
    assert 'label: "kill session and close pane", hint: "Alt+W"' in palette


def test_detach_retains_process_and_never_calls_kill():
    source = MAIN_JS.read_text(encoding="utf-8")
    start = source.index("    closePane: async () =>")
    end = source.index("\n    killFocusedSession:", start)
    implementation = source[start:end]

    assert "await api.retainSession(session.id)" in implementation
    assert "api.killSession" not in implementation


def test_workspace_restore_does_not_silently_spawn_over_missing_session():
    source = MAIN_JS.read_text(encoding="utf-8")
    start = source.index("  async function restoreWorkspace(")
    end = source.index("\n  async function startScratch", start)
    implementation = source[start:end]

    assert "pane.markUnavailable({" in implementation
    assert "onResumeClaude" in implementation
    assert "onPickClaude" in implementation


def test_claude_code_is_an_explicit_project_profile_type():
    source = TERMINAL_SETTINGS_JS.read_text(encoding="utf-8")
    assert 'kind === "claude-code"' in source
    assert 'value: "continue"' in source
    assert 'value: "resume"' in source
    assert 'value: "agents"' in source
    assert 'value: "new"' in source
    assert '"Project folder"' in source


def test_every_folder_field_has_the_native_picker():
    settings = TERMINAL_SETTINGS_JS.read_text(encoding="utf-8")
    shared = (FRONTEND_JS / "panel_shared.js").read_text(encoding="utf-8")
    dashboard = (FRONTEND_JS / "panel_dashboard.js").read_text(encoding="utf-8")
    app = (Path(__file__).parents[1] / "quickterm" / "app.py").read_text(encoding="utf-8")

    assert 'class _DesktopApi:' in app
    assert 'js_api=desktop_api' in app
    # One shared control backs every folder field, so a fix reaches all of them.
    assert "export function folderPickerControl" in shared
    assert "pickNativeFolder(input.value" in shared
    assert 'folder-picker-control' in shared
    for source in (settings, dashboard):
        assert "folderPickerControl(" in source
    # Both places a workspace folder is chosen: naming a new one, and
    # repointing an existing card.
    assert dashboard.count("folderPickerControl(") >= 2
    assert 'kind === "claude-code" ? "Project folder" : "Starting folder"' in settings


def test_workspace_folder_reaches_every_spawn_path():
    main = MAIN_JS.read_text(encoding="utf-8")
    api = (FRONTEND_JS / "api.js").read_text(encoding="utf-8")
    # An absent "path" key preserves the stored folder; every layout autosave
    # relies on that, so the wrapper must not default it to null.
    assert "...(path === undefined ? {} : { path })" in api
    assert "function contextCwd(explicit, profile)" in main
    # A profile pinned to a fixed folder keeps it; everything else defers to
    # the workspace root the backend resolves.
    assert "if (profile && profile.cwd) return null;" in main
    assert "return scratchRoot || null;" in main


def test_sidebar_collapse_returns_input_focus_to_the_terminal():
    source = LAUNCHER_JS.read_text(encoding="utf-8")
    assert "requestAnimationFrame(() => options.onLaunchComplete?.())" in source


def test_open_here_claims_one_folder_launch_and_shows_workspace_global_counts():
    main = MAIN_JS.read_text(encoding="utf-8")
    launcher = LAUNCHER_JS.read_text(encoding="utf-8")
    assert "const launch = await api.claimLaunch()" in main
    assert "await openFolderInScratch(launch.cwd)" in main
    assert "`${workspaceLabel} · ${totalLive} total`" in main
    assert "`${visible.length}/${totalLive}`" in launcher


def test_profile_cycle_uses_free_alt_shift_arrows_not_shell_ctrl_arrows():
    keys = KEYS_JS.read_text(encoding="utf-8")
    assert 'if (key === "arrowleft") return done(() => actions.cycleTerminal(-1));' in keys
    assert 'if (key === "arrowup") return done(() => actions.cycleTerminal(1));' in keys
    ctrl_layer = keys[keys.index("if (e.ctrlKey"):keys.index("if (!e.altKey")]
    assert "arrowleft" not in ctrl_layer
    assert "arrowright" not in ctrl_layer


def test_splits_inherit_signalled_directory_without_changing_new_terminal_policy():
    main = MAIN_JS.read_text(encoding="utf-8")
    pane = PANE_JS.read_text(encoding="utf-8")
    palette = PALETTE_JS.read_text(encoding="utf-8")

    assert 'from "./split_policy.js"' in main
    assert "spawnSplitInto(pane, source)" in main
    assert "newTerminal:" in main and "spawnDefaultInto(pane)" in main
    assert "registerOscHandler(7" in pane
    assert "registerOscHandler(9" in pane
    assert "split Claude agent view:" in palette
    assert 'claudeMode: "agents"' in main


def test_full_panels_return_focus_to_the_terminal():
    panels = PANELS_JS.read_text(encoding="utf-8")
    main = MAIN_JS.read_text(encoding="utf-8")

    assert "if (!this.app.refocusTerm()" in panels
    assert "if (!layout.focused) return false" in main
    assert "layout.focused.setFocused(true)" in main
