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

export { finishedAttachRecord } from "./shell_routing.js";

const $ = (id) => document.getElementById(id);
const SIDEBAR_POLL_MS = 10000;

// Which session, if any, the user is plainly looking at and the server still
// flags. "Looking at" is the focused pane while the document is visible, and
// either the focus just moved there (the user went to it) or this window has
// the keyboard (a bell in the pane you are typing into is not news). A
// visible window behind another application is not being looked at.
export function sessionToMarkSeen({ sessions, focusedId, focusChanged, visible, windowFocused }) {
  if (!focusedId || !visible) return null;
  if (!focusChanged && !windowFocused) return null;
  const session = (sessions || []).find((item) => item?.id === focusedId);
  return session?.attention ? focusedId : null;
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
}) {
  return {
    profiles: state.profiles,
    inventory: state.terminalInventory,
    defaultProfile: state.cfg?.default_profile,
    selectedTerminal: state.selectedTerminal || null,
    logoUrl,
    workspaces: (state.workspaceNames || [])
      .filter((name) => !isScratchWorkspace(name))
      .map((name) => ({
        name,
        path: folders.get(name)?.path ?? null,
        pathExists: folders.get(name)?.pathExists ?? null,
      })),
    views: views.map(({ workspace, label, color, active }) => ({ workspace, label, color, active })),
    sessions,
    attached: { ...(context.attached || {}) },
    owned: { ...(context.owned || {}) },
    here,
  };
}

export function createSidebar({ api, state, views, actions, panels, palette, folders }) {
  let lastSessions = [];
  let statusTimer = null;
  let lastFocusedId = null;

  const activeApp = () => views.appFor(views.active);

  // Optimistic: the row stops saying "needs you" at once. A failed POST only
  // means the next poll shows it again, which is the honest outcome.
  function markSeen(sessionId) {
    if (!sessionId) return;
    const session = (lastSessions || []).find((item) => item?.id === sessionId);
    if (session?.attention) session.attention = null;
    api.markSessionSeen(sessionId).catch(() => {});
  }

  function model() {
    const app = activeApp();
    return sidebarModel({
      state,
      sessions: lastSessions,
      views: views.list(),
      context: collectViewContext(views),
      folders,
      here: app?.hereState?.() || null,
      logoUrl: api.assetUrl(app?.workspaceLogo?.() || state.cfg.logo),
    });
  }

  function render() {
    views.update();
    state.launcherView?.update(model());
  }

  // Built once per shell document. Every later change is a patch.
  function init() {
    state.launcherView = initLauncher($("launcher"), {
      actions,
      elevated: Boolean(state.cfg.elevated),
      // One entry point each. The palette already has Alt+K, and the
      // Dashboard used to sit here and directly above as "Manage
      // workspaces", pixel-identical once the sidebar is collapsed.
      chrome: [
        // The discoverable half of the palette's "new window…" row. Both land
        // in the same picker, because which workspace a second window opens on
        // is a choice and the free/taken list only exists in one place. No
        // shortcut: keys.js may claim only cold Alt combos, and the letters
        // still free are readline/PSReadLine bindings the shell needs.
        ["new window", () => {
          panels.close();
          palette.newWindowMode();
        }],
        ["dashboard", () => panels.toggle("dashboard"), "alt+g"],
        ["settings", () => panels.toggle("settings"), "alt+s"],
        ["help", () => panels.toggle("help"), "alt+i"],
      ],
    });
    // Coming back to the window is looking at its focused terminal again.
    window.addEventListener("focus", refreshSoon);
    setInterval(refreshStatus, SIDEBAR_POLL_MS);
    render();
  }

  function refreshStatus() {
    if (document.hidden) return;
    api.getSessions({ metrics: false }).then((list) => {
      lastSessions = list || [];
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

  return {
    init, render, refreshStatus, refreshSoon, markSeen,
    sessions: () => lastSessions,
    context: () => collectViewContext(views),
  };
}
