// Thin fetch wrappers over the REST routes in docs/CONTRACTS.md.

// Loopback auth token, handed to the window through its launch URL fragment
// (see quickterm/auth.py). Every /api call carries it; WS connections pass it
// as a subprotocol because browsers cannot set headers on a WebSocket.
let authToken = "";
export function setToken(value) { authToken = value || ""; }
export function token() { return authToken; }
export function authHeaders() { return authToken ? { "X-QuickTerm-Token": authToken } : {}; }
export function wsSubprotocols() { return authToken ? [`qtauth.${authToken}`] : []; }

async function req(method, path, body) {
  const opts = { method, headers: { ...authHeaders() } };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}`);
    err.status = res.status;
    try {
      const payload = await res.json();
      if (payload && payload.detail) err.detail = String(payload.detail);
      // The whole body, for the few errors that carry structure worth acting
      // on: a 409 from the window registry names the window that holds the
      // workspace, so the UI can say who instead of only saying no.
      err.payload = payload;
    } catch (_) { /* response was not JSON */ }
    throw err;
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : res.text();
}

export const getConfig = () => req("GET", "/api/config");
export const getProfiles = () => req("GET", "/api/profiles");
export const getSnippets = () => req("GET", "/api/snippets");
export const getSessions = (options = {}) =>
  req("GET", options.metrics === false ? "/api/sessions?metrics=false" : "/api/sessions");
export const createSession = (spec) => req("POST", "/api/sessions", spec || {});
export const killSession = (id) => req("DELETE", `/api/sessions/${encodeURIComponent(id)}`);
export const retainSession = (id) => req("POST", `/api/sessions/${encodeURIComponent(id)}/retain`, {});
export const renameSession = (id, name) => req("PATCH", `/api/sessions/${encodeURIComponent(id)}`, { name });
export const cleanupSessions = (sessionIds) => req("POST", "/api/sessions/cleanup", { session_ids: sessionIds });
export const killAllSessions = () => req("POST", "/api/sessions/kill-all", {});
export const claimLaunch = () => req("GET", "/api/launches/next");
// busy = the shell has a child process (ssh, build, editor) running right now
export const sessionBusy = (id) =>
  getSessions().then((list) => Boolean((list.find((s) => s.id === id) || {}).busy)).catch(() => false);
// dot-prefixed workspaces (".scratch") are internal and never listed
export const listWorkspaces = () =>
  req("GET", "/api/workspaces").then((names) => (names || []).filter((name) => !name.startsWith(".")));
export const getWorkspace = (name) => req("GET", `/api/workspaces/${encodeURIComponent(name)}`);
// `path` is deliberately three-valued: undefined omits the key so the server
// keeps the stored folder (every layout autosave takes this branch), null
// clears it, a string sets it.
export const putWorkspace = (name, layout, logo, sessionIds = [], path) =>
  req("PUT", `/api/workspaces/${encodeURIComponent(name)}`, {
    layout,
    logo: logo ?? null,
    session_ids: [...new Set(sessionIds || [])],
    ...(path === undefined ? {} : { path }),
  });
export const deleteWorkspace = (name) => req("DELETE", `/api/workspaces/${encodeURIComponent(name)}`);
// Directory-only listing for the in-app folder browser. A blank path lets the
// backend choose the home folder, so the caller never has to know one.
export const listDirs = (path) =>
  req("GET", `/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`);
// Window registry (quickterm/windows.py). One backend process serves every
// window and every window autosaves the layout of the workspace it is on, so
// the registry is the only thing keeping two of them off one file. Every route
// here is token-gated like the rest of /api.
export const listWindows = () => req("GET", "/api/windows");
// Announce this window, optionally claiming a workspace in the same step.
// Re-registering a known id is idempotent, so a reload does not 409 against its
// own claim; the id the shell put in the launch URL must be reused, because
// that is the id it forgets when the native window closes.
// `workspace` is three-valued like `path` on the workspace PUT: omit to keep
// the current claim, null to drop it, a name to take it.
export const registerWindow = (body) => req("POST", "/api/windows", body || {});
export const heartbeatWindow = (id) =>
  req("POST", `/api/windows/${encodeURIComponent(id)}/heartbeat`, {});
// 409 = another live window holds that workspace. That is a refusal and must be
// shown; any other failure is the registry being unavailable (see claimOutcome
// in windows.js), which must never block the user. The 409 body carries
// `owner`, so the UI can name the window instead of only refusing.
export const claimWindowWorkspace = (id, workspace) =>
  req("PUT", `/api/windows/${encodeURIComponent(id)}/workspace`, { workspace });
export const releaseWindowWorkspace = (id) => claimWindowWorkspace(id, null);
export const unregisterWindow = (id) => req("DELETE", `/api/windows/${encodeURIComponent(id)}`);
// Ask the desktop shell to open another window. It answers {opened:false,
// target:"unavailable"} where there is no native shell, which is the signal to
// open the same URL in a browser window instead (newWindowUrl in windows.js).
export const requestWindow = (body) => req("POST", "/api/windows/open", body || {});

export const getFullConfig = () => req("GET", "/api/config/full");
export const putConfig = (cfg) => req("PUT", "/api/config", cfg);
export const getTerminalOptions = () => req("GET", "/api/system/terminals");
export const elevateTerminal = (spec) => req("POST", "/api/elevate", spec);
export const checkUpdate = (force) => req("GET", `/api/update${force ? "?force=true" : ""}`);
export const openTarget = (target) => req("POST", "/api/open", { target });
export const installUpdate = () => req("POST", "/api/update/install");

// Branding assets (logos). Uploads send the raw file with its own content-type.
export const assetUrl = (id) => (id ? `/api/assets/${encodeURIComponent(id)}` : null);
export const deleteAsset = (id) => req("DELETE", `/api/assets/${encodeURIComponent(id)}`);
export async function uploadAsset(file) {
  const res = await fetch("/api/assets", {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream", ...authHeaders() },
    body: file,
  });
  if (!res.ok) {
    const err = new Error(`upload -> ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}
