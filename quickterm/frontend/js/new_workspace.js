// "New workspace…" (CONTRACTS 4.5): a location, a folder there and a name.
// This is the dialog's model, without a DOM; new_workspace_dialog.js draws
// it. A folder that already is a workspace's (same location, same path)
// opens that workspace instead of making a second one.

import { folderWorkspaceName, samePath } from "./here.js";
import {
  locationKind, remoteFolderProblem, samePosixPath, sshDestinationProblem, uncForWslPath, wslDistro,
  wslPathFromUnc,
} from "./locations.js";
import { validateWorkspaceName } from "./workspace_actions.js";
import { STARTUP_KINDS, cleanStartupItem, newStartupItem } from "./workspace_setup.js";

export const THIS_PC = Object.freeze({ id: null, kind: "local", label: "This PC", detail: null, browse: null });
// The menu row that lets a person type an SSH destination of their own.
export const OTHER_SSH = Object.freeze({ id: "", kind: "other", label: "Other SSH host…", detail: null, browse: null });

// GET /api/locations as the menu lists it: This PC first, whatever the
// answer says. An unreadable answer still offers This PC.
export function normalizeLocations(answer) {
  const rows = [THIS_PC];
  for (const entry of answer?.locations || []) {
    if (!entry || !entry.id || !["wsl", "ssh"].includes(entry.kind)) continue;
    if (rows.some((row) => row.id === entry.id)) continue;
    rows.push({
      id: String(entry.id), kind: entry.kind, label: String(entry.label || entry.id),
      detail: entry.detail || null, browse: entry.browse || null,
    });
  }
  return rows;
}

// What the workspace's `host` is for a location row; "Other SSH host…"
// takes the typed destination.
export function hostFor(location, typedHost = "") {
  if (!location || location.kind === "local") return null;
  if (location.kind === "other") return String(typedHost || "").trim();
  return location.id;
}

// Only This PC and WSL have a disk the folder browser can list.
export function canBrowse(location) {
  return location?.kind === "local" || location?.kind === "wsl";
}

// Where Browse opens: the typed folder when there is one, else the focused
// terminal's folder (This PC) or the distribution's home (WSL).
export function browseStart(location, folder = "", suggested = "") {
  const typed = String(folder || "").trim();
  if (location?.kind === "local") return typed || suggested || "";
  if (location?.kind !== "wsl") return null;
  const distro = wslDistro(location.id);
  if (typed.startsWith("/")) return uncForWslPath(distro, typed);
  return location.browse || uncForWslPath(distro, "/home");
}

// The folder browser answers a Windows path; in WSL that is a share path of
// the distribution, which becomes the POSIX folder. {path} or {problem}.
export function browsedFolder(location, chosen) {
  if (!chosen) return { path: null };
  if (location?.kind !== "wsl") return { path: chosen };
  const distro = wslDistro(location.id);
  const posix = wslPathFromUnc(chosen);
  if (!posix || posix.distro.toLowerCase() !== String(distro).toLowerCase()) {
    return { problem: `Choose a folder inside ${location.label}.` };
  }
  return { path: posix.path };
}

// The name prefilled from the folder. A folder named only `~` or `/` gives
// the location's name instead.
export function suggestName(host, folder, taken = []) {
  const text = String(folder || "").trim();
  if (!text) return "";
  const kind = locationKind(host);
  if (kind === "local") return folderWorkspaceName(text, taken);
  const last = text.split("/").filter((part) => part && part !== "~").pop();
  // ssh://user@box:22 is "box".
  const machine = kind === "wsl" ? wslDistro(host) : String(host || "").replace(/^ssh:\/\//, "").replace(/^.*@/, "").replace(/:\d*$/, "");
  return folderWorkspaceName(last || machine || "workspace", taken);
}

export function nameTaken(name, names = []) {
  const wanted = String(name || "").trim().toLowerCase();
  return (names || []).some((item) => String(item).toLowerCase() === wanted);
}

// The saved workspace that already is this folder at this location, or null.
// `folders` is the shell's Map of name -> {path, host}.
export function workspaceAt(host, path, folders) {
  const kind = locationKind(host);
  for (const [name, entry] of folders?.entries?.() || []) {
    if (!entry?.path || locationKind(entry.host) !== kind) continue;
    if (kind === "local") {
      if (samePath(entry.path, path)) return name;
    } else if (kind === "wsl") {
      if (String(entry.host).toLowerCase() === String(host).toLowerCase() && samePosixPath(entry.path, path)) return name;
    } else if (entry.host === host && samePosixPath(entry.path, path)) return name;
  }
  return null;
}

// What Create would save, or the first problem with it: {host, kind, path,
// name} or {problem, field}.
export function createRequest({ location, typedHost = "", folder = "", name = "" }) {
  const host = hostFor(location, typedHost);
  if (location?.kind === "other") {
    const problem = sshDestinationProblem(host);
    if (problem) return { problem, field: "host" };
  }
  const kind = locationKind(host);
  const path = String(folder || "").trim();
  if (kind === "local") {
    if (!path) return { problem: "Choose the folder.", field: "folder" };
  } else {
    const problem = remoteFolderProblem(path);
    if (problem) return { problem, field: "folder" };
  }
  const problem = validateWorkspaceName(name);
  if (problem) return { problem, field: "name" };
  return { host, kind, path, name: String(name).trim() };
}

// Saves the workspace at its location with an empty layout, then opens its
// view. A folder that already is a workspace's opens that one. Resolves to
// {name, existing}.
// "Start with" (CONTRACTS 4.5 wave 2): Shell, Claude Code and Codex as
// toggles, Shell on by default. The ones on become the workspace's startup
// list in that order, each with the agent settings' own options.
export const START_WITH = Object.freeze(STARTUP_KINDS.map((kind) => kind.id));
export const DEFAULT_START_WITH = Object.freeze(["shell"]);

export function startWithItems(chosen = DEFAULT_START_WITH) {
  const on = new Set(chosen || []);
  return START_WITH.filter((kind) => on.has(kind)).map((kind) => cleanStartupItem(newStartupItem(kind)));
}

// A chosen set toggled once: `kind` in when it was out, out when it was in.
export function toggleStartWith(chosen, kind) {
  if (!START_WITH.includes(kind)) return [...(chosen || [])];
  const on = new Set(chosen || []);
  if (on.has(kind)) on.delete(kind);
  else on.add(kind);
  return START_WITH.filter((item) => on.has(item));
}

export async function createLocationWorkspace({
  api, host, path, name, folders, openView, onWorkspacesChanged, startup,
}) {
  const existing = workspaceAt(host, path, folders);
  if (existing) {
    await openView?.(existing);
    return { name: existing, existing: true };
  }
  // No fallback to "nothing is taken": PUT replaces a workspace of that
  // name, so an unreadable list must stop here instead of overwriting one.
  const names = await api.listWorkspaces();
  if (nameTaken(name, names)) throw { detail: `A workspace named "${name}" exists already. Choose another name.` };
  if (startup === undefined) await api.putLocationWorkspace(name, host, path);
  else await api.putLocationWorkspace(name, host, path, startup);
  await Promise.resolve(onWorkspacesChanged?.()).catch(() => {});
  await Promise.resolve(openView?.(name)).catch(() => null);
  return { name, existing: false };
}
