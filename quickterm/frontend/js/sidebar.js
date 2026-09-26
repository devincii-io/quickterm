// The sidebar is the whole chrome. This wires launcher.js to the rest of the
// app and keeps its terminal list fresh: a full rebuild when the workspace,
// the profiles or the inventory change, a patch on every status poll.

import { initLauncher } from "./launcher.js";

const $ = (id) => document.getElementById(id);

export function createSidebar({
  api, state, layout, app, panels, palette, viewHost, initialSessions,
  runProfile, runSystemTerminal, elevateProfile, elevateSystemTerminal, attachSession,
  switchWorkspace, newScratchWorkspace, hereState, createWorkspaceHere, openHere,
}) {
  let lastSessions = initialSessions;
  let statusTimer = null;

  function buildLauncher() {
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
        const pane = layout.panes().find((item) => item.session?.id === sessionId);
        if (pane) layout.focusPane(pane);
      },
      onAttachSession: attachSession,
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
      state.launcherView?.updateSessions(list, [...app.attachedSessionIds()], [...app.ownedSessionIds()]);
    }).catch(() => {});
  }

  function refreshStatusSoon() {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(refreshStatus, 250);
  }

  return { buildLauncher, refreshStatus, refreshStatusSoon };
}
