// The window's own document. It hosts no workspace, no layout, no autosave
// and no terminal. It owns what the whole window shares: the sidebar, the
// palette and the panels, the launch loop, the settings watcher, the theme,
// the update check, the setup tour and the error banner, plus the stage of
// workspace views (workspace_views.js). Every workspace, scratch included,
// is one of those views.
//
// The palette, the panels and the sidebar talk to one app object
// (`chromeApp`). Members that concern the whole window are answered here;
// everything else goes to the active view's app; with no view open a small
// facade answers, and an action that needs a terminal opens a scratch view
// first.

import * as api from "./api.js";
import * as workspace from "./workspace.js";
import { Palette } from "./palette.js";
import { Panels } from "./panels.js";
import { initKeys } from "./keys.js";
import { applyChromeTheme } from "./themes.js";
import { focusOwners } from "./focus.js";
import { closeMenu } from "./menu.js";
import { acceptConfirm, closeConfirm } from "./confirm_popover.js";
import { setupNeeded } from "./setup.js";
import { watchGlobalSettings } from "./global_settings.js";
import { WorkspaceViews, viewArrangementStore } from "./workspace_views.js";
import { windowChoiceMessage, windowChoices } from "./windows.js";
import { createAppState } from "./app_state.js";
import {
  captureOpenDir, captureToken, captureWindowIdentity, isScratchWorkspace, loadInventoryCache,
  saveInventoryCache, storedScratchActive, storedWorkspace, workspaceLabel,
} from "./boot_context.js";
import { createConfigSync } from "./config_sync.js";
import { clearError, setWorkspaceSaveState, showError } from "./feedback.js";
import { createLaunchLoop } from "./launch_loop.js";
import { createLifecycle } from "./lifecycle.js";
import { createSidebar } from "./sidebar.js";
import { createTerminalActions } from "./terminal_actions.js";
import { createTerminalRouting, sessionOwner } from "./shell_routing.js";
import { watchUpdates } from "./updates.js";
import { createWindowRegistry } from "./window_registry.js";
import { createWorkspaceActions, validateWorkspaceName } from "./workspace_actions.js";

const $ = (id) => document.getElementById(id);
const noop = () => {};

// Shell members win over the active view's app (spec 4.4): they concern the
// whole window, so a view must never answer them for itself.
export const SHELL_MEMBERS = Object.freeze([
  "openWorkspace", "loadWorkspace", "closeWorkspaceView", "newScratchView", "openWorkspaces",
  "liveTerminals", "activateTerminal", "killTerminal", "killAllSessions", "detachTerminal", "moveTerminalHere",
  "settingEntries", "openSetting", "editTerminalConfig", "editSnippet", "setupTerminals", "setupTour",
  "openPanel", "onConfigSaved", "onWorkspacesChanged", "previewTheme", "appliedTheme",
  "deleteWorkspace", "revealSearchResult",
]);

// The app object the palette, the panels and the sidebar see.
export function shellApp({ shell, facade, activeApp }) {
  const members = new Set(SHELL_MEMBERS);
  return new Proxy(facade, {
    get(target, key) {
      if (members.has(key) && key in shell) return shell[key];
      const app = activeApp();
      if (app && key in app) return app[key];
      return Reflect.get(target, key);
    },
  });
}

export async function bootShell() {
  document.title = "QuickTerm";
  const openDir = captureOpenDir();
  const identity = captureWindowIdentity();
  captureToken();
  const cachedInventory = loadInventoryCache();
  const [loadedConfig, loadedProfiles, loadedWorkspaces, loadedInventory] = await Promise.all([
    api.getConfig().catch(() => null),
    api.getProfiles().catch(() => null),
    api.listWorkspaces().catch(() => []),
    cachedInventory
      ? Promise.resolve(cachedInventory)
      : api.getTerminalOptions().then(saveInventoryCache).catch(() => ({ types: [], wsl_distributions: [] })),
  ]);
  const cfg = loadedConfig || { profiles: [], snippets: [] };
  const state = createAppState({
    cfg,
    profiles: loadedProfiles || cfg.profiles || [],
    snippets: cfg.snippets || [],
    workspaceNames: loadedWorkspaces || [],
    terminalInventory: loadedInventory,
    windowIsPrimary: identity.primary,
  });
  // Nothing in the shell is ever replaced wholesale.
  state.transitioning = false;
  applyChromeTheme(state.cfg.theme, state.cfg.custom_theme);
  if (state.cfg.elevated) document.body.classList.add("elevated");

  // ---- this window in the registry: registered, primary, claims nothing ----
  const refresh = () => sidebar.refreshSoon();
  const registry = createWindowRegistry({
    api, state, identity, showError,
    cancelWorkspaceSave: noop,
    buildLauncher: () => refresh(),
    refreshStatusSoon: () => refresh(),
  });
  await registry.acquireWindowId();
  registry.startWindowHeartbeat();

  // ---- the stage ----
  // Only the window the user started keeps its tiling across a restart.
  // localStorage is shared by every window on this origin, so a second
  // window (opened on a workspace of its own) must neither restore it nor
  // write over it.
  const keepsViewArrangement = identity.workspace === undefined && state.windowIsPrimary;
  const views = new WorkspaceViews({
    fit: () => { for (const view of views.views()) views.appFor(view)?.fitAll?.(); },
    error: showError,
    store: keepsViewArrangement ? viewArrangementStore() : null,
    newScratch: () => newScratchView(),
    parentId: () => state.windowId,
    reservedNames: () => state.workspaceNames,
  });
  window.quicktermViews = views;
  const activeApp = () => views.appFor(views.active);
  const eachViewDocument = () => views.views()
    .map((view) => view.frame?.contentWindow?.quicktermView)
    .filter(Boolean);

  // Every saved workspace's folder, for the sidebar's group heads.
  const folders = new Map();
  async function refreshFolders() {
    const entries = await Promise.all(state.workspaceNames.filter((name) => !isScratchWorkspace(name)).map(async (name) => {
      const saved = await workspace.details(name).catch(() => null);
      return [name, { path: saved?.path || null, pathExists: saved ? saved.path_exists !== false : null }];
    }));
    folders.clear();
    for (const [name, folder] of entries) folders.set(name, folder);
    refresh();
  }

  // ---- workspaces: open, close, delete ----
  async function openWorkspace(name) {
    return Boolean(await views.open(name || null));
  }
  async function newScratchView() {
    return Boolean(await views.open(null));
  }
  // True when no view of this window shows `name` any more. A label only
  // names a scratch view, and never when it is also a saved workspace's name.
  async function closeWorkspaceView(name) {
    const view = views.viewForWorkspace(name)
      || (state.workspaceNames.includes(name) ? null : views.scratchViewLabelled(name));
    return view ? views.close(view) : true;
  }
  let lastActionError = null;
  const actions = createWorkspaceActions({
    api, workspace, state, layout: null,
    claimWorkspaceFor: registry.claimWorkspaceFor,
    listWindowsSafe: registry.listWindowsSafe,
    ensureScratchWorkspace: async () => false,
    attachSession: () => false,
    hereState: () => null,
    openWorkspaceView: (name) => views.open(name),
    closeWorkspaceView,
    persistCurrentWorkspace: async () => true,
    scheduleWorkspaceSave: noop,
    cancelWorkspaceSave: noop,
    ownedSessionIds: () => new Set(),
    attachedSessionIds: () => [],
    forgetSession: noop,
    refreshWorkspaceRoots: () => refreshFolders(),
    viewSessionIds: (name) => {
      const view = views.viewForWorkspace(name);
      return view ? views.appFor(view)?.attachedSessionIds?.() || [] : [];
    },
    showError: (text) => { lastActionError = text; showError(text); },
    clearError,
    buildLauncher: () => refresh(),
    refreshStatusSoon: () => refresh(),
  });

  // ---- config, theme, launch errors ----
  // A layout with nothing in it: the shell has no terminal to restyle.
  const noLayout = { setTheme: noop, setFontFamily: noop, fitAll: noop };
  const facade = {};
  const configSync = createConfigSync({
    api, state, app: facade, layout: noLayout, setFontSize: noop, showError,
    buildLauncher: () => refresh(),
  });
  async function onConfigSaved() {
    await configSync.onConfigSaved();
    for (const view of eachViewDocument()) await view.syncConfig();
    settingsEvents.publish();
  }
  async function onWorkspacesChanged() {
    state.workspaceNames = await api.listWorkspaces().catch(() => state.workspaceNames);
    for (const view of eachViewDocument()) await view.syncWorkspaces();
    settingsEvents.publish();
    refreshFolders();
  }
  function previewTheme(id, custom) {
    configSync.previewTheme(id, custom);
    for (const view of eachViewDocument()) view.previewTheme(id, custom);
  }
  // The sidebar's delete answers with the reason on failure, so its
  // confirmation can show it next to the row.
  async function deleteWorkspace(name) {
    lastActionError = null;
    const deleted = await actions.deleteWorkspace(name);
    if (!deleted) throw { detail: lastActionError || `Could not delete workspace "${name}".` };
    await onWorkspacesChanged();
    return true;
  }

  // ---- terminals ----
  const routing = createTerminalRouting({
    api, views,
    context: () => sidebar.context(),
    removeSessionsFromSavedWorkspaces: (ids) => actions.removeSessionsFromSavedWorkspaces(ids),
    markSeen: (id) => sidebar.markSeen(id),
    refreshSoon: () => refresh(),
    forgetSession: (id) => sidebar.forget(id),
  });
  const search = createTerminalActions({
    api, layout: { panes: () => [], focused: null }, attachSession: () => false, restartSavedPane: noop, showError,
  });
  function liveTerminals() {
    const context = sidebar.context();
    return (sidebar.sessions() || []).filter((session) => session.alive).map((session) => {
      const owner = sessionOwner(session, context);
      return {
        session,
        workspace: owner,
        label: owner ? workspaceLabel(owner) : "unassigned",
        attachedIn: context.attached[session.id] || null,
      };
    });
  }
  // A hit is shown in the view whose pane holds it; anything else is
  // attached in the active view by that view's own rules.
  async function revealSearchResult(result, query) {
    const holder = views.viewForSession(result?.session_id);
    if (holder) views.focusView(holder);
    const view = holder || views.active || await views.open(null);
    return views.appFor(view)?.revealSearchResult(result, query) ?? false;
  }
  // Something that needs a terminal while no view is open opens a scratch
  // view first, then asks it.
  const viaView = (name) => async (...args) => {
    const view = views.active || await views.open(null);
    if (!view || !(await views.whenReady(view))) return false;
    return views.appFor(view)?.[name]?.(...args);
  };

  let panels = null;
  let palette = null;
  const shell = {
    openWorkspace,
    loadWorkspace: openWorkspace,
    closeWorkspaceView,
    newScratchView,
    openWorkspaces: () => views.list().map(({ workspace: name, label, color, active }) => ({ workspace: name, label, color, active })),
    liveTerminals,
    ...routing,
    settingEntries: () => panels.settingEntries?.() || [],
    openSetting: (id) => panels.showSetting?.(id),
    editTerminalConfig: (name) => panels.showConfig?.("terminal", name),
    editSnippet: (name) => panels.showConfig?.("snippet", name),
    setupTerminals: () => {
      panels.settingsTab = "connections";
      panels.show("settings");
    },
    setupTour: () => panels.show("setup"),
    openPanel: (name) => panels.show(name),
    onConfigSaved,
    onWorkspacesChanged,
    previewTheme,
    appliedTheme: configSync.appliedTheme,
    deleteWorkspace: async (name) => {
      try { return await deleteWorkspace(name); } catch (_) { return false; }
    },
    revealSearchResult,
  };

  // With no view open, the palette and the panels still need answers. The
  // config sync writes profiles, snippets and the idle timeout back here.
  Object.assign(facade, {
    profiles: state.profiles,
    snippets: state.snippets,
    idleTimeoutSeconds: state.cfg.idle_timeout_s ?? 300,
    version: state.cfg.version || "",
    hotkeyError: () => state.cfg.hotkey_error || null,
    validateWorkspaceName,
    currentWorkspace: () => null,
    workspacePath: () => null,
    workspacePathExists: () => true,
    workspaceLogo: () => null,
    suggestedWorkspaceFolder: () => null,
    scratchRoot: () => state.scratchRoot,
    attachedSessionIds: () => [],
    ownedSessionIds: () => [],
    hereFolder: () => null,
    hereState: () => null,
    focusedPaneName: () => null,
    isZoomed: () => false,
    isBroadcasting: () => false,
    canRestartFocused: () => false,
    lastSavedOutput: () => null,
    refocusTerm: () => false,
    focusHeldByOverlay: () => focusOwners().length > 0,
    windowRegistryAvailable: () => state.registryAvailable,
    shellInstalls: () => state.terminalInventory?.installs || [],
    newWindowChoices: async () => windowChoices(
      state.workspaceNames.filter((item) => !isScratchWorkspace(item)),
      await registry.listWindowsSafe(),
      state.windowId,
      null,
    ),
    openNewWindow: registry.openNewWindow,
    explainWindowChoice: (row) => showError(windowChoiceMessage(row)),
    canShowWorkspaceBeside: () => true,
    openWorkspaceBeside: (name) => views.open(name),
    focusShownWorkspace: (name) => views.focusWorkspace(name),
    shownViews: () => views.list(),
    setWorkspaceFolder: actions.setWorkspaceFolder,
    setWorkspaceAppearance: actions.setWorkspaceAppearance,
    killWorkspaceSession: actions.killWorkspaceSession,
    searchTerminals: search.searchTerminals,
    cycleTerminal: (delta) => state.launcherView?.cycleTerminal(delta),
    openExplorer: () => showError("Nothing to open in Explorer: open a workspace or a terminal first."),
    openEditor: () => showError("Nothing to open in VS Code: open a workspace or a terminal first."),
    openHere: (app) => facade[app === "vscode" ? "openEditor" : "openExplorer"](),
    killFocusedSession: noop,
    closePane: noop,
    zoom: noop,
    focusDir: noop,
    fontBigger: noop,
    fontSmaller: noop,
    fontReset: noop,
    splitH: viaView("splitH"),
    splitV: viaView("splitV"),
    newTerminal: viaView("newTerminal"),
    runProfile: viaView("runProfile"),
    runSystemTerminal: viaView("runSystemTerminal"),
    runClaudeMode: viaView("runClaudeMode"),
    runAgentMode: viaView("runAgentMode"),
    resumeAgentSession: viaView("resumeAgentSession"),
    splitClaudeAgentView: viaView("splitClaudeAgentView"),
    splitAgentView: viaView("splitAgentView"),
    installShell: viaView("installShell"),
    elevateProfile: viaView("elevateProfile"),
    elevateSystemTerminal: viaView("elevateSystemTerminal"),
    attachSession: viaView("attachSession"),
    moveSessionHere: viaView("moveSessionHere"),
    createWorkspaceHere: async () => false,
    saveWorkspace: async () => "Open a workspace view first.",
  });
  const chromeApp = shellApp({ shell, facade, activeApp });
  palette = new Palette(chromeApp);
  panels = new Panels(chromeApp);

  // ---- the chrome every view reaches through window.parent ----
  const settingsEvents = watchGlobalSettings({
    // Another window saved settings: this one follows.
    refresh: async () => {
      await configSync.onConfigSaved();
      state.workspaceNames = await api.listWorkspaces().catch(() => state.workspaceNames);
      for (const view of eachViewDocument()) {
        await view.syncConfig();
        await view.syncWorkspaces();
      }
      refreshFolders();
      if (panels._themePreviewDirty) previewTheme(panels.settingsDraft.theme, panels.settingsDraft.custom_theme);
    },
  });
  window.quicktermChrome = {
    palette, panels,
    saveState: (text, status) => setWorkspaceSaveState(text, status, true),
    showError, clearError,
    scratchLabels: new Map(),
    ownsKeyboard: () => focusOwners().length > 0,
    refreshSoon: () => refresh(),
    settingsEvents,
    get selectedTerminal() { return state.selectedTerminal; },
    set selectedTerminal(choice) { state.selectedTerminal = choice; },
    get launcherView() { return state.launcherView; },
    // A view re-registering after its entry expired names this window again.
    get windowId() { return state.windowId; },
    onConfigSaved,
    onWorkspacesChanged,
    deleteWorkspace,
  };

  // ---- the sidebar ----
  // launcher.js shows only kill and delete failures itself, in their
  // confirmation. Every other row or group gesture reports here.
  const reported = (gesture) => async (...args) => {
    try {
      return await gesture(...args);
    } catch (error) {
      showError(error?.detail || error?.message || "That did not work. Try again.");
      return false;
    }
  };
  const sidebar = createSidebar({
    api, state, views, panels, palette, folders,
    actions: {
      newTerminal: () => chromeApp.newTerminal(),
      runProfile: (profile) => chromeApp.runProfile(profile),
      runSystem: (choice) => chromeApp.runSystemTerminal(choice),
      install: (choice) => chromeApp.installShell(choice),
      elevateProfile: (profile) => chromeApp.elevateProfile(profile),
      elevateSystem: (choice) => chromeApp.elevateSystemTerminal(choice),
      selectTerminal: (choice) => { state.selectedTerminal = choice; },
      setup: () => shell.setupTerminals(),
      openWorkspace: reported(openWorkspace),
      closeWorkspace: reported(closeWorkspaceView),
      newScratch: reported(newScratchView),
      openWorkspaceInWindow: (name) => registry.openNewWindow(name),
      newWindow: () => {
        panels.close();
        palette.newWindowMode();
      },
      editWorkspace: (name) => (panels.showWorkspace ? panels.showWorkspace(name) : panels.show("dashboard")),
      deleteWorkspace,
      activateTerminal: reported(routing.activateTerminal),
      detachTerminal: reported(routing.detachTerminal),
      killTerminal: routing.killTerminal,
      moveTerminalHere: reported(routing.moveTerminalHere),
      renameTerminal: reported(async (session, name) => {
        const app = views.appFor(views.viewForSession(session.id));
        if (app) return app.renameSession(session.id, name);
        await api.renameSession(session.id, name);
        refresh();
        return true;
      }),
      workspaceHere: reported(() => chromeApp.createWorkspaceHere()),
      openFolder: (app) => chromeApp.openHere(app),
      sidebarResized: () => setTimeout(() => views.layout({ animate: false }), 160),
      handBack: () => views.focusView(views.active),
    },
  });
  sidebar.init();

  // ---- the keyboard, while the shell itself has it (sidebar, panels) ----
  // Any overlay holding the keyboard here (palette, panel, menu, a sidebar
  // confirmation or rename, a shortcut capture) stands the plain Alt actions
  // down, and opening the palette or a panel first closes a menu or box
  // still drawn, so its claim does not outlive it.
  const dropSidebarOverlays = () => {
    closeMenu("replaced");
    closeConfirm("replaced");
  };
  initKeys({
    togglePalette: () => { dropSidebarOverlays(); panels.close(); palette.toggle(); },
    paletteOpen: () => focusOwners().length > 0,
    // Alt+W in the sidebar's kill box completes it, like a second Alt+W in a
    // pane's kill bar. Nothing else takes it while an overlay is up.
    acceptKill: () => acceptConfirm(),
    splitH: () => chromeApp.splitH(),
    splitV: () => chromeApp.splitV(),
    // Alt+N with no view open is a new scratch view, whose first terminal is
    // the new terminal.
    newTerminal: () => (views.active ? chromeApp.newTerminal() : newScratchView()),
    cycleTerminal: (delta) => chromeApp.cycleTerminal(delta),
    zoom: () => chromeApp.zoom(),
    closePane: () => chromeApp.closePane(),
    killSession: () => chromeApp.killFocusedSession({ keyboard: true }),
    focusDir: (direction) => chromeApp.focusDir(direction),
    toggleDashboard: () => { dropSidebarOverlays(); palette.close(); panels.toggle("dashboard"); },
    toggleSettings: () => { dropSidebarOverlays(); palette.close(); panels.toggle("settings"); },
    toggleHelp: () => { dropSidebarOverlays(); palette.close(); panels.toggle("help"); },
    toggleSidebar: () => state.launcherView?.cycleMode(),
    openExplorer: () => chromeApp.openExplorer(),
    openEditor: () => chromeApp.openEditor(),
    fontBigger: () => chromeApp.fontBigger(),
    fontSmaller: () => chromeApp.fontSmaller(),
    fontReset: () => chromeApp.fontReset(),
  });
  $("app-error-close").addEventListener("click", () => {
    clearError();
    views.focusView(views.active);
  });

  // ---- leaving, coming back ----
  const { claimLaunchLoop, stopLaunchLoop } = createLaunchLoop({
    api, state,
    openView: (name, options) => views.open(name, options),
    appFor: (view) => views.appFor(view),
    activeView: () => views.active,
    whenReady: (view) => views.whenReady(view),
    showError,
  });
  const { persistOnExit } = createLifecycle({
    api, workspace, state, layout: { root: null },
    stopWindowHeartbeat: registry.stopWindowHeartbeat,
    stopLaunchLoop, cancelWorkspaceSave: noop, cancelWorkspaceRetry: noop, scheduleWorkspaceSave: noop,
  });
  window.addEventListener("pagehide", persistOnExit);
  window.addEventListener("pagehide", () => settingsEvents.dispose(), { once: true });
  const { reportLaunchError, checkLaunchError } = configSync;
  // The summon hotkey and the taskbar give the keyboard to this document,
  // which has no terminal. Once nothing here took it (a click on the sidebar
  // does), it goes on to the active view's focused pane.
  window.addEventListener("focus", () => {
    checkLaunchError();
    setTimeout(() => {
      const idle = !document.activeElement || document.activeElement === document.body;
      if (idle && !focusOwners().length) views.focusView(views.active);
    }, 0);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refresh();
      checkLaunchError();
    }
  });

  // ---- what the window opens on ----
  const exists = (name) => state.workspaceNames.includes(name);
  let restored = null;
  if (identity.workspace !== undefined) {
    // A second window, asked for one workspace or for scratch.
    await views.open(identity.workspace && exists(identity.workspace) ? identity.workspace : null);
  } else {
    restored = await views.restoreSaved({
      exists,
      rememberedWorkspace: storedScratchActive() ? null : storedWorkspace(),
    });
  }
  // Explorer's "Open QuickTerm here": a scratch view whose first terminal
  // starts in that folder, beside whatever came back.
  if (openDir) await views.open(null, { cwd: openDir });
  if (!views.views().length) {
    // The workspace 3.x remembered, read only until this window has stored
    // an arrangement of its own.
    const remembered = identity.workspace === undefined && !restored?.stored ? storedWorkspace() : null;
    const usable = remembered && !isScratchWorkspace(remembered) && exists(remembered);
    if (!usable || !(await views.open(remembered))) {
      await views.open(null, { first: identity.workspace === undefined });
    }
  }
  // After the boot plan, so nothing the boot itself reports replaces it.
  reportLaunchError(state.cfg.launch_error);
  claimLaunchLoop();
  refreshFolders();
  if (cachedInventory) configSync.refreshCachedInventory();
  watchUpdates({ api, state, panels });
  if (setupNeeded(state.profiles)) panels.show("setup");
}
