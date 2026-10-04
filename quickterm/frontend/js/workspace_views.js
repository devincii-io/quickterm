// Workspaces in one window, tiled like the panes inside them.
//
// The window's own document is the shell: it hosts no workspace. Every
// workspace, scratch included, is a same-origin iframe view running the app on
// that one workspace, with its own layout, autosave, registry claim and
// heartbeat. No view is special: each one has a close button, and closing the
// last one leaves an empty stage. The views are leaves of the same split tree
// the panes use (split_tree.js), so a new one takes half of the active view
// along its longer side, a header drag docks it beside another view or swaps
// the two (pane_move.js), and a divider drag or its arrow keys change one
// ratio.
//
// One rule shapes the DOM here: an iframe that moves in the DOM reloads its
// document, terminals and all. So views are never re-parented. Every view
// and divider is absolutely positioned inside the stage, and a layout change
// only writes left/top/width/height. The CSS transition on those four
// properties is what makes a split, a move or a close slide into place.

import * as api from "./api.js";
import { isScratchWorkspace } from "./boot_context.js";
import { focusOwners } from "./focus.js";
import { icon } from "./icons.js";
import { dropZone, movePaneNode, zoneRect } from "./pane_move.js";
import { dwindleDir, findLeaf, insertBeside, layoutRects, leaves, mapLeaves, removeLeaf } from "./split_tree.js";
import {
  VIEW_RATIO_MAX, VIEW_RATIO_MIN, clampViewRatio, describeArrangement, restoreFailureMessage, restorePlan,
  viewArrangementStore,
} from "./view_arrangement.js";

// The arrangement helpers stay importable from here.
export {
  VIEW_ARRANGEMENT_KEY, VIEW_ARRANGEMENT_VERSION, VIEW_RATIO_MAX, VIEW_RATIO_MIN, clampViewRatio,
  describeArrangement, parseArrangement, restoreFailureMessage, restorePlan, viewArrangementStore,
} from "./view_arrangement.js";

export const VIEW_COLORS = ["#d4ad63", "#6daedb", "#8fcf8a", "#c78fd6", "#e0907a", "#6fc7c2"];
// The narrowest a divider drag may make a view, when the window has the room.
export const VIEW_MIN_PX = 160;
export const EMPTY_STAGE_TEXT = "No workspace open. Open one from the sidebar.";
const DIVIDER_PX = 10;
const STAGE_INSET = 6;
const SLIDE_MS = 240;
const DRAG_START_PX = 6;
// A view whose document never says it is ready (a crashed boot) must not
// leave a caller waiting forever.
const READY_TIMEOUT_MS = 30000;

// `cwd` is the Explorer "Open QuickTerm here" folder for a scratch view;
// `first` marks the one scratch view a fresh window opens on its own, the
// only view that may adopt the elevated first terminal.
export function companionUrl(path, workspace, id, token, { cwd = null, first = false } = {}) {
  const query = new URLSearchParams({ workspace: workspace || "", window: id, embedded: "1" });
  if (!workspace) query.set("scratch", `scratch-view-${id}`);
  if (cwd) query.set("cwd", cwd);
  if (first) query.set("first", "1");
  return `${path || "/"}?${query}#t=${encodeURIComponent(token || "")}`;
}


// A workspace's own colour, the same on every open and after a restart: a
// stable hash of its name into the palette.
export function viewColorFor(name) {
  let hash = 0;
  for (const char of String(name || "")) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return VIEW_COLORS[hash % VIEW_COLORS.length];
}

// A named workspace keeps its own colour unless an open view already shows
// it; otherwise (and for scratch) the first palette colour no open view
// uses. Past six views they repeat.
export function pickViewColor(used = [], name = null) {
  const taken = new Set(used);
  const own = name ? viewColorFor(name) : null;
  if (own && !taken.has(own)) return own;
  return VIEW_COLORS.find((color) => !taken.has(color)) || own || VIEW_COLORS[used.length % VIEW_COLORS.length];
}

export function nextScratchLabel(names) {
  let index = 1;
  while (names.includes(`scratch ${index}`)) index++;
  return `scratch ${index}`;
}

// Ratio bounds for one split of `total` pixels: the percent clamp, tightened
// so neither side drops under VIEW_MIN_PX while the split can afford it.
export function ratioBounds(total) {
  let min = VIEW_RATIO_MIN / 100;
  let max = VIEW_RATIO_MAX / 100;
  if (total > 2 * VIEW_MIN_PX + DIVIDER_PX) {
    min = Math.max(min, VIEW_MIN_PX / total);
    max = Math.min(max, 1 - VIEW_MIN_PX / total);
  }
  return { min, max };
}

function reducedMotion() {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; }
}

function applyRect(el, rect) {
  el.style.left = `${rect.left}px`;
  el.style.top = `${rect.top}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
}

export class WorkspaceViews {
  // `store` (viewArrangementStore) is given only to the window whose
  // arrangement outlives a restart. It stays silent until restoreSaved() has
  // read it, so an early boot cannot erase what it is about to restore.
  // `fit` re-fits the terminals after the boxes moved; `newScratch` is the
  // empty stage's button.
  // `parentId` is this shell window's registry id: every view registers
  // under it, so closing the native window frees the views' claims at once.
  // `reservedNames()` are the saved workspaces: a scratch label never takes
  // one, so a label can never be mistaken for a workspace.
  constructor({
    fit = () => {}, error, store = null, newScratch = null, parentId = () => null, reservedNames = () => [],
  }) {
    this.fit = fit;
    this.parentId = parentId;
    this.reservedNames = reservedNames;
    // Opens, closes and rebuilds run one after another. Refusing while one
    // was running dropped a sidebar click or an Explorer handoff silently.
    this.queue = Promise.resolve();
    this.error = error;
    this.store = store;
    this.persisting = false;
    this.lastStored = undefined;
    // No busy flag: open, close and rebuild all run through _serial(), so
    // one never sees another half done.
    this.zoomed = null;
    this.root = null;
    this.active = null;
    this.stage = document.createElement("div");
    this.stage.className = "workspace-views";
    // The shell document hosts no workspace: its own terminal grid gives its
    // place in the window to the stage.
    const shell = document.querySelector("#app > .workspace-shell");
    shell.before(this.stage);
    shell.remove();
    this.empty = this._emptyState(newScratch || (() => this.open(null)));
    this.stage.append(this.empty);
    window.addEventListener("resize", () => this.layout({ animate: false }));
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(() => this.layout({ animate: false })).observe(this.stage);
    }
    this.layout({ animate: false, persist: false });
  }

  // ---- what is open ----

  views() {
    return leaves(this.root);
  }

  // `target` is a view or a child window (the iframe's contentWindow, which
  // is how an embedded document names itself).
  viewFor(target) {
    if (!target) return null;
    if (target.el) return this.views().includes(target) ? target : null;
    return this.views().find((view) => view.frame?.contentWindow === target) || null;
  }

  appFor(view) {
    try { return view?.frame?.contentWindow?.quicktermView?.app || null; } catch (_) { return null; }
  }

  // The workspace a view is on: what its document says once it has booted,
  // else the one it was opened for (`scratch-view-<id>` for scratch).
  workspaceOf(view) {
    let live = null;
    try { live = view.frame?.contentWindow?.quicktermView?.workspace() || null; } catch (_) { /* gone */ }
    return live || view.workspace;
  }

  // What a person calls the view: the workspace name, or the scratch label.
  nameOf(view) {
    const name = this.workspaceOf(view);
    return name && !isScratchWorkspace(name) ? name : view.label || "scratch";
  }

  names() {
    return this.views().map((view) => this.nameOf(view));
  }

  viewForWorkspace(name) {
    if (!name) return null;
    return this.views().find((view) => this.workspaceOf(view) === name) || null;
  }

  viewForSession(id) {
    if (!id) return null;
    return this.views().find((view) => (this.appFor(view)?.attachedSessionIds?.() || []).includes(id)) || null;
  }

  // For the sidebar and the palette: which workspace each view shows, its
  // label and colour, whether the keyboard is in it, and its child window.
  list() {
    return this.views().map((view) => ({
      workspace: this.workspaceOf(view),
      label: this.nameOf(view),
      color: view.color,
      active: view === this.active,
      window: view.frame?.contentWindow || null,
    }));
  }

  update() {
    for (const view of this.views()) {
      const name = this.nameOf(view);
      view.nameEl.textContent = name;
      view.el.setAttribute("aria-label", `Workspace view: ${name}`);
      if (view.frame) view.frame.title = `Workspace: ${name}`;
    }
    // A scratch view promoted to a named workspace renames itself in place,
    // and the stored arrangement has to follow the name.
    this._persist();
  }

  _persist() {
    if (!this.store || !this.persisting) return;
    const arrangement = describeArrangement({
      root: this.root,
      nameOf: (view) => this.workspaceOf(view),
      active: this.active,
      zoomed: this.zoomed,
    });
    const text = JSON.stringify(arrangement);
    if (text === this.lastStored) return;
    this.lastStored = text;
    this.store.save(text);
  }

  // A view's document calls this once its quicktermView exists. Its iframe
  // fired "load" long before (the boot awaits the backend), so only now can
  // it be told whether it is the active view, and take the keyboard if it
  // was the one waiting for it.
  ready(target) {
    const view = this.viewFor(target);
    if (!view) return;
    view.markReady(true);
    try { view.frame.contentWindow.quicktermView.suspend(view !== this.active); } catch (_) { /* gone */ }
    if (this.pendingFocus === view) {
      this.pendingFocus = null;
      this.focusView(view);
    }
    window.quicktermChrome?.refreshSoon?.();
  }

  // Resolves true once the view's document has booted, false when the view
  // went away first or never answered.
  whenReady(view) {
    if (!view?.ready || !this.views().includes(view)) return Promise.resolve(false);
    if (this.appFor(view)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
      view.ready.then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  // ---- focus ----

  activate(target) {
    const view = this.viewFor(target);
    if (!view || this.active === view) return;
    this.active = view;
    for (const each of this.views()) {
      each.el.classList.toggle("active", each === view);
      try { each.frame?.contentWindow?.quicktermView?.suspend(each !== view); } catch (_) { /* loading */ }
    }
    this._persist();
    window.quicktermChrome?.refreshSoon?.();
  }

  // While a shell overlay (palette, panel, menu, sidebar confirm or rename)
  // owns the keyboard, the view only becomes active and waits as
  // pendingFocus: contentWindow.focus() would pull the keyboard out of the
  // overlay into the terminal behind it. The overlay's own hand-back focuses
  // the active view once it releases.
  focusView(view) {
    if (!view) return;
    this.activate(view);
    if (focusOwners().length) {
      this.pendingFocus = view;
      return;
    }
    if (this.pendingFocus === view) this.pendingFocus = null;
    try {
      view.frame.contentWindow.focus();
      view.frame.contentWindow.quicktermView?.app.refocusTerm();
    } catch (_) { /* not loaded yet */ }
  }

  _unzoomFor(view) {
    if (this.zoomed && this.zoomed !== view) {
      this.zoomed = null;
      this.layout();
    }
  }

  // The view showing `name`, brought back from zoom if needed. False when
  // no view shows it. A scratch view also answers to its label.
  focusWorkspace(name) {
    const view = this.viewForWorkspace(name) || this.scratchViewLabelled(name);
    if (!view) return false;
    this._unzoomFor(view);
    this.focusView(view);
    return true;
  }

  // The view whose pane shows session `id`, focused on that pane.
  focusSession(id) {
    const view = this.viewForSession(id);
    if (!view) return false;
    this._unzoomFor(view);
    this.focusView(view);
    this.appFor(view)?.focusSession(id);
    return true;
  }

  // The scratch view a person calls `label`, or null. Only scratch views:
  // a saved workspace is found by its name, never by a label.
  scratchViewLabelled(label) {
    if (!label) return null;
    return this.views().find((each) => isScratchWorkspace(this.workspaceOf(each)) && this.nameOf(each) === label) || null;
  }

  // ---- open / close / zoom ----

  // One operation at a time, in the order asked; a failure does not stop
  // the ones queued behind it.
  _serial(task) {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  // Opens `name` (null for a new scratch view) beside the active view, or
  // focuses the view that already shows it. Resolves with the view once its
  // document has booted, or false when nothing was opened.
  async open(name, options = {}) {
    const shown = name && this.viewForWorkspace(name);
    const view = shown ? this._focusShown(shown) : await this._serial(() => this._open(name, options));
    if (!view) return false;
    await this.whenReady(view);
    return view;
  }

  _focusShown(view) {
    this._unzoomFor(view);
    this.focusView(view);
    return view;
  }

  async _open(name, { anchorWindow = null, anchor = null, cwd = null, first = false } = {}) {
    // Another open of the same workspace may have finished while this waited.
    const shown = name && this.viewForWorkspace(name);
    if (shown) return this._focusShown(shown);
    const beside = this.viewFor(anchor || anchorWindow) || this.active;
    let view = null;
    try {
      view = await this._claimView(name, this.views().map((each) => each.color), { cwd, first });
      const from = !beside ? this._stageRect()
        : this.zoomed && this.zoomed !== beside ? this._rectOf(this.zoomed) : this._rectOf(beside);
      this.zoomed = null;
      this.root = insertBeside(this.root, beside, view, dwindleDir(from));
      this.stage.append(view.el);
      this.pendingFocus = view;
      this.layout({ entering: beside ? view : null, from });
      // The keyboard stays where it is until the new document can take it;
      // ready() hands it over.
      this.activate(beside || view);
    } catch (error) {
      this.error(error?.detail || (name
        ? `Could not open "${name}" here. It may already be open elsewhere.`
        : "Could not open a scratch view here."));
      return false;
    }
    return view;
  }

  // Claim `name` for a new view and build it, iframe included, without
  // placing it: the caller decides where it goes in the tree and appends it
  // to the stage exactly once. Throws when the registry refuses the claim.
  async _claimView(name, usedColors, { cwd = null, first = false } = {}) {
    // Reserve first: a failed registry must never create two layout writers.
    const parent = this.parentId() || undefined;
    const info = await api.registerWindow({ workspace: name || null, title: `View: ${name || "scratch"}`, parent });
    if (!info?.id) throw new Error("Missing workspace view identity");
    const id = String(info.id);
    const scratchLabels = window.quicktermChrome?.scratchLabels;
    const view = this._makeView({
      color: pickViewColor(usedColors, name),
      label: name || nextScratchLabel([
        ...this.names(), ...(scratchLabels?.values() || []), ...(this.reservedNames() || []),
      ]),
      id,
      workspace: name || `scratch-view-${id}`,
    });
    if (!name) scratchLabels?.set(view.workspace, view.label);
    view.frame = document.createElement("iframe");
    view.frame.title = `Workspace: ${view.label}`;
    view.frame.src = companionUrl(location.pathname, name, id, api.token(), { cwd, first });
    // The newest view is where the work is about to happen, so it gets the
    // keyboard once its document is ready (see ready()), exactly as a tiling
    // window manager focuses the window it just opened.
    view.frame.addEventListener("load", () => this.update());
    view.el.append(view.frame);
    return view;
  }

  // Rebuild a whole arrangement in one step, where open() would only place
  // one view by dwindle. `tree` is a split tree of {workspace} leaves, as
  // restorePlan() returns it. Each workspace is claimed through the same
  // registry path open() uses, one after another; a refused claim drops that
  // leaf and its split collapses. Views are built where they will stay: each
  // element is appended to the stage once and only its box is written
  // afterwards.
  rebuild(tree, options = {}) {
    return this._serial(() => this._rebuild(tree, options));
  }

  async _rebuild(tree, { active = null, zoomed = null } = {}) {
    const result = { restored: [], failed: [] };
    if (this.views().length || !tree) return result;
    const claimed = new Map();
    for (const descriptor of leaves(tree)) {
      const name = descriptor.workspace;
      try {
        // The iframe this view had before a reload is gone, but its claim
        // outlives it: its goodbye on pagehide rarely leaves in time, and
        // the registry keeps an entry for its whole TTL, so the claim below
        // was refused as "open in another window". The id was minted for
        // that view alone and nothing else holds it (a rebuild only runs
        // while no view is open), so releasing it is safe; after a real
        // restart the registry is empty and this is a no-op.
        if (descriptor.window) await api.unregisterWindow(descriptor.window).catch(() => {});
        const used = [...claimed.values()].map((view) => view.color);
        claimed.set(name, await this._claimView(name, used));
        result.restored.push(name);
      } catch (_) {
        result.failed.push(name);
      }
    }
    if (!claimed.size) return result;
    this.root = mapLeaves(tree, (descriptor) => claimed.get(descriptor.workspace) || null);
    for (const view of claimed.values()) this.stage.append(view.el);
    const find = (descriptor) => claimed.get(descriptor?.workspace) || null;
    this.zoomed = find(zoomed);
    const focused = find(active) || leaves(this.root)[0];
    this.layout({ animate: false });
    this.activate(focused);
    // An iframe cannot take the keyboard before its document exists;
    // ready() hands it over.
    this.pendingFocus = focused;
    return result;
  }

  // Once per boot: read the stored arrangement, rebuild what can come back,
  // and from then on keep the store current. Nothing is said about a view
  // that stayed away unless every one of them did. `stored` is true when a
  // version 2 record was there, which means the window was already migrated.
  async restoreSaved({ exists = () => true, rememberedWorkspace = null } = {}) {
    if (!this.store) return null;
    let result = { restored: [], failed: [], stored: false };
    try {
      const plan = restorePlan(this.store.load(), { exists, rememberedWorkspace });
      // Something was opened by hand before the restore got here; that wins.
      if (!plan || this.views().length) return result;
      result = { ...await this.rebuild(plan.tree, plan), stored: !plan.migrated };
      const gone = plan.skipped.filter((item) => item.reason === "missing").map((item) => item.workspace);
      const message = restoreFailureMessage(result.restored, [...gone, ...result.failed]);
      if (message) this.error(message);
    } finally {
      this.persisting = true;
      this._persist();
    }
    return result;
  }

  // Any view closes the same way: its document saves, retains its terminals
  // (a scratch view only those holding work, lifecycle.closeView) and
  // releases its claim, then the iframe goes. Nothing is killed.
  close(view) {
    return this._serial(() => this._close(view));
  }

  async _close(view) {
    if (!view || !this.views().includes(view)) return false;
    const child = view.frame?.contentWindow?.quicktermView;
    if (!child) {
      this.error("That workspace view is still loading. Try closing it again once it has loaded.");
      return false;
    }
    view.closeButton.disabled = true;
    try {
      if (!await child.close()) {
        this.error("That workspace is switching. Wait for it to finish before closing its view.");
        return false;
      }
      // The view that inherits the space inherits the keyboard.
      const parent = findLeaf(this.root, view)?.parent;
      const heir = parent ? leaves(parent.children.find((node) => node.pane !== view))[0] : null;
      this.root = removeLeaf(this.root, view);
      if (this.zoomed === view) this.zoomed = null;
      view.markReady(false);
      const wasActive = this.active === view;
      if (wasActive) this.active = null;
      this.layout({ leaving: view });
      if (wasActive && heir) this.focusView(heir);
      window.quicktermChrome?.refreshSoon?.();
      return true;
    } catch (error) {
      this.error(error?.detail || "Could not save that workspace. Its view remains open.");
      return false;
    } finally {
      view.closeButton.disabled = false;
    }
  }

  // One view over the whole window, the others kept alive but hidden; the
  // same gesture again brings them back. Opening a new view unzooms.
  zoom(view) {
    const target = this.viewFor(view) || this.active;
    if (!target) return;
    this.zoomed = this.zoomed === target ? null : target;
    this.layout();
    this.focusView(target);
  }

  // Drop `view` on `target`: a side docks it there, the middle swaps the two.
  moveView(view, target, zone) {
    const root = movePaneNode(this.root, view, target, zone);
    if (!root) return false;
    this.root = root;
    this.layout();
    this.focusView(view);
    return true;
  }

  // ---- geometry ----

  _stageRect() {
    const box = this.stage.getBoundingClientRect();
    const inset = this.views().length > 1 ? STAGE_INSET : 0;
    return {
      left: inset,
      top: inset,
      width: Math.max(0, box.width - 2 * inset),
      height: Math.max(0, box.height - 2 * inset),
    };
  }

  _rectOf(view) {
    const box = view.el.getBoundingClientRect();
    const stage = this.stage.getBoundingClientRect();
    return { left: box.left - stage.left, top: box.top - stage.top, width: box.width, height: box.height };
  }

  // Writes every view's and divider's box. `entering` starts at `from` (the
  // box of the view it split off) and slides to its own; `leaving` fades and
  // is removed once the others have slid over it.
  layout({ animate = true, entering = null, from = null, leaving = null, persist = true } = {}) {
    const views = this.views();
    const multiple = views.length > 1;
    const stage = this._stageRect();
    const still = !animate || reducedMotion();
    this.stage.classList.toggle("multiple", multiple);
    this.stage.classList.toggle("zoomed", Boolean(this.zoomed));
    this.stage.classList.toggle("still", still);
    this.stage.classList.toggle("empty", !views.length);
    this.empty.hidden = views.length > 0;
    if (leaving) {
      leaving.el.classList.add("leaving");
      leaving.el.hidden = still;
      setTimeout(() => leaving.el.remove(), still ? 0 : SLIDE_MS);
    }
    const seen = new Set();
    if (this.zoomed && views.includes(this.zoomed)) {
      for (const view of views) {
        view.el.hidden = view !== this.zoomed;
        view.zoomButton.replaceChildren(icon(view === this.zoomed ? "minimize" : "maximize", 14));
        view.zoomButton.title = view === this.zoomed
          ? "Show every workspace view again" : "Show only this workspace view";
        view.zoomButton.setAttribute("aria-label", view.zoomButton.title);
      }
      applyRect(this.zoomed.el, stage);
    } else {
      this.zoomed = null;
      const { leaves: boxes, dividers } = layoutRects(this.root, stage, multiple ? DIVIDER_PX : 0,
        { min: VIEW_RATIO_MIN / 100, max: VIEW_RATIO_MAX / 100 });
      for (const view of views) {
        const box = boxes.get(view);
        view.el.hidden = false;
        view.zoomButton.replaceChildren(icon("maximize", 14));
        view.zoomButton.title = "Show only this workspace view";
        view.zoomButton.setAttribute("aria-label", view.zoomButton.title);
        if (view === entering && from && !still) {
          view.el.classList.add("entering");
          applyRect(view.el, from);
          void view.el.offsetWidth; // commit the start box before the slide
          view.el.classList.remove("entering");
        }
        applyRect(view.el, box);
      }
      for (const divider of dividers) {
        const el = this._dividerFor(divider.node);
        divider.node.box = divider.box;
        seen.add(el);
        el.hidden = false;
        el.classList.toggle("h", divider.node.dir !== "v");
        el.classList.toggle("v", divider.node.dir === "v");
        el.setAttribute("aria-orientation", divider.node.dir === "v" ? "horizontal" : "vertical");
        el.setAttribute("aria-valuenow", String(Math.round(divider.node.ratio * 100)));
        applyRect(el, divider);
      }
    }
    for (const el of this.stage.querySelectorAll(".workspace-view-divider")) {
      if (!seen.has(el)) el.remove();
    }
    requestAnimationFrame(() => this.fit());
    if (!still) setTimeout(() => this.fit(), SLIDE_MS + 20);
    if (persist) this._persist();
  }

  _dividerFor(node) {
    if (node.divider && node.divider.isConnected) return node.divider;
    const el = document.createElement("div");
    el.className = "workspace-view-divider";
    el.tabIndex = 0;
    el.setAttribute("role", "separator");
    el.setAttribute("aria-label", "Resize workspace views");
    el.setAttribute("aria-valuemin", String(VIEW_RATIO_MIN));
    el.setAttribute("aria-valuemax", String(VIEW_RATIO_MAX));
    el.title = "Drag to resize · arrow keys resize · double-click balances";
    this._wireDivider(el, node);
    node.divider = el;
    this.stage.append(el);
    return el;
  }

  _setRatio(node, percent) {
    node.ratio = clampViewRatio(percent) / 100;
    this.layout();
  }

  _wireDivider(el, node) {
    el.addEventListener("keydown", (event) => {
      const vertical = node.dir === "v";
      const decrease = vertical ? "ArrowUp" : "ArrowLeft";
      const increase = vertical ? "ArrowDown" : "ArrowRight";
      if (![decrease, increase, "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const now = node.ratio * 100;
      this._setRatio(node, event.key === "Home" ? VIEW_RATIO_MIN
        : event.key === "End" ? VIEW_RATIO_MAX
          : now + (event.key === decrease ? -5 : 5));
    });
    el.addEventListener("dblclick", () => this._setRatio(node, 50));
    el.addEventListener("pointerdown", (down) => {
      if (down.button !== 0) return;
      down.preventDefault();
      const vertical = node.dir === "v";
      // The split's box, from the divider's own position: the divider sits at
      // the ratio point, so the box is whatever layoutRects last gave it.
      const box = node.box;
      if (!box) return;
      const total = vertical ? box.height : box.width;
      if (!(total > 0)) return;
      const { min, max } = ratioBounds(total);
      try { el.setPointerCapture(down.pointerId); } catch (_) { /* old WebView */ }
      this.stage.classList.add("resizing");
      document.body.classList.add("dragging");
      const move = (event) => {
        const stage = this.stage.getBoundingClientRect();
        const pos = vertical ? event.clientY - stage.top - box.top : event.clientX - stage.left - box.left;
        node.ratio = Math.min(max, Math.max(min, (pos - DIVIDER_PX / 2) / (total - DIVIDER_PX)));
        // Stored once, where the drag ends, not on every pointer move.
        this.layout({ animate: false, persist: false });
      };
      const stop = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", stop);
        el.removeEventListener("lostpointercapture", stop);
        this.stage.classList.remove("resizing");
        document.body.classList.remove("dragging");
        this.fit();
        this._persist();
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", stop);
      el.addEventListener("lostpointercapture", stop);
    });
  }

  // ---- the view element ----

  // The one block an empty stage shows. It is content, not a chrome bar.
  _emptyState(newScratch) {
    const block = document.createElement("div");
    block.className = "workspace-views-empty";
    const text = document.createElement("p");
    text.textContent = EMPTY_STAGE_TEXT;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "New scratch";
    button.title = "Open a new scratch view";
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", () => newScratch());
    block.append(text, button);
    return block;
  }

  _makeView({ color, label, id = null, workspace = null }) {
    const view = { id, color, label, workspace, frame: null };
    view.ready = new Promise((resolve) => { view.markReady = resolve; });
    view.el = document.createElement("section");
    view.el.className = "workspace-view";
    view.el.style.setProperty("--workspace-color", color);
    view.header = document.createElement("header");
    view.header.className = "workspace-view-heading";
    view.header.title = "Drag to move this workspace view";
    const dot = document.createElement("span");
    dot.className = "workspace-view-dot";
    view.nameEl = document.createElement("strong");
    view.nameEl.textContent = label;
    view.zoomButton = this._button("maximize", "Show only this workspace view", () => this.zoom(view));
    view.closeButton = this._button("x", "Save and close this view; its terminals keep running", () => this.close(view));
    view.header.append(dot, view.nameEl, view.zoomButton, view.closeButton);
    view.el.addEventListener("pointerdown", () => this.activate(view), true);
    view.el.append(view.header);
    this._wireDrag(view);
    return view;
  }

  _button(label, title, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.append(icon(label, 14));
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      action();
    });
    return button;
  }

  // The header is the handle, like a pane's tab: a few pixels of travel
  // start a drag, Escape cancels, and the zone under the pointer is the
  // outer band of another view (dock there) or its middle (swap).
  _wireDrag(view) {
    view.header.addEventListener("pointerdown", (down) => {
      if (down.button !== 0 || down.target.closest("button")) return;
      const startX = down.clientX;
      const startY = down.clientY;
      const pointerId = down.pointerId;
      let dragging = false;
      let hint = null;
      let ghost = null;
      let preview = null;
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", stop);
        window.removeEventListener("keydown", key, true);
        if (!dragging) return;
        dragging = false;
        try { view.header.releasePointerCapture(pointerId); } catch (_) { /* already released */ }
        this.stage.classList.remove("resizing");
        document.body.classList.remove("dragging", "pane-dragging");
        ghost.remove();
        preview.remove();
      };
      const move = (event) => {
        if (!dragging) {
          if (Math.hypot(event.clientX - startX, event.clientY - startY) < DRAG_START_PX) return;
          if (this.views().length < 2 || this.zoomed) return;
          dragging = true;
          try { view.header.setPointerCapture(pointerId); } catch (_) { /* old WebView */ }
          // Iframes swallow pointer events; while dragging they must not.
          this.stage.classList.add("resizing");
          document.body.classList.add("dragging", "pane-dragging");
          ghost = document.createElement("div");
          ghost.className = "pane-drag-ghost";
          ghost.textContent = this.nameOf(view);
          preview = document.createElement("div");
          preview.className = "pane-drop-hint";
          preview.hidden = true;
          document.body.append(ghost, preview);
        }
        ghost.style.left = `${Math.max(0, Math.min(event.clientX + 12, window.innerWidth - ghost.offsetWidth - 4))}px`;
        ghost.style.top = `${Math.max(0, Math.min(event.clientY + 12, window.innerHeight - ghost.offsetHeight - 4))}px`;
        hint = this._dropHint(view, event.clientX, event.clientY);
        preview.hidden = !hint;
        if (!hint) return;
        const box = zoneRect(hint.rect, hint.zone);
        preview.style.left = `${box.left}px`;
        preview.style.top = `${box.top}px`;
        preview.style.width = `${box.width}px`;
        preview.style.height = `${box.height}px`;
        preview.dataset.zone = hint.zone;
      };
      const up = () => {
        const drop = dragging ? hint : null;
        stop();
        if (drop) this.moveView(view, drop.target, drop.zone);
      };
      const key = (event) => {
        if (event.key !== "Escape" || !dragging) return;
        event.preventDefault();
        event.stopPropagation();
        stop();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", stop);
      window.addEventListener("keydown", key, true);
    });
  }

  _dropHint(dragged, x, y) {
    for (const target of this.views()) {
      if (target === dragged || target.el.hidden) continue;
      const rect = target.el.getBoundingClientRect();
      const zone = dropZone(rect, x, y);
      if (zone) return { target, zone, rect };
    }
    return null;
  }
}
