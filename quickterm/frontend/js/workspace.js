// Workspace persistence: PUT/GET /api/workspaces/{name} with the layout
// tree from layout.serialize() (schema shared with the backend).

import * as api from "./api.js";

export async function save(name, layoutTree, logo, sessionIds = []) {
  await api.putWorkspace(name, layoutTree, logo, sessionIds);
}

export async function load(name) {
  const ws = await api.getWorkspace(name);
  return ws ? ws.layout : null;
}

export function details(name) {
  return api.getWorkspace(name);
}

export async function loadLogo(name) {
  const ws = await api.getWorkspace(name).catch(() => null);
  return ws ? ws.logo || null : null;
}

export function list() {
  return api.listWorkspaces();
}
