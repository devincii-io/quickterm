// The diff the right panel opens over the stage: unified by default, side by
// side on a toggle (remembered per machine), line numbers, prev/next change
// on the arrows and on n / p. At most 5000 lines; past that the backend sends
// only the count and this says "diff too large".

import * as wsApi from "./ws_api.js";
import { changeStops, nextStop, parseDiff, sideBySide } from "./right_panel_model.js";
import { iconButton, make } from "./rp_dom.js";

const LAYOUT_KEY = "quickterm.diffLayout.v1";
const GROUP_LABELS = { staged: "Staged", changes: "Changes", committed: "Committed on branch" };

function storedLayout() {
  try { return localStorage.getItem(LAYOUT_KEY) === "split" ? "split" : "unified"; } catch (_) { return "unified"; }
}

function storeLayout(value) {
  try { localStorage.setItem(LAYOUT_KEY, value); } catch (_) { /* the default comes back */ }
}

function cell(className, text) {
  const node = make("span", className);
  if (text != null && text !== "") node.textContent = String(text);
  return node;
}

function unifiedRow(row) {
  const line = make("div", `rp-diff-line ${row.kind}`);
  if (row.kind === "hunk" || row.kind === "meta") {
    line.append(cell("rp-diff-full", row.text));
    return line;
  }
  const sign = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
  line.append(cell("rp-diff-no", row.old), cell("rp-diff-no", row.new), cell("rp-diff-sign", sign), cell("rp-diff-text", row.text));
  return line;
}

function sideRow(pair) {
  const line = make("div", "rp-diff-line rp-diff-pair");
  if (pair.full) {
    line.classList.add(pair.full.kind);
    line.append(cell("rp-diff-full", pair.full.text));
    return line;
  }
  const half = (row, side) => {
    const box = make("div", `rp-diff-half ${row ? row.kind : "empty"}`);
    box.append(cell("rp-diff-no", row ? row[side] : ""), cell("rp-diff-text", row ? row.text : ""));
    return box;
  };
  line.append(half(pair.left, "old"), half(pair.right, "new"));
  return line;
}

export function createDiffView(ctx) {
  const el = make("div", "rp-viewer rp-diff-view");
  el.tabIndex = -1;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Changes");
  const head = make("div", "rp-viewer-head");
  const path = make("span", "rp-viewer-path");
  const group = make("span", "rp-viewer-group");
  const prev = iconButton("arrow-up", "Previous change (p)");
  const next = iconButton("arrow-down", "Next change (n)");
  const layout = iconButton("columns", "Side by side");
  const file = make("button", "rp-text-button", "File");
  file.type = "button";
  file.title = "Show the whole file";
  const close = iconButton("x", "Close (Esc)");
  head.append(path, group, prev, next, layout, file, close);
  const body = make("div", "rp-viewer-body rp-diff-body");
  el.append(head, body);

  let current = null;
  let rows = [];
  let items = [];
  let stops = [];
  let at = -1;
  let mode = storedLayout();

  function paintLayout() {
    layout.replaceChildren(iconButton(mode === "split" ? "rows" : "columns", "").firstChild);
    layout.title = mode === "split" ? "Unified" : "Side by side";
    layout.setAttribute("aria-label", layout.title);
    layout.setAttribute("aria-pressed", String(mode === "split"));
  }

  function render() {
    paintLayout();
    items = mode === "split" ? sideBySide(rows) : rows;
    stops = changeStops(items);
    at = -1;
    // Not a bare "split" class: app.css styles .split as a pane split.
    const list = make("div", `rp-diff rp-diff-${mode}`);
    list.append(...items.map(mode === "split" ? sideRow : unifiedRow));
    body.replaceChildren(list);
    prev.disabled = !stops.length;
    next.disabled = !stops.length;
  }

  function go(delta) {
    const stop = nextStop(stops, at, delta);
    if (stop == null) return;
    at = stop;
    const target = body.querySelector(".rp-diff")?.children[stop];
    if (!target) return;
    for (const node of body.querySelectorAll(".rp-diff-line.current")) node.classList.remove("current");
    target.classList.add("current");
    body.scrollTop = Math.max(0, target.offsetTop - body.clientHeight / 3);
  }

  async function open(name, filePath, groupId) {
    current = { name, path: filePath, group: groupId };
    path.textContent = filePath;
    path.title = filePath;
    group.textContent = GROUP_LABELS[groupId] || "";
    rows = [];
    body.replaceChildren(make("div", "rp-viewer-message", "Loading…"));
    let answer;
    try {
      answer = await wsApi.getDiff(name, filePath, groupId);
    } catch (error) {
      if (current?.path === filePath) body.replaceChildren(make("div", "rp-viewer-message", error.detail || "Could not read the diff."));
      return;
    }
    if (current?.path !== filePath || current.group !== groupId) return;
    if (answer.truncated) {
      body.replaceChildren(make("div", "rp-viewer-message", `Diff too large (${answer.lines.toLocaleString()} lines).`));
      prev.disabled = true;
      next.disabled = true;
      return;
    }
    rows = parseDiff(answer.text);
    if (!rows.length) {
      body.replaceChildren(make("div", "rp-viewer-message", "No differences."));
      return;
    }
    render();
    go(1);
  }

  prev.addEventListener("click", () => go(-1));
  next.addEventListener("click", () => go(1));
  layout.addEventListener("click", () => {
    mode = mode === "split" ? "unified" : "split";
    storeLayout(mode);
    if (rows.length) {
      render();
      go(1);
    } else {
      paintLayout();
    }
  });
  file.addEventListener("click", () => ctx.openFile(current.path));
  close.addEventListener("click", () => ctx.close());
  paintLayout();

  function handleKey(event) {
    if (event.ctrlKey || event.altKey || event.metaKey) return false;
    const target = event.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return false;
    if (event.key === "n") { go(1); return true; }
    if (event.key === "p") { go(-1); return true; }
    return false;
  }

  return {
    kind: "diff",
    el,
    open,
    handleKey,
    path: () => current?.path || null,
    dispose: () => {},
  };
}
