// Workspace persistence: PUT/GET /api/workspaces/{name} with the layout
// tree from layout.serialize() (schema shared with the backend).

import * as api from "./api.js";

export async function save(name, layoutTree) {
  await api.putWorkspace(name, layoutTree);
}

export async function load(name) {
  const ws = await api.getWorkspace(name);
  return ws ? ws.layout : null;
}

export function list() {
  return api.listWorkspaces();
}
