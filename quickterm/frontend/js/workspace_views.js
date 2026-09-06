// Several workspaces in one window, tiled like the panes inside them.
//
// The primary view is this document (#app). Every other view is a same-origin
// iframe running the same app on another workspace, with its own layout,
// autosave, registry claim and heartbeat. The views are leaves of the same
// split tree the panes use (split_tree.js), so a new one takes half of the
// active view along its longer side, a header drag docks it beside another
// view or swaps the two (pane_move.js), and a divider drag or its arrow keys
// change one ratio.
//
// One rule shapes the DOM here: an iframe that moves in the DOM reloads its
// document, terminals and all. So views are never re-parented. Every view
// and divider is absolutely positioned inside the stage, and a layout change
// only writes left/top/width/height. The CSS transition on those four
// properties is what makes a split, a move or a close slide into place.

import * as api from "./api.js";
import { claimFocus, releaseFocus } from "./focus.js";
import { dropZone, movePaneNode, zoneRect } from "./pane_move.js";
import { dwindleDir, insertBeside, layoutRects, leaves, removeLeaf } from "./split_tree.js";

export const VIEW_COLORS = ["#d4ad63", "#6daedb", "#8fcf8a", "#c78fd6", "#e0907a", "#6fc7c2"];
export const VIEW_RATIO_MIN = 15;
export const VIEW_RATIO_MAX = 85;
// The narrowest a divider drag may make a view, when the window has the room.
export const VIEW_MIN_PX = 160;
const DIVIDER_PX = 10;
const STAGE_INSET = 6;
const SLIDE_MS = 240;
const DRAG_START_PX = 6;

export function companionUrl(path, workspace, id, token) {
  const query = new URLSearchParams({ workspace, window: id, embedded: "1" });
  return `${path || "/"}?${query}#t=${encodeURIComponent(token || "")}`;
}

export function clampViewRatio(value) {
  return Math.max(VIEW_RATIO_MIN, Math.min(VIEW_RATIO_MAX, Number.isFinite(value) ? value : 50));
}

// The first palette colour no open view uses; past six views they repeat.
export function pickViewColor(used = []) {
  const taken = new Set(used);
  return VIEW_COLORS.find((color) => !taken.has(color)) || VIEW_COLORS[used.length % VIEW_COLORS.length];
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
  constructor({ current, focus, fit, error }) {
    this.current = current;
    this.focus = focus;
    this.fit = fit;
    this.error = error;
    this.busy = false;
    this.zoomed = null;
    this.companionClaimed = false;
    this.stage = document.createElement("div");
    this.stage.className = "workspace-views";
    const app = document.getElementById("app");
    app.before(this.stage);
    this.primary = this._makeView({ primary: true, color: VIEW_COLORS[0], label: current() || "scratch" });
    this.primary.el.append(app);
    this.stage.append(this.primary.el);
    this.root = { type: "pane", pane: this.primary };
    this.active = this.primary;
    this.primary.el.addEventListener("pointerdown", () => this.activate(this.primary), true);
    this.primary.el.addEventListener("focusin", () => this.activate(this.primary));
    window.addEventListener("resize", () => this.layout({ animate: false }));
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(() => this.layout({ animate: false })).observe(this.stage);
    }
    this.layout({ animate: false });
    this.update();
  }

  // ---- what is open ----

  views() {
    return leaves(this.root);
  }

  viewFor(target) {
    if (!target || target === window || target === this.primary) return this.primary;
    if (target.el) return this.views().includes(target) ? target : null;
    return this.views().find((view) => view.frame?.contentWindow === target) || null;
  }

  nameOf(view) {
    if (view.primary) return this.current() || "scratch";
    const child = view.frame?.contentWindow?.quicktermView;
    return (child ? child.workspace() : view.label) || "scratch";
  }

  names() {
    return this.views().map((view) => this.nameOf(view));
  }

  // For the sidebar's workspace menu: which workspace each view shows, its
  // colour, and whether it is the one the keyboard is in.
  list() {
    return this.views().map((view) => ({
      name: this.nameOf(view),
      color: view.color,
      primary: view.primary,
      active: view === this.active,
    }));
  }

  update() {
    for (const view of this.views()) {
      const name = this.nameOf(view);
      view.nameEl.textContent = name;
      view.el.setAttribute("aria-label", `Workspace view: ${name}`);
      if (view.frame) view.frame.title = `Workspace: ${name}`;
    }
  }

  // ---- focus ----

  // `target` is a view, a child window (the iframe's contentWindow, which is
  // how an embedded document names itself) or null for the primary.
  activate(target) {
    const view = this.viewFor(target) || this.primary;
    if (this.active === view) return;
    this.active = view;
    const secondary = !view.primary;
    if (secondary && !this.companionClaimed) claimFocus("companion");
    if (!secondary && this.companionClaimed) releaseFocus("companion");
    this.companionClaimed = secondary;
    for (const each of this.views()) {
      each.el.classList.toggle("active", each === view);
      each.frame?.contentWindow?.quicktermView?.suspend(each !== view);
    }
  }

  focusView(view) {
    this.activate(view);
    if (view.primary) this.focus();
    else {
      try { view.frame.contentWindow.focus(); } catch (_) { /* not loaded yet */ }
    }
  }

  // The view showing `name`, brought back from zoom if needed. False when
  // no view shows it.
  focusWorkspace(name) {
    const view = this.views().find((each) => this.nameOf(each) === name);
    if (!view) return false;
    if (this.zoomed && this.zoomed !== view) {
      this.zoomed = null;
      this.layout();
    }
    this.focusView(view);
    return true;
  }

  // ---- open / close / zoom ----

  async open(name, { anchorWindow = null, anchor = null } = {}) {
    if (this.busy) return false;
    if (!name) return false;
    const shown = this.views().find((view) => this.nameOf(view) === name);
    if (shown) {
      this.zoomed = null;
      this.layout();
      this.focusView(shown);
      this.error(`“${name}” is already shown in this window.`);
      return false;
    }
    const beside = this.viewFor(anchor || anchorWindow) || this.active || this.primary;
    this.busy = true;
    try {
      // Reserve first: a failed registry must never create two layout writers.
      const info = await api.registerWindow({ workspace: name, title: `Side view: ${name}` });
      if (!info?.id) throw new Error("Missing workspace view identity");
      const view = this._makeView({
        primary: false,
        color: pickViewColor(this.views().map((each) => each.color)),
        label: name,
        id: String(info.id),
      });
      view.frame = document.createElement("iframe");
      view.frame.title = `Workspace: ${name}`;
      view.frame.src = companionUrl(location.pathname, name, info.id, api.token());
      view.frame.addEventListener("load", () => {
        this.update();
        // The newest view is where the work is about to happen, so it gets
        // the keyboard, exactly as a tiling window manager focuses the window
        // it just opened.
        if (this.pendingFocus === view) {
          this.pendingFocus = null;
          this.focusView(view);
        }
      });
      view.el.append(view.frame);
      const from = this.zoomed && this.zoomed !== beside
        ? this._rectOf(this.zoomed)
        : this._rectOf(beside);
      this.zoomed = null;
      this.root = insertBeside(this.root, beside, view, dwindleDir(from));
      this.stage.append(view.el);
      this.pendingFocus = view;
      this.layout({ entering: view, from });
      this.activate(beside);
      return true;
    } catch (error) {
      this.error(error?.detail || `Could not open “${name}” here. It may already be open elsewhere.`);
      return false;
    } finally {
      this.busy = false;
    }
  }

  async close(view) {
    if (!view || view.primary || this.busy || !this.views().includes(view)) return false;
    const child = view.frame?.contentWindow?.quicktermView;
    if (!child) {
      this.error("That workspace view is still loading. Try closing it again once it has loaded.");
      return false;
    }
    this.busy = true;
    view.closeButton.disabled = true;
    try {
      if (!await child.close()) {
        this.error("That workspace is switching. Wait for it to finish before closing its view.");
        return false;
      }
      this.root = removeLeaf(this.root, view);
      if (this.zoomed === view) this.zoomed = null;
      if (this.active === view) this.activate(this.primary);
      this.layout({ leaving: view });
      this.focus();
      return true;
    } catch (error) {
      this.error(error?.detail || "Could not save that workspace. Its view remains open.");
      return false;
    } finally {
      this.busy = false;
      view.closeButton.disabled = false;
    }
  }

  // One view over the whole window, the others kept alive but hidden; the
  // same gesture again brings them back. Opening a new view unzooms.
  zoom(view) {
    const target = this.viewFor(view) || this.active;
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
  layout({ animate = true, entering = null, from = null, leaving = null } = {}) {
    const views = this.views();
    const multiple = views.length > 1;
    const stage = this._stageRect();
    const still = !animate || reducedMotion();
    this.stage.classList.toggle("multiple", multiple);
    this.stage.classList.toggle("zoomed", Boolean(this.zoomed));
    this.stage.classList.toggle("still", still);
    if (leaving) {
      leaving.el.classList.add("leaving");
      leaving.el.hidden = still;
      setTimeout(() => leaving.el.remove(), still ? 0 : SLIDE_MS);
    }
    const seen = new Set();
    if (this.zoomed && views.includes(this.zoomed)) {
      for (const view of views) {
        view.el.hidden = view !== this.zoomed;
        view.zoomButton.textContent = view === this.zoomed ? "unzoom" : "zoom";
        view.zoomButton.title = view === this.zoomed
          ? "Show every workspace view again" : "Show only this workspace view";
      }
      applyRect(this.zoomed.el, stage);
    } else {
      this.zoomed = null;
      const { leaves: boxes, dividers } = layoutRects(this.root, stage, multiple ? DIVIDER_PX : 0,
        { min: VIEW_RATIO_MIN / 100, max: VIEW_RATIO_MAX / 100 });
      for (const view of views) {
        const box = boxes.get(view);
        view.el.hidden = false;
        view.zoomButton.textContent = "zoom";
        view.zoomButton.title = "Show only this workspace view";
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
        this.layout({ animate: false });
      };
      const stop = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", stop);
        el.removeEventListener("lostpointercapture", stop);
        this.stage.classList.remove("resizing");
        document.body.classList.remove("dragging");
        this.fit();
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", stop);
      el.addEventListener("lostpointercapture", stop);
    });
  }

  // ---- the view element ----

  _makeView({ primary, color, label, id = null }) {
    const view = { id, primary, color, label, frame: null };
    view.el = document.createElement("section");
    view.el.className = `workspace-view${primary ? " workspace-view-primary active" : ""}`;
    view.el.style.setProperty("--workspace-color", color);
    view.header = document.createElement("header");
    view.header.className = "workspace-view-heading";
    view.header.title = "Drag to move this workspace view";
    const dot = document.createElement("span");
    dot.className = "workspace-view-dot";
    view.nameEl = document.createElement("strong");
    view.nameEl.textContent = label;
    view.zoomButton = this._button("zoom", "Show only this workspace view", () => this.zoom(view));
    view.header.append(dot, view.nameEl, view.zoomButton);
    if (!primary) {
      view.closeButton = this._button("close", "Save and close this view; its terminals keep running", () => this.close(view));
      view.header.append(view.closeButton);
      view.el.addEventListener("pointerdown", () => this.activate(view), true);
    } else {
      view.closeButton = null;
    }
    view.el.append(view.header);
    this._wireDrag(view);
    return view;
  }

  _button(label, title, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
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
