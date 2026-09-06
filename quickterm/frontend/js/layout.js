// Layout tree matching the workspace JSON schema (CONTRACTS.md):
//   {"type":"split","dir":"h"|"v","ratio":r,"children":[node,node]}
//   {"type":"pane","profile":name,"cwd":path}
// dir "h" = children side by side, "v" = stacked.
// Rendered as nested flex divs with draggable splitters. Pane elements are
// reused across re-renders so terminals survive structural changes.

import { Pane } from "./pane.js";
import { dropZone, movePaneNode, zoneRect } from "./pane_move.js";
import { dwindleDir } from "./split_tree.js";

const MIN_PANE_PX = 90;
// Pointer travel before a press on a header becomes a drag. Below it, the
// press is a click (focus) or half of a double-click (rename).
const DRAG_START_PX = 6;
// How long the flex transition in app.css takes a pane to slide into place.
// The DOM catches up with the tree once it has finished.
const SLIDE_MS = 220;

function reducedMotion() {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; }
}

export class LayoutManager {
  constructor(gridEl, zoomHostEl, opts = {}) {
    this.gridEl = gridEl;
    this.zoomHostEl = zoomHostEl;
    this.opts = opts; // {fontFamily, onFocusChange(pane), onPaneState(pane)}
    this.root = null;
    this.focused = null;
    this.zoomed = false;
  }

  newPane(profile, cwd, sessionId, launchSpec, title) {
    const pane = new Pane({
      fontFamily: this.opts.fontFamily,
      fontSize: this.opts.fontSize,
      theme: this.opts.theme,
      profile: profile || null,
      cwd: cwd || null,
      sessionId: sessionId || null,
      launchSpec: launchSpec || null,
      title: title || null,
      onFocusRequest: (p) => this.focusPane(p),
      onStateChange: (p) => { if (this.opts.onPaneState) this.opts.onPaneState(p); },
      onActionRequest: (action, p) => {
        if (this.opts.onPaneAction) this.opts.onPaneAction(action, p);
      },
    });
    this._wireDrag(pane);
    return pane;
  }

  init() {
    const pane = this.newPane();
    this.root = { type: "pane", pane };
    this.render();
    this.focusPane(pane);
    return pane;
  }

  panes(node = this.root, out = []) {
    if (!node) return out;
    if (node.type === "pane") out.push(node.pane);
    else for (const c of node.children) this.panes(c, out);
    return out;
  }

  render() {
    if (this.zoomed) this._unzoomDom();
    this.gridEl.textContent = "";
    if (this.root) {
      const el = this._renderNode(this.root);
      el.style.flex = "1 1 auto";
      this.gridEl.appendChild(el);
    }
    this.fitAll();
  }

  fitAll() {
    for (const p of this.panes()) p.fitSoon();
  }

  setTheme(theme) {
    this.opts.theme = theme;
    for (const p of this.panes()) p.setTheme(theme);
  }

  setFontSize(px) {
    this.opts.fontSize = px;
    for (const p of this.panes()) p.setFontSize(px);
  }

  setFontFamily(family) {
    this.opts.fontFamily = family;
    for (const p of this.panes()) p.setFontFamily(family);
  }

  // ---- structural ops ----

  // Where a new pane goes when nobody said: it takes half of `pane` along
  // its longer side, the dwindle rule of a tiling window manager, so
  // repeated Alt+N spirals inward instead of stacking slivers.
  autoDir(pane = this.focused) {
    if (!pane) return "h";
    return dwindleDir(pane.el.getBoundingClientRect());
  }

  splitPane(pane, dir) {
    if (!pane) return null;
    if (this.zoomed) this.toggleZoom();
    // Refuse splits that would leave either half below a usable size: a
    // sliver pane can't render a prompt and is only good for mis-clicks.
    const rect = pane.el.getBoundingClientRect();
    const room = dir === "v" ? rect.height : rect.width;
    if (room > 0 && (room - 6) / 2 < MIN_PANE_PX) {
      if (pane.flashNotice) pane.flashNotice("[no room to split, enlarge this pane first]");
      return null;
    }
    const hit = this._findLeaf(pane);
    if (!hit) return null;
    const fresh = this.newPane();
    const split = {
      type: "split",
      dir: dir === "v" ? "v" : "h",
      ratio: 0.5,
      children: [hit.node, { type: "pane", pane: fresh }],
    };
    this._replaceNode(hit.node, split, hit.parent);
    this.render();
    this._animateEnter(split, fresh);
    this.focusPane(fresh);
    this._changed();
    return fresh;
  }

  splitFocused(dir) {
    return this.splitPane(this.focused, dir);
  }

  // Drop `pane` on `target`: `zone` is a side (dock it there) or "center"
  // (swap the two). A structural change like a split, so it is rendered and
  // autosaved the same way. Returns false when nothing moved.
  movePane(pane, target, zone) {
    const root = movePaneNode(this.root, pane, target, zone);
    if (!root) return false;
    this.root = root;
    this.render();
    const hit = this._findLeaf(pane);
    if (zone === "center") {
      this._flashEnter(pane);
      this._flashEnter(target);
    } else if (hit?.parent) {
      this._animateEnter(hit.parent, pane);
    }
    this.focusPane(pane);
    this._changed();
    return true;
  }

  // The tree changes at once, so panes(), serialize() and the autosave are
  // right immediately; only the DOM waits while the closing pane collapses
  // and its sibling slides over it (`animate: false` skips that for callers
  // that need the DOM settled now).
  closePane(pane = this.focused, { animate = true } = {}) {
    if (!pane) return;
    if (this.zoomed) this.toggleZoom();
    const hit = this._findLeaf(pane);
    if (!hit) return;
    pane.dispose();
    if (this.focused === pane) this.focused = null;
    if (!hit.parent) {
      const fresh = this.newPane();
      this.root = { type: "pane", pane: fresh };
      this.render();
      this.focusPane(fresh);
      this._changed();
      return;
    }
    const sibling = hit.parent.children.find((c) => c !== hit.node);
    const gp = this._parentOf(hit.parent);
    this._replaceNode(hit.parent, sibling, gp === undefined ? null : gp);
    if (!(animate && this._animateLeave(hit.parent, pane))) this.render();
    const next = this.panes(sibling)[0] || this.panes()[0] || null;
    if (next) this.focusPane(next);
    this._changed();
  }

  // ---- motion ----
  //
  // A split container is a flex row or column and app.css transitions
  // flex-grow on its children while it carries `.sliding`. Both children are
  // freshly placed in a new split element by render(), so the transition has
  // nothing to run from; these give it a start state one frame earlier.

  _animateEnter(split, fresh) {
    const el = split.el;
    if (!el || !el.isConnected || reducedMotion()) return;
    const freshEl = fresh.el;
    const otherEl = el.children[0] === freshEl ? el.children[2] : el.children[0];
    if (!freshEl || !otherEl) return;
    el.classList.add("sliding");
    freshEl.classList.add("pane-enter");
    freshEl.style.flex = "0 1 0px";
    otherEl.style.flex = "1 1 0px";
    void el.offsetWidth; // commit the start state before the slide
    this._applyRatio(split, el);
    setTimeout(() => {
      el.classList.remove("sliding");
      freshEl.classList.remove("pane-enter");
      this.fitAll();
    }, SLIDE_MS);
  }

  _animateLeave(split, leaving) {
    const el = split.el;
    if (!el || !el.isConnected || reducedMotion()) return false;
    const leavingEl = leaving.el;
    const otherEl = el.children[0] === leavingEl ? el.children[2] : el.children[0];
    if (!leavingEl || !otherEl) return false;
    el.classList.add("sliding");
    leavingEl.classList.add("pane-leave");
    leavingEl.style.flex = "0 1 0px";
    otherEl.style.flex = "1 1 0px";
    setTimeout(() => {
      // Only if nothing else has redrawn in the meantime: a later structural
      // change already rendered the tree without this pane.
      if (leavingEl.isConnected) this.render();
      if (this.focused) this.focusPane(this.focused);
    }, SLIDE_MS);
    return true;
  }

  // A swap keeps both boxes, so the only thing to show is the pane arriving.
  _flashEnter(pane) {
    if (reducedMotion()) return;
    pane.el.classList.add("pane-enter");
    setTimeout(() => pane.el.classList.remove("pane-enter"), SLIDE_MS);
  }

  // A ratio change from the keyboard or a double-click slides too; the
  // splitter drag applies its ratio directly, the pointer is the motion.
  _slideRatio(node, splitEl) {
    if (!reducedMotion()) {
      splitEl.classList.add("sliding");
      setTimeout(() => { splitEl.classList.remove("sliding"); this.fitAll(); }, SLIDE_MS);
    }
    this._applyRatio(node, splitEl);
    this.fitAll();
  }

  toggleZoom() {
    if (this.zoomed) {
      this._unzoomDom();
      this.render();
      if (this.focused) this.focusPane(this.focused);
      return;
    }
    if (!this.focused) return;
    this.zoomed = true;
    this.gridEl.hidden = true;
    this.zoomHostEl.hidden = false;
    this.zoomHostEl.textContent = "";
    this.focused.el.style.flex = "1 1 auto";
    this.zoomHostEl.appendChild(this.focused.el);
    document.body.classList.add("zoomed");
    this.focused.fitSoon();
  }

  _unzoomDom() {
    this.zoomed = false;
    this.zoomHostEl.hidden = true;
    this.zoomHostEl.textContent = "";
    this.gridEl.hidden = false;
    document.body.classList.remove("zoomed");
  }

  // ---- focus ----

  focusPane(pane) {
    if (this.focused && this.focused !== pane) this.focused.setFocused(false);
    const changed = this.focused !== pane;
    this.focused = pane;
    if (pane) pane.setFocused(true);
    if (changed && this.opts.onFocusChange) this.opts.onFocusChange(pane);
  }

  focusDir(dir) {
    if (!this.focused) return;
    const cur = this.focused.el.getBoundingClientRect();
    const cx = cur.left + cur.width / 2;
    const cy = cur.top + cur.height / 2;
    let best = null;
    let bestDist = Infinity;
    for (const p of this.panes()) {
      if (p === this.focused) continue;
      const r = p.el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue; // hidden (zoom)
      const dx = r.left + r.width / 2 - cx;
      const dy = r.top + r.height / 2 - cy;
      let primary, secondary;
      if (dir === "left") { primary = -dx; secondary = Math.abs(dy); }
      else if (dir === "right") { primary = dx; secondary = Math.abs(dy); }
      else if (dir === "up") { primary = -dy; secondary = Math.abs(dx); }
      else { primary = dy; secondary = Math.abs(dx); }
      if (primary <= 1) continue;
      const d = primary + secondary * 2;
      if (d < bestDist) { bestDist = d; best = p; }
    }
    if (best) this.focusPane(best);
  }

  canResizeFocused(axis) {
    return Boolean(this._focusedSplit(axis));
  }

  adjustFocusedSize(axis, amount) {
    const hit = this._focusedSplit(axis);
    if (!hit) return false;
    // Growing child 0 increases the ratio; growing child 1 decreases it.
    const signed = (hit.childIndex === 0 ? 1 : -1) * amount;
    hit.node.ratio = Math.min(0.9, Math.max(0.1, hit.node.ratio + signed));
    this._commitRatio(hit.node);
    return true;
  }

  balanceFocusedSplit() {
    // Prefer width when both axes are available: it is the common two-pane
    // layout and makes the single balance button deterministic.
    const hit = this._focusedSplit("h") || this._focusedSplit("v");
    if (!hit) return false;
    hit.node.ratio = 0.5;
    this._commitRatio(hit.node);
    return true;
  }

  // Apply a changed ratio without rebuilding the tree, so a zoomed pane stays
  // zoomed (render() tears the zoom down while the UI still says "Show all
  // panes"). Falls back to a full render if this split has no live element.
  _commitRatio(node) {
    if (node.el && node.el.isConnected) {
      this._slideRatio(node, node.el);
    } else {
      this.render();
      if (this.focused) this.focusPane(this.focused);
    }
    this._changed();
  }

  // ---- persistence ----

  serialize(node = this.root) {
    if (!node) return null;
    if (node.type === "pane") {
      const out = { type: "pane", profile: node.pane.profileName };
      if (node.pane.cwd) out.cwd = node.pane.cwd;
      if (node.pane.session && node.pane.session.id) out.session_id = node.pane.session.id;
      else if (node.pane.savedSessionId) out.session_id = node.pane.savedSessionId;
      if (node.pane.launchSpec) out.launch_spec = node.pane.launchSpec;
      if (node.pane.title) out.title = node.pane.title;
      return out;
    }
    return {
      type: "split",
      dir: node.dir,
      ratio: node.ratio,
      children: node.children.map((c) => this.serialize(c)),
    };
  }

  // Rebuild from workspace JSON. Returns the new panes (leaf order) so the
  // caller can spawn a session per pane node.
  restore(layout) {
    if (this.zoomed) this._unzoomDom();
    for (const p of this.panes()) p.dispose();
    this.focused = null;
    const build = (n) => {
      if (n && n.type === "split" && Array.isArray(n.children) && n.children.length === 2) {
        return {
          type: "split",
          dir: n.dir === "v" ? "v" : "h",
          ratio: typeof n.ratio === "number" ? Math.min(0.9, Math.max(0.1, n.ratio)) : 0.5,
          children: n.children.map(build),
        };
      }
      const pane = this.newPane(
        n && n.profile,
        n && n.cwd,
        n && n.session_id,
        n && n.launch_spec,
        n && n.title,
      );
      return { type: "pane", pane };
    };
    this.root = layout ? build(layout) : { type: "pane", pane: this.newPane() };
    this.render();
    const all = this.panes();
    if (all.length) this.focusPane(all[0]);
    return all;
  }

  // ---- internals ----

  _renderNode(node) {
    if (node.type === "pane") return node.pane.el;
    const el = document.createElement("div");
    el.className = "split " + (node.dir === "v" ? "v" : "h");
    const a = this._renderNode(node.children[0]);
    const sp = document.createElement("div");
    sp.className = "splitter";
    sp.tabIndex = 0;
    sp.setAttribute("role", "separator");
    sp.setAttribute("aria-label", "Resize terminal panes");
    sp.setAttribute("aria-orientation", node.dir === "v" ? "horizontal" : "vertical");
    sp.setAttribute("aria-valuemin", "10");
    sp.setAttribute("aria-valuemax", "90");
    sp.title = "Drag to resize · arrow keys resize · double-click balances";
    this._wireSplitter(sp, node, el);
    const b = this._renderNode(node.children[1]);
    el.appendChild(a);
    el.appendChild(sp);
    el.appendChild(b);
    // Remembered so ratio changes from the Quick-settings drawer and the
    // palette can update this split in place, exactly like the splitter does.
    // Going through render() instead silently dropped zoom.
    node.el = el;
    this._applyRatio(node, el);
    return el;
  }

  _applyRatio(node, splitEl) {
    const r = Math.min(0.95, Math.max(0.05, typeof node.ratio === "number" ? node.ratio : 0.5));
    splitEl.children[0].style.flex = `${r} 1 0px`;
    splitEl.children[2].style.flex = `${1 - r} 1 0px`;
    splitEl.children[1].setAttribute("aria-valuenow", String(Math.round(r * 100)));
  }

  _wireSplitter(sp, node, splitEl) {
    sp.addEventListener("keydown", (event) => {
      const horizontal = node.dir !== "v";
      const decrease = horizontal ? event.key === "ArrowLeft" : event.key === "ArrowUp";
      const increase = horizontal ? event.key === "ArrowRight" : event.key === "ArrowDown";
      if (!decrease && !increase && event.key !== "Home") return;
      event.preventDefault();
      node.ratio = event.key === "Home"
        ? 0.5
        : Math.min(0.9, Math.max(0.1, node.ratio + (increase ? 0.05 : -0.05)));
      this._slideRatio(node, splitEl);
      this._changed();
    });
    sp.addEventListener("dblclick", (event) => {
      event.preventDefault();
      node.ratio = 0.5;
      this._slideRatio(node, splitEl);
      this._changed();
    });
    sp.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const horiz = node.dir !== "v";
      const rect = splitEl.getBoundingClientRect();
      const total = horiz ? rect.width : rect.height;
      if (total <= 0) return;
      const min = Math.min(MIN_PANE_PX / total, 0.45);
      try { sp.setPointerCapture(e.pointerId); } catch (_) { /* old WebView */ }
      const move = (ev) => {
        const pos = horiz ? ev.clientX - rect.left : ev.clientY - rect.top;
        node.ratio = Math.min(1 - min, Math.max(min, pos / total));
        this._applyRatio(node, splitEl);
      };
      const up = (ev) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        try { sp.releasePointerCapture(ev.pointerId); } catch (_) { /* already released */ }
        document.body.classList.remove("dragging");
        this.fitAll();
        this._changed();
      };
      document.body.classList.add("dragging");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
  }

  // ---- drag to rearrange ----
  //
  // The header is the handle. It exists only with two or more panes and never
  // while zoomed, so a lone pane cannot start a drag. A few pixels of travel
  // start one, which leaves click-to-focus and double-click-to-rename alone;
  // Escape cancels. The zone under the pointer is the outer band of another
  // pane (dock on that side) or its middle (swap), previewed by one fixed
  // element over the half the pane would take.
  _wireDrag(pane) {
    const tab = pane.tabEl;
    if (!tab) return;
    tab.addEventListener("pointerdown", (down) => {
      if (down.button !== 0 || this.zoomed) return;
      if (down.target.closest("input")) return; // a rename in progress
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
        try { tab.releasePointerCapture(pointerId); } catch (_) { /* already released */ }
        document.body.classList.remove("dragging", "pane-dragging");
        ghost.remove();
        preview.remove();
      };
      const move = (ev) => {
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_START_PX) return;
          dragging = true;
          // Capture, so the drop lands here even from over an xterm canvas or
          // outside the window; body.dragging also switches pointer events
          // off on every pane, exactly as the splitter drag does.
          try { tab.setPointerCapture(pointerId); } catch (_) { /* old WebView */ }
          document.body.classList.add("dragging", "pane-dragging");
          ghost = document.createElement("div");
          ghost.className = "pane-drag-ghost";
          ghost.textContent = pane.displayName();
          preview = document.createElement("div");
          preview.className = "pane-drop-hint";
          preview.hidden = true;
          document.body.append(ghost, preview);
        }
        // Kept inside the window, or a drop near the right edge hides the
        // very name that says what is being moved.
        ghost.style.left = `${Math.max(0, Math.min(ev.clientX + 12, window.innerWidth - ghost.offsetWidth - 4))}px`;
        ghost.style.top = `${Math.max(0, Math.min(ev.clientY + 12, window.innerHeight - ghost.offsetHeight - 4))}px`;
        hint = this._dropHint(pane, ev.clientX, ev.clientY);
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
        if (drop) this.movePane(pane, drop.target, drop.zone);
      };
      const key = (ev) => {
        if (ev.key !== "Escape" || !dragging) return;
        ev.preventDefault();
        ev.stopPropagation();
        stop();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", stop);
      window.addEventListener("keydown", key, true);
    });
  }

  _dropHint(dragged, x, y) {
    for (const target of this.panes()) {
      if (target === dragged) continue;
      const rect = target.el.getBoundingClientRect();
      const zone = dropZone(rect, x, y);
      if (zone) return { target, zone, rect };
    }
    return null;
  }

  _findLeaf(pane, node = this.root, parent = null) {
    if (!node) return null;
    if (node.type === "pane") return node.pane === pane ? { node, parent } : null;
    for (const c of node.children) {
      const r = this._findLeaf(pane, c, node);
      if (r) return r;
    }
    return null;
  }

  _focusedSplit(axis) {
    if (!this.focused) return null;
    const wanted = axis === "v" || axis === "height" ? "v" : "h";
    const path = this._pathToPane(this.focused);
    if (!path) return null;
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i].node.dir === wanted) return path[i];
    }
    return null;
  }

  _pathToPane(pane, node = this.root, path = []) {
    if (!node) return null;
    if (node.type === "pane") return node.pane === pane ? path : null;
    for (let childIndex = 0; childIndex < node.children.length; childIndex++) {
      const found = this._pathToPane(
        pane,
        node.children[childIndex],
        [...path, { node, childIndex }],
      );
      if (found) return found;
    }
    return null;
  }

  // Returns null when target is root, undefined when not found.
  _parentOf(target, node = this.root, parent = null) {
    if (node === target) return parent;
    if (node && node.type === "split") {
      for (const c of node.children) {
        const r = this._parentOf(target, c, node);
        if (r !== undefined) return r;
      }
    }
    return undefined;
  }

  _replaceNode(oldNode, newNode, parent) {
    if (!parent) this.root = newNode;
    else parent.children[parent.children.indexOf(oldNode)] = newNode;
  }

  _changed() {
    if (this.opts.onLayoutChange) this.opts.onLayoutChange(this.serialize());
  }
}
