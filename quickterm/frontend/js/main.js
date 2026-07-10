import * as api from "./api.js";
import { LayoutManager } from "./layout.js";
import { Palette } from "./palette.js";
import { Panels } from "./panels.js";
import { initLauncher } from "./launcher.js";
import { initKeys } from "./keys.js";
import { applyChromeTheme, getTheme } from "./themes.js";
import * as workspace from "./workspace.js";

document.title = "QuickTerm";

const $ = (id) => document.getElementById(id);
const ACTIVE_WORKSPACE_KEY = "quickterm.activeWorkspace";

function storedWorkspace() {
  try { return localStorage.getItem(ACTIVE_WORKSPACE_KEY); } catch (_) { return null; }
}

function rememberWorkspace(name) {
  try {
    if (name) localStorage.setItem(ACTIVE_WORKSPACE_KEY, name);
    else localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
  } catch (_) { /* storage may be disabled */ }
}

function sessionIdsInLayout(node, out = new Set()) {
  if (!node) return out;
  if (node.type === "split") {
    for (const child of node.children || []) sessionIdsInLayout(child, out);
  } else if (node.session_id) {
    out.add(node.session_id);
  }
  return out;
}

async function boot() {
  let cfg = { font_family: "JetBrains Mono", profiles: [], snippets: [], voice_available: false };
  const [loadedConfig, loadedProfiles, loadedSessions, loadedWorkspaces, loadedInventory] = await Promise.all([
    api.getConfig().catch(() => null),
    api.getProfiles().catch(() => null),
    api.getSessions().catch(() => []),
    api.listWorkspaces().catch(() => []),
    api.getTerminalOptions().catch(() => ({ types: [], wsl_distributions: [] })),
  ]);
  if (loadedConfig) cfg = loadedConfig;
  let profiles = loadedProfiles || cfg.profiles || [];
  let snippets = cfg.snippets || [];
  let workspaceNames = loadedWorkspaces || [];
  let terminalInventory = loadedInventory;
  const remembered = storedWorkspace();
  let currentWorkspace = remembered && workspaceNames.includes(remembered) ? remembered : null;
  if (!currentWorkspace) rememberWorkspace(null);

  const initialSessions = (loadedSessions || []).filter((session) => session.alive);
  const scratchSessionIds = new Set();
  let statusTimer = null;
  let workspaceSaveTimer = null;
  let transitioning = true;
  let panels;
  let workspaceLogo = null;

  applyChromeTheme(cfg.theme, cfg.custom_theme);

  const layout = new LayoutManager($("grid"), $("zoom-host"), {
    fontFamily: cfg.font_family || "JetBrains Mono",
    theme: getTheme(cfg.theme, cfg.custom_theme).xterm,
    onFocusChange: (pane) => {
      if (pane && pane.session && pane.state === "attached") api.postFocus(pane.session.id).catch(() => {});
    },
    onPaneState: () => {
      refreshStatusSoon();
      scheduleWorkspaceSave();
    },
    onLayoutChange: () => scheduleWorkspaceSave(),
  });

  function defaultProfile() {
    return profiles.find((profile) => profile.name === cfg.default_profile)
      || profiles[0]
      || null;
  }

  // With no personal profiles, fall back to the first available system shell.
  function defaultSystemSpec() {
    const types = (terminalInventory && terminalInventory.types) || [];
    const usable = types.find((type) => type.executable && type.available !== false && type.id !== "custom");
    if (!usable) return null;
    const args = usable.id === "powershell-core" || usable.id === "windows-powershell" ? ["-NoLogo"] : [];
    return { cmd: usable.executable, args, name: usable.label };
  }

  function autoDir(pane) {
    const rect = pane.el.getBoundingClientRect();
    return rect.width > rect.height * 1.8 ? "h" : "v";
  }

  function serializableSpec(spec) {
    return {
      cmd: spec.cmd,
      args: [...(spec.args || [])],
      cwd: spec.cwd || null,
      env: { ...(spec.env || {}) },
      name: spec.name || spec.label || spec.cmd,
    };
  }

  async function spawnInto(pane, profileName, cwd) {
    try {
      const info = await api.createSession({ profile: profileName });
      pane.profileName = profileName;
      pane.launchSpec = null;
      if (cwd) pane.cwd = cwd;
      pane.attach(info);
      pane.spawnedFresh = true;
      if (!currentWorkspace) scratchSessionIds.add(info.id);
      if (layout.focused === pane) api.postFocus(info.id).catch(() => {});
      scheduleWorkspaceSave();
      refreshStatusSoon();
      return info;
    } catch (_) {
      pane.showNotice(`[spawn failed: ${profileName}]`);
      return null;
    }
  }

  async function spawnSpecInto(pane, spec) {
    const launchSpec = serializableSpec(spec);
    try {
      const info = await api.createSession(launchSpec);
      pane.profileName = null;
      pane.cwd = launchSpec.cwd;
      pane.launchSpec = launchSpec;
      pane.attach(info);
      pane.spawnedFresh = true;
      if (!currentWorkspace) scratchSessionIds.add(info.id);
      if (layout.focused === pane) api.postFocus(info.id).catch(() => {});
      scheduleWorkspaceSave();
      refreshStatusSoon();
      return info;
    } catch (_) {
      pane.showNotice(`[spawn failed: ${launchSpec.name}]`);
      return null;
    }
  }

  function spawnDefaultInto(pane) {
    const profile = defaultProfile();
    if (profile) return spawnInto(pane, profile.name, profile.cwd || null);
    const system = defaultSystemSpec();
    if (system) return spawnSpecInto(pane, system);
    pane.showNotice("[no shell found — add one in settings]");
    return Promise.resolve(null);
  }

  async function runProfile(profile) {
    let pane = layout.focused || layout.init();
    if (!pane.canReplace) pane = layout.splitPane(pane, autoDir(pane));
    if (!pane) return;
    layout.focusPane(pane);
    await spawnInto(pane, profile.name, profile.cwd || null);
  }

  async function runSystemTerminal(system) {
    let pane = layout.focused || layout.init();
    if (!pane.canReplace) pane = layout.splitPane(pane, autoDir(pane));
    if (!pane) return;
    layout.focusPane(pane);
    await spawnSpecInto(pane, {
      cmd: system.cmd,
      args: system.args || [],
      name: system.label,
    });
  }

  function attachSession(info) {
    let pane = layout.focused || layout.init();
    if (!pane.canReplace) pane = layout.splitPane(pane, autoDir(pane));
    if (!pane) return;
    layout.focusPane(pane);
    pane.attach(info);
    api.postFocus(info.id).catch(() => {});
    scheduleWorkspaceSave();
    refreshStatusSoon();
  }

  async function persistCurrentWorkspace() {
    if (!currentWorkspace || transitioning || !layout.root) return;
    clearTimeout(workspaceSaveTimer);
    await workspace.save(
      currentWorkspace,
      layout.serialize(),
      workspaceLogo,
    ).catch(() => {});
  }

  function scheduleWorkspaceSave() {
    if (!currentWorkspace || transitioning) return;
    clearTimeout(workspaceSaveTimer);
    workspaceSaveTimer = setTimeout(() => persistCurrentWorkspace(), 300);
  }

  async function cleanupScratchSessions() {
    const ids = [...scratchSessionIds];
    scratchSessionIds.clear();
    if (ids.length) await api.cleanupSessions(ids).catch(() => {});
  }

  async function restoreWorkspace(name) {
    const saved = await workspace.details(name).catch(() => null);
    if (!saved || !saved.layout) return false;
    const savedLayout = saved.layout;
    workspaceLogo = saved.logo || null;
    const liveSessions = await api.getSessions().catch(() => []);
    const byId = new Map(liveSessions.filter((session) => session.alive).map((session) => [session.id, session]));
    const panes = layout.restore(savedLayout);
    for (const pane of panes) {
      const live = pane.savedSessionId && byId.get(pane.savedSessionId);
      if (live) {
        pane.attach(live);
      } else if (pane.profileName) {
        await spawnInto(pane, pane.profileName, pane.cwd);
      } else if (pane.launchSpec) {
        await spawnSpecInto(pane, pane.launchSpec);
      } else {
        await spawnDefaultInto(pane);
      }
    }
    if (panes.length) layout.focusPane(panes[0]);
    return true;
  }

  async function startScratch() {
    currentWorkspace = null;
    workspaceLogo = null;
    rememberWorkspace(null);
    const pane = layout.restore(null)[0];
    await spawnDefaultInto(pane);
    layout.focusPane(pane);
  }

  async function switchWorkspace(name) {
    if ((name || null) === currentWorkspace) return;
    transitioning = true;
    clearTimeout(workspaceSaveTimer);
    if (currentWorkspace) {
      await workspace.save(currentWorkspace, layout.serialize(), workspaceLogo).catch(() => {});
    } else {
      await cleanupScratchSessions();
    }

    if (name) {
      currentWorkspace = name;
      rememberWorkspace(name);
      const restored = await restoreWorkspace(name);
      if (!restored) await startScratch();
    } else {
      await startScratch();
    }
    transitioning = false;
    buildLauncher();
    refreshStatusSoon();
    scheduleWorkspaceSave();
  }

  const app = {
    profiles,
    snippets,
    runProfile,
    runSystemTerminal,
    attachSession,
    splitH: () => { const pane = layout.splitFocused("h"); if (pane) spawnDefaultInto(pane); },
    splitV: () => { const pane = layout.splitFocused("v"); if (pane) spawnDefaultInto(pane); },
    zoom: () => layout.toggleZoom(),
    // Closing a pane detaches its session. If this pane spawned the session
    // itself and nothing was ever typed into it, kill it too so untouched
    // shells don't pile up as background clutter. Reattached sessions and
    // sessions other windows are using are never auto-killed.
    closePane: () => {
      const pane = layout.focused;
      const session = pane && pane.session;
      const freshUnused = pane ? pane.spawnedFresh && !pane.userWrote : false;
      layout.closePane();
      refreshStatusSoon();
      if (!session || !freshUnused) return;
      setTimeout(() => { // let our own detach land server-side first
        api.getSessions().then((list) => {
          const live = list.find((item) => item.id === session.id);
          if (live && live.alive && !(live.attachments > 0)) {
            api.killSession(session.id).catch(() => {});
            // the server removes killed sessions after a short grace period
            setTimeout(refreshStatus, 1300);
          }
        }).catch(() => {});
      }, 350);
    },
    killFocusedSession: () => {
      const pane = layout.focused;
      if (pane && pane.session) {
        api.killSession(pane.session.id).catch(() => {});
        refreshStatusSoon();
      }
    },
    sendSnippet: (snippet) => { if (layout.focused) layout.focused.sendText(snippet.text); },
    saveWorkspace: async (name) => {
      const cleanName = name.trim();
      if (!cleanName || cleanName.startsWith(".")) return;
      const wasScratch = !currentWorkspace;
      currentWorkspace = cleanName;
      if (wasScratch) scratchSessionIds.clear();
      rememberWorkspace(cleanName);
      await workspace.save(cleanName, layout.serialize(), workspaceLogo);
      if (!workspaceNames.includes(cleanName)) workspaceNames.push(cleanName);
      workspaceNames.sort((a, b) => a.localeCompare(b));
      buildLauncher();
      refreshStatusSoon();
    },
    loadWorkspace: (name) => switchWorkspace(name),
    // Deleting a workspace never touches the current layout: the server only
    // kills sessions nobody is attached to, and deleting the workspace you're
    // in simply turns the live layout into a scratch layout in place.
    deleteWorkspace: async (name) => {
      const deletingCurrent = currentWorkspace === name;
      if (deletingCurrent) {
        clearTimeout(workspaceSaveTimer);
        currentWorkspace = null;
        workspaceLogo = null;
        rememberWorkspace(null);
        for (const sid of app.attachedSessionIds()) scratchSessionIds.add(sid);
      }
      await api.deleteWorkspace(name).catch(() => {});
      workspaceNames = workspaceNames.filter((item) => item !== name);
      buildLauncher();
      refreshStatusSoon();
      scheduleWorkspaceSave(); // live layout continues as scratch
    },
    onWorkspacesChanged: async () => {
      workspaceNames = await api.listWorkspaces().catch(() => workspaceNames);
      buildLauncher();
    },
    currentWorkspace: () => currentWorkspace,
    workspaceLogo: () => workspaceLogo,
    setWorkspaceLogo: async (assetId) => {
      if (!currentWorkspace) return false;
      workspaceLogo = assetId || null;
      await workspace.save(currentWorkspace, layout.serialize(), workspaceLogo);
      buildLauncher();
      return true;
    },
    attachedSessionIds: () => layout.panes()
      .filter((pane) => pane.session && pane.state === "attached")
      .map((pane) => pane.session.id),
    refocusTerm: () => { if (layout.focused) layout.focused.setFocused(true); },
    onConfigSaved: async () => {
      const [fresh, freshInventory] = await Promise.all([
        api.getConfig().catch(() => null),
        api.getTerminalOptions().catch(() => terminalInventory),
      ]);
      if (!fresh) return;
      cfg = fresh;
      profiles = fresh.profiles || [];
      snippets = fresh.snippets || [];
      terminalInventory = freshInventory;
      app.profiles = profiles;
      app.snippets = snippets;
      applyChromeTheme(fresh.theme, fresh.custom_theme);
      layout.setTheme(getTheme(fresh.theme, fresh.custom_theme).xterm);
      buildLauncher();
    },
  };

  const palette = new Palette(app);
  panels = new Panels(app);
  app.openPanel = (name) => panels.show(name);

  initKeys({
    togglePalette: () => { panels.close(); palette.toggle(); },
    paletteOpen: () => palette.open || panels.open !== null,
    splitH: app.splitH,
    splitV: app.splitV,
    zoom: app.zoom,
    closePane: app.closePane,
    focusDir: (direction) => layout.focusDir(direction),
  });

  function buildLauncher() {
    initLauncher($("launcher"), {
      profiles,
      inventory: terminalInventory,
      workspaces: workspaceNames,
      currentWorkspace,
      logoUrl: api.assetUrl(workspaceLogo || cfg.logo),
      onRunProfile: runProfile,
      onRunSystem: runSystemTerminal,
      onWorkspace: switchWorkspace,
      onManage: () => panels.toggle("dashboard"),
      chrome: [
        ["dashboard", () => panels.toggle("dashboard")],
        ["settings", () => panels.toggle("settings")],
        ["help", () => panels.toggle("help")],
      ],
    });
  }

  function refreshStatus() {
    $("sb-workspace").textContent = currentWorkspace ? `ws ${currentWorkspace}` : "scratch · disposable";
    api.getSessions().then((list) => {
      const count = list.filter((session) => session.alive).length;
      $("sb-sessions").textContent = `${count} session${count === 1 ? "" : "s"}`;
    }).catch(() => { $("sb-sessions").textContent = "offline"; });
  }

  function refreshStatusSoon() {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(refreshStatus, 250);
  }

  function tickClock() {
    const date = new Date();
    const pad = (number) => String(number).padStart(2, "0");
    $("sb-clock").textContent = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function persistOnExit() {
    if (currentWorkspace && layout.root && !transitioning) {
      fetch(`/api/workspaces/${encodeURIComponent(currentWorkspace)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layout: layout.serialize(), logo: workspaceLogo }),
        keepalive: true,
      }).catch(() => {});
    } else if (scratchSessionIds.size) {
      fetch("/api/sessions/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_ids: [...scratchSessionIds] }),
        keepalive: true,
      }).catch(() => {});
    }
  }
  window.addEventListener("pagehide", persistOnExit);

  $("voice-indicator").textContent = cfg.voice_available ? "voice" : "";
  tickClock();
  setInterval(tickClock, 15000);
  setInterval(refreshStatus, 10000);

  if (currentWorkspace) {
    const restored = await restoreWorkspace(currentWorkspace);
    if (!restored) await startScratch();
  } else {
    const workspaceData = await Promise.all(
      workspaceNames.map((name) => api.getWorkspace(name).catch(() => null)),
    );
    const preserved = new Set();
    for (const saved of workspaceData) sessionIdsInLayout(saved && saved.layout, preserved);
    const orphans = initialSessions.filter((session) => !preserved.has(session.id)).map((session) => session.id);
    if (orphans.length) await api.cleanupSessions(orphans).catch(() => {});
    const pane = layout.init();
    await spawnDefaultInto(pane);
  }
  transitioning = false;
  buildLauncher();
  refreshStatus();
  scheduleWorkspaceSave();
}

boot();
