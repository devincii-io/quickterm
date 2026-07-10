import * as api from "./api.js";
import { LayoutManager } from "./layout.js";
import { Palette } from "./palette.js";
import { Panels } from "./panels.js";
import { initLauncher } from "./launcher.js";
import { initKeys } from "./keys.js";
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

  const layout = new LayoutManager($("grid"), $("zoom-host"), {
    fontFamily: cfg.font_family || "JetBrains Mono",
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
      || profiles.find((profile) => profile.name.toLowerCase() === "powershell")
      || profiles[0]
      || null;
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
    return profile ? spawnInto(pane, profile.name, profile.cwd || null) : Promise.resolve(null);
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
    await workspace.save(currentWorkspace, layout.serialize()).catch(() => {});
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
    const savedLayout = await workspace.load(name).catch(() => null);
    if (!savedLayout) return false;
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
    rememberWorkspace(null);
    const pane = layout.restore(null)[0];
    await spawnDefaultInto(pane);
    layout.focusPane(pane);
  }

  async function switchWorkspace(name) {
    if ((name || null) === currentWorkspace) return;
    transitioning = true;
    clearTimeout(workspaceSaveTimer);
    if (currentWorkspace) await workspace.save(currentWorkspace, layout.serialize()).catch(() => {});
    else await cleanupScratchSessions();

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
    closePane: () => { layout.closePane(); refreshStatusSoon(); },
    killFocusedSession: () => {
      const pane = layout.focused;
      if (pane && pane.session) {
        scratchSessionIds.delete(pane.session.id);
        api.killSession(pane.session.id).catch(() => {});
        refreshStatusSoon();
      }
    },
    sendSnippet: (snippet) => { if (layout.focused) layout.focused.sendText(snippet.text); },
    saveWorkspace: async (name) => {
      const cleanName = name.trim();
      if (!cleanName) return;
      currentWorkspace = cleanName;
      scratchSessionIds.clear();
      rememberWorkspace(cleanName);
      await workspace.save(cleanName, layout.serialize());
      if (!workspaceNames.includes(cleanName)) workspaceNames.push(cleanName);
      workspaceNames.sort((a, b) => a.localeCompare(b));
      buildLauncher();
      refreshStatusSoon();
    },
    loadWorkspace: (name) => switchWorkspace(name),
    deleteWorkspace: async (name) => {
      const deletingCurrent = currentWorkspace === name;
      if (deletingCurrent) {
        await workspace.save(name, layout.serialize()).catch(() => {});
        currentWorkspace = null;
        rememberWorkspace(null);
      }
      await api.deleteWorkspace(name).catch(() => {});
      workspaceNames = workspaceNames.filter((item) => item !== name);
      if (deletingCurrent) {
        transitioning = true;
        await startScratch();
        transitioning = false;
      }
      buildLauncher();
      refreshStatusSoon();
    },
    onWorkspacesChanged: async () => {
      workspaceNames = await api.listWorkspaces().catch(() => workspaceNames);
      buildLauncher();
    },
    currentWorkspace: () => currentWorkspace,
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
    if (currentWorkspace && layout.root) {
      fetch(`/api/workspaces/${encodeURIComponent(currentWorkspace)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layout: layout.serialize() }),
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
    const workspaceData = await Promise.all(workspaceNames.map((name) => api.getWorkspace(name).catch(() => null)));
    const preserved = new Set();
    for (const saved of workspaceData) sessionIdsInLayout(saved && saved.layout, preserved);
    const disposable = initialSessions.filter((session) => !preserved.has(session.id)).map((session) => session.id);
    if (disposable.length) await api.cleanupSessions(disposable).catch(() => {});
    const pane = layout.init();
    await spawnDefaultInto(pane);
  }
  transitioning = false;
  buildLauncher();
  refreshStatus();
  scheduleWorkspaceSave();
}

boot();
