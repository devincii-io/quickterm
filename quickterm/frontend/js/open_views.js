// Which workspaces the primary window had open, and which one it showed,
// across restarts. Pure apart from the localStorage behind openViewsStore;
// WorkspaceViews in workspace_views.js uses it.
//
//   localStorage["quickterm.openViews.v1"] =
//     {"version": 1, "open": [<name>, ...], "shown": <name> | null}
//
// A name is a saved workspace, or "" for the window's scratch view. The list
// is in the order the views were opened.
//
// Up to 4.2 the window tiled its views and stored the tiling under
// "quickterm.workspaceViews" (version 2, or version 1 from 3.x with a
// {"primary": true} leaf for the document that hosted a workspace itself).
// The first boot after the upgrade reads that record once for its leaves, in
// tree order, with its active leaf as the shown one, and removes it.

import { isScratchWorkspace } from "./boot_context.js";

export const OPEN_VIEWS_KEY = "quickterm.openViews.v1";
export const LEGACY_ARRANGEMENT_KEY = "quickterm.workspaceViews";
const OPEN_VIEWS_VERSION = 1;
// Past this a stored list is not something a person opened by hand.
const MAX_STORED_VIEWS = 16;
const MAX_TREE_DEPTH = 16;

const scratchOrName = (name) => (isScratchWorkspace(name) ? "" : name);

// The record for `views` (in the order they were opened) with `shown` the
// view on screen. `nameOf(view)` is the workspace it shows.
export function describeOpenViews(views, shown, nameOf) {
  const open = views.map((view) => scratchOrName(nameOf(view)));
  return {
    version: OPEN_VIEWS_VERSION,
    open,
    shown: shown && views.includes(shown) ? scratchOrName(nameOf(shown)) : null,
  };
}

function storedName(value) {
  if (value === "") return "";
  return typeof value === "string" && value.trim() ? value : null;
}

// A stored record, checked. Null for anything malformed or from another
// version: a half-trusted list would open workspaces nobody had open.
export function parseOpenViews(raw) {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch (_) { return null; }
  }
  if (!value || typeof value !== "object" || value.version !== OPEN_VIEWS_VERSION) return null;
  if (!Array.isArray(value.open) || value.open.length > MAX_STORED_VIEWS) return null;
  const open = [];
  for (const item of value.open) {
    const name = storedName(item);
    if (name === null) return null;
    if (!open.includes(name)) open.push(name);
  }
  const shown = storedName(value.shown);
  return { open, shown: shown !== null && open.includes(shown) ? shown : null };
}

// The leaves of a 4.2 (version 2) or 3.x (version 1) tiling record, as an
// open-views record. A 3.x primary leaf becomes the workspace that primary
// remembered, or nothing when it remembered none. Null when the record is
// unreadable.
export function migrateArrangement(raw, { rememberedWorkspace = null } = {}) {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch (_) { return null; }
  }
  if (!value || typeof value !== "object" || ![1, 2].includes(value.version)) return null;
  const remembered = typeof rememberedWorkspace === "string" && rememberedWorkspace.trim() ? rememberedWorkspace : null;
  const nameOf = (leaf) => {
    if (!leaf || typeof leaf !== "object") return null;
    if (leaf.primary === true) return value.version === 1 && remembered ? scratchOrName(remembered) : null;
    return typeof leaf.workspace === "string" && leaf.workspace.trim() ? scratchOrName(leaf.workspace) : null;
  };
  const open = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > MAX_TREE_DEPTH) return;
    if (node.type === "pane") {
      const name = nameOf(node.pane);
      if (name !== null && !open.includes(name) && open.length < MAX_STORED_VIEWS) open.push(name);
    } else if (node.type === "split" && Array.isArray(node.children)) {
      for (const child of node.children) walk(child, depth + 1);
    }
  };
  walk(value.tree, 0);
  // A 3.x record without a stored active view meant the primary.
  const active = value.version === 1 && !value.active ? { primary: true } : value.active;
  const shown = nameOf(active);
  return { open, shown: shown !== null && open.includes(shown) ? shown : null };
}

// What can come back: a workspace that no longer exists is dropped and named
// in `skipped`. Scratch ("") always comes back as a fresh scratch view. Null
// when nothing valid was stored.
export function restorePlan(record, { exists = () => true } = {}) {
  if (!record) return null;
  const skipped = [];
  const open = record.open.filter((name) => {
    if (name === "" || exists(name)) return true;
    skipped.push({ workspace: name, reason: "missing" });
    return false;
  });
  return { open, shown: open.includes(record.shown) ? record.shown : null, skipped };
}

// localStorage behind the two keys. Every access can throw (storage
// disabled, quota, a private window), and none of that may reach the view
// manager: losing the list is fine, losing the window is not.
export function openViewsStore(storage = null) {
  const backing = () => storage || globalThis.localStorage;
  const read = (key) => {
    try { return backing().getItem(key); } catch (_) { return null; }
  };
  return {
    load: () => read(OPEN_VIEWS_KEY),
    loadLegacy: () => read(LEGACY_ARRANGEMENT_KEY),
    dropLegacy() {
      try { backing().removeItem(LEGACY_ARRANGEMENT_KEY); } catch (_) { /* storage may be disabled */ }
    },
    save(text) {
      try { backing().setItem(OPEN_VIEWS_KEY, text); } catch (_) { /* storage may be disabled */ }
    },
  };
}

// The record to restore from `store`: the current key, else the tiling
// record read once and removed. `stored` says a record of either kind was
// there, so this window has been migrated.
export function readStoredViews(store, { rememberedWorkspace = null } = {}) {
  const current = store.load();
  const legacy = store.loadLegacy?.() ?? null;
  if (legacy !== null) store.dropLegacy?.();
  if (current !== null) return { record: parseOpenViews(current), stored: true };
  if (legacy !== null) return { record: migrateArrangement(legacy, { rememberedWorkspace }), stored: true };
  return { record: null, stored: false };
}

// One sentence for a restore that brought nothing back, or null when at
// least one view returned or nothing was there to return. A workspace that
// is missing on its own is not worth a word: the others are the answer.
export function restoreFailureMessage(restored, failed) {
  if (restored.length || !failed.length) return null;
  const names = failed.map((name) => `"${name || "scratch"}"`).join(", ");
  return failed.length === 1
    ? `${names} did not come back: it is open in another window or no longer saved.`
    : `${names} did not come back: they are open in another window or no longer saved.`;
}
