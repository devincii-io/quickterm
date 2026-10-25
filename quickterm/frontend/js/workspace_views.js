// The stage: the window shows one workspace at a time, chosen in the sidebar.
//
// The window's own document is the shell: it hosts no workspace. Every
// workspace, scratch included, is a same-origin iframe view running the app on
// that one workspace, with its own layout, autosave, registry claim and
// heartbeat. Any number of views can be open (loaded) in one window; exactly
// one is shown, full size. The others stay loaded and keep their box, hidden
// with `visibility: hidden` and `inert`, so xterm keeps its size, and each is
// told `setHidden(true)` so its panes release their WebGL renderers.
//
// One rule shapes the DOM here: an iframe that moves in the DOM reloads its
// document, terminals and all. So a view element is appended to the stage
// once and never moved; showing another workspace only flips classes.

import * as api from "./api.js";
import { isScratchWorkspace } from "./boot_context.js";
import { focusOwners } from "./focus.js";
import { readStoredViews, restoreFailureMessage, restorePlan, describeOpenViews } from "./open_views.js";

export {
  OPEN_VIEWS_KEY, LEGACY_ARRANGEMENT_KEY, describeOpenViews, migrateArrangement, openViewsStore,
  parseOpenViews, readStoredViews, restoreFailureMessage, restorePlan,
} from "./open_views.js";

// Theme tokens, not literals: applyChromeTheme() sets --view-1..6 from the
// theme's ANSI hues. The sidebar's dot for an open workspace uses them.
export const VIEW_COLORS = ["--view-1", "--view-2", "--view-3", "--view-4", "--view-5", "--view-6"]
  .map((token) => `var(${token})`);
export const EMPTY_STAGE_TEXT = "No workspace open. Open one from the sidebar.";
export const SCRATCH_LABEL = "scratch";
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

// The sidebar's order: saved workspaces by name (case ignored, numbers as
// numbers), scratch last. Next and previous workspace walk it.
export function sidebarOrder(names) {
  const named = names.filter((name) => !isScratchWorkspace(name))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
  return [...named, ...names.filter((name) => isScratchWorkspace(name))];
}

// What Ctrl+Shift+1..9 count: the workspace groups the sidebar draws, in its
// order, skipping Unassigned and a closed scratch's leftovers (nothing to
// show there). A sidebar not grouped by workspace has no such list; the open
// views in sidebar order stand in.
export function workspaceSlots(groups = [], openNames = []) {
  const named = groups
    .filter((group) => group?.name && (group.kind === "workspace" || (group.kind === "scratch" && group.open)))
    .map((group) => group.name);
  return (named.length ? named : sidebarOrder(openNames)).slice(0, 9);
}

export class WorkspaceViews {
  // `store` (openViewsStore) is given only to the window whose open views
  // outlive a restart. It stays silent until restoreSaved() has read it, so
  // an early boot cannot erase what it is about to restore. `fit` re-fits
  // the shown view's terminals; `newScratch` is the empty stage's button.
  // `parentId` is this shell window's registry id: every view registers
  // under it, so closing the native window frees the views' claims at once.
  constructor({ fit = () => {}, error, store = null, newScratch = null, parentId = () => null }) {
    this.fit = fit;
    this.error = error;
    this.store = store;
    this.parentId = parentId;
    // Opens, closes and restores run one after another. Refusing while one
    // was running dropped a sidebar click or an Explorer handoff silently.
    this.queue = Promise.resolve();
    this.persisting = false;
    this.lastStored = undefined;
    this.items = [];
    // Most recently shown last; closing the shown view falls back along it.
    this.recent = [];
    this.active = null;
    this.pendingFocus = null;
    this.stage = document.createElement("div");
    this.stage.className = "workspace-views";
    // The shell document hosts no workspace: its own terminal grid gives its
    // place in the window to the stage.
    const shell = document.querySelector("#app > .workspace-shell");
    shell.before(this.stage);
    shell.remove();
    this.empty = this._emptyState(newScratch || (() => this.open(null)));
    this.stage.append(this.empty);
    this._paint();
  }

  // ---- what is open ----

  views() {
    return [...this.items];
  }

  // `target` is a view or a child window (the iframe's contentWindow, which
  // is how an embedded document names itself).
  viewFor(target) {
    if (!target) return null;
    if (target.el) return this.items.includes(target) ? target : null;
    return this.items.find((view) => view.frame?.contentWindow === target) || null;
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

  // What a person calls the view: the workspace name, or "scratch".
  nameOf(view) {
    const name = this.workspaceOf(view);
    return name && !isScratchWorkspace(name) ? name : SCRATCH_LABEL;
  }

  viewForWorkspace(name) {
    if (!name) return null;
    return this.items.find((view) => this.workspaceOf(view) === name) || null;
  }

  // The window's one scratch view, or null.
  scratchView() {
    return this.items.find((view) => isScratchWorkspace(this.workspaceOf(view))) || null;
  }

  viewForSession(id) {
    if (!id) return null;
    return this.items.find((view) => (this.appFor(view)?.attachedSessionIds?.() || []).includes(id)) || null;
  }

  // For the sidebar and the palette: which workspace each view shows, its
  // label and colour, whether it is the shown one, and its child window.
  list() {
    return this.items.map((view) => ({
      workspace: this.workspaceOf(view),
      label: this.nameOf(view),
      color: viewColorFor(this.nameOf(view)),
      active: view === this.active,
      window: view.frame?.contentWindow || null,
    }));
  }

  update() {
    for (const view of this.items) {
      const name = this.nameOf(view);
      view.el.setAttribute("aria-label", `Workspace: ${name}`);
      if (view.frame) view.frame.title = `Workspace: ${name}`;
    }
    // A scratch view promoted to a named workspace renames itself in place,
    // and the stored list has to follow the name.
    this._persist();
  }

  _persist() {
    if (!this.store || !this.persisting) return;
    const text = JSON.stringify(describeOpenViews(this.items, this.active, (view) => this.workspaceOf(view)));
    if (text === this.lastStored) return;
    this.lastStored = text;
    this.store.save(text);
  }

  // A view's document calls this once its quicktermView exists. Its iframe
  // fired "load" long before (the boot awaits the backend), so only now can
  // it be told whether it is shown, and take the keyboard if it was the one
  // waiting for it.
  ready(target) {
    const view = this.viewFor(target);
    if (!view) return;
    view.markReady(true);
    try { view.frame.contentWindow.quicktermView.suspend(view !== this.active); } catch (_) { /* gone */ }
    view.toldHidden = undefined; // a fresh document knows nothing yet
    this._tellHidden(view);
    if (this.pendingFocus === view) {
      this.pendingFocus = null;
      this.focusView(view);
    }
    window.quicktermChrome?.refreshSoon?.();
  }

  // Resolves true once the view's document has booted, false when the view
  // went away first or never answered.
  whenReady(view) {
    if (!view?.ready || !this.items.includes(view)) return Promise.resolve(false);
    if (this.appFor(view)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
      view.ready.then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  // ---- showing one ----

  // Show `target` and hide every other view. The keyboard is not moved
  // here; focusView() does that.
  activate(target) {
    const view = this.viewFor(target);
    if (!view || this.active === view) return;
    this.active = view;
    this.recent = [...this.recent.filter((each) => each !== view), view];
    for (const each of this.items) {
      try { each.frame?.contentWindow?.quicktermView?.suspend(each !== view); } catch (_) { /* loading */ }
    }
    this._paint();
    this._persist();
    window.quicktermChrome?.refreshSoon?.();
  }

  // While a shell overlay (palette, panel, menu, sidebar confirm or rename)
  // owns the keyboard, the view is only shown and waits as pendingFocus:
  // contentWindow.focus() would pull the keyboard out of the overlay into the
  // terminal behind it. The overlay's own hand-back focuses the shown view
  // once it releases.
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

  // The view showing `name`, shown and focused. False when no view shows it.
  focusWorkspace(name) {
    const view = this.viewForWorkspace(name);
    if (!view) return false;
    this.focusView(view);
    return true;
  }

  // The view whose pane shows session `id`, shown and focused on that pane.
  focusSession(id) {
    const view = this.viewForSession(id);
    if (!view) return false;
    this.focusView(view);
    this.appFor(view)?.focusSession(id);
    return true;
  }

  // The next (1) or previous (-1) open workspace in sidebar order, wrapping.
  cycle(delta) {
    if (this.items.length < 2) return false;
    const order = sidebarOrder(this.items.map((view) => this.workspaceOf(view)));
    const at = order.indexOf(this.active ? this.workspaceOf(this.active) : null);
    const next = order[(at + (delta < 0 ? order.length - 1 : 1)) % order.length];
    this.focusView(this.viewForWorkspace(next));
    return true;
  }

  // The nth (1-based) of `slots` (workspaceSlots), shown and focused; a saved
  // workspace that is not open yet opens, as a sidebar click would.
  async showSlot(slots, n) {
    const name = slots[n - 1];
    if (!name) return false;
    if (isScratchWorkspace(name)) return this.focusWorkspace(name);
    return Boolean(await this.open(name));
  }

  // ---- open / close ----

  // One operation at a time, in the order asked; a failure does not stop
  // the ones queued behind it.
  _serial(task) {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  // Shows `name` (null for the window's scratch view), opening it first when
  // it is not open yet. With `cwd` on scratch, a scratch view already open
  // starts a terminal there; a new one starts its first terminal there.
  // Resolves with the view once its document has booted, or false when
  // nothing was opened.
  async open(name, options = {}) {
    const view = await this._serial(() => this._open(name, options));
    if (!view) return false;
    await this.whenReady(view);
    return view;
  }

  async _open(name, { cwd = null, first = false } = {}) {
    const shown = name ? this.viewForWorkspace(name) : this.scratchView();
    if (shown) {
      this.focusView(shown);
      if (!name && cwd) this._startIn(shown, cwd);
      return shown;
    }
    try {
      const view = await this._claimView(name, { cwd, first });
      this._place(view);
      // The keyboard goes in once the new document can take it.
      this.pendingFocus = view;
      this.activate(view);
      return view;
    } catch (error) {
      this.error(error?.detail || (name
        ? `Could not open "${name}" here. It may already be open elsewhere.`
        : "Could not open the scratch workspace here."));
      return false;
    }
  }

  // Explorer's folder, in the scratch view that is already open.
  async _startIn(view, cwd) {
    const app = await this.whenReady(view) ? this.appFor(view) : null;
    try {
      if (app?.startLaunch && await app.startLaunch({ cwd })) return;
    } catch (_) { /* reported below */ }
    this.error(`Could not open "${cwd}" in a terminal. The request was dropped.`);
  }

  // Claim `name` for a new view and build it, iframe included, without
  // placing it. Throws when the registry refuses the claim.
  async _claimView(name, { cwd = null, first = false } = {}) {
    // Reserve first: a failed registry must never create two layout writers.
    const parent = this.parentId() || undefined;
    const info = await api.registerWindow({ workspace: name || null, title: `View: ${name || SCRATCH_LABEL}`, parent });
    if (!info?.id) throw new Error("Missing workspace view identity");
    const id = String(info.id);
    const view = { id, workspace: name || `scratch-view-${id}`, frame: null };
    view.ready = new Promise((resolve) => { view.markReady = resolve; });
    if (!name) window.quicktermChrome?.scratchLabels?.set(view.workspace, SCRATCH_LABEL);
    view.el = document.createElement("section");
    view.el.className = "workspace-view";
    view.frame = document.createElement("iframe");
    view.frame.title = `Workspace: ${name || SCRATCH_LABEL}`;
    view.frame.src = companionUrl(location.pathname, name, id, api.token(), { cwd, first });
    view.frame.addEventListener("load", () => this.update());
    view.el.append(view.frame);
    return view;
  }

  // Appended once, never moved again.
  _place(view) {
    this.items.push(view);
    this.stage.append(view.el);
  }

  // Any view closes the same way: its document saves, retains its terminals
  // (a scratch view only those holding work, lifecycle.closeView) and
  // releases its claim, then the iframe goes. Nothing is killed. Closing the
  // shown view shows the one shown before it, or the empty stage.
  close(view) {
    return this._serial(() => this._close(view));
  }

  async _close(view) {
    if (!view || !this.items.includes(view)) return false;
    const child = view.frame?.contentWindow?.quicktermView;
    if (!child) {
      this.error("That workspace is still loading. Try closing it again once it has loaded.");
      return false;
    }
    try {
      if (!await child.close()) {
        this.error("That workspace is switching. Wait for it to finish before closing it.");
        return false;
      }
    } catch (error) {
      this.error(error?.detail || "Could not save that workspace. It stays open.");
      return false;
    }
    this.items = this.items.filter((each) => each !== view);
    this.recent = this.recent.filter((each) => each !== view);
    if (this.pendingFocus === view) this.pendingFocus = null;
    view.markReady(false);
    view.el.remove();
    // Terminals a closed scratch kept are listed under "scratch <id>", so
    // they never read as the scratch view opened next.
    window.quicktermChrome?.scratchLabels?.delete(view.workspace);
    if (this.active === view) {
      this.active = null;
      const heir = this.recent.at(-1) || this.items.at(-1) || null;
      if (heir) this.focusView(heir);
    }
    this._paint();
    this._persist();
    window.quicktermChrome?.refreshSoon?.();
    return true;
  }

  // ---- across restarts ----

  // A reload leaves the previous page's views registered under this window
  // until their TTL runs out: their goodbye on pagehide rarely leaves in
  // time, and a new claim on the same workspace would be refused as "open in
  // another window". Nothing else registers under this window's id, so
  // every child that is not one of ours now is a leftover.
  async releaseLeftovers() {
    const parent = this.parentId();
    if (!parent) return;
    let listed = [];
    try { listed = await api.listWindows(); } catch (_) { return; }
    const entries = Array.isArray(listed) ? listed : Array.isArray(listed?.windows) ? listed.windows : [];
    const ours = new Set(this.items.map((view) => view.id));
    await Promise.all(entries
      .filter((entry) => entry?.parent === parent && !ours.has(String(entry.id)))
      .map((entry) => api.unregisterWindow(String(entry.id)).catch(() => {})));
  }

  // Once per boot: read what was open, open what can come back in the order
  // it was opened, show the one that was shown, and from then on keep the
  // store current. Nothing is said about a view that stayed away unless
  // every one of them did. `stored` is true when a record was there (either
  // key), so the 3.x remembered workspace must not be consulted again.
  async restoreSaved({ exists = () => true, rememberedWorkspace = null } = {}) {
    if (!this.store) return null;
    const result = { restored: [], failed: [], stored: false };
    try {
      const saved = readStoredViews(this.store, { rememberedWorkspace });
      result.stored = saved.stored;
      const plan = restorePlan(saved.record, { exists });
      // Something was opened by hand before the restore got here; that wins.
      if (!plan || this.items.length) return result;
      await this._serial(() => this._restore(plan, result));
      const gone = plan.skipped.map((item) => item.workspace);
      const message = restoreFailureMessage(result.restored, [...gone, ...result.failed]);
      if (message) this.error(message);
    } finally {
      this.persisting = true;
      this._persist();
    }
    return result;
  }

  async _restore(plan, result) {
    if (this.items.length) return;
    const byName = new Map();
    for (const name of plan.open) {
      try {
        const view = await this._claimView(name || null);
        this._place(view);
        byName.set(name, view);
        result.restored.push(name);
      } catch (_) {
        result.failed.push(name);
      }
    }
    const shown = byName.get(plan.shown) || this.items[0];
    if (!shown) return;
    // An iframe cannot take the keyboard before its document exists;
    // ready() hands it over.
    this.pendingFocus = shown;
    this.activate(shown);
  }

  // ---- drawing ----

  // Every view keeps the full stage box; only the shown one is visible.
  _paint() {
    this.stage.classList.toggle("empty", !this.items.length);
    this.empty.hidden = this.items.length > 0;
    for (const view of this.items) {
      const shown = view === this.active;
      view.el.classList.toggle("shown", shown);
      view.el.inert = !shown;
      this._tellHidden(view);
    }
  }

  // A hidden view lets its panes release their WebGL renderers (pane.js
  // setOffscreen). Its document cannot tell on its own: `visibility` on the
  // view element changes neither the iframe's visibilityState nor anything
  // it can observe reliably. A view still booting is told by ready().
  _tellHidden(view) {
    const hidden = view !== this.active;
    if (view.toldHidden === hidden) return;
    try {
      const child = view.frame?.contentWindow?.quicktermView;
      if (!child?.setHidden) return;
      child.setHidden(hidden);
      view.toldHidden = hidden;
    } catch (_) { /* loading or gone */ }
  }

  // The one block an empty stage shows. It is content, not a chrome bar.
  _emptyState(newScratch) {
    const block = document.createElement("div");
    block.className = "workspace-views-empty";
    const text = document.createElement("p");
    text.textContent = EMPTY_STAGE_TEXT;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "New scratch";
    button.title = "Open the scratch workspace";
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", () => newScratch());
    block.append(text, button);
    return block;
  }
}
