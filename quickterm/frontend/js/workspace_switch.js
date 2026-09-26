// Moving this window from one workspace to another: save what is being left
// while it is still ours, claim the target, restore its layout (reattaching
// live terminals and offering recovery for dead ones), or fall back to a
// fresh scratch layout.

import { SCRATCH_WS, rememberWorkspace } from "./boot_context.js";
import { sessionIdsInLayout } from "./layout_sessions.js";
import { claudeProfileForPane, commandTerminalType } from "./spawner.js";

export function createWorkspaceSwitch({
  api, workspace, state, layout,
  claimWorkspaceFor, discardScratch, ownedSessionIds, usableWorkspacePath,
  spawnInto, spawnSpecInto, spawnDefaultInto, profileTerminalType, restartSavedPane, resumeClaudePane,
  cancelWorkspaceSave, scheduleWorkspaceSave, buildLauncher, refreshStatusSoon, showError, clearError,
}) {
  async function restoreWorkspace(name) {
    const saved = await workspace.details(name).catch(() => null);
    if (!saved || !saved.layout) return false;
    const savedLayout = saved.layout;
    state.workspaceLogo = saved.logo || null;
    state.workspacePath = saved.path || null;
    state.workspaceRoots.set(name, state.workspacePath);
    state.workspacePathExists = saved.path ? saved.path_exists !== false : true;
    if (saved.path && saved.path_exists === false) {
      showError(`The folder for "${name}" is missing: ${saved.path}. New terminals open in your home folder until you pick another.`);
    }
    const knownSessions = await api.getSessions({ metrics: false }).catch(() => []);
    const knownById = new Map(knownSessions.map((session) => [session.id, session]));
    const byId = new Map(knownSessions.filter((session) => session.alive).map((session) => [session.id, session]));
    state.workspaceSessionIds = new Set(saved.session_ids || []);
    for (const sessionId of sessionIdsInLayout(savedLayout)) {
      if (byId.has(sessionId)) state.workspaceSessionIds.add(sessionId);
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
          onResumeClaude: claudeProfileForPane(state.profiles, pane) ? () => resumeClaudePane(pane) : null,
          onPickClaude: claudeProfileForPane(state.profiles, pane) ? () => resumeClaudePane(pane, "resume") : null,
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
    state.currentWorkspace = null;
    state.workspaceLogo = null;
    state.workspacePath = state.scratchRoot || null;
    state.workspacePathExists = true;
    state.workspaceSessionIds = new Set();
    rememberWorkspace(null);
    const pane = layout.restore(null)[0];
    const started = await spawnDefaultInto(pane, cwdOverride);
    layout.focusPane(pane);
    return Boolean(started);
  }

  async function switchWorkspace(name, scratchCwd = null, { replaceScratch = false } = {}) {
    if (state.transitioning) return false;
    if ((name || null) === state.currentWorkspace) return true;
    // The scratch sidebar row reports itself as null, but once scratch has been
    // adopted currentWorkspace is the string "scratch", so the guard above
    // missed and a click on the row drawn as "current" fell through to
    // discardScratch(), killing every live scratch terminal without asking.
    // Replacing scratch is the explicit, confirmed "New scratch" action only.
    if (!name && state.currentWorkspace === SCRATCH_WS && !replaceScratch) return true;
    // What this call really lands on. The sidebar's scratch row passes null,
    // but an adopted scratch is a workspace file like any other and is
    // restored, not replaced; only the confirmed "New scratch" action replaces.
    const target = name
      || (!replaceScratch && state.workspaceNames.includes(SCRATCH_WS) ? SCRATCH_WS : null);
    const leavingWorkspace = state.currentWorkspace;
    state.transitioning = true;
    cancelWorkspaceSave();
    if (state.currentWorkspace) {
      try {
        await workspace.save(
          state.currentWorkspace,
          layout.serialize(),
          state.workspaceLogo,
          [...ownedSessionIds()],
          state.workspacePath,
        );
      } catch (_) {
        state.transitioning = false;
        showError(`Could not save "${state.currentWorkspace}". The workspace was not switched and nothing was closed.`);
        return false;
      }
    }
    if (target) {
      const refusal = await claimWorkspaceFor(target);
      if (refusal) {
        state.transitioning = false;
        showError(refusal);
        return false;
      }
    }
    if (!state.currentWorkspace && name) {
      // A never-adopted scratch has no workspace file; leaving it is the one
      // time we clean up its disposable sessions immediately.
      await discardScratch();
    }

    let opened = true;
    if (name) {
      state.currentWorkspace = name;
      rememberWorkspace(name);
      const restored = await restoreWorkspace(name);
      if (!restored) opened = await startScratch();
    } else if (!replaceScratch && state.workspaceNames.includes(SCRATCH_WS)) {
      // Going *to* scratch. An adopted scratch is restored exactly like any
      // other workspace, terminals and all: the old code deleted the file here
      // and built an empty one, so simply navigating to scratch from another
      // workspace destroyed the scratch layout the user had left running. Only
      // the confirmed "New scratch" action below may replace it.
      state.currentWorkspace = SCRATCH_WS;
      rememberWorkspace(SCRATCH_WS); // scratch has its own flag, not the durable key
      const restored = await restoreWorkspace(SCRATCH_WS);
      if (!restored) opened = await startScratch(scratchCwd);
    } else {
      // Explicit replacement, or there is no adopted scratch to go back to.
      // newScratchWorkspace() has already named what dies and asked.
      if (leavingWorkspace === SCRATCH_WS) await discardScratch({ force: true });
      else if (state.workspaceNames.includes(SCRATCH_WS)) await api.deleteWorkspace(SCRATCH_WS).catch(() => {});
      state.workspaceNames = state.workspaceNames.filter((item) => item !== SCRATCH_WS);
      opened = await startScratch(scratchCwd);
    }
    // Sync the claim to where this window actually ended up. A window on an
    // unadopted scratch owns nothing, so the workspace it just left is free for
    // another window at once instead of after a heartbeat timeout, and a failed
    // restore that fell back to scratch does not keep holding a name.
    if (state.currentWorkspace !== state.claimedWorkspace) await claimWorkspaceFor(state.currentWorkspace);
    state.transitioning = false;
    clearError();
    buildLauncher();
    refreshStatusSoon();
    scheduleWorkspaceSave();
    return opened;
  }

  return { restoreWorkspace, startScratch, switchWorkspace };
}
