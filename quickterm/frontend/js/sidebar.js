// The sidebar is the whole chrome. This wires launcher.js to the rest of the
// app and keeps its terminal list fresh: a full rebuild when the workspace,
// the profiles or the inventory change, a patch on every status poll.
//
// It also answers "needs you": when the terminal a person is looking at has
// attention on the server, it tells the server that terminal was seen.

import { initLauncher } from "./launcher.js";

const $ = (id) => document.getElementById(id);

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

// Whether this document itself has the keyboard. document.hasFocus() is also
// true while a tiled workspace view (an iframe inside this document) has it,
// and then the primary's own focused pane is not what the user is looking at:
// a bell there was cleared as "seen" while they typed in the other view.
export function documentHasKeyboard(doc = globalThis.document) {
  if (!doc || !doc.hasFocus()) return false;
  return doc.activeElement?.tagName !== "IFRAME";
}

// The record attachSession is handed for a finished row. It refuses an
// exited record on purpose (a stale card must not open a dead pane), but a
// finished row is an explicit request to read one: the pane attaches, the
// server serves the ring replay-only, and that replay acknowledges it.
export function finishedAttachRecord(session) {
  const { alive: _alive, ...rest } = session || {};
  return rest;
}

export function createSidebar({
  api, state, layout, app, panels, palette, viewHost, initialSessions,
  runProfile, runSystemTerminal, elevateProfile, elevateSystemTerminal, attachSession,
  switchWorkspace, newScratchWorkspace, hereState, createWorkspaceHere, openHere,
}) {
  let lastSessions = initialSessions;
  let statusTimer = null;
  let lastFocusedId = null;
  let watchingWindowFocus = false;

  // Optimistic: the row stops saying "needs you" at once. A failed POST only
  // means the next poll shows it again, which is the honest outcome.
  function markSeen(sessionId) {
    if (!sessionId) return;
    const session = (lastSessions || []).find((item) => item?.id === sessionId);
    if (session?.attention) session.attention = null;
    api.markSessionSeen(sessionId).catch(() => {});
  }

  function renderSessions() {
    state.launcherView?.updateSessions(lastSessions, [...app.attachedSessionIds()], [...app.ownedSessionIds()]);
  }

  function buildLauncher() {
    if (!watchingWindowFocus) {
      // Coming back to the window is looking at its focused terminal again.
      // Wired on the first build rather than in the factory, which must not
      // touch the page.
      watchingWindowFocus = true;
      window.addEventListener("focus", refreshStatusSoon);
    }
    viewHost()?.update();
    state.launcherView = initLauncher($("launcher"), {
      profiles: state.profiles,
      inventory: state.terminalInventory,
      workspaces: state.workspaceNames,
      currentWorkspace: state.currentWorkspace,
      workspacePath: state.workspacePath,
      workspacePathExists: state.workspacePathExists,
      selectedTerminal: state.selectedTerminal,
      defaultProfile: state.cfg.default_profile,
      onSelectTerminal: (choice) => { state.selectedTerminal = choice; },
      logoUrl: api.assetUrl(state.workspaceLogo || state.cfg.logo),
      onRunProfile: runProfile,
      onRunSystem: runSystemTerminal,
      onLaunchComplete: () => layout.focused?.focusSoon(),
      onElevateProfile: elevateProfile,
      onElevateSystem: elevateSystemTerminal,
      onWorkspace: switchWorkspace,
      onNewScratch: newScratchWorkspace,
      onNewTerminal: app.newTerminal,
      onRenameSession: (session, name) => app.renameSession(session.id, name),
      onFocusSession: (sessionId) => {
        markSeen(sessionId);
        const pane = layout.panes().find((item) => item.session?.id === sessionId);
        if (pane) layout.focusPane(pane);
      },
      onAttachSession: (session) => {
        markSeen(session?.id);
        return attachSession(session);
      },
      onOpenFinished: (session) => {
        markSeen(session?.id);
        return attachSession(finishedAttachRecord(session));
      },
      // A terminal another workspace owns is never attached by a click alone.
      // The sidebar arms a choice first; this is the explicit half of it, and
      // moveSessionHere re-checks the session is alive and takes it out of the
      // old workspace's saved ownership before attaching.
      onMoveSession: (session, fromWorkspace) => app.moveSessionHere(session, fromWorkspace),
      // Tiling: which workspaces the window already shows (with their view
      // colours), how to add one beside this view, and the "workspace here"
      // offer for the focused terminal's folder.
      shownViews: () => app.shownViews(),
      canOpenBeside: () => app.canShowWorkspaceBeside(),
      onOpenBeside: (name) => app.openWorkspaceBeside(name),
      onFocusView: (name) => app.focusShownWorkspace(name),
      workspaceRoots: () => state.workspaceRoots,
      here: hereState(),
      onWorkspaceHere: () => createWorkspaceHere(),
      onSidebarResize: () => setTimeout(() => layout.fitAll(), 160),
      onOpenFolder: openHere,
      sessions: lastSessions,
      attachedSessionIds: app.attachedSessionIds(),
      ownedSessionIds: app.ownedSessionIds(),
      elevated: Boolean(state.cfg.elevated),
      // One entry point each. The palette already has a permanent trigger in
      // the status bar (#sb-shortcuts) plus Alt+K, and the Dashboard used to
      // sit here AND directly above as "Manage workspaces", pixel-identical
      // once the sidebar is collapsed.
      chrome: [
        // Tile another workspace into this window. From inside a view this
        // still works, because the parent window does the tiling.
        ["workspace beside", () => {
          panels.close();
          palette.newWindowMode(true);
        }],
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
  }

  function refreshStatus() {
    if (document.hidden) return;
    // The focused terminal's folder changes with every cd and focus change,
    // so the "workspace here" offer is patched here, not rebuilt with the
    // sidebar.
    state.launcherView?.updateHere(hereState());
    api.getSessions({ metrics: false }).then((list) => {
      lastSessions = list;
      // layout.js calls refreshStatusSoon on every focus change, so this
      // poll is also the moment a pane that needs you gains focus.
      const focusedId = layout.focused?.session?.id || null;
      const seen = sessionToMarkSeen({
        sessions: list,
        focusedId,
        focusChanged: focusedId !== lastFocusedId,
        visible: !document.hidden,
        windowFocused: documentHasKeyboard(),
      });
      lastFocusedId = focusedId;
      if (seen) markSeen(seen);
      renderSessions();
    }).catch(() => {});
  }

  function refreshStatusSoon() {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(refreshStatus, 250);
  }

  return { buildLauncher, refreshStatus, refreshStatusSoon };
}
