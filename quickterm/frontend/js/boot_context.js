// What this document was launched as and what it remembers between runs: the
// token in the URL fragment, the window identity and folder in the query,
// and the per-window and per-origin storage keys. Read once at boot; nothing
// here touches the DOM.

import * as api from "./api.js";

const ACTIVE_WORKSPACE_KEY = "quickterm.activeWorkspace";
const SCRATCH_ACTIVE_KEY = "quickterm.scratchActive";
const WINDOW_ID_KEY = "qt.windowId";
// The typeof guard only matters outside a browser (the node tests import this
// module); in a window it is always an object.
export const embedded = typeof window !== "undefined"
  && window.parent !== window
  && new URLSearchParams(location.search).get("embedded") === "1";
const launchParams = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
// Every workspace lives in a view with its own registry id, so every scratch
// is `scratch-view-<id>`. The bare "scratch" is what 3.x primaries used; it
// still counts as scratch because app.py deletes those files at startup.
const scratchId = launchParams.get("scratch")
  || (launchParams.get("window") ? `scratch-view-${launchParams.get("window")}` : null);
export const SCRATCH_WS = /^scratch-view-[A-Za-z0-9_-]{8,64}$/.test(scratchId || "") ? scratchId : "scratch";
export const isScratchWorkspace = (name) => name === "scratch" || /^scratch-view-[A-Za-z0-9_-]{8,64}$/.test(name || "");
export function workspaceLabel(name) {
  if (!isScratchWorkspace(name)) return name || "scratch";
  const host = typeof window !== "undefined" ? (embedded ? window.parent : window) : null;
  return host?.quicktermChrome?.scratchLabels?.get(name) || (name === "scratch" ? "scratch" : `scratch ${name.slice(-4)}`);
}

// The workspace a 3.x primary window remembered, and whether it was on
// scratch. Only the shell's first boot reads them, to migrate; nothing writes
// them any more.
export function storedWorkspace() {
  try { return localStorage.getItem(ACTIVE_WORKSPACE_KEY); } catch (_) { return null; }
}

export function storedScratchActive() {
  try { return localStorage.getItem(SCRATCH_ACTIVE_KEY) === "1"; } catch (_) { return false; }
}

// The shell's view arrangement (workspace_views.js) replaced what 3.x
// remembered here. Views still call this on every switch and promotion; it
// is a no-op so those call sites need no branch.
export function rememberWorkspace(_name) {}

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

// The one scratch view a fresh window opens on its own carries ?first=1. Only
// that view adopts the elevated first terminal ("Administrator - ...").
export function captureFirstView() {
  try { return new URLSearchParams(location.search).get("first") === "1"; } catch (_) { return false; }
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
