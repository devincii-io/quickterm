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


def test_open_here_claims_one_folder_launch_and_shows_workspace_global_counts():
    """The status bar keeps naming both figures; the sidebar pill now counts all.

    The launcher assertion used to pin `${visible.length}/${totalLive}`, the
    count of a list filtered down to this window's own terminals. That filter
    was the bug: seven live terminals showed as "2/7" with no way to reach the
    other five. The invariant is now the opposite one, so the check moved to
    test_sidebar_lists_every_live_terminal_grouped_by_workspace rather than
    being dropped.
    """
    main = MAIN_JS.read_text(encoding="utf-8")
    launcher = LAUNCHER_JS.read_text(encoding="utf-8")
    assert "const launch = await api.claimLaunch()" in main
    assert "await openFolderInScratch(launch.cwd)" in main
    assert "`${workspaceLabel} · ${totalLive} total`" in main
    assert "terminalsCount.textContent = String(totalLive);" in launcher


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

    # The claim is taken before anything is saved, discarded or torn down, and a
    # refusal is a visible banner rather than a silent no-op.
    start = main.index("  async function switchWorkspace(")
    switch = main[start:main.index("\n  // Which scratch terminals", start)]
    assert switch.index("await claimWorkspaceFor(target)") < switch.index("transitioning = true;")
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
    assert '"DELETE"' in exiting


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
