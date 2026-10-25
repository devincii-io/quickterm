// "New workspace…" in the sidebar's "+" and the palette: a folder chosen in
// the folder browser becomes a workspace named after it, and its view opens
// with a first terminal there. A folder that already is a local workspace's
// opens that workspace instead of making a second one. The pure helper is
// tested under node.

import { folderWorkspaceName, samePath } from "./here.js";

// The saved local workspace whose folder `folder` is, or null. `folders` is
// the shell's Map of name -> {path, host}.
export function workspaceForFolder(folder, folders) {
  for (const [name, entry] of folders?.entries?.() || []) {
    if (!entry?.host && samePath(entry?.path, folder)) return name;
  }
  return null;
}

// Saves the workspace with its folder and an empty layout, then opens its
// view. Resolves to the workspace's name.
export async function createFolderWorkspace({ api, folder, folders, openView, onWorkspacesChanged }) {
  const existing = workspaceForFolder(folder, folders);
  if (existing) {
    await openView?.(existing);
    return existing;
  }
  // No fallback to "nothing is taken": PUT replaces a workspace of that
  // name, so an unreadable list must stop here instead of overwriting one.
  const names = await api.listWorkspaces();
  const name = folderWorkspaceName(folder, names);
  await api.putWorkspace(name, null, null, [], folder);
  await Promise.resolve(onWorkspacesChanged?.()).catch(() => {});
  await Promise.resolve(openView?.(name)).catch(() => null);
  return name;
}
