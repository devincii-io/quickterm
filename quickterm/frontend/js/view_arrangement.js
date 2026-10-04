// The tiling of workspace views across restarts: what is stored, how a
// stored record (version 1 from 3.x, or version 2) is read back, which
// views of it can return, and the localStorage behind it. Pure apart from
// that storage; WorkspaceViews in workspace_views.js uses it.

import { isScratchWorkspace } from "./boot_context.js";
import { leaves, mapLeaves } from "./split_tree.js";

// A split's share of its first view, in percent, as stored and as dragged.
export const VIEW_RATIO_MIN = 15;
export const VIEW_RATIO_MAX = 85;

export function clampViewRatio(value) {
  return Math.max(VIEW_RATIO_MIN, Math.min(VIEW_RATIO_MAX, Number.isFinite(value) ? value : 50));
}

// Stored in localStorage under VIEW_ARRANGEMENT_KEY, written by the window
// whenever the tiling changes and read once when it boots:
//
//   {"version": 2,
//    "tree": <node> | null,      null once the last view was closed
//    "active": <view> | null,    the view the keyboard was in
//    "zoomed": <view> | null}
//   <node> = {"type":"split","dir":"h"|"v","ratio":r,"children":[<node>,<node>]}
//          | {"type":"pane","pane":<view>}
//   <view> = {"workspace":"<name>", "window"?: "<registry id>"}
//
// Version 1 (3.x) also had a {"primary":true} leaf for the document that
// hosted a workspace itself. It migrates: that leaf becomes the workspace the
// primary remembered, or is dropped when it was on scratch or remembered
// nothing. A stored version 2 record, even an empty one, also says the
// remembered workspace has been read once and must not be consulted again.

export const VIEW_ARRANGEMENT_KEY = "quickterm.workspaceViews";
export const VIEW_ARRANGEMENT_VERSION = 2;
const LEGACY_ARRANGEMENT_VERSION = 1;
// Past this a stored tree is not something a person tiled by hand.
const MAX_STORED_VIEWS = 16;
const MAX_STORED_DEPTH = 16;

const LEGACY_PRIMARY = Object.freeze({ primary: true });

function viewKey(descriptor) {
  return descriptor ? `w:${descriptor.workspace}` : "";
}

// The arrangement for `root`. With no view open it is an empty record, not
// nothing: the empty record is what tells the next boot that this window has
// been migrated.
export function describeArrangement({ root, nameOf, active = null, zoomed = null }) {
  // The registry id travels with a view so a restore can release the claim
  // the previous page's iframe still holds (see rebuild()).
  const describe = (view) => ({ workspace: nameOf(view), ...(view.id ? { window: String(view.id) } : {}) });
  const tree = mapLeaves(root, describe);
  return {
    version: VIEW_ARRANGEMENT_VERSION,
    tree,
    active: tree && active ? describe(active) : null,
    zoomed: tree && zoomed ? describe(zoomed) : null,
  };
}

function parseDescriptor(value, legacy) {
  if (!value || typeof value !== "object") return null;
  if (value.primary === true) return legacy ? LEGACY_PRIMARY : null;
  if (typeof value.workspace !== "string" || !value.workspace.trim()) return null;
  const window = typeof value.window === "string" && value.window && value.window.length <= 64
    ? { window: value.window }
    : {};
  return { workspace: value.workspace, ...window };
}

function parseNode(node, depth, counts, legacy) {
  if (!node || typeof node !== "object" || depth > MAX_STORED_DEPTH) return null;
  if (node.type === "pane") {
    const view = parseDescriptor(node.pane, legacy);
    if (!view) return null;
    counts.views += 1;
    if (view.primary) counts.primary += 1;
    return { type: "pane", pane: view };
  }
  if (node.type !== "split" || !Array.isArray(node.children) || node.children.length !== 2) return null;
  if (node.dir !== "h" && node.dir !== "v") return null;
  const first = parseNode(node.children[0], depth + 1, counts, legacy);
  const second = first && parseNode(node.children[1], depth + 1, counts, legacy);
  if (!second) return null;
  const ratio = clampViewRatio(Number(node.ratio) * 100) / 100;
  return { type: "split", dir: node.dir, ratio, children: [first, second] };
}

// A stored arrangement, checked all the way down. Anything malformed or from
// an unknown version is null: a half-trusted tree would be rebuilt into a
// layout nobody made. A version 1 record must have had exactly one primary,
// as 3.x wrote it; `rememberedWorkspace` is what that primary leaf becomes.
// `migrated` is true for a version 1 record.
export function parseArrangement(raw, { rememberedWorkspace = null } = {}) {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch (_) { return null; }
  }
  if (!value || typeof value !== "object") return null;
  const legacy = value.version === LEGACY_ARRANGEMENT_VERSION;
  if (!legacy && value.version !== VIEW_ARRANGEMENT_VERSION) return null;
  const counts = { views: 0, primary: 0 };
  let tree = null;
  if (value.tree !== null || legacy) {
    tree = parseNode(value.tree, 0, counts, legacy);
    if (!tree || counts.views > MAX_STORED_VIEWS) return null;
    if (legacy && counts.primary !== 1) return null;
  }
  let active = parseDescriptor(value.active, legacy);
  let zoomed = parseDescriptor(value.zoomed, legacy);
  if (legacy) {
    const name = typeof rememberedWorkspace === "string" && rememberedWorkspace.trim() ? rememberedWorkspace : null;
    const promote = (view) => (view?.primary ? (name ? { workspace: name } : null) : view);
    tree = mapLeaves(tree, promote);
    // A version 1 record without a stored active view meant the primary.
    active = value.active === undefined || value.active === null ? promote(LEGACY_PRIMARY) : promote(active);
    zoomed = promote(zoomed);
  }
  return { version: VIEW_ARRANGEMENT_VERSION, tree, active, zoomed, migrated: legacy };
}

// What can come back after a restart. Scratch views are dropped because the
// backend deletes their files at startup; a workspace that no longer exists
// and a second copy of a name are dropped too. The splits they leave
// collapse into their siblings. An active or zoomed view that did not
// survive falls back to none. `skipped` lists every dropped view with its
// reason. Null when nothing valid was stored.
export function restorePlan(arrangement, { exists = () => true, rememberedWorkspace = null } = {}) {
  const parsed = parseArrangement(arrangement, { rememberedWorkspace });
  if (!parsed) return null;
  const skipped = [];
  const seen = new Set();
  const tree = mapLeaves(parsed.tree, (view) => {
    const name = view.workspace;
    let reason = null;
    if (isScratchWorkspace(name)) reason = "scratch";
    else if (seen.has(name)) reason = "duplicate";
    else if (!exists(name)) reason = "missing";
    if (reason) {
      skipped.push({ workspace: name, reason });
      return null;
    }
    seen.add(name);
    return view;
  });
  const kept = new Set(leaves(tree).map(viewKey));
  return {
    tree,
    active: parsed.active && kept.has(viewKey(parsed.active)) ? parsed.active : null,
    zoomed: parsed.zoomed && kept.has(viewKey(parsed.zoomed)) ? parsed.zoomed : null,
    skipped,
    migrated: parsed.migrated,
  };
}

// localStorage behind a load/save pair. Every access can throw (storage
// disabled, quota, a private window), and none of that may reach the view
// manager: losing the arrangement is fine, losing the window is not.
export function viewArrangementStore(storage = null) {
  const backing = () => storage || globalThis.localStorage;
  return {
    load() {
      try { return backing().getItem(VIEW_ARRANGEMENT_KEY); } catch (_) { return null; }
    },
    save(text) {
      try {
        if (text) backing().setItem(VIEW_ARRANGEMENT_KEY, text);
        else backing().removeItem(VIEW_ARRANGEMENT_KEY);
      } catch (_) { /* storage may be disabled */ }
    },
  };
}

// One sentence for a restore that brought nothing back, or null when at
// least one view returned or nothing but scratch was ever there to return.
// A view that is missing on its own is not worth a word: the others are the
// answer.
export function restoreFailureMessage(restored, failed) {
  if (restored.length || !failed.length) return null;
  const names = failed.map((name) => `"${name}"`).join(", ");
  return failed.length === 1
    ? `The tiled view of ${names} did not come back: it is open in another window or no longer saved.`
    : `The tiled views of ${names} did not come back: they are open in another window or no longer saved.`;
}
