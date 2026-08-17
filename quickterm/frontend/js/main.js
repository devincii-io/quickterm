import * as api from "./api.js";
import { LayoutManager } from "./layout.js";
import { Palette } from "./palette.js";
import { Panels } from "./panels.js";
import { initLauncher } from "./launcher.js";
import { initKeys } from "./keys.js";
import { applyChromeTheme, getTheme } from "./themes.js";
import * as workspace from "./workspace.js";
import { displaySnippet } from "./panel_shared.js";
import { normalClaudeSplitMode, splitDirectory } from "./split_policy.js";

document.title = "QuickTerm";

const $ = (id) => document.getElementById(id);
const ACTIVE_WORKSPACE_KEY = "quickterm.activeWorkspace";
const SCRATCH_ACTIVE_KEY = "quickterm.scratchActive";
const SCRATCH_WS = "scratch";

function storedWorkspace() {
  try { return localStorage.getItem(ACTIVE_WORKSPACE_KEY); } catch (_) { return null; }
}

function storedScratchActive() {
  try { return localStorage.getItem(SCRATCH_ACTIVE_KEY) === "1"; } catch (_) { return false; }
}

// The remembered workspace and "scratch is the current one" are two different
// facts. Writing "scratch" into the durable key erased the user's real last
// workspace — and the backend deletes the scratch file at startup, so nothing
// was auto-restored on the next launch. Scratch gets its own flag; within a
// run (tray close and reopen) the scratch file still exists and wins, and on
// a fresh start it is gone and the named workspace comes back.
function rememberWorkspace(name) {
  try {
    if (name === SCRATCH_WS) {
      localStorage.setItem(SCRATCH_ACTIVE_KEY, "1");
      return;
    }
    localStorage.removeItem(SCRATCH_ACTIVE_KEY);
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
  let currentWorkspace = null;
  if (storedScratchActive() && workspaceNames.includes(SCRATCH_WS)) currentWorkspace = SCRATCH_WS;
  else if (remembered && workspaceNames.includes(remembered)) currentWorkspace = remembered;
  if (!currentWorkspace) rememberWorkspace(null);

  const initialSessions = (loadedSessions || []).filter((session) => session.alive);
  let lastSessions = initialSessions;
  const scratchSessionIds = new Set();
  let workspaceSessionIds = new Set();
  let statusTimer = null;
  let workspaceSaveTimer = null;
  let workspaceRetryTimer = null;
  let workspaceStatusTimer = null;
  let workspaceSaveInFlight = false;
  let workspaceSavePending = false;
  let transitioning = true;
  let panels;
  let launcherView = null;
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
    onFocusChange: () => { refreshStatusSoon(); updateQuickSettings(); },
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

  // An empty default_profile is Settings' explicit "System default shell"
  // choice, not "unset" — falling through to profiles[0] made that option a
  // no-op and handed every new pane the first personal profile instead.
  function defaultProfile() {
    if (cfg.default_profile === "") return null;
    return profiles.find((profile) => profile.name === cfg.default_profile)
      || profiles[0]
      || null;
  }

  // With no personal profiles, fall back to the first available system shell.
  function defaultSystemSpec() {
    const types = (terminalInventory && terminalInventory.types) || [];
    const usable = types.find((type) => type.executable && type.available !== false
      && !["custom", "claude-code", "ssh", "sftp"].includes(type.id));
    if (!usable) return null;
    const args = usable.id === "powershell-core" || usable.id === "windows-powershell"
      ? ["-NoLogo"]
      : usable.id === "wsl" ? ["--cd", "~"] : [];
    return { cmd: usable.executable, args, name: usable.label, terminalType: usable.id };
  }

  function autoDir(pane) {
    const rect = pane.el.getBoundingClientRect();
    return rect.width > rect.height * 1.8 ? "h" : "v";
  }

  function serializableSpec(spec) {
    const out = {
      cmd: spec.cmd,
      args: [...(spec.args || [])],
      cwd: spec.cwd || null,
      env: { ...(spec.env || {}) },
      name: spec.name || spec.label || spec.cmd,
    };
    if (spec.terminalType || spec.terminal_type) {
      out.terminal_type = spec.terminalType || spec.terminal_type;
    }
    return out;
  }

  function profileTerminalType(name) {
    return profiles.find((profile) => profile.name === name)?.terminal_type || null;
  }

  function commandTerminalType(spec) {
    if (spec.terminal_type || spec.terminalType) return spec.terminal_type || spec.terminalType;
    const command = String(spec.cmd || "").toLowerCase();
    if (/(^|[\\/])wsl(?:\.exe)?$/.test(command)) return "wsl";
    if (/(^|[\\/])psftp(?:\.exe)?$/.test(command)) return "sftp";
    if (/(^|[\\/])plink(?:\.exe)?$/.test(command)) return "ssh";
    return null;
  }

  // Tag new sessions with their named workspace. Scratch remains untagged
  // because it is disposable and may be promoted under a different name.
  function spawnWorkspaceTag() {
    return currentWorkspace && currentWorkspace !== SCRATCH_WS ? currentWorkspace : undefined;
  }

  async function spawnInto(pane, profileName, cwd, options = {}) {
    if (!pane.beginSpawn()) return null;
    try {
      const info = await api.createSession({
        profile: profileName,
        cwd: cwd || undefined,
        workspace: spawnWorkspaceTag(),
        ...(options.startCommand !== undefined ? { start_command: options.startCommand } : {}),
        ...(options.claudeMode !== undefined ? { claude_mode: options.claudeMode } : {}),
        ...(options.args !== undefined ? { args: options.args } : {}),
      });
      pane.profileName = profileName;
      pane.terminalType = profileTerminalType(profileName);
      pane.launchSpec = null;
      pane.setLaunchCwd(cwd || profiles.find((profile) => profile.name === profileName)?.cwd || null);
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
      pane.terminalType = commandTerminalType(launchSpec);
      pane.setLaunchCwd(launchSpec.cwd);
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
        terminalType: selectedTerminal.id,
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

  function splitCwd(source, choice) {
    return splitDirectory(
      source?.bestKnownCwd?.() || null,
      source?.terminalType || null,
      choice,
      /Windows/i.test(navigator.userAgent),
    );
  }

  function spawnSplitInto(pane, source) {
    if (selectedTerminal) {
      const cwd = splitCwd(source, selectedTerminal);
      if (selectedTerminal.kind === "profile") {
        const profile = selectedTerminal.profile;
        const claudeMode = normalClaudeSplitMode(profile);
        return spawnInto(pane, profile.name, cwd || profile.cwd || null, { claudeMode });
      }
      return spawnSpecInto(pane, {
        cmd: selectedTerminal.cmd,
        args: selectedTerminal.args || [],
        cwd,
        name: selectedTerminal.label,
        terminalType: selectedTerminal.id,
      });
    }
    const profile = defaultProfile();
    if (profile) {
      const choice = { kind: "profile", profile };
      return spawnInto(pane, profile.name, splitCwd(source, choice) || profile.cwd || null, {
        claudeMode: normalClaudeSplitMode(profile),
      });
    }
    const system = defaultSystemSpec();
    if (!system) return spawnDefaultInto(pane);
    const choice = { kind: "system", id: system.terminalType, ...system };
    return spawnSpecInto(pane, { ...system, cwd: splitCwd(source, choice) });
  }

  async function runProfile(profile) {
    let pane = layout.focused || layout.init();
    if (!pane.canReplace) pane = layout.splitPane(pane, autoDir(pane));
    if (!pane) return;
    layout.focusPane(pane);
    await spawnInto(pane, profile.name, profile.cwd || null);
  }

  async function runClaudeMode(profile, claudeMode) {
    let pane = layout.focused || layout.init();
    if (!pane.canReplace) pane = layout.splitPane(pane, autoDir(pane));
    if (!pane) return;
    layout.focusPane(pane);
    await spawnInto(pane, profile.name, profile.cwd || null, { claudeMode });
  }

  async function splitClaudeAgentView(profile) {
    const source = layout.focused || layout.init();
    const pane = layout.splitPane(source, autoDir(source));
    if (!pane) return null;
    layout.focusPane(pane);
    return spawnInto(pane, profile.name, profile.cwd || null, { claudeMode: "agents" });
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
      terminalType: system.id,
    });
  }

  // Elevation opens a separate Administrator window, so nothing in this window
  // changes on success and every failure mode (non-Windows, unknown profile,
  // declined UAC) used to land in an empty catch. Always say what happened.
  function elevate(spec, label) {
    const notify = (text) => {
      if (layout.focused) layout.focused.flashNotice(`[${text}]`);
      else showError(text);
    };
    return api.elevateTerminal(spec).then(
      () => { notify(`administrator terminal opening · ${label}`); return true; },
      (error) => {
        showError(error?.detail || `could not start an administrator terminal (${label})`);
        return false;
      },
    );
  }

  function elevateProfile(profile) {
    return elevate({ profile: profile.name }, profile.name);
  }

  function elevateSystemTerminal(system) {
    return elevate({
      cmd: system.cmd,
      args: system.args || [],
      name: system.label,
    }, system.label);
  }

  function attachSession(info) {
    // Session cards can become stale between a dashboard refresh and a click.
    // Never create a pane for an API record already known to have exited.
    if (!info || !info.id || info.alive === false) {
      refreshStatusSoon();
      return false;
    }
    const targetOwner = currentWorkspace || null;
    if (info.workspace && info.workspace !== targetOwner) {
      showError(`That terminal belongs to workspace “${info.workspace}” — use “Move here & attach”.`);
      return false;
    }
    let pane = layout.focused || layout.init();
    if (!pane.canReplace) pane = layout.splitPane(pane, autoDir(pane));
    if (!pane) return;
    layout.focusPane(pane);
    pane.terminalType = info.profile ? profileTerminalType(info.profile) : pane.terminalType;
    pane.attach(info);
    ownSession(info.id);
    scheduleWorkspaceSave();
    refreshStatusSoon();
    return true;
  }

  async function persistCurrentWorkspace() {
    if (!currentWorkspace || transitioning || !layout.root) return true;
    clearTimeout(workspaceSaveTimer);
    clearTimeout(workspaceRetryTimer);
    workspaceRetryTimer = null;
    if (workspaceSaveInFlight) {
      workspaceSavePending = true;
      return true;
    }
    workspaceSaveInFlight = true;
    workspaceSavePending = false;
    const targetWorkspace = currentWorkspace;
    setWorkspaceSaveState("saving");
    let saved = false;
    try {
      await workspace.save(
        targetWorkspace,
        layout.serialize(),
        workspaceLogo,
        [...ownedSessionIds()],
      );
      saved = true;
      if (currentWorkspace === targetWorkspace) {
        setWorkspaceSaveState("saved");
        clearTimeout(workspaceStatusTimer);
        workspaceStatusTimer = setTimeout(() => setWorkspaceSaveState(""), 1400);
      }
    } catch (_) {
      if (currentWorkspace === targetWorkspace) {
        workspaceSavePending = true;
        setWorkspaceSaveState("save failed · retrying", "error");
        workspaceRetryTimer = setTimeout(() => {
          workspaceRetryTimer = null;
          persistCurrentWorkspace();
        }, 2000);
      }
    } finally {
      workspaceSaveInFlight = false;
      if (saved && workspaceSavePending && currentWorkspace === targetWorkspace) {
        setTimeout(() => persistCurrentWorkspace(), 0);
      }
    }
    return saved;
  }

  function scheduleWorkspaceSave() {
    if (!currentWorkspace || transitioning) return;
    clearTimeout(workspaceSaveTimer);
    clearTimeout(workspaceRetryTimer);
    workspaceRetryTimer = null;
    workspaceSavePending = true;
    workspaceSaveTimer = setTimeout(() => persistCurrentWorkspace(), 300);
  }

  // #sb-save owns the saving/saved lifecycle only. It is a 9 px span that
  // collapses when empty and disappears under the panel overlay, so it is the
  // wrong place for anything the user has to act on.
  function setWorkspaceSaveState(text, state = "") {
    const status = $("sb-save");
    if (!status) return;
    status.textContent = text;
    if (state) status.dataset.state = state;
    else delete status.dataset.state;
  }

  // The single visible failure surface: a dismissible banner above the status
  // bar, drawn over the panel overlay so a Dashboard/Settings gesture that
  // fails is still readable.
  function showError(text) {
    const banner = $("app-error");
    const body = $("app-error-text");
    if (!banner || !body) return;
    body.textContent = text;
    banner.hidden = false;
    const live = $("live-status");
    if (live) live.textContent = text;
  }

  function clearError() {
    const banner = $("app-error");
    if (banner) banner.hidden = true;
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
  let scratchAdoption = null;
  async function maybeAdoptScratch(pane) {
    if (currentWorkspace || transitioning) return;
    if (!pane || !pane.userWrote) return;
    if (scratchAdoption) return scratchAdoption;
    scratchAdoption = (async () => {
    try {
      // Defensive guard for an externally opened viewer sharing this backend.
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

  function claudeProfileForPane(pane) {
    const profile = profiles.find((item) => item.name === pane.profileName) || null;
    if (!profile) return null;
    if (profile.terminal_type === "claude-code") return profile;
    const hint = [profile.name, profile.cmd, profile.start_command, pane.title]
      .filter(Boolean).join(" ");
    const mentionsClaude = /\bclaude(?:\.cmd|\.exe)?\b/i.test(hint);
    const directClaude = /(^|[\\/])claude(?:\.cmd|\.exe)?$/i.test(profile.cmd || "");
    const resumableShell = [
      "powershell-core", "windows-powershell", "command-prompt", "wsl", "bash", "zsh", "fish",
    ].includes(profile.terminal_type);
    return mentionsClaude && (directClaude || resumableShell) ? profile : null;
  }

  async function restartSavedPane(pane) {
    if (pane.profileName) return spawnInto(pane, pane.profileName, pane.cwd);
    if (pane.launchSpec) return spawnSpecInto(pane, pane.launchSpec);
    return spawnDefaultInto(pane, pane.cwd);
  }

  async function resumeClaudePane(pane, mode = "continue") {
    const profile = claudeProfileForPane(pane);
    if (!profile) return null;
    // Explicit recovery only: continue the latest project conversation or let
    // Claude present its own native picker. Neither path impersonates the old PTY.
    if (profile.terminal_type === "claude-code") {
      return spawnInto(pane, profile.name, pane.cwd, { claudeMode: mode });
    }
    const flag = mode === "resume" ? "--resume" : "--continue";
    const directClaude = /(^|[\\/])claude(?:\.cmd|\.exe)?$/i.test(profile.cmd || "");
    if (directClaude) {
      return spawnInto(pane, profile.name, pane.cwd, {
        args: [...(profile.args || []), flag],
      });
    }
    return spawnInto(pane, profile.name, pane.cwd, { startCommand: `claude ${flag}` });
  }

  async function restoreWorkspace(name) {
    const saved = await workspace.details(name).catch(() => null);
    if (!saved || !saved.layout) return false;
    const savedLayout = saved.layout;
    workspaceLogo = saved.logo || null;
    const knownSessions = await api.getSessions({ metrics: false }).catch(() => []);
    const knownById = new Map(knownSessions.map((session) => [session.id, session]));
    const byId = new Map(knownSessions.filter((session) => session.alive).map((session) => [session.id, session]));
    workspaceSessionIds = new Set(saved.session_ids || []);
    for (const sessionId of sessionIdsInLayout(savedLayout)) {
      if (byId.has(sessionId)) workspaceSessionIds.add(sessionId);
    }
    const panes = layout.restore(savedLayout);
    for (const pane of panes) {
      if (pane.profileName) pane.terminalType = profileTerminalType(pane.profileName);
      else if (pane.launchSpec) pane.terminalType = commandTerminalType(pane.launchSpec);
      const live = pane.savedSessionId && byId.get(pane.savedSessionId);
      if (live) {
        pane.attach(live);
      } else if (pane.savedSessionId) {
        const prior = knownById.get(pane.savedSessionId);
        pane.markUnavailable({
          exitCode: typeof prior?.exit_code === "number" ? prior.exit_code : null,
          onRestart: () => restartSavedPane(pane),
          onResumeClaude: claudeProfileForPane(pane) ? () => resumeClaudePane(pane) : null,
          onPickClaude: claudeProfileForPane(pane) ? () => resumeClaudePane(pane, "resume") : null,
        });
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

  async function startScratch(cwdOverride = null) {
    currentWorkspace = null;
    workspaceLogo = null;
    workspaceSessionIds = new Set();
    rememberWorkspace(null);
    const pane = layout.restore(null)[0];
    const started = await spawnDefaultInto(pane, cwdOverride);
    layout.focusPane(pane);
    return Boolean(started);
  }

  async function switchWorkspace(name, scratchCwd = null, { replaceScratch = false } = {}) {
    if ((name || null) === currentWorkspace) return true;
    // The scratch sidebar row reports itself as null, but once scratch has been
    // adopted currentWorkspace is the string "scratch" — so the guard above
    // missed and a click on the row drawn as "current" fell through to
    // discardScratch(), killing every live scratch terminal without asking.
    // Replacing scratch is the explicit, confirmed "New scratch" action only.
    if (!name && currentWorkspace === SCRATCH_WS && !replaceScratch) return true;
    const leavingWorkspace = currentWorkspace;
    transitioning = true;
    clearTimeout(workspaceSaveTimer);
    if (currentWorkspace) {
      try {
        await workspace.save(
          currentWorkspace,
          layout.serialize(),
          workspaceLogo,
          [...ownedSessionIds()],
        );
      } catch (_) {
        transitioning = false;
        showError(`Could not save “${currentWorkspace}” — the workspace was not switched and nothing was closed.`);
        return false;
      }
    } else if (name) {
      // A never-adopted scratch has no workspace file; leaving it is the one
      // time we clean up its disposable sessions immediately.
      await discardScratch();
    }

    let opened = true;
    if (name) {
      currentWorkspace = name;
      rememberWorkspace(name);
      const restored = await restoreWorkspace(name);
      if (!restored) opened = await startScratch();
    } else {
      // "New scratch" is explicit replacement. Ordinary workspace switching
      // preserves the adopted Scratch workspace for the rest of this run.
      if (leavingWorkspace === SCRATCH_WS) await discardScratch();
      else if (workspaceNames.includes(SCRATCH_WS)) await api.deleteWorkspace(SCRATCH_WS).catch(() => {});
      workspaceNames = workspaceNames.filter((item) => item !== SCRATCH_WS);
      opened = await startScratch(scratchCwd);
    }
    transitioning = false;
    clearError();
    buildLauncher();
    refreshStatusSoon();
    scheduleWorkspaceSave();
    return opened;
  }

  // Explicit replacement of the live scratch layout. Confirmed in place when
  // there is anything running to lose, because it kills those terminals.
  async function newScratchWorkspace() {
    if (currentWorkspace && currentWorkspace !== SCRATCH_WS) return switchWorkspace(null);
    const live = layout.panes().filter((pane) => pane.session && pane.state === "attached").length;
    const replace = () => switchWorkspace(null, null, { replaceScratch: true });
    if (!live) return replace();
    const pane = layout.focused || layout.panes()[0];
    if (!pane) return replace();
    pane.confirmAction(
      `Discard scratch and stop ${live} running terminal${live === 1 ? "" : "s"}?`,
      replace,
      "Discard",
    );
    return false;
  }

  async function openFolderInScratch(cwd) {
    if (!cwd || transitioning) return false;
    if (currentWorkspace && currentWorkspace !== SCRATCH_WS) {
      if (workspaceNames.includes(SCRATCH_WS)) {
        if (!(await switchWorkspace(SCRATCH_WS)) || currentWorkspace !== SCRATCH_WS) return false;
      }
      else {
        return switchWorkspace(null, cwd);
      }
    }
    let pane = layout.focused || layout.init();
    if (!pane.canReplace) pane = layout.splitPane(pane, autoDir(pane));
    if (!pane) return false;
    layout.focusPane(pane);
    const started = await spawnDefaultInto(pane, cwd);
    if (!started) return false;
    scheduleWorkspaceSave();
    refreshStatusSoon();
    return true;
  }

  let launchLoopStopped = false;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A folder handoff that cannot be satisfied (max_sessions reached, no shell
  // configured) used to retry twice a second forever, which also meant no
  // later "Open QuickTerm here" was ever claimed again.
  const LAUNCH_MAX_ATTEMPTS = 5;
  const LAUNCH_MAX_WAITS = 100; // 10 s of "transitioning" before giving up

  async function claimLaunchLoop() {
    while (!launchLoopStopped) {
      try {
        let waits = 0;
        while (transitioning && !launchLoopStopped && waits++ < LAUNCH_MAX_WAITS) await sleep(100);
        const launch = await api.claimLaunch();
        if (launch?.cwd) {
          let opened = false;
          let attempts = 0;
          let waited = 0;
          while (!opened && !launchLoopStopped && attempts < LAUNCH_MAX_ATTEMPTS) {
            if (transitioning) {
              if (waited++ >= LAUNCH_MAX_WAITS) break;
              await sleep(100);
              continue;
            }
            attempts += 1;
            opened = await openFolderInScratch(launch.cwd);
            if (!opened && attempts < LAUNCH_MAX_ATTEMPTS) await sleep(Math.min(500 * attempts, 4000));
          }
          if (!opened && !launchLoopStopped) {
            showError(`Could not open “${launch.cwd}” in a terminal — the request was dropped.`);
          }
        }
      } catch (_) {
        await sleep(1000);
      }
    }
  }

  function removeSessionFromLayout(node, sessionId) {
    if (!node) return false;
    if (node.type === "split") {
      return (node.children || []).reduce((changed, child) =>
        removeSessionFromLayout(child, sessionId) || changed, false);
    }
    if (node.session_id !== sessionId) return false;
    delete node.session_id;
    return true;
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
    const removedOwnership = ids.delete(sessionId);
    const removedLayoutReference = removeSessionFromLayout(saved.layout, sessionId);
    const changed = removedOwnership || removedLayoutReference;
    if (changed) await workspace.save(name, saved.layout, saved.logo || null, [...ids]).catch(() => {});
  }

  async function removeSessionsFromSavedWorkspaces(sessionIds) {
    if (!sessionIds.size) return;
    const names = await api.listWorkspaces().catch(() => []);
    await Promise.all(names.map(async (name) => {
      const saved = await workspace.details(name).catch(() => null);
      if (!saved) return;
      const ids = new Set(saved.session_ids || []);
      let changed = false;
      for (const sessionId of sessionIds) {
        const removedOwnership = ids.delete(sessionId);
        const removedLayoutReference = removeSessionFromLayout(saved.layout, sessionId);
        changed = removedOwnership || removedLayoutReference || changed;
      }
      if (changed) await workspace.save(name, saved.layout, saved.logo || null, [...ids]).catch(() => {});
    }));
  }

  async function moveSessionHere(info, fromWorkspace) {
    if (!info || !info.id) return;
    const current = await api.getSessions().catch(() => []);
    const fresh = current.find((session) => session.id === info.id && session.alive);
    if (!fresh) {
      if (fromWorkspace) await removeWorkspaceOwnership(fromWorkspace, info.id);
      forgetSession(info.id);
      showError("That terminal has already exited.");
      refreshStatusSoon();
      return false;
    }
    if (!currentWorkspace && !(await ensureScratchWorkspace())) return;
    if (fromWorkspace && fromWorkspace !== currentWorkspace) {
      await removeWorkspaceOwnership(fromWorkspace, info.id);
    }
    workspaceSessionIds.add(info.id);
    await persistCurrentWorkspace();
    return attachSession(fresh);
  }

  async function killWorkspaceSession(info, workspaceName) {
    if (!info || !info.id) return false;
    try {
      await api.killSession(info.id);
    } catch (_) {
      showError("Could not stop that terminal — it is still running.");
      return false;
    }
    forgetSession(info.id);
    if (workspaceName) await removeWorkspaceOwnership(workspaceName, info.id);
    refreshStatusSoon();
    return true;
  }

  const app = {
    profiles,
    snippets,
    idleTimeoutSeconds: cfg.idle_timeout_s ?? 300,
    runProfile,
    runClaudeMode,
    splitClaudeAgentView,
    runSystemTerminal,
    attachSession,
    splitH: () => {
      const source = layout.focused;
      const pane = layout.splitFocused("h");
      if (pane) spawnSplitInto(pane, source);
    },
    splitV: () => {
      const source = layout.focused;
      const pane = layout.splitFocused("v");
      if (pane) spawnSplitInto(pane, source);
    },
    newTerminal: () => {
      let pane = layout.focused || layout.init();
      if (!pane.canReplace) pane = layout.splitPane(pane, autoDir(pane));
      if (pane) spawnDefaultInto(pane);
    },
    cycleTerminal: (delta) => {
      const choice = launcherView?.cycleTerminal(delta);
      if (choice) layout.focused?.flashNotice(`[new terminal: ${choice.label}]`);
      return choice;
    },
    zoom: () => layout.toggleZoom(),
    // D/Alt+D is a true detach: retain the process first, then remove only its
    // viewer. It must never share the kill semantics of X/Alt+W.
    closePane: async () => {
      const pane = layout.focused;
      if (!pane) return;
      const session = pane.session;
      if (session) {
        try {
          await api.retainSession(session.id);
        } catch (_) {
          pane.flashNotice("[could not retain terminal — pane left open]");
          return;
        }
        if (!currentWorkspace) {
          const adopted = await ensureScratchWorkspace().catch(() => false);
          // Another window may already own Scratch. Retain still guarantees
          // this process lives; exclude it from this viewer's exit cleanup.
          if (!adopted) scratchSessionIds.delete(session.id);
        }
      }
      layout.closePane(pane);
      scheduleWorkspaceSave();
      refreshStatusSoon();
    },
    killFocusedSession: async () => {
      const pane = layout.focused;
      if (pane && pane.session) {
        pane.confirmAction(`Stop “${pane.displayName()}” and close this pane?`, async () => {
          const sessionId = pane.session.id;
          await api.killSession(sessionId);
          forgetSession(sessionId);
          layout.closePane(pane);
          scheduleWorkspaceSave();
          refreshStatusSoon();
        });
      }
    },
    killAllSessions: async () => {
      const result = await api.killAllSessions();
      const killedIds = new Set(result?.killed_ids || []);
      for (const pane of [...layout.panes()]) {
        if (!pane.session || !killedIds.has(pane.session.id)) continue;
        forgetSession(pane.session.id);
        layout.closePane(pane);
      }
      for (const sessionId of killedIds) forgetSession(sessionId);
      await removeSessionsFromSavedWorkspaces(killedIds);
      scheduleWorkspaceSave();
      refreshStatusSoon();
      const failed = result?.failed_ids || [];
      if (failed.length) {
        showError(`${failed.length} terminal${failed.length === 1 ? "" : "s"} could not be stopped and ${failed.length === 1 ? "is" : "are"} still running.`);
      }
      return { killed: result?.killed || 0, failed: failed.length };
    },
    moveSessionHere,
    killWorkspaceSession,
    focusedPaneName: () => layout.focused?.displayName() || null,
    // Snippets type straight into the focused terminal. Say where they went,
    // say when they went nowhere, and confirm anything multi-line first — one
    // Enter in the palette should never run three commands unannounced.
    sendSnippet: (snippet) => {
      const pane = layout.focused;
      if (!pane) {
        showError("Focus a terminal first — snippets are typed into the focused pane.");
        return;
      }
      const body = displaySnippet(snippet.text);
      const send = () => {
        if (pane.sendText(snippet.text)) pane.flashNotice(`[sent: ${snippet.name}]`);
        else showError(`“${snippet.name}” was not sent — that pane has no live terminal.`);
      };
      const lines = body ? body.split("\n").length : 0;
      if (lines > 1) {
        pane.confirmAction(
          `Run “${snippet.name}” (${lines} lines) in ${pane.displayName()}?`,
          async () => send(),
          "Run",
        );
        return;
      }
      send();
    },
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
    // Returns null on success, or a human-readable problem string. Both the
    // validation message and a failed PUT used to vanish: the caller saw
    // nothing, and a rejected save still left the app pointing at a workspace
    // that was never written.
    saveWorkspace: async (name) => {
      const cleanName = (name || "").trim();
      const problem = app.validateWorkspaceName(cleanName);
      if (problem) return problem;
      // Naming is the only way to create a workspace, so this always promotes
      // the current (scratch) layout IN PLACE: every session moves into the
      // named workspace and the disposable "scratch" is cleared — no terminal
      // is killed, and scratch never lingers beside the workspace it became.
      const promotingScratchWs = currentWorkspace === SCRATCH_WS;
      const previousWorkspace = currentWorkspace;
      const previousWorkspaceIds = new Set(workspaceSessionIds);
      const previousScratchIds = new Set(scratchSessionIds);
      if (!currentWorkspace) {
        // Never-adopted scratch: promote its background sessions too.
        workspaceSessionIds = new Set(scratchSessionIds);
        scratchSessionIds.clear();
      }
      for (const sid of app.attachedSessionIds()) workspaceSessionIds.add(sid);
      clearTimeout(workspaceSaveTimer);
      currentWorkspace = cleanName;
      rememberWorkspace(cleanName);
      try {
        await workspace.save(cleanName, layout.serialize(), workspaceLogo, [...ownedSessionIds()]);
      } catch (error) {
        currentWorkspace = previousWorkspace;
        workspaceSessionIds = previousWorkspaceIds;
        scratchSessionIds.clear();
        for (const sid of previousScratchIds) scratchSessionIds.add(sid);
        rememberWorkspace(previousWorkspace);
        const message = error?.detail || `Could not save “${cleanName}” — nothing was changed.`;
        showError(message);
        return message;
      }
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
      clearError();
      buildLauncher();
      refreshStatusSoon();
      return null;
    },
    loadWorkspace: (name) => switchWorkspace(name),
    // Deleting a workspace never touches the current layout: the server only
    // kills sessions nobody is attached to, and deleting the workspace you're
    // in simply turns the live layout into a scratch layout in place.
    deleteWorkspace: async (name) => {
      try {
        await api.deleteWorkspace(name);
      } catch (_) {
        showError(`Could not delete workspace “${name}”.`);
        return false;
      }
      const deletingCurrent = currentWorkspace === name;
      if (deletingCurrent) {
        clearTimeout(workspaceSaveTimer);
        currentWorkspace = null;
        workspaceLogo = null;
        rememberWorkspace(null);
        for (const sid of workspaceSessionIds) scratchSessionIds.add(sid);
        workspaceSessionIds = new Set();
      }
      workspaceNames = workspaceNames.filter((item) => item !== name);
      buildLauncher();
      refreshStatusSoon();
      scheduleWorkspaceSave(); // live layout continues as scratch
      return true;
    },
    onWorkspacesChanged: async () => {
      workspaceNames = await api.listWorkspaces().catch(() => workspaceNames);
      buildLauncher();
    },
    currentWorkspace: () => currentWorkspace,
    // Set when RegisterHotKey failed at startup (another program owns the
    // combination). Settings renders it next to the field.
    hotkeyError: () => cfg.hotkey_error || null,
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
    refocusTerm: () => {
      if (!layout.focused) return false;
      layout.focused.setFocused(true);
      return true;
    },
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
      layout.setFontFamily(fresh.font_family || "JetBrains Mono");
      setFontSize(fresh.font_size, false);
      buildLauncher();
    },
  };

  const palette = new Palette(app);
  panels = new Panels(app);
  app.openPanel = (name) => { closeQuickSettings(); panels.show(name); };
  $("sb-shortcuts").addEventListener("click", () => {
    closeQuickSettings();
    panels.close();
    palette.toggle();
  });
  $("app-error-close").addEventListener("click", () => {
    clearError();
    app.refocusTerm();
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
    updateQuickSettings();
  }
  app.setFontSize = setFontSize;
  app.fontSize = () => fontSize;

  // Pane-first is the least surprising developer default: changing text size
  // in one terminal should not reflow every other running terminal.  "All
  // panes" remains one click away and persists the default for new panes.
  let fontScope = "pane";
  const quickSettings = $("quick-settings");
  const quickButton = $("sb-quick");

  function scopedFontSize() {
    return fontScope === "pane" && layout.focused ? layout.focused.fontSize : fontSize;
  }

  function updateQuickSettings() {
    const value = clampFont(scopedFontSize());
    const paneScope = fontScope === "pane" && Boolean(layout.focused);
    const statusValue = $("sb-font-size");
    if (statusValue) statusValue.textContent = `${value} px · ${paneScope ? "pane" : "all"}`;
    const output = $("quick-font-value");
    if (!output) return;
    output.textContent = `${value} px`;
    $("quick-font-smaller").disabled = value <= MIN_FONT;
    $("quick-font-bigger").disabled = value >= MAX_FONT;
    $("quick-scope-pane").classList.toggle("active", paneScope);
    $("quick-scope-pane").setAttribute("aria-pressed", String(paneScope));
    $("quick-scope-all").classList.toggle("active", !paneScope);
    $("quick-scope-all").setAttribute("aria-pressed", String(!paneScope));
    $("quick-scope-hint").textContent = paneScope
      ? "This pane only; its size resets when the view is recreated."
      : "All panes and the saved default for new terminals.";
    $("quick-focus").textContent = layout.zoomed ? "Show all panes" : "Focus this pane";
    const canWidth = layout.canResizeFocused("h");
    const canHeight = layout.canResizeFocused("v");
    $("quick-width-smaller").disabled = !canWidth;
    $("quick-width-bigger").disabled = !canWidth;
    $("quick-height-smaller").disabled = !canHeight;
    $("quick-height-bigger").disabled = !canHeight;
    $("quick-pane-balance").disabled = !canWidth && !canHeight;
  }

  function setFontScope(scope) {
    fontScope = scope === "pane" && layout.focused ? "pane" : "all";
    // Switching back to All intentionally clears temporary per-pane
    // overrides so the value shown here matches every terminal immediately.
    if (fontScope === "all") layout.setFontSize(fontSize);
    updateQuickSettings();
  }

  function setScopedFontSize(px) {
    const next = clampFont(px);
    if (fontScope === "pane" && layout.focused) {
      layout.focused.setFontSize(next);
      layout.focused.flashNotice(`[font ${next}px · this pane]`);
      updateQuickSettings();
      return;
    }
    setFontSize(next);
    if (layout.focused) layout.focused.flashNotice(`[font ${next}px · all panes]`);
  }

  function resetScopedFontSize() {
    setScopedFontSize(fontScope === "pane" ? fontSize : DEFAULT_FONT);
  }

  app.fontBigger = () => setScopedFontSize(scopedFontSize() + 1);
  app.fontSmaller = () => setScopedFontSize(scopedFontSize() - 1);
  app.fontReset = resetScopedFontSize;
  app.resizeFocused = (axis, amount) => layout.adjustFocusedSize(axis, amount);
  app.balanceFocused = () => layout.balanceFocusedSplit();

  function closeQuickSettings(restoreButton = false) {
    quickSettings.hidden = true;
    quickButton.setAttribute("aria-expanded", "false");
    if (restoreButton) quickButton.focus();
  }

  function toggleQuickSettings() {
    const opening = quickSettings.hidden;
    if (!opening) { closeQuickSettings(true); return; }
    palette.close();
    panels.close();
    document.dispatchEvent(new CustomEvent("quickterm:close-dropdowns"));
    quickSettings.hidden = false;
    quickButton.setAttribute("aria-expanded", "true");
    updateQuickSettings();
    $("quick-font-smaller").focus();
  }

  quickButton.addEventListener("click", toggleQuickSettings);
  $("quick-close").addEventListener("click", () => closeQuickSettings(true));
  $("quick-scope-pane").addEventListener("click", () => setFontScope("pane"));
  $("quick-scope-all").addEventListener("click", () => setFontScope("all"));
  $("quick-font-smaller").addEventListener("click", () => setScopedFontSize(scopedFontSize() - 1));
  $("quick-font-bigger").addEventListener("click", () => setScopedFontSize(scopedFontSize() + 1));
  $("quick-font-reset").addEventListener("click", resetScopedFontSize);
  const resizeFocused = (axis, amount) => { layout.adjustFocusedSize(axis, amount); updateQuickSettings(); };
  $("quick-width-smaller").addEventListener("click", () => resizeFocused("h", -0.05));
  $("quick-width-bigger").addEventListener("click", () => resizeFocused("h", 0.05));
  $("quick-height-smaller").addEventListener("click", () => resizeFocused("v", -0.05));
  $("quick-height-bigger").addEventListener("click", () => resizeFocused("v", 0.05));
  $("quick-pane-balance").addEventListener("click", () => { layout.balanceFocusedSplit(); updateQuickSettings(); });
  $("quick-focus").addEventListener("click", () => { layout.toggleZoom(); updateQuickSettings(); });
  $("quick-full-settings").addEventListener("click", () => { closeQuickSettings(true); panels.show("settings"); });
  document.addEventListener("mousedown", (event) => {
    if (!quickSettings.hidden && !quickSettings.contains(event.target) && !quickButton.contains(event.target)) closeQuickSettings();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !quickSettings.hidden) {
      event.preventDefault();
      event.stopPropagation();
      closeQuickSettings(true);
    }
  }, true);
  updateQuickSettings();

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
    const nav = document.querySelector(".sidebar-footer");
    if (!nav || nav.querySelector(".update-pill")) return;
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "sidebar-action sidebar-nav-button update-pill";
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
    togglePalette: () => { closeQuickSettings(); panels.close(); palette.toggle(); },
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
    killSession: app.killFocusedSession,
    focusDir: (direction) => layout.focusDir(direction),
    fontBigger: () => setScopedFontSize(scopedFontSize() + 1),
    fontSmaller: () => setScopedFontSize(scopedFontSize() - 1),
    fontReset: resetScopedFontSize,
  });

  function buildLauncher() {
    launcherView = initLauncher($("launcher"), {
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
      onLaunchComplete: () => layout.focused?.focusSoon(),
      onElevateProfile: elevateProfile,
      onElevateSystem: elevateSystemTerminal,
      onWorkspace: switchWorkspace,
      onNewScratch: newScratchWorkspace,
      onFocusSession: (sessionId) => {
        const pane = layout.panes().find((item) => item.session?.id === sessionId);
        if (pane) layout.focusPane(pane);
      },
      onAttachSession: attachSession,
      onSidebarResize: () => setTimeout(() => layout.fitAll(), 160),
      sessions: lastSessions,
      attachedSessionIds: app.attachedSessionIds(),
      ownedSessionIds: app.ownedSessionIds(),
      elevated: Boolean(cfg.elevated),
      // One entry point each. The palette already has a permanent trigger in
      // the status bar (#sb-shortcuts) plus Alt+K, and the Dashboard used to
      // sit here AND directly above as "Manage workspaces" — pixel-identical
      // once the sidebar is collapsed.
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
    if (document.hidden) return;
    api.getSessions({ metrics: false }).then((list) => {
      lastSessions = list;
      const owned = new Set(app.ownedSessionIds());
      const attached = new Set(app.attachedSessionIds());
      const liveOwned = list.filter((session) => session.alive && owned.has(session.id));
      const visible = liveOwned.filter((session) => attached.has(session.id)).length;
      const detached = liveOwned.filter((session) => !attached.has(session.id)).length;
      const workspaceLabel = detached
        ? `${visible} open · ${detached} background`
        : `${visible} open`;
      const totalLive = list.filter((session) => session.alive).length;
      const countLabel = totalLive === liveOwned.length
        ? workspaceLabel
        : `${workspaceLabel} · ${totalLive} total`;
      $("sb-sessions").textContent = countLabel;
      launcherView?.updateSessions(list, [...attached], [...owned]);
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
    launchLoopStopped = true;
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
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshStatus();
      layout.fitAll();
    }
  });

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
  // Do not sweep unknown sessions here: backend autostart profiles exist
  // before this window and intentionally have no saved workspace yet. The
  // backend idle reaper already removes only safe, untouched, non-busy shells.
  transitioning = false;
  buildLauncher();
  refreshStatus();
  claimLaunchLoop();
  scheduleWorkspaceSave();
}

boot();
