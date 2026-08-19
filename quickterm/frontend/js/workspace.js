// Workspace persistence: PUT/GET /api/workspaces/{name} with the layout
// tree from layout.serialize() (schema shared with the backend).

import * as api from "./api.js";

// `path` omitted preserves the stored workspace folder; null clears it.
export async function save(name, layoutTree, logo, sessionIds = [], path) {
  await api.putWorkspace(name, layoutTree, logo, sessionIds, path);
}

export async function load(name) {
  const ws = await api.getWorkspace(name);
  return ws ? ws.layout : null;
}

export function details(name) {
  return api.getWorkspace(name);
}

export async function folder(name) {
  const ws = await api.getWorkspace(name).catch(() => null);
  return ws ? ws.path || null : null;
}

export async function loadLogo(name) {
  const ws = await api.getWorkspace(name).catch(() => null);
  return ws ? ws.logo || null : null;
}

export function list() {
  return api.listWorkspaces();
}
