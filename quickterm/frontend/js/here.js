// "Here": the folder the focused terminal is in, what opening it or naming a
// workspace after it would mean, and the saved workspaces' folders the
// sidebar compares it with.

import { SCRATCH_WS } from "./boot_context.js";

// Paths compare the way the file system does: separators unified, a
// trailing separator ignored, and case folded on Windows drives and shares.
export function pathKey(value) {
  if (!value) return "";
  let key = String(value).replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[A-Za-z]:|^\/\//.test(key)) key = key.toLowerCase();
  return key;
}
export const samePath = (a, b) => Boolean(a) && Boolean(b) && pathKey(a) === pathKey(b);
export const insidePath = (child, parent) => Boolean(child) && Boolean(parent)
  && pathKey(child).startsWith(`${pathKey(parent)}/`);
export const baseName = (value) => pathKey(value).split("/").filter(Boolean).pop() || "";

export function createHere({ api, workspace, state, layout, showError }) {
  let workspaceRootsRefresh = null;

  // Every saved workspace's folder, so the sidebar can tell whether the
  // folder the focused terminal is in already belongs to a workspace. Filled
  // off the boot path and refreshed whenever the list or a folder changes.
  function refreshWorkspaceRoots() {
    if (workspaceRootsRefresh) return workspaceRootsRefresh;
    workspaceRootsRefresh = Promise.all(state.workspaceNames.map(async (name) => {
      const saved = await workspace.details(name).catch(() => null);
      return [name, saved ? saved.path || null : null];
    })).then((entries) => {
      state.workspaceRoots.clear();
      for (const [name, root] of entries) state.workspaceRoots.set(name, root);
      state.launcherView?.updateHere(hereState());
    }).finally(() => { workspaceRootsRefresh = null; });
    return workspaceRootsRefresh;
  }

  // The workspace folder only counts if it is still there; a deleted folder
  // must fall back instead of failing every spawn.
  function usableWorkspacePath() {
    return state.workspacePath && state.workspacePathExists ? state.workspacePath : null;
  }

  // "Here" for the sidebar's folder buttons, Alt+Shift+E/C and the palette:
  // the focused terminal's current directory (OSC 7, else its launch folder),
  // else the workspace folder. Scratch resolves to its throwaway root, which
  // is the honest answer: that is where the shell is.
  function hereFolder() {
    return layout.focused?.bestKnownCwd?.() || usableWorkspacePath() || null;
  }

  async function openHere(appName) {
    const label = appName === "vscode" ? "VS Code" : "Explorer";
    const folder = hereFolder();
    if (!folder) {
      showError(`Nothing to open in ${label}: focus a terminal or give this workspace a folder.`);
      return false;
    }
    try {
      await api.openFolder(folder, appName);
      return true;
    } catch (error) {
      const why = error?.detail ? `: ${error.detail}` : "";
      showError(`Could not open ${folder} in ${label}${why}.`);
      return false;
    }
  }

  // What to pre-fill when the user names a workspace. The folder the focused
  // terminal is actually in is the best answer: a scratch shell the user cd'd
  // into their project names that project. The disposable scratch root is
  // never suggested: pinning a saved workspace to a temp folder is exactly the
  // mistake this box exists to prevent.
  function suggestedWorkspaceFolder() {
    const paneCwd = layout.focused?.bestKnownCwd?.() || null;
    if (paneCwd && paneCwd !== state.scratchRoot) return paneCwd;
    if (state.currentWorkspace && state.currentWorkspace !== SCRATCH_WS) return state.workspacePath;
    return null;
  }

  // The sidebar's "workspace here" offer. The focused terminal is somewhere
  // that is not this workspace's folder (or is in scratch), and that folder
  // either already is a workspace's root, in which case the offer is to open
  // that workspace, or is not, in which case the offer is to make it one
  // named after the folder. Inside the workspace's own tree there is no
  // offer: every `cd src` would otherwise grow a button.
  function hereState() {
    const folder = layout.focused?.bestKnownCwd?.() || null;
    if (!folder || samePath(folder, state.scratchRoot)) return null;
    const home = state.currentWorkspace && state.currentWorkspace !== SCRATCH_WS ? usableWorkspacePath() : null;
    if (home && (samePath(folder, home) || insidePath(folder, home))) return null;
    for (const [name, root] of state.workspaceRoots) {
      if (name === SCRATCH_WS || !samePath(root, folder)) continue;
      return name === state.currentWorkspace ? null : { folder, name, action: "open" };
    }
    const name = baseName(folder);
    if (!name) return null;
    return { folder, name, action: state.workspaceNames.includes(name) ? "clash" : "create" };
  }

  return {
    refreshWorkspaceRoots,
    usableWorkspacePath,
    hereFolder,
    openHere,
    suggestedWorkspaceFolder,
    hereState,
  };
}
