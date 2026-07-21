// Layout tree matching the workspace JSON schema (CONTRACTS.md):
//   {"type":"split","dir":"h"|"v","ratio":r,"children":[node,node]}
//   {"type":"pane","profile":name,"cwd":path}
// dir "h" = children side by side, "v" = stacked.
// Rendered as nested flex divs with draggable splitters. Pane elements are
// reused across re-renders so terminals survive structural changes.

import { Pane } from "./pane.js";

const MIN_PANE_PX = 90;

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
    return new Pane({
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
    });
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

  // ---- structural ops ----

  splitPane(pane, dir) {
    if (!pane) return null;
    if (this.zoomed) this.toggleZoom();
    // Refuse splits that would leave either half below a usable size — a
    // sliver pane can't render a prompt and is only good for mis-clicks.
    const rect = pane.el.getBoundingClientRect();
    const room = dir === "v" ? rect.height : rect.width;
    if (room > 0 && (room - 6) / 2 < MIN_PANE_PX) {
      if (pane.flashNotice) pane.flashNotice("[no room to split — enlarge this pane first]");
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
    this.focusPane(fresh);
    this._changed();
    return fresh;
  }

  splitFocused(dir) {
    return this.splitPane(this.focused, dir);
  }

  closePane(pane = this.focused) {
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
    this.render();
    const next = this.panes(sibling)[0] || this.panes()[0] || null;
    if (next) this.focusPane(next);
    this._changed();
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
    this.render();
    if (this.focused) this.focusPane(this.focused);
    this._changed();
    return true;
  }

  balanceFocusedSplit() {
    // Prefer width when both axes are available: it is the common two-pane
    // layout and makes the single balance button deterministic.
    const hit = this._focusedSplit("h") || this._focusedSplit("v");
    if (!hit) return false;
    hit.node.ratio = 0.5;
    this.render();
    if (this.focused) this.focusPane(this.focused);
    this._changed();
    return true;
  }

  // ---- persistence ----

  serialize(node = this.root) {
    if (!node) return null;
    if (node.type === "pane") {
      const out = { type: "pane", profile: node.pane.profileName };
      if (node.pane.cwd) out.cwd = node.pane.cwd;
      if (node.pane.session && node.pane.session.id) out.session_id = node.pane.session.id;
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
      this._applyRatio(node, splitEl);
      this.fitAll();
      this._changed();
    });
    sp.addEventListener("dblclick", (event) => {
      event.preventDefault();
      node.ratio = 0.5;
      this._applyRatio(node, splitEl);
      this.fitAll();
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
