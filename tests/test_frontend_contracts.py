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
    # No folder field of any kind: the workspace places every Claude session.
    assert 'profile.cwd' not in source
    assert 'profile.subpath' not in source


def test_every_folder_field_browses_in_app_and_still_reaches_the_native_dialog():
    # This used to assert the native pywebview dialog *was* the mechanism. It
    # cannot be: that dialog exists only in the installed app, so Browse was
    # dead in a plain browser, and opening it moves focus out of the document.
    # The invariant that matters is unchanged in shape — one shared control
    # behind every folder field — but the primary picker is now the in-app
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
    # now, so the dashboard is the only picker left.
    assert "folderPickerControl(" in dashboard
    assert dashboard.count("folderPickerControl(") >= 2
    assert "folderPickerControl(" not in settings


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


def test_workspace_folder_reaches_every_spawn_path():
    main = MAIN_JS.read_text(encoding="utf-8")
    api = (FRONTEND_JS / "api.js").read_text(encoding="utf-8")
    # An absent "path" key preserves the stored folder; every layout autosave
    # relies on that, so the wrapper must not default it to null.
    assert "...(path === undefined ? {} : { path })" in api
    assert "function contextCwd(explicit)" in main
    # Profiles carry no folder, so nothing local can pre-empt the workspace
    # root the backend resolves. Scratch is the one exception: its throwaway
    # root is only known to the viewer.
    assert "profile.cwd" not in main
    assert "return scratchRoot || null;" in main


def test_sidebar_collapse_returns_input_focus_to_the_terminal():
    source = LAUNCHER_JS.read_text(encoding="utf-8")
    assert "requestAnimationFrame(() => options.onLaunchComplete?.())" in source


def test_open_here_claims_one_folder_launch():
    """The status bar is gone; the sidebar list is the only count there is.

    The launcher assertion used to pin `${visible.length}/${totalLive}`, the
    count of a list filtered down to this window's own terminals. That filter
    was the bug: seven live terminals showed as "2/7" with no way to reach the
    other five. The invariant is now the opposite one, kept by
    test_sidebar_lists_every_live_terminal_grouped_by_workspace.
    """
    main = MAIN_JS.read_text(encoding="utf-8")
    assert "const launch = await api.claimLaunch()" in main
    assert "await openFolderInScratch(launch.cwd)" in main


def test_sidebar_lists_every_live_terminal_grouped_by_workspace():
    """Nothing live may be filtered out of the sidebar, and none of it is stolen.

    The list is grouped by the workspace that owns each terminal, using the
    same ownership rule the dashboard applies, and the pill counts the backend
    total. Acting on a terminal another workspace owns stays a decision: the
    row offers "open that workspace" or an explicit move, and never attaches on
    the click itself.
    """
    launcher = LAUNCHER_JS.read_text(encoding="utf-8")
    # No filter may narrow the list to what this window happens to hold.
    assert "owned.has(session.id) || attached.has(session.id)" not in launcher
    assert "groupSessionsByWorkspace(sessions, {" in launcher
    assert "`${here} in ${workspaceName} · ${totalLive} live on this backend`" in launcher
    # Claude needs no profile: the CLI found by the inventory is offered as is.
    assert 'key: `claude:${mode}`' in launcher

    start = launcher.index("  const sessionEntry = (entry, group) => {")
    end = launcher.index("\n  const sessionGroup =", start)
    entry = launcher[start:end]
    # A foreign row arms its choices; only the two labelled buttons act.
    assert 'const foreign = !isHere && group.kind === "workspace";' in entry
    assert entry.index("if (!foreign) {") < entry.index("options.onAttachSession?.(session)")
    assert "row.addEventListener(\"click\", () => setArmed(" in entry
    assert "options.onWorkspace?.(target)" in entry
    assert "options.onMoveSession(session, target)" in entry


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

def test_absolutely_positioned_sidebar_children_outrank_the_stretch_rule():
    """app.css stretches every direct sidebar child; the grip must outrank it.

    `.launcher.sidebar > * { width: 100% }` beats a bare `.sidebar-grip` on
    specificity whatever the file order, so the grip computed to the full
    sidebar width. Being absolutely positioned at z-index 30, it then covered
    the workspace list, the terminal picker and the footer buttons, and none of
    them could be clicked at all. Only caught by opening the app.
    """
    app_css = (Path(__file__).parents[1] / "quickterm" / "frontend" / "css" / "app.css").read_text(
        encoding="utf-8"
    )
    sidebar_css = (
        Path(__file__).parents[1] / "quickterm" / "frontend" / "css" / "sidebar.css"
    ).read_text(encoding="utf-8")

    # The stretch rule is the hazard this guards against. If it ever goes away,
    # this test should be revisited rather than silently kept.
    assert ".launcher.sidebar > * { width: 100%" in app_css
    # Two classes plus the child element beat two classes plus the universal.
    assert ".launcher.sidebar > .sidebar-grip {" in sidebar_css
    grip = sidebar_css[sidebar_css.index(".launcher.sidebar > .sidebar-grip {"):]
    grip = grip[: grip.index("}")]
    assert "width: 3px" in grip
    # inset:0 without an explicit left would stretch it back across the sidebar.
    assert "left: auto" in grip


def test_a_second_window_is_openable_from_the_sidebar_and_the_palette():
    main = MAIN_JS.read_text(encoding="utf-8")
    palette = PALETTE_JS.read_text(encoding="utf-8")
    keys = KEYS_JS.read_text(encoding="utf-8")

    # Two entry points, one picker: the sidebar footer button and the palette
    # row both land in the same list of workspaces a new window may open on.
    # The footer is built from the `chrome` array, so that is where it goes.
    assert '["new window", () => {' in main
    assert "palette.newWindowMode()" in main
    assert 'label: "new window…"' in palette
    assert "run: () => this._newWindowMode()" in palette
    # No new keyboard shortcut: keys.js may claim only cold Alt combos, and the
    # letters left over are readline/PSReadLine bindings the shell needs.
    assert "newWindow" not in keys

    # The packaged shell owns the native window, so it is asked first; a plain
    # browser still gets a window instead of a dead button, and the token only
    # reaches it through the URL fragment.
    open_start = main.index("  async function openNewWindow(")
    opener = main[open_start:main.index("\n  // Tear down the current scratch layout", open_start)]
    assert opener.index("globalThis.pywebview?.api?.open_window") < opener.index("api.requestWindow(")
    assert opener.index("api.requestWindow(") < opener.index("newWindowUrl(location.pathname")
    assert "api.token()" in opener


def test_two_windows_can_never_own_one_workspace():
    main = MAIN_JS.read_text(encoding="utf-8")
    assert (FRONTEND_JS / "windows.js").exists()
    assert 'from "./windows.js"' in main

    # Save while still owning the outgoing workspace, then claim before teardown.
    start = main.index("  async function switchWorkspace(")
    switch = main[start:main.index("\n  // Which scratch terminals", start)]
    assert switch.index("await workspace.save(") < switch.index("await claimWorkspaceFor(target)")
    assert switch.index("await claimWorkspaceFor(target)") < switch.index("await discardScratch();")
    assert "if (transitioning) return false;" in switch
    assert "showError(refusal);" in switch

    # Boot claims before restoring: this window autosaves the layout on every
    # pane change, so restoring a workspace it may not own would start
    # overwriting the other window's file before anyone could read a warning.
    boot = main[main.index("  await acquireWindowId();"):main.index("  const initialSessions")]
    assert "const refusal = await claimWorkspaceFor(currentWorkspace);" in boot
    assert boot.index("currentWorkspace = null;") < boot.index("showError(refusal);")

    # Adopting scratch and naming a workspace are the other two ways to take a
    # workspace name, so both ask as well.
    assert "if (await claimWorkspaceFor(SCRATCH_WS)) return;" in main
    assert "const refusal = await claimWorkspaceFor(cleanName);" in main


def test_an_unreachable_registry_lets_the_user_work_but_never_fakes_a_claim():
    main = MAIN_JS.read_text(encoding="utf-8")
    start = main.index("  async function claimWorkspaceFor(")
    claim = main[start:main.index("\n  // The registry expires", start)]
    # Only a 409 refuses; anything else degrades to "carry on" (claimOutcome is
    # unit-tested in tests/js/windows.test.mjs).
    assert 'if (claimOutcome(error) === "unavailable") {' in claim
    assert "return claimRefusalMessage(name, holder);" in claim
    # Every failure path leaves the claim unheld, so nothing later believes it.
    assert claim.count("claimedWorkspace = null;") >= 3


def test_a_window_heartbeats_while_it_lives_and_releases_its_claim_on_exit():
    main = MAIN_JS.read_text(encoding="utf-8")
    assert "api.heartbeatWindow(windowId).then(" in main
    assert "}, WINDOW_HEARTBEAT_MS);" in main
    # The registry answers a beat from an expired window with 404 instead of
    # reviving it, because an expired window has lost its claim and must not
    # carry on autosaving a workspace someone else may now own.
    assert "if (error?.status === 404) recoverWindowRegistration();" in main
    recover_start = main.index("  async function recoverWindowRegistration()")
    recover = main[recover_start:main.index("\n  // Opening a window is", recover_start)]
    # Losing the claim costs no terminal and no layout: the window lets go the
    # same way deleting the current workspace already does.
    assert "for (const sid of workspaceSessionIds) scratchSessionIds.add(sid);" in recover
    assert "currentWorkspace = null;" in recover
    assert "api.killSession" not in recover
    assert "cleanupSessions" not in recover

    start = main.index("  function persistOnExit()")
    exiting = main[start:main.index('\n  window.addEventListener("pagehide"', start)]
    # keepalive for the same reason the layout PUT needs it: the document is
    # going away and a normal fetch is cancelled with it, so the release would
    # never leave and the workspace would stay claimed until the heartbeat
    # expired.
    assert "fetch(`/api/windows/${encodeURIComponent(windowId)}`, {" in exiting
    assert exiting.count("keepalive: true") >= 2
    assert "workspace.save(currentWorkspace" in exiting
    assert '"DELETE"' in exiting
    assert ".finally(release)" in exiting
    assert "/api/sessions/cleanup" not in exiting


def test_a_window_registers_under_the_id_its_shell_gave_it():
    # app.py puts the window id in the launch URL and forgets *that* id when the
    # native window closes, so registering under any other one would keep the
    # workspace claimed until the heartbeat TTL ran out.
    main = MAIN_JS.read_text(encoding="utf-8")
    start = main.index("function captureWindowIdentity()")
    identity = main[start:main.index("\nasync function boot()", start)]
    assert 'params.get("window")' in identity
    assert 'params.get("primary") === "1"' in identity
    # workspace is three-valued, and a secondary shell window without one was
    # asked for scratch: restoring the workspace remembered in the shared
    # localStorage there is exactly the collision this prevents.
    assert "raw === null" in identity
    assert "(id && !primary ? null : undefined)" in identity

    acquire_start = main.index("  async function acquireWindowId()")
    acquire = main[acquire_start:main.index("\n  async function listWindowsSafe", acquire_start)]
    assert "id: identity.id || rememberedWindowId()," in acquire
    assert "primary: identity.primary," in acquire
    # No workspace key: registering is also how a reloaded page says hello, and
    # an omitted key preserves the claim instead of dropping it for a moment.
    assert "workspace" not in acquire.split("api.registerWindow({")[1].split("});")[0]


def test_only_the_primary_window_claims_the_explorer_folder_handoff():
    # The queue behind GET /api/launches/next hands each launch to exactly one
    # waiter, so several windows waiting on it made "Open QuickTerm here"
    # non-deterministic. The registry already names the window it is meant for.
    main = MAIN_JS.read_text(encoding="utf-8")
    start = main.index("  async function claimLaunchLoop()")
    loop = main[start:main.index("\n  function removeSessionFromLayout", start)]
    assert "if (!windowIsPrimary && registryAvailable) {" in loop
    # Unchanged otherwise: one claim, opened as a folder in scratch.
    assert "const launch = await api.claimLaunch()" in loop
    assert "await openFolderInScratch(launch.cwd)" in loop
    # The flag is read back from the registry, which promotes a new primary when
    # that window closes, not trusted from the launch URL for the whole run.
    assert 'if (info && "primary" in info) windowIsPrimary = Boolean(info.primary);' in main


def test_the_chrome_is_the_sidebar_and_nothing_else():
    """No status bar, no quick-settings drawer, no header on a lone pane.

    The sidebar carries the workspace, the terminals and the four panel icons;
    a single pane is a terminal from edge to edge; the pane header returns only
    with a second pane and its actions only on hover. Alt+Shift+S cycles the
    sidebar through full, rail and hidden, and the hidden state leaves a
    floating "+" that can be dragged along the terminal's left edge.
    """
    html = (Path(__file__).parents[1] / "quickterm" / "frontend" / "index.html").read_text(
        encoding="utf-8"
    )
    app_css = (Path(__file__).parents[1] / "quickterm" / "frontend" / "css" / "app.css").read_text(
        encoding="utf-8"
    )
    keys = KEYS_JS.read_text(encoding="utf-8")
    launcher = LAUNCHER_JS.read_text(encoding="utf-8")
    main = MAIN_JS.read_text(encoding="utf-8")

    assert "statusbar" not in html and "quick-settings" not in html
    assert 'id="float-launch"' in html
    assert "#grid > .pane > .pane-tab" in app_css
    assert ".pane:hover .pane-actions" in app_css
    assert "quick-settings" not in app_css and ".statusbar" not in app_css
    assert 'if (key === "s") return done(actions.toggleSidebar);' in keys
    assert 'export const SIDEBAR_MODES = ["full", "rail", "hidden"];' in launcher
    assert "toggleSidebar: () => launcherView?.cycleMode()," in main
    # The save dot keeps its id: main.js drives it through data-state only.
    assert 'save.id = "sb-save";' in launcher
    assert "status.textContent = text;" not in main


def test_open_folder_actions_share_one_resolver_and_one_route():
    """Sidebar buttons, Alt+Shift+E/C and two palette rows all open the focused
    terminal's folder. One resolver (`hereFolder`: the pane's OSC 7 directory,
    else its launch folder, else the workspace folder) and one token-gated
    route (`POST /api/open` with `app`), so every entry point opens the same
    place and says so in the same banner when it cannot.
    """
    main = MAIN_JS.read_text(encoding="utf-8")
    keys = KEYS_JS.read_text(encoding="utf-8")
    palette = PALETTE_JS.read_text(encoding="utf-8")
    launcher = LAUNCHER_JS.read_text(encoding="utf-8")
    api = (FRONTEND_JS / "api.js").read_text(encoding="utf-8")

    assert "return layout.focused?.bestKnownCwd?.() || usableWorkspacePath() || null;" in main
    assert 'openExplorer: () => openHere("explorer"),' in main
    assert 'openEditor: () => openHere("vscode"),' in main
    assert "onOpenFolder: openHere," in main
    # Shift layer only: plain Alt+C is readline's capitalize-word.
    assert 'if (key === "e") return done(actions.openExplorer);' in keys
    assert 'if (key === "c") return done(actions.openEditor);' in keys
    assert keys.index("// Alt+Shift layer") < keys.index('if (key === "e") return done(actions.openExplorer);')
    assert 'label: "open folder in Explorer", hint: folderHint("Alt+Shift+E")' in palette
    assert 'label: "open folder in VS Code", hint: folderHint("Alt+Shift+C")' in palette
    assert 'openIn("explorer", "folder",' in launcher
    assert 'openIn("vscode", "code",' in launcher
    assert 'req("POST", "/api/open", { target: path, app })' in api


def test_panes_move_by_dragging_their_header():
    """The header is the drag handle. It is only drawn with two or more panes,
    and a zoomed pane draws it but refuses the drag, so a lone pane cannot
    start one. The geometry
    and the tree surgery live in pane_move.js, pure and unit-tested; layout.js
    renders the result and autosaves it like any other structural change.
    """
    layout = (FRONTEND_JS / "layout.js").read_text(encoding="utf-8")
    app_css = (Path(__file__).parents[1] / "quickterm" / "frontend" / "css" / "app.css").read_text(
        encoding="utf-8"
    )
    pane = PANE_JS.read_text(encoding="utf-8")

    assert 'import { dropZone, movePaneNode, zoneRect } from "./pane_move.js";' in layout
    assert "this._wireDrag(pane);" in layout
    move = layout[layout.index("  movePane(pane, target, zone) {"):]
    move = move[:move.index("\n  }\n") + 4]
    assert "const root = movePaneNode(this.root, pane, target, zone);" in move
    assert "this.render();" in move and "this._changed();" in move
    # A press has to travel before it is a drag, or a double-click rename and
    # a click to focus would both start one.
    assert "const DRAG_START_PX = 6;" in layout
    assert "if (down.button !== 0 || this.zoomed) return;" in layout
    assert 'title="Drag to move · double-click to rename"' in pane
    assert ".pane-drop-hint" in app_css and ".pane-drag-ghost" in app_css
    assert ".pane-drag-ghost {" in app_css and "pointer-events: none;" in app_css


def test_workspace_views_tile_like_panes_and_never_reparent_an_iframe():
    """Any number of workspaces in one window, placed like panes.

    Views and panes are leaves of the same split tree, a new one takes half of
    the focused leaf along its longer side (dwindle), and a header drag uses the
    pane drop zones. The one rule the DOM has to keep: an iframe that changes
    parent reloads its document, so views are absolutely positioned and a
    layout change only writes their boxes. That box transition is also the
    animation, and it is off during drags and under reduced motion.
    """
    views = (FRONTEND_JS / "workspace_views.js").read_text(encoding="utf-8")
    views_css = (
        Path(__file__).parents[1] / "quickterm" / "frontend" / "css" / "workspace_views.css"
    ).read_text(encoding="utf-8")
    layout = (FRONTEND_JS / "layout.js").read_text(encoding="utf-8")
    tree = (FRONTEND_JS / "split_tree.js").read_text(encoding="utf-8")
    move = (FRONTEND_JS / "pane_move.js").read_text(encoding="utf-8")
    app_css = (Path(__file__).parents[1] / "quickterm" / "frontend" / "css" / "app.css").read_text(
        encoding="utf-8"
    )
    main = MAIN_JS.read_text(encoding="utf-8")

    assert "export function dwindleDir(rect)" in tree
    assert 'import { findLeaf, parentOf, replaceChild } from "./split_tree.js";' in move
    assert 'import { dropZone, movePaneNode, zoneRect } from "./pane_move.js";' in views
    assert (
        'import { dwindleDir, insertBeside, layoutRects, leaves, removeLeaf } from "./split_tree.js";'
        in views
    )
    assert "this.root = insertBeside(this.root, beside, view, dwindleDir(from));" in views
    # Never re-parented: appended once, then only its box is written.
    assert "this.stage.append(view.el);" in views
    assert "applyRect(view.el, box);" in views
    assert "this.stage.textContent" not in views and "this.stage.innerHTML" not in views
    assert "position: absolute;" in views_css
    assert ".workspace-views.resizing .workspace-view," in views_css
    # Panes: the same placement rule, and the same motion rules.
    assert "autoDir(pane = this.focused)" in layout and "return dwindleDir(" in layout
    assert "layout.autoDir(pane)" in main and "function autoDir(" not in main
    assert ".split.sliding > * { transition: flex-grow" in app_css
    assert "body.dragging .split > * { transition: none; }" in app_css
    assert "prefers-reduced-motion" in app_css and "function reducedMotion()" in layout
    # A view can open another view: the parent window owns the tiling.
    assert "const viewHost = () => (embedded ? window.parent?.quicktermViews || null : views);" in main
    assert "viewHost()?.open(name, { anchorWindow: window })" in main
    assert "viewHost()?.activate(window);" in main


def test_the_sidebar_has_menus_not_native_selects():
    """Every chooser in the chrome is menu.js: the OS list cannot show a folder
    under a workspace name, a colour dot for a view, or a second action on a
    row. Menus own the keyboard while open and hand it back on close, and a
    trigger toggles rather than reopening on the press that closed it.
    """
    launcher = LAUNCHER_JS.read_text(encoding="utf-8")
    menu = (FRONTEND_JS / "menu.js").read_text(encoding="utf-8")
    html = (Path(__file__).parents[1] / "quickterm" / "frontend" / "index.html").read_text(
        encoding="utf-8"
    )
    sidebar_css = (
        Path(__file__).parents[1] / "quickterm" / "frontend" / "css" / "sidebar.css"
    ).read_text(encoding="utf-8")

    assert 'make("select"' not in launcher and "<select" not in launcher
    assert "showPicker" not in launcher
    assert 'import { toggleMenu } from "./menu.js";' in launcher
    assert "openMenu(" not in launcher
    assert 'claimFocus("menu")' in menu and 'releaseFocus("menu")' in menu
    assert "export function toggleMenu(options)" in menu
    assert '<link rel="stylesheet" href="/css/menu.css">' in html
    assert ".launcher.sidebar select" not in sidebar_css
    # The save dot and the rail rules survive the swap.
    assert 'save.id = "sb-save";' in launcher
    assert "body.sidebar-collapsed .sidebar-terminal-pick," in sidebar_css


def test_workspace_here_moves_the_terminal_before_switching():
    """The sidebar's offer to make the focused terminal's folder a workspace.

    Order matters: the target workspace is written with the terminal first,
    the terminal is retained and detached here second, and only then does the
    window switch, so the restore attaches it again and no step can kill it.
    A workspace held by another window or view stops the flow before anything
    is written. The offer is patched on every status refresh, never rebuilt.
    """
    main = MAIN_JS.read_text(encoding="utf-8")
    launcher = LAUNCHER_JS.read_text(encoding="utf-8")

    start = main.index("  async function createWorkspaceHere() {")
    body = main[start : main.index("\n  }\n", start)]
    holder = body.index("workspaceHolder(await listWindowsSafe(), windowId, name)")
    save = body.index("await workspace.save(name, layoutWith(")
    retain = body.index("await api.retainSession(session.id)")
    close = body.index("layout.closePane(pane, { animate: false })")
    switch = body.index("return switchWorkspace(name)")
    assert holder < save < retain < close < switch
    assert "killSession" not in body and "cleanupSessions" not in body
    assert "launcherView?.updateHere(hereState());" in main
    assert "updateHere," in launcher and 'make("button", "sidebar-here")' in launcher


def test_closing_a_pane_hands_its_space_over_and_zoom_keeps_a_way_back():
    """3.9.0 disposed the pane (removing its element) before the leave
    animation looked for it, so the splitter inherited the closed pane's
    space and the tree was never re-rendered. The layout owns the pane DOM.
    Zoom keeps the header (the way back) and the keyboard, hidden panes cannot
    be focused without unzooming, and the kill bar answers the keyboard.
    """
    layout = (FRONTEND_JS / "layout.js").read_text(encoding="utf-8")
    pane = PANE_JS.read_text(encoding="utf-8")
    main = MAIN_JS.read_text(encoding="utf-8")
    palette = PALETTE_JS.read_text(encoding="utf-8")
    app_css = (Path(__file__).parents[1] / "quickterm" / "frontend" / "css" / "app.css").read_text(
        encoding="utf-8"
    )

    assert "pane.dispose({ keepElement: true });" in layout
    assert "if (!keepElement) this.el.remove();" in pane
    leave = layout[layout.index("  _animateLeave(split, leaving) {"):]
    leave = leave[:leave.index("\n  }\n") + 4]
    assert "if (!leavingEl || leavingEl.parentElement !== el) return false;" in leave
    assert "if (this._renderGeneration === generation) this.render();" in leave
    assert "leavingEl.remove();" in leave
    assert "leavingEl.isConnected" not in leave

    # Zoom: header stays, terminal keeps the keyboard, one pane is not zoomable.
    assert "#zoom-host > .pane > .pane-tab" not in app_css
    assert ".pane.zoomed .pane-actions { opacity: 1; }" in app_css
    zoom = layout[layout.index("  toggleZoom() {"):]
    zoom = zoom[:zoom.index("\n  }\n") + 4]
    assert "this.focused.setZoomed(true);" in zoom
    assert "this.focused.focusSoon();" in zoom
    assert "if (this.panes().length < 2) {" in zoom
    assert "if (this.zoomed && pane && pane !== this.zoomedPane) this.toggleZoom();" in layout
    assert 'label: a.isZoomed?.() ? "show all panes" : "zoom pane"' in palette

    # Kill from the keyboard: Alt+W arms with Kill focused and Alt+W again
    # kills; the header button keeps Cancel first; Escape works pane-wide.
    assert "killSession: () => app.killFocusedSession({ keyboard: true })," in main
    assert 'else if (action === "kill") app.killFocusedSession();' in main
    assert 'if (keyboard && pane.confirmationLabel() === "Kill") {' in main
    assert '}, "Kill", { focusConfirm: keyboard });' in main
    assert "requestAnimationFrame(() => (focusConfirm ? confirm : cancel).focus());" in pane
    assert 'this.el.addEventListener("keydown", keyHandler, true);' in pane
    assert 'claimFocus("pane-confirm");' in pane and 'releaseFocus("pane-confirm");' in pane
