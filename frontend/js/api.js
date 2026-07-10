// Thin fetch wrappers over the REST surface in docs/CONTRACTS.md.

async function req(method, path, body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : res.text();
}

export const getConfig = () => req("GET", "/api/config");
export const getProfiles = () => req("GET", "/api/profiles");
export const getSnippets = () => req("GET", "/api/snippets");
export const getSessions = () => req("GET", "/api/sessions");
export const createSession = (spec) => req("POST", "/api/sessions", spec || {});
export const killSession = (id) => req("DELETE", `/api/sessions/${encodeURIComponent(id)}`);
export const cleanupSessions = (sessionIds) => req("POST", "/api/sessions/cleanup", { session_ids: sessionIds });
export const listWorkspaces = () => req("GET", "/api/workspaces");
export const getWorkspace = (name) => req("GET", `/api/workspaces/${encodeURIComponent(name)}`);
export const putWorkspace = (name, layout) => req("PUT", `/api/workspaces/${encodeURIComponent(name)}`, { layout });
export const deleteWorkspace = (name) => req("DELETE", `/api/workspaces/${encodeURIComponent(name)}`);
export const postFocus = (sessionId) => req("POST", "/api/focus", { session_id: sessionId });
export const getFullConfig = () => req("GET", "/api/config/full");
export const putConfig = (cfg) => req("PUT", "/api/config", cfg);
export const getTerminalOptions = () => req("GET", "/api/system/terminals");
