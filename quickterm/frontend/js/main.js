import * as api from "./api.js";
import { LayoutManager } from "./layout.js";
import { Palette } from "./palette.js";
import { Panels } from "./panels.js";
import { initLauncher } from "./launcher.js";
import { initKeys } from "./keys.js";
import { applyChromeTheme, getTheme } from "./themes.js";
import * as workspace from "./workspace.js";
import { displaySnippet, sessionAlreadyGone } from "./panel_shared.js";
import { normalClaudeSplitMode, splitDirectory } from "./split_policy.js";
import { claimFocus, releaseFocus, terminalMayFocus } from "./focus.js";
import {
  claimOutcome, claimRefusalMessage, conflictHolder, describeHolder, newWindowUrl,
  normalizeWindows, windowChoiceMessage, windowChoices, workspaceHolder,
} from "./windows.js";

document.title = "QuickTerm";

const $ = (id) => document.getElementById(id);
const ACTIVE_WORKSPACE_KEY = "quickterm.activeWorkspace";
const SCRATCH_ACTIVE_KEY = "quickterm.scratchActive";
const SCRATCH_WS = "scratch";
const WINDOW_ID_KEY = "qt.windowId";
// Well inside whatever the registry uses to expire a silent window: a missed
// beat must never look like a crashed window, because expiry is what hands this
// window's workspace to someone else.
const WINDOW_HEARTBEAT_MS = 5000;

function storedWorkspace() {
  try { return localStorage.getItem(ACTIVE_WORKSPACE_KEY); } catch (_) { return null; }
}

function storedScratchActive() {
  try { return localStorage.getItem(SCRATCH_ACTIVE_KEY) === "1"; } catch (_) { return false; }
}

// The remembered workspace and "scratch is the current one" are two different
// facts. Writing "scratch" into the durable key erased the user's real last
// workspace, and the backend deletes the scratch file at startup, so nothing
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

// Who this window is, from the launch URL app.py built (`_window_url`).
//
// `window` is the id the desktop shell already assigned: it must be reused when
// registering, because that is the id the shell forgets when the native window
// closes, and a registration under any other id would keep the workspace
// claimed until the heartbeat expired. `primary` marks the one window the
// Explorer handoff and the summon hotkey aim at.
//
// `workspace` is three-valued, like `path` on the workspace PUT. A name is an
// instruction. Absent normally means "restore what you remember", which is what
// the primary window and a plain browser tab want. Absent in a *secondary*
// shell window means scratch: that window was asked for a scratch window, and
// localStorage is shared across every window on this origin, so restoring the
// remembered workspace there would collide with the window that opened it. The
// browser fallback says the same thing explicitly with an empty value.
function captureWindowIdentity() {
  try {
    const params = new URLSearchParams(location.search);
    const id = params.get("window") || null;
    const primary = params.get("primary") === "1";
    const raw = params.get("workspace");
    const workspace = raw === null
      ? (id && !primary ? null : undefined)
      : (raw || null);
    return { id, primary, workspace };
  } catch (_) { return { id: null, primary: false, workspace: undefined }; }
}

// sessionStorage is per window and survives a reload, so a reloaded window asks
// the registry for the id it just had. Its release on pagehide and its new
// claim are then two facts about the same window instead of a race between a
// dying one and a new one over the same workspace.
function rememberedWindowId() {
  try { return sessionStorage.getItem(WINDOW_ID_KEY) || null; } catch (_) { return null; }
}

function rememberWindowId(id) {
  try { sessionStorage.setItem(WINDOW_ID_KEY, id); } catch (_) { /* storage may be disabled */ }
}

async function boot() {
  const openDir = captureOpenDir();
  const identity = captureWindowIdentity();
  const requestedWorkspace = identity.workspace;
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
  // This window's identity in the registry, and the workspace it is allowed to
  // own. Declared before the workspace is resolved because resolving it is
  // already a claim decision.
  let windowId = null;
  let claimedWorkspace = null;
  let registryAvailable = true;
  let windowHeartbeatTimer = null;
  // Exactly one live window is primary, and the registry promotes the oldest
  // survivor when it closes, so this is read back from the registry rather than
  // trusted from the launch URL for the rest of the run.
  let windowIsPrimary = identity.primary;

  const remembered = storedWorkspace();
  let currentWorkspace = null;
  if (requestedWorkspace !== undefined) {
    // Opened by another window: the URL is the instruction and shared
    // localStorage is not consulted at all.
    currentWorkspace = requestedWorkspace && workspaceNames.includes(requestedWorkspace)
      ? requestedWorkspace
      : null;
  } else if (storedScratchActive() && workspaceNames.includes(SCRATCH_WS)) currentWorkspace = SCRATCH_WS;
  else if (remembered && workspaceNames.includes(remembered)) currentWorkspace = remembered;
  // Only a window that resolved its own workspace may rewrite the shared
  // memory of which one that is. A second window landing on scratch must not
  // erase the first window's last real workspace.
  if (!currentWorkspace && requestedWorkspace === undefined) rememberWorkspace(null);
  // "Open QuickTerm here" opens this window as a scratch window whose first
  // terminal starts in the given folder, regardless of any remembered
  // workspace. Decided here rather than just before the restore, so this window
  // never claims a workspace it is not going to open.
  if (openDir) currentWorkspace = null;

  // Claim before restoring, never after. This window autosaves the layout on
  // every pane change, so restoring a workspace another window holds would
  // start overwriting its file within the first second, before anyone could
  // read a warning. A refused claim drops this window into scratch and says so.
  await acquireWindowId();
  const refusal = await claimWorkspaceFor(currentWorkspace);
  if (refusal) {
    // The remembered name is deliberately left alone: the workspace is not
    // lost, it is busy, and it must come back the next time this window is the
    // only one on it.
    currentWorkspace = null;
    showError(refusal);
  }
  startWindowHeartbeat();

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
  // A workspace is a folder: this is the root every session it owns starts in.
  // null means "no folder chosen": the backend falls back to the profile's own
  // directory and finally the home folder.
  let workspacePath = null;
  let workspacePathExists = true;
  // Scratch is disposable, so its terminals start in a disposable folder
  // instead of the user's home directory. Re-read whenever settings are saved,
  // because scratch_dir is configurable.
  let scratchRoot = cfg.scratch_dir || null;
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
  // choice, not "unset". Falling through to profiles[0] made that option a
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

  // Where a new terminal should start when the caller has no directory of its
  // own. Inside a named workspace the answer is "let the backend resolve the
  // workspace folder"; in scratch it is the disposable scratch folder; a
  // profile pinned to a fixed folder always keeps it.
  // Profiles carry no folder, so there is nothing here to defer to: an
  // explicit directory wins, scratch supplies its own throwaway root, and a
  // named workspace is resolved by the backend from its stored path.
  function contextCwd(explicit) {
    if (explicit) return explicit;
    if (!currentWorkspace || currentWorkspace === SCRATCH_WS) return scratchRoot || null;
    return null;
  }

  // The workspace folder only counts if it is still there; a deleted folder
  // must fall back instead of failing every spawn.
  function usableWorkspacePath() {
    return workspacePath && workspacePathExists ? workspacePath : null;
  }

  // What to pre-fill when the user names a workspace. The folder the focused
  // terminal is actually in is the best answer: a scratch shell the user cd'd
  // into their project names that project. The disposable scratch root is
  // never suggested: pinning a saved workspace to a temp folder is exactly the
  // mistake this box exists to prevent.
  function suggestedWorkspaceFolder() {
    const paneCwd = layout.focused?.bestKnownCwd?.() || null;
    if (paneCwd && paneCwd !== scratchRoot) return paneCwd;
    if (currentWorkspace && currentWorkspace !== SCRATCH_WS) return workspacePath;
    return null;
  }

  function profileByName(name) {
    return profiles.find((profile) => profile.name === name) || null;
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
      // The backend resolves the workspace folder, so its answer, not the
      // hint we sent, is what this pane actually opened in.
      pane.setLaunchCwd(info.cwd || cwd || profileByName(profileName)?.cwd || null);
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
      pane.setLaunchCwd(info.cwd || launchSpec.cwd);
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
        return spawnInto(pane, selectedTerminal.profile.name, contextCwd(cwdOverride));
      }
      return spawnSpecInto(pane, {
        cmd: selectedTerminal.cmd,
        args: selectedTerminal.args || [],
        cwd: contextCwd(cwdOverride),
        name: selectedTerminal.label,
        terminalType: selectedTerminal.id,
      });
    }
    const profile = defaultProfile();
    if (profile) return spawnInto(pane, profile.name, contextCwd(cwdOverride));
    const system = defaultSystemSpec();
    if (system) return spawnSpecInto(pane, { ...system, cwd: contextCwd(cwdOverride) });
    pane.showNotice("[no shell found, add one in settings]");
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
        return spawnInto(pane, profile.name, contextCwd(cwd), { claudeMode });
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
      return spawnInto(pane, profile.name, contextCwd(splitCwd(source, choice)), {
        claudeMode: normalClaudeSplitMode(profile),
      });
    }
    const system = defaultSystemSpec();
    if (!system) return spawnDefaultInto(pane);
    const choice = { kind: "system", id: system.terminalType, ...system };
    return spawnSpecInto(pane, { ...system, cwd: contextCwd(splitCwd(source, choice)) });
  }

  async function runProfile(profile) {
    let pane = layout.focused || layout.init();
    if (!pane.canReplace) pane = layout.splitPane(pane, autoDir(pane));
    if (!pane) return;
    layout.focusPane(pane);
    await spawnInto(pane, profile.name, contextCwd(null));
  }

  async function runClaudeMode(profile, claudeMode) {
    let pane = layout.focused || layout.init();
    if (!pane.canReplace) pane = layout.splitPane(pane, autoDir(pane));
    if (!pane) return;
    layout.focusPane(pane);
    await spawnInto(pane, profile.name, contextCwd(null), { claudeMode });
  }

  async function splitClaudeAgentView(profile) {
    const source = layout.focused || layout.init();
    const pane = layout.splitPane(source, autoDir(source));
    if (!pane) return null;
    layout.focusPane(pane);
    return spawnInto(pane, profile.name, contextCwd(null), { claudeMode: "agents" });
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
    return elevate(
      { profile: profile.name, workspace: spawnWorkspaceTag() },
      profile.name,
    );
  }

  function elevateSystemTerminal(system) {
    return elevate({
      cmd: system.cmd,
      args: system.args || [],
      name: system.label,
      cwd: contextCwd(null) || undefined,
      workspace: spawnWorkspaceTag(),
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
      showError(`That terminal belongs to workspace “${info.workspace}”. Use “Move here & attach”.`);
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
        workspacePath,
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

  // The single visible failure path: a dismissible banner above the status
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

  // ---- this window in the registry ---------------------------------------
  //
  // The invariant: two windows must never own the same workspace, because both
  // of them autosave the whole layout on every pane change and the loser's
  // panes disappear without a trace. Every path that changes what this window
  // owns goes through claimWorkspaceFor().

  // The id in the launch URL wins: app.py's viewer bookkeeping forgets a window
  // by exactly that id when its native shell closes, so registering under any
  // other one would leave the workspace claimed until the heartbeat expired.
  // The remembered id is the fallback for a plain browser tab, where a reload
  // otherwise looks like a second window fighting its own claim.
  //
  // No workspace key: registering is also how a reloaded page says hello, and
  // an omitted key preserves the claim it already holds instead of dropping it
  // for the moment it takes to ask for it back.
  async function acquireWindowId() {
    try {
      const info = await api.registerWindow({
        id: identity.id || rememberedWindowId(),
        primary: identity.primary,
      });
      windowId = info && info.id ? String(info.id) : null;
      registryAvailable = Boolean(windowId);
      if (info && "primary" in info) windowIsPrimary = Boolean(info.primary);
      if (windowId) rememberWindowId(windowId);
    } catch (_) {
      // An older backend without the registry, one still starting up, or the
      // window cap. The app is fully usable without it; only the guarantee is
      // missing, and pretending otherwise would be the worse failure.
      windowId = null;
      registryAvailable = false;
    }
    return windowId;
  }

  async function listWindowsSafe() {
    try {
      const list = normalizeWindows(await api.listWindows());
      registryAvailable = true;
      return list;
    } catch (_) {
      registryAvailable = false;
      return [];
    }
  }

  // Returns null when this window may own `name` (and now does), or the message
  // to show when it may not. `name` null means scratch, which is nobody's:
  // an unadopted scratch layout has no file to overwrite.
  //
  // A registry that cannot answer degrades to "carry on": blocking the user out
  // of their own workspace because a route 404'd is a worse failure than the
  // one being prevented. It never degrades to pretending the claim worked,
  // which is why claimedWorkspace stays null on that path.
  async function claimWorkspaceFor(name) {
    if (!windowId) {
      claimedWorkspace = null;
      return null;
    }
    try {
      if (!name) {
        await api.releaseWindowWorkspace(windowId);
        claimedWorkspace = null;
        return null;
      }
      await api.claimWindowWorkspace(windowId, name);
      claimedWorkspace = name;
      return null;
    } catch (error) {
      claimedWorkspace = null;
      if (claimOutcome(error) === "unavailable") {
        registryAvailable = false;
        return null;
      }
      // Refused. The 409 body names the window that holds it, so "taken" is
      // actionable; the registry listing is only the fallback.
      const holder = conflictHolder(error)
        || workspaceHolder(await listWindowsSafe(), windowId, name);
      return claimRefusalMessage(name, holder);
    }
  }

  // The registry expires a window that stops answering; that is how a crashed
  // or force-killed window lets go of its workspace. It answers a beat from an
  // expired window with 404 rather than reviving it silently, and that 404 is
  // the one heartbeat failure that matters: this window is autosaving a
  // workspace it no longer owns.
  function startWindowHeartbeat() {
    if (!windowId || windowHeartbeatTimer) return;
    windowHeartbeatTimer = setInterval(() => {
      api.heartbeatWindow(windowId).then(
        (info) => {
          registryAvailable = true;
          if (info && "primary" in info) windowIsPrimary = Boolean(info.primary);
        },
        (error) => { if (error?.status === 404) recoverWindowRegistration(); },
      );
    }, WINDOW_HEARTBEAT_MS);
  }

  // Say hello again and ask for the same workspace back. If it has been taken
  // in the meantime this window must stop owning it, and it lets go the same
  // way deleting the current workspace already does: the layout and every
  // terminal in it stay exactly as they are and carry on as an unnamed scratch
  // layout. Nothing is killed, nothing is saved over.
  async function recoverWindowRegistration() {
    const wanted = currentWorkspace;
    let refused = null;
    try {
      const info = await api.registerWindow({
        id: windowId,
        workspace: wanted || null,
        primary: identity.primary,
      });
      if (info && info.id) {
        windowId = String(info.id);
        rememberWindowId(windowId);
        if ("primary" in info) windowIsPrimary = Boolean(info.primary);
      }
      claimedWorkspace = wanted || null;
      registryAvailable = true;
      return;
    } catch (error) {
      claimedWorkspace = null;
      if (claimOutcome(error) !== "refused") {
        registryAvailable = false;
        return;
      }
      refused = `“${wanted}” was taken over by ${describeHolder(conflictHolder(error))} `
        + "while this window was unreachable. Nothing here was closed: your terminals "
        + "keep running and this layout carries on as an unnamed scratch layout.";
    }
    clearTimeout(workspaceSaveTimer);
    for (const sid of workspaceSessionIds) scratchSessionIds.add(sid);
    workspaceSessionIds = new Set();
    currentWorkspace = null;
    showError(refused);
    buildLauncher();
    refreshStatusSoon();
  }

  // Opening a window is the desktop shell's job: it owns the native window and
  // knows the launch URL, token fragment included. The backend route is for a
  // viewer that is not the shell but is talking to a backend that has one. A
  // plain browser window is the last resort, so the button is never dead.
  async function openNewWindow(name) {
    const target = name || null;
    const bridge = globalThis.pywebview?.api?.open_window;
    if (typeof bridge === "function") {
      // The bridge never rejects: a refusal is ordinary, so it answers
      // {opened:false, error}. Only "unavailable" means "there is no shell
      // here, ask someone else"; every other error is this window's answer.
      const result = await bridge(target || "", "").catch(() => null);
      if (result && result.opened) return true;
      if (result && result.error === "workspace_claimed") {
        // The bridge answers with the owner's id; the listing turns it into
        // something the user can point at.
        const holder = (await listWindowsSafe()).find((entry) => entry.id === result.owner) || null;
        showError(claimRefusalMessageForOpen(target, holder));
        return false;
      }
      if (result && result.error && result.error !== "unavailable") {
        showError(result.detail || "Could not open a second window.");
        return false;
      }
    }
    try {
      const result = await api.requestWindow({ workspace: target });
      if (result && result.opened) return true;
    } catch (error) {
      if (claimOutcome(error) === "refused") {
        showError(claimRefusalMessageForOpen(target, conflictHolder(error)));
        return false;
      }
      // Anything else means no shell answered, which is exactly what a plain
      // browser looks like. Fall through rather than leave a dead button.
    }
    const opened = window.open(
      newWindowUrl(location.pathname, target, api.token()),
      "_blank",
      "noopener",
    );
    if (!opened) {
      showError("Could not open a second window. Your browser blocked the pop-up.");
      return false;
    }
    return true;
  }

  // Same refusal, different consequence: nothing was switched here, the second
  // window simply did not open.
  function claimRefusalMessageForOpen(name, holder) {
    return `“${name}” is already open in ${describeHolder(holder)}, `
      + "so no second window was opened. Two windows on one workspace overwrite "
      + "each other's saved layout.";
  }

  // Tear down the current scratch layout before leaving it: scratch is
  // disposable, so its sessions are killed and its file dropped. Handles both
  // pre-adoption scratch (tracked in scratchSessionIds) and the adopted
  // "scratch" workspace (whose sessions are the live layout's).
  //
  // `force` separates the two callers. Replacing scratch on purpose is
  // confirmed by the user first (newScratchWorkspace names what will die), so
  // it kills everything. Merely LEAVING scratch for another workspace was never
  // confirmed by anyone, and /api/sessions/cleanup kills whatever it is handed,
  // so a busy or already-used terminal is spared and left running in the
  // background instead. It shows up under "Unassigned" on the dashboard, where
  // it can be reattached or stopped deliberately. The rule is the backend's own
  // ("never expire a shell the user typed into", reap_idle), applied at the one
  // call site that was bypassing it.
  async function discardScratch({ force = false } = {}) {
    const ids = new Set(scratchSessionIds);
    scratchSessionIds.clear();
    if (currentWorkspace === SCRATCH_WS) {
      for (const sid of workspaceSessionIds) ids.add(sid);
      workspaceSessionIds.clear();
      await api.deleteWorkspace(SCRATCH_WS).catch(() => {});
    }
    if (!ids.size) return;
    let doomed = [...ids];
    if (!force) {
      const sessions = await api.getSessions().catch(() => null);
      // No answer means no proof of idleness, and an unprovable kill is the one
      // we do not make: keep them all rather than guess.
      if (!sessions) return;
      const byId = new Map(sessions.map((session) => [session.id, session]));
      doomed = doomed.filter((sid) => {
        const session = byId.get(sid);
        if (!session) return false;
        return session.busy === false && !session.touched;
      });
    }
    if (doomed.length) await api.cleanupSessions(doomed).catch(() => {});
  }

  // Ephemeral scratch: the first real keystroke in an unsaved scratch layout
  // adopts it as the workspace literally named "scratch", replacing the
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
      // The same reasoning one step earlier: the registry knows about a window
      // that has adopted scratch but has not written the file yet, so ask it
      // before taking the name. Refused means stay in pure scratch.
      if (await claimWorkspaceFor(SCRATCH_WS)) return;
      currentWorkspace = SCRATCH_WS;
      workspacePath = scratchRoot || null;
      workspacePathExists = true;
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
    if (await claimWorkspaceFor(SCRATCH_WS)) return false;
    currentWorkspace = SCRATCH_WS;
    workspacePath = scratchRoot || null;
    workspacePathExists = true;
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
    workspacePath = saved.path || null;
    workspacePathExists = saved.path ? saved.path_exists !== false : true;
    if (saved.path && saved.path_exists === false) {
      showError(`The folder for “${name}” is missing: ${saved.path}. New terminals open in your home folder until you pick another.`);
    }
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
        // With a workspace folder the root is authoritative: move the
        // workspace and every restored terminal follows it. Without one the
        // pane's own remembered directory still wins.
        await spawnInto(pane, pane.profileName, usableWorkspacePath() ? null : pane.cwd);
      } else if (pane.launchSpec) {
        await spawnSpecInto(pane, usableWorkspacePath()
          ? { ...pane.launchSpec, cwd: null }
          : pane.launchSpec);
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
    workspacePath = scratchRoot || null;
    workspacePathExists = true;
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
    // adopted currentWorkspace is the string "scratch", so the guard above
    // missed and a click on the row drawn as "current" fell through to
    // discardScratch(), killing every live scratch terminal without asking.
    // Replacing scratch is the explicit, confirmed "New scratch" action only.
    if (!name && currentWorkspace === SCRATCH_WS && !replaceScratch) return true;
    // What this call really lands on. The sidebar's scratch row passes null,
    // but an adopted scratch is a workspace file like any other and is
    // restored, not replaced; only the confirmed "New scratch" action replaces.
    const target = name
      || (!replaceScratch && workspaceNames.includes(SCRATCH_WS) ? SCRATCH_WS : null);
    // Ask the registry first, before anything is saved, discarded or torn down.
    // A refused switch must leave this window exactly where it was, with the
    // reason on screen instead of a silent no-op.
    if (target) {
      const refusal = await claimWorkspaceFor(target);
      if (refusal) {
        showError(refusal);
        return false;
      }
    }
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
          workspacePath,
        );
      } catch (_) {
        transitioning = false;
        // The claim was moved a moment ago for a switch that is not happening.
        // Put it back on the workspace this window is still sitting on.
        if (target) await claimWorkspaceFor(currentWorkspace);
        showError(`Could not save “${currentWorkspace}”. The workspace was not switched and nothing was closed.`);
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
    } else if (!replaceScratch && workspaceNames.includes(SCRATCH_WS)) {
      // Going *to* scratch. An adopted scratch is restored exactly like any
      // other workspace, terminals and all: the old code deleted the file here
      // and built an empty one, so simply navigating to scratch from another
      // workspace destroyed the scratch layout the user had left running. Only
      // the confirmed "New scratch" action below may replace it.
      currentWorkspace = SCRATCH_WS;
      rememberWorkspace(SCRATCH_WS); // scratch has its own flag, not the durable key
      const restored = await restoreWorkspace(SCRATCH_WS);
      if (!restored) opened = await startScratch(scratchCwd);
    } else {
      // Explicit replacement, or there is no adopted scratch to go back to.
      // newScratchWorkspace() has already named what dies and asked.
      if (leavingWorkspace === SCRATCH_WS) await discardScratch({ force: true });
      else if (workspaceNames.includes(SCRATCH_WS)) await api.deleteWorkspace(SCRATCH_WS).catch(() => {});
      workspaceNames = workspaceNames.filter((item) => item !== SCRATCH_WS);
      opened = await startScratch(scratchCwd);
    }
    // Sync the claim to where this window actually ended up. A window on an
    // unadopted scratch owns nothing, so the workspace it just left is free for
    // another window at once instead of after a heartbeat timeout, and a failed
    // restore that fell back to scratch does not keep holding a name.
    if (currentWorkspace !== claimedWorkspace) await claimWorkspaceFor(currentWorkspace);
    transitioning = false;
    clearError();
    buildLauncher();
    refreshStatusSoon();
    scheduleWorkspaceSave();
    return opened;
  }

  // Which scratch terminals would lose real work if scratch were replaced.
  //
  // The backend is no help here: POST /api/sessions/cleanup kills every id it
  // is handed without asking, because the "never expire a shell the user typed
  // into" rule lives in reap_idle and nowhere else. So the judgement is made
  // here, and it is made from the backend's own two facts about a session:
  // `busy` (a foreground process beyond the shell, so an ssh login, a dev
  // server or a build) and `touched` (the user has written to it at least
  // once). A pane's local `userWrote` is checked too, because a keystroke this
  // window has seen may not have reached a /api/sessions poll yet.
  //
  // Every unknown counts as at risk. A wrong "ask" costs one click; a wrong
  // kill costs whatever was running.
  async function scratchTerminalsAtRisk() {
    const panes = layout.panes().filter((pane) => pane.session && pane.state === "attached");
    if (!panes.length) return [];
    const sessions = await api.getSessions().catch(() => null);
    const byId = new Map((sessions || []).map((session) => [session.id, session]));
    const atRisk = [];
    for (const pane of panes) {
      const session = byId.get(pane.session.id);
      const busy = session ? session.busy !== false : true;
      const used = session ? Boolean(session.touched) : true;
      if (!busy && !used && !pane.userWrote) continue;
      atRisk.push({ name: pane.title || pane.session.name || pane.session.id, busy });
    }
    return atRisk;
  }

  function discardScratchWarning(atRisk) {
    const names = atRisk.slice(0, 3).map((item) => item.name).join(", ");
    const rest = atRisk.length > 3 ? ` and ${atRisk.length - 3} more` : "";
    const busy = atRisk.filter((item) => item.busy).length;
    const what = busy
      ? `${busy} of them ${busy === 1 ? "is" : "are"} still running something`
      : "you have typed in them";
    return `Discard scratch and stop ${atRisk.length} terminal${atRisk.length === 1 ? "" : "s"} (${names}${rest})? ${what[0].toUpperCase()}${what.slice(1)}.`;
  }

  // Explicit replacement of the live scratch layout. A scratch full of
  // untouched, idle shells is exactly what scratch is for, so replacing it goes
  // through without a prompt. The moment one terminal is busy or has been used,
  // the confirmation names what would be lost instead of counting panes.
  async function newScratchWorkspace() {
    if (currentWorkspace && currentWorkspace !== SCRATCH_WS) return switchWorkspace(null);
    const replace = async () => {
      // A never-adopted scratch has no workspace file, so switchWorkspace has
      // no discard branch for it and its terminals would quietly survive as
      // background shells although this action just said it would stop them.
      if (!currentWorkspace) await discardScratch({ force: true });
      return switchWorkspace(null, null, { replaceScratch: true });
    };
    const atRisk = await scratchTerminalsAtRisk();
    if (!atRisk.length) return replace();
    const pane = layout.focused || layout.panes()[0];
    if (!pane) return replace();
    pane.confirmAction(discardScratchWarning(atRisk), replace, "Discard");
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
        // One folder, one window. The queue behind GET /api/launches/next hands
        // each launch to a single waiter, so with several windows waiting the
        // folder used to land in whichever one happened to poll first. The
        // registry already names the window this is meant for: `primary` is the
        // same window the summon hotkey raises and the one whose native title
        // hotkeys.py matches, and it is re-promoted when that window closes.
        // A window with no registry to ask still claims, because a lost folder
        // handoff is worse than an unlikely double claim.
        if (!windowIsPrimary && registryAvailable) {
          await sleep(1000);
          continue;
        }
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
            showError(`Could not open “${launch.cwd}” in a terminal. The request was dropped.`);
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
    // No path argument: the folder of a workspace we are only fixing up
    // ownership for must survive untouched.
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
    } catch (error) {
      // A session the backend has already forgotten is not a kill that failed.
      // There is no process left to protect, so remove it like any verified stop.
      if (!sessionAlreadyGone(error)) {
        showError("Could not stop that terminal. It is still running.");
        return false;
      }
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
        let forgotten = false;
        try {
          await api.retainSession(session.id);
        } catch (error) {
          // Nothing to retain once the backend has dropped the session, and
          // closing the view is then the whole job. Any other failure means the
          // terminal may still be alive, so the pane stays visible.
          if (!sessionAlreadyGone(error)) {
            pane.flashNotice("[could not retain terminal, pane left open]");
            return;
          }
          forgotten = true;
          forgetSession(session.id);
        }
        if (!forgotten && !currentWorkspace) {
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
          try {
            await api.killSession(sessionId);
          } catch (error) {
            // Rethrowing a real failure keeps it on the confirmation bar. A
            // forgotten session must fall through and close, or the pane can
            // never be removed at all.
            if (!sessionAlreadyGone(error)) throw error;
          }
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
    // say when they went nowhere, and confirm anything multi-line first. One
    // Enter in the palette should never run three commands unannounced.
    sendSnippet: (snippet) => {
      const pane = layout.focused;
      if (!pane) {
        showError("Focus a terminal first. Snippets are typed into the focused pane.");
        return;
      }
      const body = displaySnippet(snippet.text);
      const send = () => {
        if (pane.sendText(snippet.text)) pane.flashNotice(`[sent: ${snippet.name}]`);
        else showError(`“${snippet.name}” was not sent. That pane has no live terminal.`);
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
    saveWorkspace: async (name, folderInput) => {
      const cleanName = (name || "").trim();
      const problem = app.validateWorkspaceName(cleanName);
      if (problem) return problem;
      // Naming this layout into a workspace another window already has open
      // would put two autosaving windows on one file from the next keystroke on.
      const refusal = await claimWorkspaceFor(cleanName);
      if (refusal) {
        showError(refusal);
        return refusal;
      }
      // A workspace is a folder first. An empty box falls back to a real
      // previous choice, never to the disposable scratch root.
      const folder = (folderInput || "").trim()
        || (currentWorkspace && currentWorkspace !== SCRATCH_WS ? workspacePath : null);
      // Naming is the only way to create a workspace, so this always promotes
      // the current (scratch) layout IN PLACE: every session moves into the
      // named workspace and the disposable "scratch" is cleared. No terminal
      // is killed, and scratch never lingers beside the workspace it became.
      const promotingScratchWs = currentWorkspace === SCRATCH_WS;
      const previousWorkspace = currentWorkspace;
      const previousPath = workspacePath;
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
      workspacePath = folder;
      workspacePathExists = true;
      rememberWorkspace(cleanName);
      try {
        await workspace.save(
        cleanName, layout.serialize(), workspaceLogo, [...ownedSessionIds()], folder,
      );
      } catch (error) {
        currentWorkspace = previousWorkspace;
        workspacePath = previousPath;
        workspaceSessionIds = previousWorkspaceIds;
        scratchSessionIds.clear();
        for (const sid of previousScratchIds) scratchSessionIds.add(sid);
        rememberWorkspace(previousWorkspace);
        await claimWorkspaceFor(previousWorkspace); // the rename did not happen

        const message = error?.detail || `Could not save “${cleanName}”. Nothing was changed.`;
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
      // Deleting a workspace another window has open pulls the file out from
      // under a live layout that is still autosaving into it.
      const holder = workspaceHolder(await listWindowsSafe(), windowId, name);
      if (holder) {
        showError(windowChoiceMessage({ name, taken: true, mine: false, holder })
          + " Close it there first.");
        return false;
      }
      try {
        await api.deleteWorkspace(name);
      } catch (_) {
        showError(`Could not delete workspace “${name}”.`);
        return false;
      }
      const deletingCurrent = currentWorkspace === name;
      if (deletingCurrent) {
        clearTimeout(workspaceSaveTimer);
        await claimWorkspaceFor(null); // the live layout is a scratch layout now
        currentWorkspace = null;
        workspaceLogo = null;
        workspacePath = scratchRoot || null;
        workspacePathExists = true;
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
    // Second-window support. The picker offers scratch plus every named
    // workspace, marking the ones another window already holds instead of
    // hiding them: a missing row reads as "that workspace is gone". "scratch"
    // itself is not offered by name, exactly as the sidebar does not list it;
    // the disposable scratch row is the way to open one.
    newWindowChoices: async () => windowChoices(
      workspaceNames.filter((item) => item !== SCRATCH_WS),
      await listWindowsSafe(),
      windowId,
      currentWorkspace,
    ),
    openNewWindow,
    explainWindowChoice: (row) => showError(windowChoiceMessage(row)),
    windowRegistryAvailable: () => registryAvailable,
    // Set when RegisterHotKey failed at startup (another program owns the
    // combination). Settings renders it next to the field.
    hotkeyError: () => cfg.hotkey_error || null,
    workspaceLogo: () => workspaceLogo,
    workspacePath: () => workspacePath,
    suggestedWorkspaceFolder,
    workspacePathExists: () => workspacePathExists,
    scratchRoot: () => scratchRoot,
    // Repointing a workspace at a different folder is a plain, reversible
    // edit: nothing running is touched, and the next terminal opens there.
    // Any saved workspace can be repointed from the Dashboard, not just the
    // one that happens to be open.
    setWorkspaceFolder: async (name, folder) => {
      if (!name || name === currentWorkspace) return app.setWorkspacePath(folder);
      const saved = await workspace.details(name).catch(() => null);
      if (!saved) {
        showError(`Workspace “${name}” could not be read.`);
        return false;
      }
      try {
        await workspace.save(
          name, saved.layout, saved.logo || null, [...(saved.session_ids || [])],
          (folder || "").trim() || null,
        );
      } catch (error) {
        showError(error?.detail || `That folder could not be saved for “${name}”.`);
        return false;
      }
      clearError();
      return true;
    },
    setWorkspacePath: async (folder) => {
      const next = (folder || "").trim() || null;
      if (!currentWorkspace) {
        showError("Name this workspace before giving it a folder.");
        return false;
      }
      const previous = workspacePath;
      workspacePath = next;
      workspacePathExists = true;
      try {
        await workspace.save(
          currentWorkspace, layout.serialize(), workspaceLogo, [...ownedSessionIds()], next,
        );
      } catch (error) {
        workspacePath = previous;
        showError(error?.detail || "That folder could not be saved for this workspace.");
        return false;
      }
      clearError();
      buildLauncher();
      refreshStatusSoon();
      return true;
    },
    setWorkspaceLogo: async (assetId) => {
      if (!currentWorkspace) return false;
      workspaceLogo = assetId || null;
      await workspace.save(
        currentWorkspace, layout.serialize(), workspaceLogo, [...ownedSessionIds()], workspacePath,
      );
      buildLauncher();
      return true;
    },
    attachedSessionIds: () => layout.panes()
      .filter((pane) => pane.session && pane.state === "attached")
      .map((pane) => pane.session.id),
    ownedSessionIds: () => [...ownedSessionIds()],
    refocusTerm: () => {
      if (!layout.focused) return false;
      // Report success even while an overlay holds the keyboard: the caller
      // only wants to know whether there *is* a pane to hand back to, and
      // saying "no" would send it to the fallback branch and park focus on a
      // sidebar button instead. focus.js decides when the pane actually takes
      // it; the class is set either way so the pane still reads as focused.
      layout.focused.setFocused(true);
      return true;
    },
    focusHeldByOverlay: () => !terminalMayFocus(),
    onConfigSaved: async () => {
      const [fresh, freshInventory] = await Promise.all([
        api.getConfig().catch(() => null),
        api.getTerminalOptions().catch(() => terminalInventory),
      ]);
      if (!fresh) return;
      cfg = fresh;
      scratchRoot = fresh.scratch_dir || scratchRoot;
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

  // One rule for every overlay in the app: dismissing it makes the focused
  // terminal typeable again, and the trigger is only the fallback when there is
  // no pane to go back to. Panels already worked this way; quick settings
  // parked focus on the status-bar button instead, so the next keystroke went
  // nowhere. `handBack` is false only when the caller is opening something else
  // that will claim focus for itself.
  function closeQuickSettings(handBack = false) {
    const wasOpen = !quickSettings.hidden;
    quickSettings.hidden = true;
    quickButton.setAttribute("aria-expanded", "false");
    if (wasOpen) releaseFocus("quick-settings");
    if (!handBack) return;
    if (!app.refocusTerm()) quickButton.focus();
  }

  function toggleQuickSettings() {
    const opening = quickSettings.hidden;
    if (!opening) { closeQuickSettings(true); return; }
    palette.close();
    panels.close();
    document.dispatchEvent(new CustomEvent("quickterm:close-dropdowns"));
    quickSettings.hidden = false;
    quickButton.setAttribute("aria-expanded", "true");
    // Claimed before focusing, because panels.close() above just asked the
    // focused pane to take the keyboard back on the next frame (focus.js).
    claimFocus("quick-settings");
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
    toggleDashboard: () => { closeQuickSettings(); palette.close(); panels.toggle("dashboard"); },
    toggleSettings: () => { closeQuickSettings(); palette.close(); panels.toggle("settings"); },
    toggleHelp: () => { closeQuickSettings(); palette.close(); panels.toggle("help"); },
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
      workspacePath,
      workspacePathExists,
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
      // A terminal another workspace owns is never attached by a click alone.
      // The sidebar arms a choice first; this is the explicit half of it, and
      // moveSessionHere re-checks the session is alive and takes it out of the
      // old workspace's saved ownership before attaching.
      onMoveSession: (session, fromWorkspace) => app.moveSessionHere(session, fromWorkspace),
      onSidebarResize: () => setTimeout(() => layout.fitAll(), 160),
      sessions: lastSessions,
      attachedSessionIds: app.attachedSessionIds(),
      ownedSessionIds: app.ownedSessionIds(),
      elevated: Boolean(cfg.elevated),
      // One entry point each. The palette already has a permanent trigger in
      // the status bar (#sb-shortcuts) plus Alt+K, and the Dashboard used to
      // sit here AND directly above as "Manage workspaces", pixel-identical
      // once the sidebar is collapsed.
      chrome: [
        // The discoverable half of the palette's "new window…" row. Both land
        // in the same picker, because which workspace a second window opens on
        // is a choice and the free/taken list only exists in one place. No
        // shortcut: keys.js may claim only cold Alt combos, and the letters
        // still free are readline/PSReadLine bindings the shell needs.
        ["new window", () => {
          closeQuickSettings();
          panels.close();
          palette.newWindowMode();
        }],
        ["dashboard", () => panels.toggle("dashboard"), "alt+g"],
        ["settings", () => panels.toggle("settings"), "alt+s"],
        ["help", () => panels.toggle("help"), "alt+i"],
      ],
    });
  }

  function refreshStatus() {
    const workspaceName = currentWorkspace && currentWorkspace !== "scratch"
      ? `ws ${currentWorkspace}`
      : "scratch · disposable";
    const workspaceStatus = $("sb-workspace");
    const folderLabel = workspacePath
      ? (workspacePath.split(/[\\/]+/).filter(Boolean).pop() || workspacePath)
      : "";
    // "scratch · disposable · scratch" says nothing twice.
    workspaceStatus.textContent = folderLabel && !workspaceName.includes(folderLabel)
      ? `${workspaceName} · ${folderLabel}`
      : workspaceName;
    workspaceStatus.title = workspacePath
      ? (workspacePathExists ? workspacePath : `${workspacePath} (missing)`)
      : "This workspace has no folder. Terminals open in your home folder.";
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
    clearInterval(windowHeartbeatTimer);
    // keepalive, for the same reason the layout PUT below needs it: the
    // document is going away and a normal fetch is cancelled with it, so the
    // release would never leave and this window's workspace would stay claimed
    // until the registry expired the heartbeat. That is the difference between
    // the other window opening it now and the user waiting out a timeout.
    if (windowId) {
      fetch(`/api/windows/${encodeURIComponent(windowId)}`, {
        method: "DELETE",
        headers: { ...api.authHeaders() },
        keepalive: true,
      }).catch(() => {});
    }
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

  if (currentWorkspace) {
    const restored = await restoreWorkspace(currentWorkspace);
    if (!restored) await startScratch();
  } else {
    // Boot straight into scratch without going through startScratch(): adopt
    // the scratch folder here too, or the sidebar and status bar would claim
    // scratch has no folder while its terminals open in one.
    workspacePath = scratchRoot || null;
    workspacePathExists = true;
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
