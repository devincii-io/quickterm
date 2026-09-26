// Scratch is disposable, its terminals are not. Adopting scratch on the
// first keystroke, leaving it (which spares anything busy or touched), and
// replacing it (which asks first whenever a terminal would lose real work)
// all live here, next to each other, because they are one rule.

import { SCRATCH_WS, rememberWorkspace } from "./boot_context.js";

// The confirmation names the terminals that would be stopped, not a count of
// panes, and says why they are at risk.
export function discardScratchWarning(atRisk) {
  const names = atRisk.slice(0, 3).map((item) => item.name).join(", ");
  const rest = atRisk.length > 3 ? ` and ${atRisk.length - 3} more` : "";
  const busy = atRisk.filter((item) => item.busy).length;
  const what = busy
    ? `${busy} of them ${busy === 1 ? "is" : "are"} still running something`
    : "you have typed in them";
  return `Discard scratch and stop ${atRisk.length} terminal${atRisk.length === 1 ? "" : "s"} (${names}${rest})? ${what[0].toUpperCase()}${what.slice(1)}.`;
}

export function createScratch({
  api, state, layout,
  claimWorkspaceFor, persistCurrentWorkspace, scheduleWorkspaceSave, attachedSessionIds,
  spawnDefaultInto, switchWorkspace, buildLauncher, refreshStatusSoon,
}) {
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
    const ids = new Set(state.scratchSessionIds);
    state.scratchSessionIds.clear();
    if (state.currentWorkspace === SCRATCH_WS) {
      for (const sid of state.workspaceSessionIds) ids.add(sid);
      state.workspaceSessionIds.clear();
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
    if (state.currentWorkspace || state.transitioning) return;
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
      state.currentWorkspace = SCRATCH_WS;
      state.workspacePath = state.scratchRoot || null;
      state.workspacePathExists = true;
      state.workspaceSessionIds = new Set(state.scratchSessionIds);
      for (const sid of attachedSessionIds()) state.workspaceSessionIds.add(sid);
      state.scratchSessionIds.clear(); // these sessions are workspace-managed now
      rememberWorkspace(SCRATCH_WS);
      await persistCurrentWorkspace();
      if (!state.workspaceNames.includes(SCRATCH_WS)) {
        state.workspaceNames.push(SCRATCH_WS);
        state.workspaceNames.sort((a, b) => a.localeCompare(b));
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
    if (state.currentWorkspace) return true;
    const names = await api.listWorkspaces().catch(() => []);
    if (names.includes(SCRATCH_WS)) return false;
    if (await claimWorkspaceFor(SCRATCH_WS)) return false;
    state.currentWorkspace = SCRATCH_WS;
    state.workspacePath = state.scratchRoot || null;
    state.workspacePathExists = true;
    state.workspaceSessionIds = new Set(state.scratchSessionIds);
    for (const sid of attachedSessionIds()) state.workspaceSessionIds.add(sid);
    state.scratchSessionIds.clear();
    rememberWorkspace(SCRATCH_WS);
    if (!state.workspaceNames.includes(SCRATCH_WS)) state.workspaceNames.push(SCRATCH_WS);
    state.workspaceNames.sort((a, b) => a.localeCompare(b));
    await persistCurrentWorkspace();
    buildLauncher();
    return true;
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

  // Explicit replacement of the live scratch layout. A scratch full of
  // untouched, idle shells is exactly what scratch is for, so replacing it goes
  // through without a prompt. The moment one terminal is busy or has been used,
  // the confirmation names what would be lost instead of counting panes.
  async function newScratchWorkspace() {
    if (state.currentWorkspace && state.currentWorkspace !== SCRATCH_WS) return switchWorkspace(null);
    const replace = async () => {
      // A never-adopted scratch has no workspace file, so switchWorkspace has
      // no discard branch for it and its terminals would quietly survive as
      // background shells although this action just said it would stop them.
      if (!state.currentWorkspace) await discardScratch({ force: true });
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
    if (!cwd || state.transitioning) return false;
    if (state.currentWorkspace && state.currentWorkspace !== SCRATCH_WS) {
      if (state.workspaceNames.includes(SCRATCH_WS)) {
        if (!(await switchWorkspace(SCRATCH_WS)) || state.currentWorkspace !== SCRATCH_WS) return false;
      }
      else {
        return switchWorkspace(null, cwd);
      }
    }
    let pane = layout.focused || layout.init();
    if (!pane.canReplace) pane = layout.splitPane(pane, layout.autoDir(pane));
    if (!pane) return false;
    layout.focusPane(pane);
    const started = await spawnDefaultInto(pane, cwd);
    if (!started) return false;
    scheduleWorkspaceSave();
    refreshStatusSoon();
    return true;
  }

  return {
    discardScratch,
    maybeAdoptScratch,
    ensureScratchWorkspace,
    scratchTerminalsAtRisk,
    newScratchWorkspace,
    openFolderInScratch,
  };
}
