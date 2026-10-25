// Fetch wrappers for the right panel's routes (/api/ws/<workspace>/...),
// docs/CONTRACTS.md, 4.3 round 2, "The right panel".

import { authHeaders } from "./api.js";

const base = (name) => `/api/ws/${encodeURIComponent(name)}`;

async function req(method, path, body, { signal } = {}) {
  const opts = { method, headers: { ...authHeaders() }, signal };
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
      if (payload?.detail) err.detail = String(payload.detail);
    } catch (_) { /* not JSON */ }
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const query = (params) => new URLSearchParams(Object.entries(params).filter(([, value]) => value != null)).toString();

export const listFiles = (name, dir = "") => req("GET", `${base(name)}/files?${query({ dir })}`);
export const searchFiles = (name, q, contents = false, options) =>
  req("GET", `${base(name)}/files/search?${query({ q, contents: contents ? 1 : 0 })}`, undefined, options);
export const readFile = (name, path) => req("GET", `${base(name)}/file?${query({ path })}`);
// app "editor" (VS Code, else the default program) or "explorer".
export const openPath = (name, path, app) => req("POST", `${base(name)}/open`, { path, app });
export const getChanges = (name) => req("GET", `${base(name)}/changes`);
export const changeFiles = (name, action, paths) => req("POST", `${base(name)}/changes`, { action, paths });
export const getDiff = (name, path, group) => req("GET", `${base(name)}/diff?${query({ path, group })}`);
export const gitAction = (name, action, message = null) => req("POST", `${base(name)}/git`, { action, message });
export const getPr = (name) => req("GET", `${base(name)}/pr`);
export const getPrLog = (name, run, job = null) => req("GET", `${base(name)}/pr/log?${query({ run, job })}`);
// `number` and `headSha` are the PR the user confirmed; the backend refuses
// another PR or a newer head.
export const mergePr = (name, method, number, headSha) =>
  req("POST", `${base(name)}/pr/merge`, { method, number, head_sha: headSha });
