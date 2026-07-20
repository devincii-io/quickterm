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

const MIN_FONT = 9;
const MAX_FONT = 30;
const DEFAULT_FONT = 14;
const clampFont = (px) => Math.max(MIN_FONT, Math.min(MAX_FONT, Math.round(px || DEFAULT_FONT)));

// The window is launched at .../#t=<token>. Capture it before any API call,
// stash it in sessionStorage so a reload (which loses the fragment) still works,
// then scrub it from the URL so it does not linger in history. sessionStorage is
// per-tab and same-origin, so other local programs cannot read it.
function captureToken() {
  const match = /[#&]t=([^&]+)/.exec(location.hash || "");
  let value = match ? decodeURIComponent(match[1]) : "";
  if (!value) { try { value = sessionStorage.getItem("qt.token") || ""; } catch (_) { /* ignore */ } }
  if (value) {
    api.setToken(value);
    try { sessionStorage.setItem("qt.token", value); } catch (_) { /* ignore */ }
  }
  if (match) {
    try { history.replaceState(null, "", location.pathname + location.search); } catch (_) { /* ignore */ }
  }
}

// Explorer "Open QuickTerm here" passes the folder as ?cwd=... (app.py). Read
// it before captureToken scrubs the fragment; the query itself is preserved.
function captureOpenDir() {
  try {
    const value = new URLSearchParams(location.search).get("cwd");
    return value || null;
  } catch (_) { return null; }
}

async function boot() {
  const openDir = captureOpenDir();
  captureToken();
  let cfg = { font_family: "JetBrains Mono", font_size: DEFAULT_FONT, profiles: [], snippets: [], voice_available: false };
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
  let workspaceSessionIds = new Set();
  let statusTimer = null;
  let workspaceSaveTimer = null;
  let transitioning = true;
  let panels;
  let workspaceLogo = null;
  let fontSize = clampFont(cfg.font_size);
  let fontSaveTimer = null;

  function ownSession(id) {
    if (!id) return;
    if (currentWorkspace) workspaceSessionIds.add(id);
    else scratchSessionIds.add(id);
  }

  function forgetSession(id) {
    workspaceSessionIds.delete(id);
    scratchSessionIds.delete(id);
  }

  function ownedSessionIds() {
    const ids = new Set(currentWorkspace ? workspaceSessionIds : scratchSessionIds);
    sessionIdsInLayout(layout.serialize(), ids);
    return ids;
  }

  applyChromeTheme(cfg.theme, cfg.custom_theme);
  if (cfg.elevated) document.body.classList.add("elevated");

  const layout = new LayoutManager($("grid"), $("zoom-host"), {
    fontFamily: cfg.font_family || "JetBrains Mono",
    fontSize,
    theme: getTheme(cfg.theme, cfg.custom_theme).xterm,
    onFocusChange: () => refreshStatusSoon(),
    onPaneState: (pane) => {
      refreshStatusSoon();
      maybeAdoptScratch(pane);
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

  // Tag new sessions with their named workspace. Scratch remains untagged
  // because it is disposable and may be promoted under a different name.
  function spawnWorkspaceTag() {
    return currentWorkspace && currentWorkspace !== SCRATCH_WS ? currentWorkspace : undefined;
  }

  async function spawnInto(pane, profileName, cwd) {
    if (!pane.beginSpawn()) return null;
    try {
      const info = await api.createSession({
        profile: profileName, cwd: cwd || undefined, workspace: spawnWorkspaceTag(),
      });
      pane.profileName = profileName;
      pane.launchSpec = null;
      if (cwd) pane.cwd = cwd;
      pane.attach(info);
      pane.spawnedFresh = true;
      ownSession(info.id);
      scheduleWorkspaceSave();
      refreshStatusSoon();
      return info;
    } catch (error) {
      pane.endSpawn();
      pane.showNotice(`[${error.detail || `spawn failed: ${profileName}`}]`);
      return null;
    }
  }

  async function spawnSpecInto(pane, spec) {
    if (!pane.beginSpawn()) return null;
    const launchSpec = serializableSpec(spec);
    try {
      // workspace tags the request only (not the persisted launchSpec).
      const info = await api.createSession({ ...launchSpec, workspace: spawnWorkspaceTag() });
      pane.profileName = null;
      pane.cwd = launchSpec.cwd;
      pane.launchSpec = launchSpec;
      pane.attach(info);
      pane.spawnedFresh = true;
      ownSession(info.id);
      scheduleWorkspaceSave();
      refreshStatusSoon();
      return info;
    } catch (error) {
      pane.endSpawn();
      pane.showNotice(`[${error.detail || `spawn failed: ${launchSpec.name}`}]`);
      return null;
    }
  }

  // Whatever the launcher's "New terminal" dropdown currently shows is what
  // splits and fresh panes open.
  let selectedTerminal = null;

  function spawnDefaultInto(pane, cwdOverride) {
    if (selectedTerminal) {
      if (selectedTerminal.kind === "profile") {
        return spawnInto(pane, selectedTerminal.profile.name, cwdOverride || selectedTerminal.profile.cwd || null);
      }
      return spawnSpecInto(pane, {
        cmd: selectedTerminal.cmd,
        args: selectedTerminal.args || [],
        cwd: cwdOverride || null,
        name: selectedTerminal.label,
      });
    }
    const profile = defaultProfile();
    if (profile) return spawnInto(pane, profile.name, cwdOverride || profile.cwd || null);
    const system = defaultSystemSpec();
    if (system && cwdOverride) return spawnSpecInto(pane, { ...system, cwd: cwdOverride });
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

  function elevateProfile(profile) {
    return api.elevateTerminal({ profile: profile.name }).catch(() => {});
  }

  function elevateSystemTerminal(system) {
    return api.elevateTerminal({
      cmd: system.cmd,
      args: system.args || [],
      name: system.label,
    }).catch(() => {});
  }

  function attachSession(info) {
    let pane = layout.focused || layout.init();
    if (!pane.canReplace) pane = layout.splitPane(pane, autoDir(pane));
    if (!pane) return;
    layout.focusPane(pane);
    pane.attach(info);
    ownSession(info.id);
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
      [...ownedSessionIds()],
    ).catch(() => {});
  }

  function scheduleWorkspaceSave() {
    if (!currentWorkspace || transitioning) return;
    clearTimeout(workspaceSaveTimer);
    workspaceSaveTimer = setTimeout(() => persistCurrentWorkspace(), 300);
  }

  // Tear down the current scratch layout before leaving it: scratch is
  // disposable, so its sessions are killed and its file dropped. Handles both
  // pre-adoption scratch (tracked in scratchSessionIds) and the adopted
  // "scratch" workspace (whose sessions are the live layout's).
  async function discardScratch() {
    const ids = new Set(scratchSessionIds);
    scratchSessionIds.clear();
    if (currentWorkspace === SCRATCH_WS) {
      for (const sid of workspaceSessionIds) ids.add(sid);
      workspaceSessionIds.clear();
      await api.deleteWorkspace(SCRATCH_WS).catch(() => {});
    }
    if (ids.size) await api.cleanupSessions([...ids]).catch(() => {});
  }

  // Ephemeral scratch: the first real keystroke in an unsaved scratch layout
  // adopts it as the workspace literally named "scratch" — replacing the
  // previous one (whose background sessions die with it). From then on it
  // autosaves like any workspace. The backend deletes the "scratch" file at
  // app start and exit, so it never survives a run; within a run it survives
  // window close (tray) and can be reopened from the workspace menu.
  const SCRATCH_WS = "scratch";
  let scratchAdoption = null;
  async function maybeAdoptScratch(pane) {
    if (currentWorkspace || transitioning) return;
    if (!pane || !pane.userWrote) return;
    if (scratchAdoption) return scratchAdoption;
    scratchAdoption = (async () => {
    try {
      // Single-window guard: two windows share one backend and one scratch.json.
      // If another window already adopted "scratch", stay in pure scratch here
      // rather than fighting over the file (its sessions stay disposable).
      const names = await api.listWorkspaces().catch(() => null);
      if (names && names.includes(SCRATCH_WS)) return;
      currentWorkspace = SCRATCH_WS;
      workspaceSessionIds = new Set(scratchSessionIds);
      for (const sid of app.attachedSessionIds()) workspaceSessionIds.add(sid);
      scratchSessionIds.clear(); // these sessions are workspace-managed now
      rememberWorkspace(SCRATCH_WS);
      await persistCurrentWorkspace();
      if (!workspaceNames.includes(SCRATCH_WS)) {
        workspaceNames.push(SCRATCH_WS);
        workspaceNames.sort((a, b) => a.localeCompare(b));
      }
      buildLauncher();
      refreshStatusSoon();
    } finally {
      scratchAdoption = null;
    }
    })();
    return scratchAdoption;
  }

  async function ensureScratchWorkspace() {
    if (currentWorkspace) return true;
    const names = await api.listWorkspaces().catch(() => []);
    if (names.includes(SCRATCH_WS)) return false;
    currentWorkspace = SCRATCH_WS;
    workspaceSessionIds = new Set(scratchSessionIds);
    for (const sid of app.attachedSessionIds()) workspaceSessionIds.add(sid);
    scratchSessionIds.clear();
    rememberWorkspace(SCRATCH_WS);
    if (!workspaceNames.includes(SCRATCH_WS)) workspaceNames.push(SCRATCH_WS);
    workspaceNames.sort((a, b) => a.localeCompare(b));
    await persistCurrentWorkspace();
    buildLauncher();
    return true;
  }

  async function restoreWorkspace(name) {
    const saved = await workspace.details(name).catch(() => null);
    if (!saved || !saved.layout) return false;
    const savedLayout = saved.layout;
    workspaceLogo = saved.logo || null;
    const liveSessions = await api.getSessions().catch(() => []);
    const byId = new Map(liveSessions.filter((session) => session.alive).map((session) => [session.id, session]));
    workspaceSessionIds = new Set(
      (saved.session_ids || []).filter((sessionId) => byId.has(sessionId)),
    );
    for (const sessionId of sessionIdsInLayout(savedLayout)) {
      if (byId.has(sessionId)) workspaceSessionIds.add(sessionId);
    }
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
    workspaceSessionIds = new Set();
    rememberWorkspace(null);
    const pane = layout.restore(null)[0];
    await spawnDefaultInto(pane);
    layout.focusPane(pane);
  }

  async function switchWorkspace(name) {
    if ((name || null) === currentWorkspace) return;
    const leavingWorkspace = currentWorkspace;
    transitioning = true;
    clearTimeout(workspaceSaveTimer);
    if (currentWorkspace) {
      await workspace.save(
        currentWorkspace,
        layout.serialize(),
        workspaceLogo,
        [...ownedSessionIds()],
      ).catch(() => {});
    } else if (name) {
      // A never-adopted scratch has no workspace file; leaving it is the one
      // time we clean up its disposable sessions immediately.
      await discardScratch();
    }

    if (name) {
      currentWorkspace = name;
      rememberWorkspace(name);
      const restored = await restoreWorkspace(name);
      if (!restored) await startScratch();
    } else {
      // "New scratch" is explicit replacement. Ordinary workspace switching
      // preserves the adopted Scratch workspace for the rest of this run.
      if (leavingWorkspace === SCRATCH_WS) await discardScratch();
      else if (workspaceNames.includes(SCRATCH_WS)) await api.deleteWorkspace(SCRATCH_WS).catch(() => {});
      workspaceNames = workspaceNames.filter((item) => item !== SCRATCH_WS);
      await startScratch();
    }
    transitioning = false;
    buildLauncher();
    refreshStatusSoon();
    scheduleWorkspaceSave();
  }

  async function removeWorkspaceOwnership(name, sessionId) {
    if (name === currentWorkspace) {
      workspaceSessionIds.delete(sessionId);
      await persistCurrentWorkspace();
      return;
    }
    const saved = await workspace.details(name).catch(() => null);
    if (!saved) return;
    const ids = new Set(saved.session_ids || []);
    sessionIdsInLayout(saved.layout, ids);
    ids.delete(sessionId);
    await workspace.save(name, saved.layout, saved.logo || null, [...ids]).catch(() => {});
  }

  async function moveSessionHere(info, fromWorkspace) {
    if (!info || !info.id) return;
    if (!currentWorkspace && !(await ensureScratchWorkspace())) return;
    if (fromWorkspace && fromWorkspace !== currentWorkspace) {
      await removeWorkspaceOwnership(fromWorkspace, info.id);
    }
    workspaceSessionIds.add(info.id);
    await persistCurrentWorkspace();
    attachSession(info);
  }

  async function killWorkspaceSession(info, workspaceName) {
    if (!info || !info.id) return;
    await api.killSession(info.id).catch(() => {});
    forgetSession(info.id);
    if (workspaceName) await removeWorkspaceOwnership(workspaceName, info.id);
    refreshStatusSoon();
  }

  const app = {
    profiles,
    snippets,
    idleTimeoutSeconds: cfg.idle_timeout_s ?? 300,
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
    closePane: async () => {
      const pane = layout.focused;
      if (!pane) return;
      const session = pane.session;
      const freshUnused = pane.spawnedFresh && !pane.userWrote;
      if (session && !freshUnused && !currentWorkspace) await maybeAdoptScratch(pane);
      let busy = false;
      if (session && pane.state === "attached") {
        // Busy guard: a shell with something running inside (ssh, a build,
        // claude, ...) is too easy to lose to one keypress. First press only
        // warns; a second within 3s proceeds — and never auto-kills.
        busy = await api.sessionBusy(session.id);
        if (busy && !pane.closeArmed) {
          if (layout.focused === pane) pane.armClose();
          return;
        }
      }
      if (freshUnused && session) forgetSession(session.id);
      layout.closePane(pane);
      refreshStatusSoon();
      if (!session || !freshUnused || busy) return;
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
        if (!window.confirm(`Stop terminal "${pane.displayName()}"?`)) return;
        forgetSession(pane.session.id);
        api.killSession(pane.session.id).catch(() => {});
        scheduleWorkspaceSave();
        refreshStatusSoon();
      }
    },
    moveSessionHere,
    killWorkspaceSession,
    sendSnippet: (snippet) => { if (layout.focused) layout.focused.sendText(snippet.text); },
    validateWorkspaceName: (name) => {
      const cleanName = (name || "").trim();
      if (!cleanName) return "Give the workspace a name.";
      if (cleanName.startsWith(".")) return "Names starting with a dot are reserved.";
      // "scratch" is reserved: the backend deletes that file at app start and
      // exit, so a user workspace under that name would silently vanish.
      if (cleanName.toLowerCase() === "scratch") return "“scratch” is reserved for the disposable workspace.";
      // The backend stores names through a safe-name filter; a name that does
      // not survive it unchanged would collide or fail to restore on reboot.
      if (cleanName.replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/\.+$/, "") !== cleanName) {
        return "Use letters, digits, spaces, dots, dashes or underscores.";
      }
      return null;
    },
    saveWorkspace: async (name) => {
      const cleanName = name.trim();
      if (app.validateWorkspaceName(cleanName)) return;
      // Naming is the only way to create a workspace, so this always promotes
      // the current (scratch) layout IN PLACE: every session moves into the
      // named workspace and the disposable "scratch" is cleared — no terminal
      // is killed, and scratch never lingers beside the workspace it became.
      const promotingScratchWs = currentWorkspace === SCRATCH_WS;
      if (!currentWorkspace) {
        // Never-adopted scratch: promote its background sessions too.
        workspaceSessionIds = new Set(scratchSessionIds);
        scratchSessionIds.clear();
      }
      for (const sid of app.attachedSessionIds()) workspaceSessionIds.add(sid);
      clearTimeout(workspaceSaveTimer);
      currentWorkspace = cleanName;
      rememberWorkspace(cleanName);
      await workspace.save(cleanName, layout.serialize(), workspaceLogo, [...ownedSessionIds()]);
      if (promotingScratchWs) {
        // Strip the scratch file's ownership before deleting it, so the backend
        // delete (which reaps a workspace's detached sessions) can't take the
        // terminals we just migrated. Then drop the ephemeral file and name.
        await workspace.save(SCRATCH_WS, { type: "pane" }, null, []).catch(() => {});
        await api.deleteWorkspace(SCRATCH_WS).catch(() => {});
        workspaceNames = workspaceNames.filter((item) => item !== SCRATCH_WS);
      }
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
        for (const sid of workspaceSessionIds) scratchSessionIds.add(sid);
        workspaceSessionIds = new Set();
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
      await workspace.save(currentWorkspace, layout.serialize(), workspaceLogo, [...ownedSessionIds()]);
      buildLauncher();
      return true;
    },
    attachedSessionIds: () => layout.panes()
      .filter((pane) => pane.session && pane.state === "attached")
      .map((pane) => pane.session.id),
    ownedSessionIds: () => [...ownedSessionIds()],
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
      app.idleTimeoutSeconds = fresh.idle_timeout_s ?? 300;
      applyChromeTheme(fresh.theme, fresh.custom_theme);
      layout.setTheme(getTheme(fresh.theme, fresh.custom_theme).xterm);
      setFontSize(fresh.font_size, false);
      buildLauncher();
    },
  };

  const palette = new Palette(app);
  panels = new Panels(app);
  app.openPanel = (name) => panels.show(name);
  $("sb-shortcuts").addEventListener("click", () => {
    panels.close();
    palette.toggle();
  });

  // Terminal text size: applied live to every pane, persisted to config so it
  // survives restarts and shows up in Settings. Saving is debounced so holding
  // the shortcut does not spam the backend.
  function persistFontSize() {
    clearTimeout(fontSaveTimer);
    fontSaveTimer = setTimeout(() => {
      api.getFullConfig().then((full) => {
        if (!full) return;
        full.font_size = fontSize;
        cfg.font_size = fontSize;
        return api.putConfig(full);
      }).catch(() => {});
    }, 700);
  }

  function setFontSize(px, persist = true) {
    const next = clampFont(px);
    if (next === fontSize && persist) return;
    fontSize = next;
    layout.setFontSize(fontSize);
    if (persist) persistFontSize();
  }
  app.setFontSize = setFontSize;
  app.fontSize = () => fontSize;

  // Live theme preview: apply the chrome and every terminal's colors instantly
  // (Settings calls this the moment you click a theme) without persisting.
  // Reverting is just re-applying the committed config theme, which is what
  // appliedTheme() reports.
  app.previewTheme = (themeId, custom) => {
    applyChromeTheme(themeId, custom || {});
    layout.setTheme(getTheme(themeId, custom || {}).xterm);
  };
  app.appliedTheme = () => ({ theme: cfg.theme, custom_theme: cfg.custom_theme || {} });
  app.version = cfg.version || "";

  // Update notification: a quiet accent pill in the nav when a newer release
  // exists. Clicking it opens Settings > About, where install lives.
  function showUpdatePill(latest) {
    const nav = document.querySelector(".launcher-nav");
    if (!nav || nav.querySelector(".update-pill")) return;
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "nav-button update-pill";
    pill.title = `QuickTerm v${latest} is available - open About to install`;
    pill.textContent = `Update v${latest}`;
    pill.addEventListener("click", () => {
      panels.settingsTab = "about"; // land directly on About, where install lives
      panels.show("settings");
    });
    nav.prepend(pill);
  }

  function watchUpdates() {
    if (cfg.elevated || cfg.update_check === false) return;
    const probe = () => {
      api.checkUpdate().then((result) => {
        if (result && result.update_available) showUpdatePill(result.latest);
      }).catch(() => {});
    };
    setTimeout(probe, 4000); // stay out of the boot path
    setInterval(probe, 6 * 3600 * 1000);
  }
  watchUpdates();

  initKeys({
    togglePalette: () => { panels.close(); palette.toggle(); },
    paletteOpen: () => palette.open || panels.open !== null,
    splitH: app.splitH,
    splitV: app.splitV,
    zoom: app.zoom,
    closePane: app.closePane,
    focusDir: (direction) => layout.focusDir(direction),
    fontBigger: () => setFontSize(fontSize + 1),
    fontSmaller: () => setFontSize(fontSize - 1),
    fontReset: () => setFontSize(DEFAULT_FONT),
  });

  function buildLauncher() {
    initLauncher($("launcher"), {
      profiles,
      inventory: terminalInventory,
      workspaces: workspaceNames,
      currentWorkspace,
      selectedTerminal,
      defaultProfile: cfg.default_profile,
      onSelectTerminal: (choice) => { selectedTerminal = choice; },
      logoUrl: api.assetUrl(workspaceLogo || cfg.logo),
      onRunProfile: runProfile,
      onRunSystem: runSystemTerminal,
      onElevateProfile: elevateProfile,
      onElevateSystem: elevateSystemTerminal,
      onWorkspace: switchWorkspace,
      onManage: () => panels.toggle("dashboard"),
      elevated: Boolean(cfg.elevated),
      chrome: [
        ["dashboard", () => panels.toggle("dashboard")],
        ["settings", () => panels.toggle("settings")],
        ["help", () => panels.toggle("help")],
      ],
    });
  }

  function refreshStatus() {
    $("sb-workspace").textContent = currentWorkspace && currentWorkspace !== "scratch"
      ? `ws ${currentWorkspace}`
      : "scratch · disposable";
    api.getSessions().then((list) => {
      const owned = new Set(app.ownedSessionIds());
      const attached = new Set(app.attachedSessionIds());
      const liveOwned = list.filter((session) => session.alive && owned.has(session.id));
      const visible = liveOwned.filter((session) => attached.has(session.id)).length;
      const detached = liveOwned.filter((session) => !attached.has(session.id)).length;
      $("sb-sessions").textContent = `${visible} live · ${detached} detached`;
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
        headers: { "Content-Type": "application/json", ...api.authHeaders() },
        body: JSON.stringify({
          layout: layout.serialize(),
          logo: workspaceLogo,
          session_ids: [...ownedSessionIds()],
        }),
        keepalive: true,
      }).catch(() => {});
    } else if (scratchSessionIds.size) {
      fetch("/api/sessions/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...api.authHeaders() },
        body: JSON.stringify({ session_ids: [...scratchSessionIds] }),
        keepalive: true,
      }).catch(() => {});
    }
  }
  window.addEventListener("pagehide", persistOnExit);

  $("voice-indicator").textContent = ""; // voice is parked until it has a real overlay
  tickClock();
  setInterval(tickClock, 15000);
  setInterval(refreshStatus, 10000);

  // One boot-time sweep for every path (a fix: it used to run only when
  // booting into scratch): kill leftovers that no saved workspace references,
  // that no window is attached to, and that this window did not just adopt.
  async function sweepOrphanSessions() {
    try {
      const names = await api.listWorkspaces();
      const workspaceData = await Promise.all(names.map((name) => api.getWorkspace(name).catch(() => null)));
      const preserved = new Set();
      for (const saved of workspaceData) {
        sessionIdsInLayout(saved && saved.layout, preserved);
        for (const sid of (saved && saved.session_ids) || []) preserved.add(sid);
      }
      for (const sid of app.attachedSessionIds()) preserved.add(sid);
      const sessions = await api.getSessions();
      const orphans = sessions
        .filter((session) => session.alive && !preserved.has(session.id) && !(session.attachments > 0))
        .map((session) => session.id);
      if (orphans.length) await api.cleanupSessions(orphans);
    } catch (_) { /* best effort */ }
  }

  // "Open QuickTerm here" opens this window as a scratch window whose first
  // terminal starts in the given folder, regardless of any remembered workspace.
  if (openDir) currentWorkspace = null;

  if (currentWorkspace) {
    const restored = await restoreWorkspace(currentWorkspace);
    if (!restored) await startScratch();
  } else {
    const pane = layout.init();
    const administratorSession = !openDir && initialSessions.find((session) =>
      (session.name || "").startsWith("Administrator - "));
    if (administratorSession) {
      pane.attach(administratorSession);
      scratchSessionIds.add(administratorSession.id);
      layout.focusPane(pane);
    } else {
      await spawnDefaultInto(pane, openDir);
    }
  }
  await sweepOrphanSessions();
  transitioning = false;
  buildLauncher();
  refreshStatus();
  scheduleWorkspaceSave();
}

boot();
