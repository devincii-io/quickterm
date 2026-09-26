import * as api from "./api.js";
import { LayoutManager } from "./layout.js";
import { Palette } from "./palette.js";
import { Panels } from "./panels.js";
import { initKeys } from "./keys.js";
import { applyChromeTheme, getTheme } from "./themes.js";
import * as workspace from "./workspace.js";
import { claimFocus, releaseFocus } from "./focus.js";
import { WorkspaceViews } from "./workspace_views.js";
import { windowChoiceMessage, windowChoices } from "./windows.js";
import { createAppState } from "./app_state.js";
import { createAutosave } from "./autosave.js";
import {
  SCRATCH_WS, captureOpenDir, captureToken, captureWindowIdentity, embedded, loadInventoryCache,
  rememberWorkspace, saveInventoryCache, storedScratchActive, storedWorkspace,
} from "./boot_context.js";
import { createConfigSync } from "./config_sync.js";
import { clearError, setWorkspaceSaveState, showError } from "./feedback.js";
import { DEFAULT_FONT, clampFont, createFontSize } from "./fonts.js";
import { createHere } from "./here.js";
import { createLaunchLoop } from "./launch_loop.js";
import { createLifecycle } from "./lifecycle.js";
import { createPaneCommands } from "./pane_commands.js";
import { createScratch } from "./scratch.js";
import { createSessionOwnership } from "./session_ownership.js";
import { createSidebar } from "./sidebar.js";
import { createSpawner } from "./spawner.js";
import { watchUpdates } from "./updates.js";
import { createWindowRegistry } from "./window_registry.js";
import { createWorkspaceActions, validateWorkspaceName } from "./workspace_actions.js";
import { createWorkspaceSwitch } from "./workspace_switch.js";

document.title = "QuickTerm";

const $ = (id) => document.getElementById(id);

// The composition root. Each module is a factory that is handed what it uses;
// the state several of them share is one object (app_state.js). Where a module
// built early calls one built later (almost everything rebuilds the sidebar,
// which is built last from almost everything), it is handed an arrow that
// resolves the later name when it runs. Everything from the layout to the
// sidebar is composed synchronously, before the first restore awaits, so no
// such arrow can run early.
async function boot() {
  const openDir = captureOpenDir();
  const identity = captureWindowIdentity();
  const requestedWorkspace = identity.workspace;
  captureToken();
  let cfg = { font_family: "JetBrains Mono", font_size: DEFAULT_FONT, profiles: [], snippets: [], voice_available: false };
  // The shell inventory probes the disk for every shell and asks WSL for its
  // distributions, a third of a second that used to sit in the boot path. The
  // last answer is kept in localStorage: boot draws with it and a fresh scan
  // replaces it in the background once the first terminal is up.
  const cachedInventory = loadInventoryCache();
  const [loadedConfig, loadedProfiles, loadedSessions, loadedWorkspaces, loadedInventory] = await Promise.all([
    api.getConfig().catch(() => null),
    api.getProfiles().catch(() => null),
    api.getSessions({ metrics: false }).catch(() => []),
    api.listWorkspaces().catch(() => []),
    cachedInventory
      ? Promise.resolve(cachedInventory)
      : api.getTerminalOptions().then(saveInventoryCache).catch(() => ({ types: [], wsl_distributions: [] })),
  ]);
  if (loadedConfig) cfg = loadedConfig;
  const state = createAppState({
    cfg,
    profiles: loadedProfiles || cfg.profiles || [],
    snippets: cfg.snippets || [],
    workspaceNames: loadedWorkspaces || [],
    terminalInventory: loadedInventory,
    windowIsPrimary: identity.primary,
  });

  const remembered = storedWorkspace();
  if (requestedWorkspace !== undefined) {
    // Opened by another window: the URL is the instruction and shared
    // localStorage is not consulted at all.
    state.currentWorkspace = requestedWorkspace && state.workspaceNames.includes(requestedWorkspace)
      ? requestedWorkspace
      : null;
  } else if (storedScratchActive() && state.workspaceNames.includes(SCRATCH_WS)) state.currentWorkspace = SCRATCH_WS;
  else if (remembered && state.workspaceNames.includes(remembered)) state.currentWorkspace = remembered;
  // Only a window that resolved its own workspace may rewrite the shared
  // memory of which one that is. A second window landing on scratch must not
  // erase the first window's last real workspace.
  if (!state.currentWorkspace && requestedWorkspace === undefined) rememberWorkspace(null);
  // "Open QuickTerm here" opens this window as a scratch window whose first
  // terminal starts in the given folder, regardless of any remembered
  // workspace. Decided here rather than just before the restore, so this window
  // never claims a workspace it is not going to open.
  if (openDir) state.currentWorkspace = null;

  const registry = createWindowRegistry({
    api, state, identity, showError,
    cancelWorkspaceSave: () => cancelWorkspaceSave(),
    buildLauncher: () => buildLauncher(),
    refreshStatusSoon: () => refreshStatusSoon(),
  });
  const { acquireWindowId, listWindowsSafe, claimWorkspaceFor, openNewWindow } = registry;

  // Claim before restoring, never after. This window autosaves the layout on
  // every pane change, so restoring a workspace another window holds would
  // start overwriting its file within the first second, before anyone could
  // read a warning. A refused claim drops this window into scratch and says so.
  await acquireWindowId();
  const refusal = await claimWorkspaceFor(state.currentWorkspace);
  if (refusal) {
    // The remembered name is deliberately left alone: the workspace is not
    // lost, it is busy, and it must come back the next time this window is the
    // only one on it.
    state.currentWorkspace = null;
    showError(refusal);
  }
  registry.startWindowHeartbeat();

  const initialSessions = (loadedSessions || []).filter((session) => session.alive);
  const views = embedded ? null : new WorkspaceViews({
    current: () => state.currentWorkspace,
    focus: () => layout.focused?.focusSoon(),
    fit: () => layout.fitAll(),
    error: showError,
  });
  // The view manager this document talks to: its own when it is the window,
  // the parent's when it is one view inside a window. A view names itself to
  // the parent by its own `window`, which is the iframe's contentWindow.
  const viewHost = () => (embedded ? window.parent?.quicktermViews || null : views);
  let suspended = false;
  function suspendView(value) {
    if (suspended === value) return;
    suspended = value;
    if (value) claimFocus("inactive-view"); else releaseFocus("inactive-view");
  }
  if (embedded) {
    suspendView(true);
    document.addEventListener("pointerdown", () => {
      viewHost()?.activate(window);
      suspendView(false);
    }, true);
    window.addEventListener("focus", () => {
      viewHost()?.activate(window);
      suspendView(false);
    });
  } else {
    window.quicktermViews = views;
  }

  applyChromeTheme(state.cfg.theme, state.cfg.custom_theme);
  if (state.cfg.elevated) document.body.classList.add("elevated");

  const layout = new LayoutManager($("grid"), $("zoom-host"), {
    fontFamily: state.cfg.font_family || "JetBrains Mono",
    fontSize: clampFont(state.cfg.font_size),
    theme: getTheme(state.cfg.theme, state.cfg.custom_theme).xterm,
    onFocusChange: () => refreshStatusSoon(),
    onPaneState: (pane) => {
      refreshStatusSoon();
      maybeAdoptScratch(pane);
      scheduleWorkspaceSave();
    },
    onLayoutChange: () => scheduleWorkspaceSave(),
    onPaneAction: (action, pane) => {
      layout.focusPane(pane);
      if (action === "split-h") app.splitH();
      else if (action === "split-v") app.splitV();
      else if (action === "zoom") app.zoom();
      else if (action === "detach") app.closePane();
      else if (action === "kill") app.killFocusedSession();
    },
  });

  const { ownSession, forgetSession, ownedSessionIds, attachedSessionIds } =
    createSessionOwnership({ state, layout });
  const { persistCurrentWorkspace, scheduleWorkspaceSave, cancelWorkspaceSave, cancelWorkspaceRetry } =
    createAutosave({ state, layout, workspace, ownedSessionIds, setWorkspaceSaveState });
  const {
    refreshWorkspaceRoots, usableWorkspacePath, hereFolder, openHere, suggestedWorkspaceFolder, hereState,
  } = createHere({ api, workspace, state, layout, showError });
  const {
    profileTerminalType, spawnInto, spawnSpecInto, spawnDefaultInto, spawnSplitInto,
    runProfile, runClaudeMode, splitClaudeAgentView, runSystemTerminal,
    elevateProfile, elevateSystemTerminal, attachSession, restartSavedPane, resumeClaudePane,
  } = createSpawner({
    api, state, layout, ownSession, scheduleWorkspaceSave, showError,
    refreshStatusSoon: () => refreshStatusSoon(),
  });
  const { discardScratch, maybeAdoptScratch, ensureScratchWorkspace, newScratchWorkspace, openFolderInScratch } =
    createScratch({
      api, state, layout,
      claimWorkspaceFor, persistCurrentWorkspace, scheduleWorkspaceSave, attachedSessionIds, spawnDefaultInto,
      switchWorkspace: (...args) => switchWorkspace(...args),
      buildLauncher: () => buildLauncher(),
      refreshStatusSoon: () => refreshStatusSoon(),
    });
  const { restoreWorkspace, startScratch, switchWorkspace } = createWorkspaceSwitch({
    api, workspace, state, layout,
    claimWorkspaceFor, discardScratch, ownedSessionIds, usableWorkspacePath,
    spawnInto, spawnSpecInto, spawnDefaultInto, profileTerminalType, restartSavedPane, resumeClaudePane,
    cancelWorkspaceSave, scheduleWorkspaceSave, showError, clearError,
    buildLauncher: () => buildLauncher(),
    refreshStatusSoon: () => refreshStatusSoon(),
  });
  const actions = createWorkspaceActions({
    api, workspace, state, layout,
    claimWorkspaceFor, listWindowsSafe, switchWorkspace, ensureScratchWorkspace, attachSession, hereState,
    persistCurrentWorkspace, scheduleWorkspaceSave, cancelWorkspaceSave,
    ownedSessionIds, attachedSessionIds, forgetSession, refreshWorkspaceRoots, showError, clearError,
    buildLauncher: () => buildLauncher(),
    refreshStatusSoon: () => refreshStatusSoon(),
  });
  const paneCommands = createPaneCommands({
    api, state, layout,
    spawnSplitInto, spawnDefaultInto, forgetSession, ensureScratchWorkspace,
    removeSessionsFromSavedWorkspaces: actions.removeSessionsFromSavedWorkspaces,
    scheduleWorkspaceSave, showError,
    refreshStatusSoon: () => refreshStatusSoon(),
  });
  const { setFontSize, fontSize, scopedFontSize, setScopedFontSize, resetScopedFontSize } =
    createFontSize({ api, state, layout });

  // The one object the palette, the panels and the pane header talk to.
  const app = {
    profiles: state.profiles,
    snippets: state.snippets,
    idleTimeoutSeconds: state.cfg.idle_timeout_s ?? 300,
    runProfile,
    runClaudeMode,
    splitClaudeAgentView,
    runSystemTerminal,
    attachSession,
    ...paneCommands,
    moveSessionHere: actions.moveSessionHere,
    killWorkspaceSession: actions.killWorkspaceSession,
    hereFolder,
    openExplorer: () => openHere("explorer"),
    openEditor: () => openHere("vscode"),
    validateWorkspaceName,
    saveWorkspace: actions.saveWorkspace,
    loadWorkspace: (name) => switchWorkspace(name),
    deleteWorkspace: actions.deleteWorkspace,
    onWorkspacesChanged: actions.onWorkspacesChanged,
    currentWorkspace: () => state.currentWorkspace,
    // Second-window support. The picker offers scratch plus every named
    // workspace, marking the ones another window already holds instead of
    // hiding them: a missing row reads as "that workspace is gone". "scratch"
    // itself is not offered by name, exactly as the sidebar does not list it;
    // the disposable scratch row is the way to open one.
    newWindowChoices: async () => windowChoices(
      state.workspaceNames.filter((item) => item !== SCRATCH_WS),
      await listWindowsSafe(),
      state.windowId,
      state.currentWorkspace,
    ),
    openNewWindow,
    // Another workspace tiled into this window, beside the view that asked.
    // Works from inside a view too: the parent window owns the tiling.
    openWorkspaceBeside: (name) => viewHost()?.open(name, { anchorWindow: window }) ?? Promise.resolve(false),
    canShowWorkspaceBeside: () => Boolean(viewHost()),
    shownViews: () => viewHost()?.list() || [],
    focusShownWorkspace: (name) => Boolean(viewHost()?.focusWorkspace(name)),
    createWorkspaceHere: actions.createWorkspaceHere,
    hereState,
    explainWindowChoice: (row) => showError(windowChoiceMessage(row)),
    windowRegistryAvailable: () => state.registryAvailable,
    // Set when RegisterHotKey failed at startup (another program owns the
    // combination). Settings renders it next to the field.
    hotkeyError: () => state.cfg.hotkey_error || null,
    workspaceLogo: () => state.workspaceLogo,
    workspacePath: () => state.workspacePath,
    suggestedWorkspaceFolder,
    workspacePathExists: () => state.workspacePathExists,
    scratchRoot: () => state.scratchRoot,
    setWorkspaceFolder: actions.setWorkspaceFolder,
    setWorkspacePath: actions.setWorkspacePath,
    setWorkspaceLogo: actions.setWorkspaceLogo,
    attachedSessionIds,
    ownedSessionIds: () => [...ownedSessionIds()],
  };

  const {
    reportLaunchError, checkLaunchError, onConfigSaved, previewTheme, appliedTheme, refreshCachedInventory,
  } = createConfigSync({
    api, state, app, layout, setFontSize, showError,
    buildLauncher: () => buildLauncher(),
  });
  app.onConfigSaved = onConfigSaved;

  const palette = new Palette(app);
  const panels = new Panels(app);
  app.openPanel = (name) => panels.show(name);
  $("app-error-close").addEventListener("click", () => {
    clearError();
    app.refocusTerm();
  });

  app.setFontSize = setFontSize;
  app.fontSize = fontSize;
  app.fontBigger = () => setScopedFontSize(scopedFontSize() + 1);
  app.fontSmaller = () => setScopedFontSize(scopedFontSize() - 1);
  app.fontReset = resetScopedFontSize;
  app.resizeFocused = (axis, amount) => layout.adjustFocusedSize(axis, amount);
  app.balanceFocused = () => layout.balanceFocusedSplit();
  app.previewTheme = previewTheme;
  app.appliedTheme = appliedTheme;
  app.version = state.cfg.version || "";

  watchUpdates({ api, state, panels });

  initKeys({
    togglePalette: () => { panels.close(); palette.toggle(); },
    // Quick Settings is intentionally non-modal: its view shortcuts keep
    // working while the drawer is open. Full panels and the command palette
    // still own the keyboard while they are active.
    paletteOpen: () => palette.open || panels.open !== null,
    splitH: app.splitH,
    splitV: app.splitV,
    newTerminal: app.newTerminal,
    cycleTerminal: app.cycleTerminal,
    zoom: app.zoom,
    closePane: app.closePane,
    killSession: () => app.killFocusedSession({ keyboard: true }),
    focusDir: (direction) => layout.focusDir(direction),
    toggleDashboard: () => { palette.close(); panels.toggle("dashboard"); },
    toggleSettings: () => { palette.close(); panels.toggle("settings"); },
    toggleHelp: () => { palette.close(); panels.toggle("help"); },
    toggleSidebar: () => state.launcherView?.cycleMode(),
    openExplorer: app.openExplorer,
    openEditor: app.openEditor,
    fontBigger: () => setScopedFontSize(scopedFontSize() + 1),
    fontSmaller: () => setScopedFontSize(scopedFontSize() - 1),
    fontReset: resetScopedFontSize,
  });

  const { buildLauncher, refreshStatus, refreshStatusSoon } = createSidebar({
    api, state, layout, app, panels, palette, viewHost, initialSessions,
    runProfile, runSystemTerminal, elevateProfile, elevateSystemTerminal, attachSession,
    switchWorkspace, newScratchWorkspace, hereState, openHere,
    createWorkspaceHere: actions.createWorkspaceHere,
  });
  const { claimLaunchLoop, stopLaunchLoop } = createLaunchLoop({ api, state, openFolderInScratch, showError });
  const { persistOnExit, closeView } = createLifecycle({
    api, workspace, state, layout, ownedSessionIds,
    stopWindowHeartbeat: registry.stopWindowHeartbeat,
    stopLaunchLoop, cancelWorkspaceSave, cancelWorkspaceRetry, scheduleWorkspaceSave,
  });

  window.addEventListener("pagehide", persistOnExit);
  window.addEventListener("focus", checkLaunchError);

  setInterval(refreshStatus, 10000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshStatus();
      layout.fitAll();
      checkLaunchError();
    }
  });

  if (state.currentWorkspace) {
    const restored = await restoreWorkspace(state.currentWorkspace);
    if (!restored) await startScratch();
  } else {
    // Boot straight into scratch without going through startScratch(): adopt
    // the scratch folder here too, or the sidebar and status bar would claim
    // scratch has no folder while its terminals open in one.
    state.workspacePath = state.scratchRoot || null;
    state.workspacePathExists = true;
    const pane = layout.init();
    const administratorSession = !openDir && initialSessions.find((session) =>
      (session.name || "").startsWith("Administrator - "));
    if (administratorSession) {
      pane.attach(administratorSession);
      state.scratchSessionIds.add(administratorSession.id);
      layout.focusPane(pane);
    } else {
      await spawnDefaultInto(pane, openDir);
    }
  }
  // Do not sweep unknown sessions here: backend autostart profiles exist
  // before this window and intentionally have no saved workspace yet. The
  // backend idle reaper already removes only safe, untouched, non-busy shells.
  state.transitioning = false;
  window.quicktermView = {
    workspace: () => state.currentWorkspace,
    suspend: suspendView,
    close: closeView,
  };
  buildLauncher();
  refreshStatus();
  // After the restore, so nothing the boot itself reports replaces it.
  reportLaunchError(state.cfg.launch_error);
  if (!embedded) claimLaunchLoop();
  scheduleWorkspaceSave();
  // Off the boot path: one small request per saved workspace.
  setTimeout(() => refreshWorkspaceRoots(), 1200);
  if (cachedInventory) refreshCachedInventory();
}

boot();
