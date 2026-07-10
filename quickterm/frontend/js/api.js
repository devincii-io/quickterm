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
export const renameSession = (id, name) => req("PATCH", `/api/sessions/${encodeURIComponent(id)}`, { name });
export const cleanupSessions = (sessionIds) => req("POST", "/api/sessions/cleanup", { session_ids: sessionIds });
// dot-prefixed workspaces (".scratch") are internal and never listed
export const listWorkspaces = () =>
  req("GET", "/api/workspaces").then((names) => (names || []).filter((name) => !name.startsWith(".")));
export const getWorkspace = (name) => req("GET", `/api/workspaces/${encodeURIComponent(name)}`);
export const putWorkspace = (name, layout, logo) =>
  req("PUT", `/api/workspaces/${encodeURIComponent(name)}`, { layout, logo: logo ?? null });
export const deleteWorkspace = (name) => req("DELETE", `/api/workspaces/${encodeURIComponent(name)}`);
export const postFocus = (sessionId) => req("POST", "/api/focus", { session_id: sessionId });
export const getFullConfig = () => req("GET", "/api/config/full");
export const putConfig = (cfg) => req("PUT", "/api/config", cfg);
export const getTerminalOptions = () => req("GET", "/api/system/terminals");

// Branding assets (logos). Uploads send the raw file with its own content-type.
export const assetUrl = (id) => (id ? `/api/assets/${encodeURIComponent(id)}` : null);
export const deleteAsset = (id) => req("DELETE", `/api/assets/${encodeURIComponent(id)}`);
export async function uploadAsset(file) {
  const res = await fetch("/api/assets", {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) {
    const err = new Error(`upload -> ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}
