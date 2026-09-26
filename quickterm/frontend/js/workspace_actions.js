// Naming, saving, deleting and repointing workspaces, and moving terminals
// between them. Every path that takes a workspace name asks the window
// registry first, because two windows autosaving one file overwrite each other.

import { SCRATCH_WS, rememberWorkspace } from "./boot_context.js";
import { layoutWith, removeSessionFromLayout } from "./layout_sessions.js";
import { sessionAlreadyGone } from "./panel_shared.js";
import { describeHolder, windowChoiceMessage, workspaceHolder } from "./windows.js";

export function validateWorkspaceName(name) {
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
}

export function createWorkspaceActions({
  api, workspace, state, layout,
  claimWorkspaceFor, listWindowsSafe, switchWorkspace, ensureScratchWorkspace, attachSession, hereState,
  persistCurrentWorkspace, scheduleWorkspaceSave, cancelWorkspaceSave,
  ownedSessionIds, attachedSessionIds, forgetSession,
  refreshWorkspaceRoots, buildLauncher, refreshStatusSoon, showError, clearError,
}) {
  // Make the focused terminal's folder a workspace (or open the one it already
  // belongs to) and take the terminal along. The terminal is what the user
  // was looking at when they asked, so it leads: it is written into the
  // target's layout first, then detached here, then the window switches and
  // the restore attaches it again. Nothing is killed at any step.
  async function createWorkspaceHere() {
    const here = hereState();
    if (!here || state.transitioning) return false;
    const { folder, name } = here;
    if (here.action === "clash") {
      showError(`A workspace named “${name}” already exists with a different folder. Name this one in the Dashboard.`);
      return false;
    }
    const problem = validateWorkspaceName(name);
    if (problem) {
      showError(`“${name}” cannot be a workspace name (${problem.replace(/\.$/, "")}). Name it in the Dashboard.`);
      return false;
    }
    const holder = workspaceHolder(await listWindowsSafe(), state.windowId, name);
    if (holder) {
      showError(`“${name}” is open in ${describeHolder(holder)}. Use “move here” from that view to take this terminal along.`);
      return false;
    }
    const pane = layout.focused;
    const session = pane?.session && pane.state === "attached" ? pane.session : null;
    let saved = null;
    if (here.action === "open") {
      saved = await workspace.details(name).catch(() => null);
      if (!saved) {
        showError(`Workspace “${name}” could not be read.`);
        return false;
      }
    }
    let carried = null;
    if (session) {
      carried = { type: "pane", session_id: session.id, cwd: folder };
      if (pane.profileName) carried.profile = pane.profileName;
      if (pane.launchSpec) carried.launch_spec = pane.launchSpec;
      if (pane.title) carried.title = pane.title;
    }
    const ids = new Set(saved?.session_ids || []);
    if (session) ids.add(session.id);
    try {
      // A new workspace gets the folder; an existing one keeps its own (an
      // absent path preserves it, see PUT /api/workspaces).
      await workspace.save(name, layoutWith(saved?.layout, carried), saved?.logo || null, [...ids],
        saved ? undefined : folder);
    } catch (error) {
      showError(error?.detail || `Could not ${saved ? "update" : "create"} workspace “${name}”.`);
      return false;
    }
    if (session) {
      try {
        await api.retainSession(session.id);
      } catch (error) {
        if (!sessionAlreadyGone(error)) {
          showError("Could not detach that terminal safely. Nothing was moved.");
          return false;
        }
      }
      forgetSession(session.id);
      layout.closePane(pane, { animate: false });
    }
    if (!state.workspaceNames.includes(name)) {
      state.workspaceNames.push(name);
      state.workspaceNames.sort((a, b) => a.localeCompare(b));
    }
    state.workspaceRoots.set(name, saved ? saved.path || null : folder);
    return switchWorkspace(name);
  }

  async function removeWorkspaceOwnership(name, sessionId) {
    if (name === state.currentWorkspace) {
      state.workspaceSessionIds.delete(sessionId);
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
    if (!state.currentWorkspace && !(await ensureScratchWorkspace())) return;
    if (fromWorkspace && fromWorkspace !== state.currentWorkspace) {
      await removeWorkspaceOwnership(fromWorkspace, info.id);
    }
    state.workspaceSessionIds.add(info.id);
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

  // Returns null on success, or a human-readable problem string. Both the
  // validation message and a failed PUT used to vanish: the caller saw
  // nothing, and a rejected save still left the app pointing at a workspace
  // that was never written.
  async function saveWorkspace(name, folderInput) {
    const cleanName = (name || "").trim();
    const problem = validateWorkspaceName(cleanName);
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
      || (state.currentWorkspace && state.currentWorkspace !== SCRATCH_WS ? state.workspacePath : null);
    // Naming is the only way to create a workspace, so this always promotes
    // the current (scratch) layout IN PLACE: every session moves into the
    // named workspace and the disposable "scratch" is cleared. No terminal
    // is killed, and scratch never lingers beside the workspace it became.
    const promotingScratchWs = state.currentWorkspace === SCRATCH_WS;
    const previousWorkspace = state.currentWorkspace;
    const previousPath = state.workspacePath;
    const previousWorkspaceIds = new Set(state.workspaceSessionIds);
    const previousScratchIds = new Set(state.scratchSessionIds);
    if (!state.currentWorkspace) {
      // Never-adopted scratch: promote its background sessions too.
      state.workspaceSessionIds = new Set(state.scratchSessionIds);
      state.scratchSessionIds.clear();
    }
    for (const sid of attachedSessionIds()) state.workspaceSessionIds.add(sid);
    cancelWorkspaceSave();
    state.currentWorkspace = cleanName;
    state.workspacePath = folder;
    state.workspacePathExists = true;
    rememberWorkspace(cleanName);
    try {
      await workspace.save(
        cleanName, layout.serialize(), state.workspaceLogo, [...ownedSessionIds()], folder,
      );
    } catch (error) {
      state.currentWorkspace = previousWorkspace;
      state.workspacePath = previousPath;
      state.workspaceSessionIds = previousWorkspaceIds;
      state.scratchSessionIds.clear();
      for (const sid of previousScratchIds) state.scratchSessionIds.add(sid);
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
      state.workspaceNames = state.workspaceNames.filter((item) => item !== SCRATCH_WS);
    }
    if (!state.workspaceNames.includes(cleanName)) state.workspaceNames.push(cleanName);
    state.workspaceNames.sort((a, b) => a.localeCompare(b));
    state.workspaceRoots.set(cleanName, folder);
    clearError();
    buildLauncher();
    refreshStatusSoon();
    return null;
  }

  // Deleting a workspace never touches the current layout: the server only
  // kills sessions nobody is attached to, and deleting the workspace you're
  // in simply turns the live layout into a scratch layout in place.
  async function deleteWorkspace(name) {
    // Deleting a workspace another window has open pulls the file out from
    // under a live layout that is still autosaving into it.
    const holder = workspaceHolder(await listWindowsSafe(), state.windowId, name);
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
    const deletingCurrent = state.currentWorkspace === name;
    if (deletingCurrent) {
      cancelWorkspaceSave();
      await claimWorkspaceFor(null); // the live layout is a scratch layout now
      state.currentWorkspace = null;
      state.workspaceLogo = null;
      state.workspacePath = state.scratchRoot || null;
      state.workspacePathExists = true;
      rememberWorkspace(null);
      for (const sid of state.workspaceSessionIds) state.scratchSessionIds.add(sid);
      state.workspaceSessionIds = new Set();
    }
    state.workspaceNames = state.workspaceNames.filter((item) => item !== name);
    state.workspaceRoots.delete(name);
    buildLauncher();
    refreshStatusSoon();
    scheduleWorkspaceSave(); // live layout continues as scratch
    return true;
  }

  async function onWorkspacesChanged() {
    state.workspaceNames = await api.listWorkspaces().catch(() => state.workspaceNames);
    buildLauncher();
    refreshWorkspaceRoots();
  }

  // Repointing a workspace at a different folder is a plain, reversible
  // edit: nothing running is touched, and the next terminal opens there.
  // Any saved workspace can be repointed from the Dashboard, not just the
  // one that happens to be open.
  async function setWorkspaceFolder(name, folder) {
    if (!name || name === state.currentWorkspace) return setWorkspacePath(folder);
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
    state.workspaceRoots.set(name, (folder || "").trim() || null);
    clearError();
    return true;
  }

  async function setWorkspacePath(folder) {
    const next = (folder || "").trim() || null;
    if (!state.currentWorkspace) {
      showError("Name this workspace before giving it a folder.");
      return false;
    }
    const previous = state.workspacePath;
    state.workspacePath = next;
    state.workspacePathExists = true;
    try {
      await workspace.save(
        state.currentWorkspace, layout.serialize(), state.workspaceLogo, [...ownedSessionIds()], next,
      );
    } catch (error) {
      state.workspacePath = previous;
      showError(error?.detail || "That folder could not be saved for this workspace.");
      return false;
    }
    state.workspaceRoots.set(state.currentWorkspace, next);
    clearError();
    buildLauncher();
    refreshStatusSoon();
    return true;
  }

  async function setWorkspaceLogo(assetId) {
    if (!state.currentWorkspace) return false;
    state.workspaceLogo = assetId || null;
    await workspace.save(
      state.currentWorkspace, layout.serialize(), state.workspaceLogo, [...ownedSessionIds()], state.workspacePath,
    );
    buildLauncher();
    return true;
  }

  return {
    createWorkspaceHere,
    removeWorkspaceOwnership,
    removeSessionsFromSavedWorkspaces,
    moveSessionHere,
    killWorkspaceSession,
    saveWorkspace,
    deleteWorkspace,
    onWorkspacesChanged,
    setWorkspaceFolder,
    setWorkspacePath,
    setWorkspaceLogo,
  };
}
