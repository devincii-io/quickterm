from pathlib import Path


FRONTEND_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js"
PANELS_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js" / "panels.js"
MAIN_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js" / "main.js"
# main.js is the composition root; the code it wires lives in these modules.
BOOT_CONTEXT_JS = FRONTEND_JS / "boot_context.js"
CONFIG_SYNC_JS = FRONTEND_JS / "config_sync.js"
HERE_JS = FRONTEND_JS / "here.js"
LAUNCH_LOOP_JS = FRONTEND_JS / "launch_loop.js"
LIFECYCLE_JS = FRONTEND_JS / "lifecycle.js"
PANE_COMMANDS_JS = FRONTEND_JS / "pane_commands.js"
SCRATCH_JS = FRONTEND_JS / "scratch.js"
SIDEBAR_JS = FRONTEND_JS / "sidebar.js"
SPAWNER_JS = FRONTEND_JS / "spawner.js"
WINDOW_REGISTRY_JS = FRONTEND_JS / "window_registry.js"
WORKSPACE_ACTIONS_JS = FRONTEND_JS / "workspace_actions.js"
WORKSPACE_SWITCH_JS = FRONTEND_JS / "workspace_switch.js"
MAIN_MODULES = (
    MAIN_JS, BOOT_CONTEXT_JS, CONFIG_SYNC_JS, HERE_JS, LAUNCH_LOOP_JS, LIFECYCLE_JS,
    PANE_COMMANDS_JS, SCRATCH_JS, SIDEBAR_JS, SPAWNER_JS, WINDOW_REGISTRY_JS,
    WORKSPACE_ACTIONS_JS, WORKSPACE_SWITCH_JS,
    FRONTEND_JS / "app_state.js", FRONTEND_JS / "autosave.js", FRONTEND_JS / "feedback.js",
    FRONTEND_JS / "fonts.js", FRONTEND_JS / "layout_sessions.js",
    FRONTEND_JS / "session_ownership.js", FRONTEND_JS / "updates.js",
)
PANE_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js" / "pane.js"
KEYS_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js" / "keys.js"
PALETTE_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js" / "palette.js"
LAUNCHER_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js" / "launcher.js"


def test_kill_all_closes_only_backend_verified_sessions():
    source = PANE_COMMANDS_JS.read_text(encoding="utf-8")
    start = source.index("    killAllSessions: async () =>")
    end = source.index("\n    focusedPaneName:", start)
    implementation = source[start:end]

    assert "new Set(result?.killed_ids || [])" in implementation
    assert "!killedIds.has(pane.session.id)" in implementation
    assert "result?.failed_ids || []" in implementation
    assert "workspaceSessionIds.clear()" not in implementation


def test_detach_retains_process_and_never_calls_kill():
    source = PANE_COMMANDS_JS.read_text(encoding="utf-8")
    start = source.index("    closePane: async () =>")
    end = source.index("\n    killFocusedSession:", start)
    implementation = source[start:end]

    assert "await api.retainSession(session.id)" in implementation
    assert "api.killSession" not in implementation


def test_workspace_restore_does_not_silently_spawn_over_missing_session():
    source = WORKSPACE_SWITCH_JS.read_text(encoding="utf-8")
    start = source.index("  async function restoreWorkspace(")
    end = source.index("\n  async function startScratch", start)
    implementation = source[start:end]

    assert "pane.markUnavailable({" in implementation
    assert "onResumeClaude" in implementation
    assert "onPickClaude" in implementation


def test_a_background_launch_failure_reaches_the_banner_once():
    # Autostart and hotkey launches have no pane to report into; app.py keeps
    # the latest failure as launch_error on GET /api/config.
    main = MAIN_JS.read_text(encoding="utf-8")
    sync = CONFIG_SYNC_JS.read_text(encoding="utf-8")
    start = sync.index("  function reportLaunchError(value) {")
    end = sync.index("\n  }\n", start)
    body = sync[start:end]
    assert "text !== shownLaunchError" in body
    assert "!embedded && state.windowIsPrimary" in body
    assert "showError(" in body
    assert "shownLaunchError = text;" in body
    assert "reportLaunchError(state.cfg.launch_error);" in main
    assert "reportLaunchError(fresh.launch_error);" in sync
    # Boot reports it after the restore, so the restore cannot overwrite it.
    assert main.index("reportLaunchError(state.cfg.launch_error);") > main.index(
        "const restored = await restoreWorkspace(state.currentWorkspace);"
    )
    # A hotkey fires while the window is in the background: coming back to it
    # (focus, or the page becoming visible) looks again.
    assert 'window.addEventListener("focus", checkLaunchError);' in main
    visible = main[main.index('document.addEventListener("visibilitychange", () => {\n    if (!document.hidden) {'):]
    assert "checkLaunchError();" in visible[: visible.index("\n  });")]


def test_open_here_claims_one_folder_launch():
    """The status bar is gone; the sidebar list is the only count there is.

    The launcher assertion used to pin `${visible.length}/${totalLive}`, the
    count of a list filtered down to this window's own terminals. That filter
    was the bug: seven live terminals showed as "2/7" with no way to reach the
    other five. The invariant is now the opposite one, kept by
    test_sidebar_lists_every_live_terminal_grouped_by_workspace.
    """
    loop = LAUNCH_LOOP_JS.read_text(encoding="utf-8")
    assert "const launch = await api.claimLaunch()" in loop
    assert 'if (kind === "folder") return await openFolder(launch.cwd);' in loop
    assert "if (!embedded) claimLaunchLoop();" in MAIN_JS.read_text(encoding="utf-8")


def test_full_panels_return_focus_to_the_terminal():
    panels = PANELS_JS.read_text(encoding="utf-8")
    commands = PANE_COMMANDS_JS.read_text(encoding="utf-8")

    assert "if (!this.app.refocusTerm()" in panels
    assert "if (!layout.focused) return false" in commands
    assert "layout.focused.setFocused(true)" in commands
    assert "...paneCommands," in MAIN_JS.read_text(encoding="utf-8")


def test_a_second_window_is_openable_from_the_sidebar_and_the_palette():
    sidebar = SIDEBAR_JS.read_text(encoding="utf-8")
    registry = WINDOW_REGISTRY_JS.read_text(encoding="utf-8")
    palette = PALETTE_JS.read_text(encoding="utf-8")
    keys = KEYS_JS.read_text(encoding="utf-8")

    # Two entry points, one picker: the sidebar footer button and the palette
    # row both land in the same list of workspaces a new window may open on.
    # The footer is built from the `chrome` array, so that is where it goes.
    assert '["new window", () => {' in sidebar
    assert "palette.newWindowMode()" in sidebar
    assert 'label: "new window…"' in palette
    assert "run: () => this._newWindowMode()" in palette
    # No new keyboard shortcut: keys.js may claim only cold Alt combos, and the
    # letters left over are readline/PSReadLine bindings the shell needs.
    assert "newWindow" not in keys

    # The packaged shell owns the native window, so it is asked first; a plain
    # browser still gets a window instead of a dead button, and the token only
    # reaches it through the URL fragment.
    open_start = registry.index("  async function openNewWindow(")
    opener = registry[open_start:registry.index("\n  // Same refusal, different consequence", open_start)]
    assert opener.index("globalThis.pywebview?.api?.open_window") < opener.index("api.requestWindow(")
    assert opener.index("api.requestWindow(") < opener.index("newWindowUrl(location.pathname")
    assert "api.token()" in opener


def test_two_windows_can_never_own_one_workspace():
    main = MAIN_JS.read_text(encoding="utf-8")
    switcher = WORKSPACE_SWITCH_JS.read_text(encoding="utf-8")
    assert (FRONTEND_JS / "windows.js").exists()
    assert 'from "./windows.js"' in WINDOW_REGISTRY_JS.read_text(encoding="utf-8")
    assert 'from "./windows.js"' in main

    # Save while still owning the outgoing workspace, then claim before teardown.
    start = switcher.index("  async function switchWorkspace(")
    switch = switcher[start:switcher.index("\n  return {", start)]
    assert switch.index("await workspace.save(") < switch.index("await claimWorkspaceFor(target)")
    assert switch.index("await claimWorkspaceFor(target)") < switch.index("await discardScratch();")
    assert "if (state.transitioning) return false;" in switch
    assert "showError(refusal);" in switch

    # Boot claims before restoring: this window autosaves the layout on every
    # pane change, so restoring a workspace it may not own would start
    # overwriting the other window's file before anyone could read a warning.
    boot = main[main.index("  await acquireWindowId();"):main.index("  const initialSessions")]
    assert "const refusal = await claimWorkspaceFor(state.currentWorkspace);" in boot
    assert boot.index("state.currentWorkspace = null;") < boot.index("showError(refusal);")

    # Adopting scratch and naming a workspace are the other two ways to take a
    # workspace name, so both ask as well.
    assert "if (await claimWorkspaceFor(SCRATCH_WS)) return;" in SCRATCH_JS.read_text(encoding="utf-8")
    assert "const refusal = await claimWorkspaceFor(cleanName);" in (
        WORKSPACE_ACTIONS_JS.read_text(encoding="utf-8")
    )


def test_an_unreachable_registry_lets_the_user_work_but_never_fakes_a_claim():
    registry = WINDOW_REGISTRY_JS.read_text(encoding="utf-8")
    start = registry.index("  async function claimWorkspaceFor(")
    claim = registry[start:registry.index("\n  // The registry expires", start)]
    # Only a 409 refuses; anything else degrades to "carry on" (claimOutcome is
    # unit-tested in tests/js/windows.test.mjs).
    assert 'if (claimOutcome(error) === "unavailable") {' in claim
    assert "return claimRefusalMessage(name, holder);" in claim
    # Every failure path leaves the claim unheld, so nothing later believes it.
    assert claim.count("state.claimedWorkspace = null;") >= 3


def test_a_window_heartbeats_while_it_lives_and_releases_its_claim_on_exit():
    main = MAIN_JS.read_text(encoding="utf-8")
    registry = WINDOW_REGISTRY_JS.read_text(encoding="utf-8")
    lifecycle = LIFECYCLE_JS.read_text(encoding="utf-8")
    assert "api.heartbeatWindow(state.windowId).then(" in registry
    assert "}, WINDOW_HEARTBEAT_MS);" in registry
    # The registry answers a beat from an expired window with 404 instead of
    # reviving it, because an expired window has lost its claim and must not
    # carry on autosaving a workspace someone else may now own.
    assert "if (error?.status === 404) recoverWindowRegistration();" in registry
    recover_start = registry.index("  async function recoverWindowRegistration()")
    recover = registry[recover_start:registry.index("\n  // Opening a window is", recover_start)]
    # Losing the claim costs no terminal and no layout: the window lets go the
    # same way deleting the current workspace already does.
    assert "for (const sid of state.workspaceSessionIds) state.scratchSessionIds.add(sid);" in recover
    assert "state.currentWorkspace = null;" in recover
    assert "api.killSession" not in recover
    assert "cleanupSessions" not in recover

    assert 'window.addEventListener("pagehide", persistOnExit);' in main
    start = lifecycle.index("  function persistOnExit()")
    exiting = lifecycle[start:lifecycle.index("\n  // window.quicktermView.close()", start)]
    # keepalive for the same reason the layout PUT needs it: the document is
    # going away and a normal fetch is cancelled with it, so the release would
    # never leave and the workspace would stay claimed until the heartbeat
    # expired.
    assert "fetch(`/api/windows/${encodeURIComponent(state.windowId)}`, {" in exiting
    assert exiting.count("keepalive: true") >= 2
    assert "workspace.save(state.currentWorkspace" in exiting
    assert '"DELETE"' in exiting
    assert ".finally(release)" in exiting
    assert "/api/sessions/cleanup" not in exiting


def test_a_window_registers_under_the_id_its_shell_gave_it():
    # app.py puts the window id in the launch URL and forgets *that* id when the
    # native window closes, so registering under any other one would keep the
    # workspace claimed until the heartbeat TTL ran out.
    context = BOOT_CONTEXT_JS.read_text(encoding="utf-8")
    registry = WINDOW_REGISTRY_JS.read_text(encoding="utf-8")
    start = context.index("export function captureWindowIdentity()")
    identity = context[start:context.index("\n// sessionStorage is per window", start)]
    assert 'params.get("window")' in identity
    assert 'params.get("primary") === "1"' in identity
    # workspace is three-valued, and a secondary shell window without one was
    # asked for scratch: restoring the workspace remembered in the shared
    # localStorage there is exactly the collision this prevents.
    assert "raw === null" in identity
    assert "(id && !primary ? null : undefined)" in identity

    acquire_start = registry.index("  async function acquireWindowId()")
    acquire = registry[acquire_start:registry.index("\n  async function listWindowsSafe", acquire_start)]
    assert "id: identity.id || rememberedWindowId()," in acquire
    assert "primary: identity.primary," in acquire
    # No workspace key: registering is also how a reloaded page says hello, and
    # an omitted key preserves the claim instead of dropping it for a moment.
    assert "workspace" not in acquire.split("api.registerWindow({")[1].split("});")[0]


def test_only_the_primary_window_claims_the_explorer_folder_handoff():
    # The queue behind GET /api/launches/next hands each launch to exactly one
    # waiter, so several windows waiting on it made "Open QuickTerm here"
    # non-deterministic. The registry already names the window it is meant for.
    launch = LAUNCH_LOOP_JS.read_text(encoding="utf-8")
    registry = WINDOW_REGISTRY_JS.read_text(encoding="utf-8")
    start = launch.index("  async function claimLaunchLoop()")
    loop = launch[start:launch.index("\n  function stopLaunchLoop", start)]
    assert "if (!state.windowIsPrimary && state.registryAvailable) {" in loop
    # Unchanged otherwise: one claim, and a folder alone opens in scratch
    # (tests/js/launch_loop.test.mjs covers the other launch shapes).
    assert "await claimOnce()" in loop
    assert "const launch = await api.claimLaunch()" in launch
    assert "opened = await openFolderInScratch(cwd)" in launch
    # The flag is read back from the registry, which promotes a new primary when
    # that window closes, not trusted from the launch URL for the whole run.
    assert 'if (info && "primary" in info) state.windowIsPrimary = Boolean(info.primary);' in registry


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

    assert (
        "return layout.focused?.bestKnownCwd?.() || usableWorkspacePath() || null;"
        in HERE_JS.read_text(encoding="utf-8")
    )
    assert 'openExplorer: () => openHere("explorer"),' in main
    assert 'openEditor: () => openHere("vscode"),' in main
    assert "onOpenFolder: openHere," in SIDEBAR_JS.read_text(encoding="utf-8")
    # Shift layer only: plain Alt+C is readline's capitalize-word.
    assert 'if (key === "e") return done(actions.openExplorer);' in keys
    assert 'if (key === "c") return done(actions.openEditor);' in keys
    assert keys.index("// Alt+Shift layer") < keys.index('if (key === "e") return done(actions.openExplorer);')
    assert 'label: "open folder in Explorer", hint: folderHint("Alt+Shift+E")' in palette
    assert 'label: "open folder in VS Code", hint: folderHint("Alt+Shift+C")' in palette
    assert 'openIn("explorer", "folder",' in launcher
    assert 'openIn("vscode", "code",' in launcher
    assert 'req("POST", "/api/open", { target: path, app })' in api


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
        "import { dwindleDir, insertBeside, layoutRects, leaves, mapLeaves, removeLeaf }"
        ' from "./split_tree.js";'
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
    assert "layout.autoDir(pane)" in SPAWNER_JS.read_text(encoding="utf-8")
    for module in MAIN_MODULES:
        assert "function autoDir(" not in module.read_text(encoding="utf-8"), module.name
    assert ".split.sliding > * { transition: flex-grow" in app_css
    assert "body.dragging .split > * { transition: none; }" in app_css
    assert "prefers-reduced-motion" in app_css and "function reducedMotion()" in layout
    # A view can open another view: the parent window owns the tiling.
    assert "const viewHost = () => (embedded ? window.parent?.quicktermViews || null : views);" in main
    assert "viewHost()?.open(name, { anchorWindow: window })" in main
    assert "viewHost()?.activate(window);" in main


def test_workspace_here_moves_the_terminal_before_switching():
    """The sidebar's offer to make the focused terminal's folder a workspace.

    Order matters: the target workspace is written with the terminal first,
    the terminal is retained and detached here second, and only then does the
    window switch, so the restore attaches it again and no step can kill it.
    A workspace held by another window or view stops the flow before anything
    is written. The offer is patched on every status refresh, never rebuilt.
    """
    actions = WORKSPACE_ACTIONS_JS.read_text(encoding="utf-8")
    launcher = LAUNCHER_JS.read_text(encoding="utf-8")

    start = actions.index("  async function createWorkspaceHere() {")
    body = actions[start : actions.index("\n  }\n", start)]
    holder = body.index("workspaceHolder(await listWindowsSafe(), state.windowId, name)")
    save = body.index("await workspace.save(name, layoutWith(")
    retain = body.index("await api.retainSession(session.id)")
    close = body.index("layout.closePane(pane, { animate: false })")
    switch = body.index("return switchWorkspace(name)")
    assert holder < save < retain < close < switch
    assert "killSession" not in body and "cleanupSessions" not in body
    assert "state.launcherView?.updateHere(hereState());" in SIDEBAR_JS.read_text(encoding="utf-8")
    assert "state.launcherView?.updateHere(hereState());" in HERE_JS.read_text(encoding="utf-8")
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
    commands = PANE_COMMANDS_JS.read_text(encoding="utf-8")
    assert 'if (keyboard && pane.confirmationLabel() === "Kill") {' in commands
    assert '}, "Kill", { focusConfirm: keyboard });' in commands
    assert "requestAnimationFrame(() => (focusConfirm ? confirm : cancel).focus());" in pane
    assert 'this.el.addEventListener("keydown", keyHandler, true);' in pane
    assert 'claimFocus("pane-confirm");' in pane and 'releaseFocus("pane-confirm");' in pane


def test_tiled_views_are_restored_by_the_primary_after_its_own_workspace():
    """The view arrangement outlives a restart, restored only by the primary window.

    localStorage is shared by every window on the origin, so a second window
    must neither restore the arrangement nor write over it. Restored views are
    claimed through the same registry path open() uses.
    """
    main = MAIN_JS.read_text(encoding="utf-8")
    views = (FRONTEND_JS / "workspace_views.js").read_text(encoding="utf-8")

    assert main.index("views?.restoreSaved(") > main.index(
        "await restoreWorkspace(state.currentWorkspace)"
    )
    assert (
        "const keepsViewArrangement = !embedded && requestedWorkspace === undefined"
        " && state.windowIsPrimary;"
    ) in main
    assert "store: keepsViewArrangement ? viewArrangementStore() : null," in main

    assert 'export const VIEW_ARRANGEMENT_KEY = "quickterm.workspaceViews";' in views
    store = views[views.index("export function viewArrangementStore("):]
    store = store[: store.index("\n}\n")]
    # Both the read and the write are wrapped; storage can throw at any time.
    assert store.count("try {") == 2
    assert store.count("catch (_)") == 2
    assert views.count("api.registerWindow(") == 1
    assert views.count("await this._claimView(") == 2


def test_an_exited_pane_restarts_in_place_with_its_own_launch():
    """The exit bar offers Restart (button, Enter, palette). The restart repeats
    the pane's own launch, never the sidebar's current choice, and keeps the
    dead session's output above a separator instead of the replay's reset.
    """
    pane = PANE_JS.read_text(encoding="utf-8")
    palette = PALETTE_JS.read_text(encoding="utf-8")
    main = MAIN_JS.read_text(encoding="utf-8")
    actions = (FRONTEND_JS / "terminal_actions.js").read_text(encoding="utf-8")
    spawner = SPAWNER_JS.read_text(encoding="utf-8")
    layout = (FRONTEND_JS / "layout.js").read_text(encoding="utf-8")

    exit_path = pane[pane.index("  _onExit(code) {"):]
    exit_path = exit_path[:exit_path.index("\n  }\n")]
    assert "this._renderExitBar();" in exit_path
    assert '`[exited · code ${this._exitCode}]`' in pane
    # Enter only while exited, and inside xterm's own key handler, so the
    # keyboard is never taken from focus.js's owner.
    keys = pane[pane.index("this.term.attachCustomKeyEventHandler((e) => {"):]
    keys = keys[:keys.index("\n    });")]
    assert 'e.key === "Enter" && this.state === "exited"' in keys
    assert "this.requestRestart();" in keys
    assert 'this.onActionRequest("restart", this);' in pane
    assert 'else if (action === "restart") app.restartTerminal(pane);' in main
    assert 'label: "restart terminal"' in palette
    # Same launch: restartSavedPane, fed by the pane's profile/spec/options.
    assert "pane.keepScreenOnNextAttach();" in actions
    assert "restartSavedPane(pane)" in actions
    # A restart that started nothing does not leave the keep-screen flag behind.
    assert "pane.dropKeepScreen();" in actions
    assert "state.selectedTerminal" not in actions
    assert "repeatLaunchOptions(pane, profileName, options," in spawner
    assert "out.launch_options = options;" in layout
    assert "launchOptionsFromNode(n && n.launch_options)" in layout
    # Keep the screen: the separator replaces reset() for that one replay.
    replay = pane[pane.index('      case "replay_size":'):pane.index('      case "replay_done":')]
    assert replay.index("this._keepScreenGeneration === this._generation") < replay.index(
        "this.term.reset();"
    )
    assert "this.term.write(this._restartSeparator());" in replay
    assert "[restarted]" in pane
