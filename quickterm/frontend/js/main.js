import * as api from "./api.js";
import { LayoutManager } from "./layout.js";
import { initKeys } from "./keys.js";
import { applyChromeTheme, getTheme } from "./themes.js";
import * as workspace from "./workspace.js";
import { claimFocus, releaseFocus } from "./focus.js";
import { windowChoiceMessage, windowChoices } from "./windows.js";
import { createAppState } from "./app_state.js";
import { createAutosave } from "./autosave.js";
import {
  isScratchWorkspace, captureFirstView, captureOpenDir, captureToken, captureWindowIdentity, embedded,
  loadInventoryCache, saveInventoryCache,
} from "./boot_context.js";
import { createConfigSync } from "./config_sync.js";
import { setWorkspaceSaveState, showError, clearError } from "./feedback.js";
import { DEFAULT_FONT, clampFont, createFontSize } from "./fonts.js";
import { createHere } from "./here.js";
import { createLaunchTarget } from "./launch_loop.js";
import { createLifecycle } from "./lifecycle.js";
import { createPaneCommands } from "./pane_commands.js";
import { createScratch } from "./scratch.js";
import { createSessionOwnership } from "./session_ownership.js";
import { bootShell } from "./shell.js";
import { createSpawner } from "./spawner.js";
import { createTerminalActions } from "./terminal_actions.js";
import { createWindowRegistry } from "./window_registry.js";
import { createWorkspaceActions, validateWorkspaceName } from "./workspace_actions.js";
import { createWorkspaceSwitch } from "./workspace_switch.js";

const $ = (id) => document.getElementById(id);

// One workspace view: an iframe in the shell's stage (shell.js) running the
// app on one workspace. The composition root. Each module is a factory that
// is handed what it uses; the state several of them share is one object
// (app_state.js). Where a module built early calls one built later, it is
// handed an arrow that resolves the later name when it runs. Everything from
// the layout to the app object is composed synchronously, before the first
// restore awaits, so no such arrow can run early.
//
// The view draws no chrome. The sidebar, the palette, the panels and the
// error banner belong to the shell, reached through window.parent; after
// anything the sidebar shows changes, the view says so with
// `quicktermChrome.refreshSoon()`.
async function bootView() {
  document.body.classList.add("embedded");
  const chrome = window.parent.quicktermChrome;
  const viewHost = () => window.parent?.quicktermViews || null;
  const openDir = captureOpenDir();
  const firstView = captureFirstView();
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
    windowIsPrimary: false,
  });
  state.requireConfiguredTerminals = true;
  // The shell's sidebar and its terminal choice, seen from this view.
  Object.defineProperty(state, "selectedTerminal", {
    get: () => chrome.selectedTerminal || null,
    set: (choice) => { chrome.selectedTerminal = choice; },
  });
  Object.defineProperty(state, "launcherView", {
    get: () => ({
      cycleTerminal: (delta) => chrome.launcherView?.cycleTerminal(delta) || null,
      cycleMode: () => chrome.launcherView?.cycleMode(),
      updateHere: () => chrome.refreshSoon(),
    }),
  });

  // The shell opened this view for one workspace (or for scratch, empty) and
  // claimed it for this view's registry id before the iframe existed.
  state.currentWorkspace = requestedWorkspace && state.workspaceNames.includes(requestedWorkspace)
    ? requestedWorkspace
    : null;
  // "Open QuickTerm here" opens a scratch view whose first terminal starts in
  // the given folder. Decided here rather than just before the restore, so
  // this view never claims a workspace it is not going to open.
  if (openDir) state.currentWorkspace = null;

  const registry = createWindowRegistry({
    api, state, identity, showError,
    cancelWorkspaceSave: () => cancelWorkspaceSave(),
    buildLauncher: () => buildLauncher(),
    refreshStatusSoon: () => refreshStatusSoon(),
  });
  const { acquireWindowId, listWindowsSafe, claimWorkspaceFor, openNewWindow } = registry;

  // Claim before restoring, never after. This view autosaves the layout on
  // every pane change, so restoring a workspace another window holds would
  // start overwriting its file within the first second, before anyone could
  // read a warning. A refused claim drops this view into scratch and says so.
  await acquireWindowId();
  const refusal = await claimWorkspaceFor(state.currentWorkspace);
  if (refusal) {
    state.currentWorkspace = null;
    showError(refusal);
  }
  registry.startWindowHeartbeat();

  const initialSessions = (loadedSessions || []).filter((session) => session.alive);
  let suspended = false;
  function suspendView(value) {
    if (suspended === value) return;
    suspended = value;
    if (value) claimFocus("inactive-view"); else releaseFocus("inactive-view");
  }
  suspendView(true);
  document.addEventListener("pointerdown", () => {
    viewHost()?.activate(window);
    suspendView(false);
  }, true);
  window.addEventListener("focus", () => {
    viewHost()?.activate(window);
    suspendView(false);
  });

  applyChromeTheme(state.cfg.theme, state.cfg.custom_theme);
  if (state.cfg.elevated) document.body.classList.add("elevated");

  // Every change the shell's sidebar shows is announced, never drawn here.
  const refreshStatusSoon = () => chrome.refreshSoon();
  const buildLauncher = refreshStatusSoon;

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
      else if (action === "restart") app.restartTerminal(pane);
    },
  });

  const { ownSession, forgetSession, ownedSessionIds, attachedSessionIds } =
    createSessionOwnership({ state, layout });
  const { persistCurrentWorkspace, scheduleWorkspaceSave, cancelWorkspaceSave, cancelWorkspaceRetry } =
    createAutosave({ state, layout, workspace, ownedSessionIds, setWorkspaceSaveState });
  const {
    refreshWorkspaceRoots, usableWorkspacePath, hereFolder, openHere, suggestedWorkspaceFolder, hereState,
  } = createHere({ api, workspace, state, layout, showError });
  const spawner = createSpawner({
    api, state, layout, ownSession, scheduleWorkspaceSave, showError,
    refreshStatusSoon: () => refreshStatusSoon(),
    refreshInventory: (options) => refreshInventory(options),
  });
  const {
    profileTerminalType, spawnInto, spawnSpecInto, spawnDefaultInto, spawnSplitInto,
    runProfile, runClaudeMode, splitClaudeAgentView, runSystemTerminal, runInstaller,
    elevateProfile, elevateSystemTerminal, attachSession, restartSavedPane, resumeClaudePane,
  } = spawner;
  const { discardScratch, maybeAdoptScratch, ensureScratchWorkspace } =
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
  // A view never switches to another workspace in place: it opens or
  // focuses that workspace's own view in the shell.
  const openWorkspaceView = (name) => viewHost()?.open(name, { anchorWindow: window }) ?? Promise.resolve(false);
  const actions = createWorkspaceActions({
    api, workspace, state, layout,
    claimWorkspaceFor, listWindowsSafe, ensureScratchWorkspace, attachSession, hereState,
    openWorkspaceView,
    closeWorkspaceView: async (name) => {
      const host = viewHost();
      const view = host?.viewForWorkspace(name);
      return view ? host.close(view) : true;
    },
    persistCurrentWorkspace, scheduleWorkspaceSave, cancelWorkspaceSave,
    ownedSessionIds, attachedSessionIds, forgetSession, refreshWorkspaceRoots, showError, clearError,
    buildLauncher: () => buildLauncher(),
    refreshStatusSoon: () => refreshStatusSoon(),
  });
  const paneCommands = createPaneCommands({
    api, state, layout,
    spawnSplitInto, spawnDefaultInto, forgetSession, ensureScratchWorkspace,
    removeSessionsFromSavedWorkspaces: actions.removeSessionsFromSavedWorkspaces,
    scheduleWorkspaceSave, persistCurrentWorkspace, showError,
    refreshStatusSoon: () => refreshStatusSoon(),
  });
  const { setFontSize, fontSize, scopedFontSize, setScopedFontSize, resetScopedFontSize } =
    createFontSize({ api, state, layout });
  const { startLaunch } = createLaunchTarget({ state, layout, spawnInto, spawnDefaultInto, showError });

  // The one object the shell's palette, panels and sidebar reach for this
  // view (through the shell's app proxy), and the pane header talks to.
  const app = {
    profiles: state.profiles,
    snippets: state.snippets,
    idleTimeoutSeconds: state.cfg.idle_timeout_s ?? 300,
    runProfile,
    runClaudeMode,
    splitClaudeAgentView,
    runSystemTerminal,
    elevateProfile,
    elevateSystemTerminal,
    attachSession,
    ...paneCommands,
    ...createTerminalActions({ api, layout, attachSession, restartSavedPane, showError }),
    moveSessionHere: actions.moveSessionHere,
    killWorkspaceSession: actions.killWorkspaceSession,
    hereFolder,
    openHere,
    openExplorer: () => openHere("explorer"),
    openEditor: () => openHere("vscode"),
    validateWorkspaceName,
    saveWorkspace: actions.saveWorkspace,
    loadWorkspace: (name) => openWorkspaceView(name),
    // The shell closes this workspace's view first when it is this one, which
    // only a document that outlives the view can do.
    deleteWorkspace: (name) => chrome.deleteWorkspace(name).catch(() => false),
    currentWorkspace: () => state.currentWorkspace,
    // Second-window support. The picker offers every named workspace,
    // marking the ones another window already holds instead of hiding them:
    // a missing row reads as "that workspace is gone".
    newWindowChoices: async () => windowChoices(
      state.workspaceNames.filter((item) => !isScratchWorkspace(item)),
      await listWindowsSafe(),
      state.windowId,
      state.currentWorkspace,
    ),
    openNewWindow,
    // Another workspace tiled into this window, beside this view.
    openWorkspaceBeside: (name) => openWorkspaceView(name),
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
    setWorkspaceAppearance: actions.setWorkspaceAppearance,
    attachedSessionIds,
    ownedSessionIds: () => [...ownedSessionIds()],
    focusedSessionId: () => layout.focused?.session?.id || null,
    focusSession: (id) => {
      const pane = layout.panes().find((item) => item.session?.id === id);
      if (pane) layout.focusPane(pane);
    },
    focusDir: (direction) => layout.focusDir(direction),
    fitAll: () => layout.fitAll(),
    startLaunch,
    setupTour: () => chrome.panels.show("setup"),
    // Settings and workspace changes reach every view and the shell's own
    // copy, so they go through the shell.
    onConfigSaved: () => chrome.onConfigSaved(),
    onWorkspacesChanged: () => chrome.onWorkspacesChanged(),
  };
  // The agent launches arrive with the 4.0 spawner; until then the view
  // simply does not offer them.
  for (const name of ["runAgentMode", "resumeAgentSession", "splitAgentView"]) {
    if (typeof spawner[name] === "function") app[name] = spawner[name];
  }

  const {
    onConfigSaved, previewTheme, appliedTheme, refreshInventory, refreshCachedInventory,
  } = createConfigSync({
    api, state, app, layout, setFontSize, showError,
    buildLauncher: () => buildLauncher(),
  });
  for (const name of ["saveWorkspace", "createWorkspaceHere", "setWorkspaceFolder", "setWorkspacePath", "setWorkspaceLogo", "setWorkspaceAppearance"]) {
    const change = app[name];
    app[name] = async (...args) => {
      const result = await change(...args);
      if (result !== false && typeof result !== "string") await app.onWorkspacesChanged();
      return result;
    };
  }
  // The palette offers the same installs as the new-terminal menu.
  app.shellInstalls = () => state.terminalInventory?.installs || [];
  app.installShell = (install) => runInstaller(install);

  const palette = chrome.palette;
  const panels = chrome.panels;
  app.openPanel = (name) => panels.show(name);
  app.setupTerminals = () => {
    panels.settingsTab = "connections";
    panels.show("settings");
  };
  const newConfiguredTerminal = app.newTerminal;
  app.newTerminal = () => {
    if (!state.profiles.some((profile) => !["rdp", "vnc"].includes(profile.terminal_type))) return app.setupTerminals();
    return newConfiguredTerminal();
  };

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

  const { persistOnExit, closeView } = createLifecycle({
    api, workspace, state, layout, ownedSessionIds,
    stopWindowHeartbeat: registry.stopWindowHeartbeat,
    stopLaunchLoop: () => {}, cancelWorkspaceSave, cancelWorkspaceRetry, scheduleWorkspaceSave,
  });

  window.addEventListener("pagehide", persistOnExit);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) layout.fitAll();
  });

  if (state.currentWorkspace) {
    const restored = await restoreWorkspace(state.currentWorkspace);
    if (!restored) await startScratch();
  } else {
    // Boot straight into scratch without going through startScratch(): adopt
    // the scratch folder here too, or the sidebar would claim scratch has no
    // folder while its terminals open in one.
    state.workspacePath = state.scratchRoot || null;
    state.workspacePathExists = true;
    const pane = layout.init();
    // The elevated first terminal: only the scratch view a fresh window opens
    // on its own takes it over, as the window's own document did before.
    const administratorSession = firstView && !openDir && initialSessions.find((session) =>
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
  // before this view and intentionally have no saved workspace yet. The
  // backend idle reaper already removes only safe, untouched, non-busy shells.
  state.transitioning = false;
  if (!state.currentWorkspace) await ensureScratchWorkspace();
  window.quicktermView = {
    workspace: () => state.currentWorkspace,
    suspend: suspendView,
    close: closeView,
    app,
    syncConfig: onConfigSaved,
    syncWorkspaces: actions.onWorkspacesChanged,
    previewTheme,
    whenRestored: Promise.resolve(true),
  };
  viewHost()?.ready(window);
  buildLauncher();
  scheduleWorkspaceSave();
  // Off the boot path: one small request per saved workspace.
  setTimeout(() => refreshWorkspaceRoots(), 1200);
  if (cachedInventory) refreshCachedInventory();
}

if (embedded) bootView(); else bootShell();
