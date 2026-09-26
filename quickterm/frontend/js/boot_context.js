// What this document was launched as and what it remembers between runs: the
// token in the URL fragment, the window identity and folder in the query,
// and the per-window and per-origin storage keys. Read once at boot; nothing
// here touches the DOM.

import * as api from "./api.js";

const ACTIVE_WORKSPACE_KEY = "quickterm.activeWorkspace";
const SCRATCH_ACTIVE_KEY = "quickterm.scratchActive";
export const SCRATCH_WS = "scratch";
const WINDOW_ID_KEY = "qt.windowId";
// The typeof guard only matters outside a browser (the node tests import this
// module); in a window it is always an object.
export const embedded = typeof window !== "undefined"
  && window.parent !== window
  && new URLSearchParams(location.search).get("embedded") === "1";

export function storedWorkspace() {
  try { return localStorage.getItem(ACTIVE_WORKSPACE_KEY); } catch (_) { return null; }
}

export function storedScratchActive() {
  try { return localStorage.getItem(SCRATCH_ACTIVE_KEY) === "1"; } catch (_) { return false; }
}

// The remembered workspace and "scratch is the current one" are two different
// facts. Writing "scratch" into the durable key erased the user's real last
// workspace, and the backend deletes the scratch file at startup, so nothing
// was auto-restored on the next launch. Scratch gets its own flag; within a
// run (tray close and reopen) the scratch file still exists and wins, and on
// a fresh start it is gone and the named workspace comes back.
export function rememberWorkspace(name) {
  if (embedded) return;
  try {
    if (name === SCRATCH_WS) {
      localStorage.setItem(SCRATCH_ACTIVE_KEY, "1");
      return;
    }
    localStorage.removeItem(SCRATCH_ACTIVE_KEY);
    if (name) localStorage.setItem(ACTIVE_WORKSPACE_KEY, name);
    else localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
  } catch (_) { /* storage may be disabled */ }
}

// The window is launched at .../#t=<token>. Capture it before any API call,
// stash it in sessionStorage so a reload (which loses the fragment) still works,
// then scrub it from the URL so it does not linger in history. sessionStorage is
// per-tab and same-origin, so other local programs cannot read it.
export function captureToken() {
  const match = /[#&]t=([^&]+)/.exec(location.hash || "");
  let value = match ? decodeURIComponent(match[1]) : "";
  if (!value) { try { value = sessionStorage.getItem("qt.token") || ""; } catch (_) { /* ignore */ } }
  if (value) {
    api.setToken(value);
    try { sessionStorage.setItem("qt.token", value); } catch (_) { /* ignore */ }
  }
  if (match) {
    try { history.replaceState(null, "", location.pathname + location.search); } catch (_) { /* ignore */ }
  }
}

// Explorer "Open QuickTerm here" passes the folder as ?cwd=... (app.py). Read
// it before captureToken scrubs the fragment; the query itself is preserved.
export function captureOpenDir() {
  try {
    const value = new URLSearchParams(location.search).get("cwd");
    return value || null;
  } catch (_) { return null; }
}

// Who this window is, from the launch URL app.py built (`_window_url`).
//
// `window` is the id the desktop shell already assigned: it must be reused when
// registering, because that is the id the shell forgets when the native window
// closes, and a registration under any other id would keep the workspace
// claimed until the heartbeat expired. `primary` marks the one window the
// Explorer handoff and the summon hotkey aim at.
//
// `workspace` is three-valued, like `path` on the workspace PUT. A name is an
// instruction. Absent normally means "restore what you remember", which is what
// the primary window and a plain browser tab want. Absent in a *secondary*
// shell window means scratch: that window was asked for a scratch window, and
// localStorage is shared across every window on this origin, so restoring the
// remembered workspace there would collide with the window that opened it. The
// browser fallback says the same thing explicitly with an empty value.
export function captureWindowIdentity() {
  try {
    const params = new URLSearchParams(location.search);
    const id = params.get("window") || null;
    const primary = params.get("primary") === "1";
    const raw = params.get("workspace");
    const workspace = raw === null
      ? (id && !primary ? null : undefined)
      : (raw || null);
    return { id, primary, workspace };
  } catch (_) { return { id: null, primary: false, workspace: undefined }; }
}

// sessionStorage is per window and survives a reload, so a reloaded window asks
// the registry for the id it just had. Its release on pagehide and its new
// claim are then two facts about the same window instead of a race between a
// dying one and a new one over the same workspace.
export function rememberedWindowId() {
  if (embedded) return null;
  try { return sessionStorage.getItem(WINDOW_ID_KEY) || null; } catch (_) { return null; }
}

export function rememberWindowId(id) {
  if (embedded) return;
  try { sessionStorage.setItem(WINDOW_ID_KEY, id); } catch (_) { /* storage may be disabled */ }
}

const INVENTORY_CACHE_KEY = "quickterm.inventory";

export function loadInventoryCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(INVENTORY_CACHE_KEY) || "null");
    return parsed && Array.isArray(parsed.types) ? parsed : null;
  } catch (_) { return null; }
}

export function saveInventoryCache(inventory) {
  try {
    if (inventory && Array.isArray(inventory.types)) {
      localStorage.setItem(INVENTORY_CACHE_KEY, JSON.stringify(inventory));
    }
  } catch (_) { /* optional */ }
  return inventory;
}
