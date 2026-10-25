// The sidebar is the whole chrome, and only the shell draws it. This builds
// launcher.js once and keeps it fresh: every 10 s and whenever a view says
// something changed (`quicktermChrome.refreshSoon()`), it reads the live
// terminals, asks every view what it shows and owns, and patches the result
// in through `launcherView.update(model)`. Nothing here rebuilds the list.
//
// It also answers "needs you": when the terminal a person is looking at has
// attention on the server, it tells the server that terminal was seen.

import { initLauncher } from "./launcher.js";
import { isScratchWorkspace } from "./boot_context.js";
import { agentState, loadView, sidebarGroups, visibleGroups } from "./sidebar_model.js";
import { agentProfiles } from "./agent_profile.js";

export { finishedAttachRecord } from "./shell_routing.js";

const $ = (id) => document.getElementById(id);
const SIDEBAR_POLL_MS = 10000;
// Branches change rarely and the heads only name them, so git facts are read
// once a minute, and a moment after the workspace folders change.
const GIT_POLL_MS = 60000;
const GIT_SOON_MS = 1500;
const GIT_MAX_PATHS = 256;

// What a terminal still asks of whoever looks at it: an attention, or an
// agent turn that ended unseen. Looking at it clears both on the server.
function wantsSeen(session) {
  return Boolean(session?.attention) || ["done", "failed"].includes(agentState(session));
}

// The folders POST /api/git/info is asked about: every saved local
// workspace's, once each, at most what the route takes. A folder on an SSH
// host is not on this disk; its git facts come with the workspace record.
export function gitPaths(folders) {
  const paths = new Set();
  for (const folder of folders?.values?.() || []) if (folder?.path && !folder.host) paths.add(folder.path);
  return [...paths].slice(0, GIT_MAX_PATHS);
}

// The remote workspaces whose git facts are re-read with the local ones.
export function remoteNames(folders) {
  return [...(folders?.entries?.() || [])].filter(([, folder]) => folder?.host).map(([name]) => name);
}

// Which session, if any, the user is plainly looking at and the server still
// flags. "Looking at" is the focused pane while the document is visible, and
// either the focus just moved there (the user went to it) or this window has
// the keyboard (a bell in the pane you are typing into is not news). A
// visible window behind another application is not being looked at.
export function sessionToMarkSeen({ sessions, focusedId, focusChanged, visible, windowFocused }) {
  if (!focusedId || !visible) return null;
  if (!focusChanged && !windowFocused) return null;
  const session = (sessions || []).find((item) => item?.id === focusedId);
  return wantsSeen(session) ? focusedId : null;
}

// Whether a document that hosts terminals itself has the keyboard.
// document.hasFocus() is also true while an iframe inside it has the
// keyboard. The shell hosts no terminal, so it asks document.hasFocus()
// directly; this stays for a document that has panes of its own.
export function documentHasKeyboard(doc = globalThis.document) {
  if (!doc || !doc.hasFocus()) return false;
  return doc.activeElement?.tagName !== "IFRAME";
}

// What every open view shows and owns right now, keyed by session id. A
// pane on a terminal (`attached`) is the strongest fact; a view's in-memory
// claim (`owned`) comes next; the backend's tag is left to the reader.
export function collectViewContext(views) {
  const attached = {};
  const owned = {};
  const openWorkspaces = [];
  let activeWorkspace = null;
  for (const view of views?.views() || []) {
    const workspace = views.workspaceOf(view);
    openWorkspaces.push(workspace);
    if (view === views.active) activeWorkspace = workspace;
    const app = views.appFor(view);
    if (!app) continue;
    for (const id of app.attachedSessionIds?.() || []) attached[id] ??= workspace;
    for (const id of app.ownedSessionIds?.() || []) owned[id] ??= workspace;
  }
  return { attached, owned, openWorkspaces, activeWorkspace };
}

// The SidebarModel launcher.js draws (spec 4.2). Pure: the shell hands it
// the facts and patches the answer in.
export function sidebarModel({
  state, sessions = [], views = [], context = {}, folders = new Map(), here = null, logoUrl = null,
  git = new Map(), focusedId = null,
}) {
  return {
    profiles: state.profiles,
    inventory: state.terminalInventory,
    shell: state.cfg?.shell ?? null,
    agents: agentProfiles(state.cfg, state.terminalInventory),
    logoUrl,
    workspaces: (state.workspaceNames || [])
      .filter((name) => !isScratchWorkspace(name))
      .map((name) => ({
        name,
        path: folders.get(name)?.path ?? null,
        pathExists: folders.get(name)?.pathExists ?? null,
        host: folders.get(name)?.host ?? null,
        git: (folders.get(name)?.host ? folders.get(name)?.git : git.get(folders.get(name)?.path)) ?? null,
      })),
    views: views.map(({ workspace, label, color, active }) => ({ workspace, label, color, active })),
    sessions,
    attached: { ...(context.attached || {}) },
    owned: { ...(context.owned || {}) },
    here,
    focusedId,
  };
}

export function createSidebar({ api, state, views, actions, panels, palette, folders }) {
  let lastSessions = [];
  let statusTimer = null;
  let lastFocusedId = null;
  // Terminals killed from this window. The backend lists a killed session as
  // exited for a grace period, and once its owner is gone that row would sit
  // under "Unassigned" until the next poll; a verified kill removes it now.
  const killed = new Set();
  const visible = (list) => (list || []).filter((session) => !(killed.has(session?.id) && session.alive !== true));

  const activeApp = () => views.appFor(views.active);

  // Optimistic: the row stops saying "needs you" at once. A failed POST only
  // means the next poll shows it again, which is the honest outcome.
  function markSeen(sessionId) {
    if (!sessionId) return;
    const session = (lastSessions || []).find((item) => item?.id === sessionId);
    if (session?.attention) session.attention = null;
    if (wantsSeen(session)) session.agent = { ...session.agent, state: "idle" };
    api.markSessionSeen(sessionId).catch(() => {});
  }

  // Git facts by folder, from POST /api/git/info. Never on the boot path:
  // the folders arrive after boot, and the first read trails them.
  const git = new Map();
  let gitAsked = "";
  let gitTimer = null;
  // The backend answers a remote workspace from a cache it fills in the
  // background over ssh, so a first answer without git is asked again soon.
  let remoteRetries = 0;
  function refreshRemoteGit() {
    const names = remoteNames(folders);
    if (!names.length || typeof api.getWorkspace !== "function") return;
    Promise.all(names.map((name) => api.getWorkspace(name).then((saved) => {
      const folder = folders.get(name);
      if (folder && saved) folder.git = saved.git || null;
      return Boolean(saved?.git);
    }, () => true))).then((answered) => {
      render();
      if (answered.every(Boolean) || remoteRetries >= 3) { remoteRetries = 0; return; }
      remoteRetries += 1;
      setTimeout(refreshRemoteGit, 5000);
    });
  }
  function refreshGit() {
    clearTimeout(gitTimer);
    gitTimer = null;
    if (!document.hidden) refreshRemoteGit();
    const paths = gitPaths(folders);
    gitAsked = gitKey();
    if (!paths.length || document.hidden || typeof api.gitInfo !== "function") return;
    api.gitInfo(paths).then((answer) => {
      git.clear();
      for (const path of paths) if (answer?.[path]) git.set(path, answer[path]);
      render();
    }).catch(() => {});
  }
  const gitKey = () => [...gitPaths(folders), ...remoteNames(folders)].join("\n");
  function gitSoon() {
    if (!gitTimer && gitKey() !== gitAsked) gitTimer = setTimeout(refreshGit, GIT_SOON_MS);
  }

  function model() {
    const app = activeApp();
    return sidebarModel({
      state,
      sessions: lastSessions,
      views: views.list(),
      context: collectViewContext(views),
      folders,
      git,
      focusedId: app?.focusedSessionId?.() || null,
      here: app?.hereState?.() || null,
      logoUrl: api.assetUrl(app?.workspaceLogo?.() || state.cfg.logo),
    });
  }

  function render() {
    views.update();
    state.launcherView?.update(model());
    gitSoon();
  }

  // Built once per shell document. Every later change is a patch.
  function init() {
    state.launcherView = initLauncher($("launcher"), {
      actions: {
        // The host and folder are asked for in the palette, the one inline
        // input the chrome has.
        newRemoteWorkspace: () => {
          panels.close();
          palette.remoteWorkspaceMode?.();
        },
        ...actions,
      },
      elevated: Boolean(state.cfg.elevated),
      // One entry point each. The palette already has Alt+K, and the
      // Dashboard used to sit here and directly above as "Manage
      // workspaces", pixel-identical once the sidebar is collapsed.
      // A new window is a row of the Workspaces "+" menu and the palette's
      // "new window…", not a footer icon of its own.
      chrome: [
        ["workspace board", () => panels.toggle("dashboard"), "alt+g"],
        ["settings", () => panels.toggle("settings"), "alt+s"],
        ["help", () => panels.toggle("help"), "alt+i"],
        // Shows and hides the right panel; on while it shows (markNavToggle).
        ["right panel", () => actions.toggleRightPanel?.(), "alt+shift+e"],
      ],
    });
    // Coming back to the window is looking at its focused terminal again.
    window.addEventListener("focus", refreshSoon);
    setInterval(refreshStatus, SIDEBAR_POLL_MS);
    setInterval(refreshGit, GIT_POLL_MS);
    render();
  }

  function refreshStatus() {
    if (document.hidden) return;
    api.getSessions({ metrics: false }).then((list) => {
      const listed = new Set((list || []).map((session) => session?.id));
      for (const id of [...killed]) if (!listed.has(id)) killed.delete(id);
      lastSessions = visible(list);
      for (const view of views?.views?.() || []) views.appFor(view)?.noteSessions?.(lastSessions);
      // Views call refreshSoon on every focus change, so this poll is also
      // the moment a pane that needs you gains focus.
      const focusedId = activeApp()?.focusedSessionId?.() || null;
      const seen = sessionToMarkSeen({
        sessions: lastSessions,
        focusedId,
        focusChanged: focusedId !== lastFocusedId,
        visible: !document.hidden,
        windowFocused: document.hasFocus(),
      });
      lastFocusedId = focusedId;
      if (seen) markSeen(seen);
      render();
    }).catch(() => {});
  }

  // What changed locally (a view opened, a pane moved) is drawn at once from
  // the last answer; the live terminals follow a moment later.
  function refreshSoon() {
    render();
    clearTimeout(statusTimer);
    statusTimer = setTimeout(refreshStatus, 250);
  }

  // A verified kill: the row goes at once instead of turning into a finished
  // row for the backend's grace period.
  function forget(sessionId) {
    if (!sessionId) return;
    killed.add(sessionId);
    lastSessions = visible(lastSessions);
    render();
  }

  return {
    init, render, refreshStatus, refreshSoon, markSeen, forget,
    sessions: () => lastSessions,
    context: () => collectViewContext(views),
    // The groups as the sidebar draws them, in its order (Ctrl+Shift+1..9).
    groups: () => {
      const view = loadView();
      const now = model();
      return visibleGroups(sidebarGroups(now.sessions, { ...now, view }), view).groups;
    },
  };
}
