// The right panel's Files tab: the workspace folder as a lazy tree (one
// level per request), a filter that searches names or, with Contents on,
// file contents. A row opens in the file view; Alt+click pastes its quoted
// path into the focused terminal; right click has the rest.

import * as wsApi from "./ws_api.js";
import { openMenu } from "./menu.js";
import { itemFor, patchList, setAttrs, setClass, setText } from "./render.js";
import { flattenTree, splitPath } from "./right_panel_model.js";
import { gitMark, icon, make } from "./rp_dom.js";

const SEARCH_DELAY_MS = 220;

export function createFilesTab(ctx) {
  const el = make("section", "rp-pane rp-files");
  el.setAttribute("aria-label", "Files");
  const bar = make("div", "rp-filter");
  const input = make("input", "rp-filter-input");
  input.type = "search";
  input.placeholder = "Filter files";
  input.setAttribute("aria-label", "Filter files by name");
  input.spellcheck = false;
  const contents = make("button", "rp-toggle", "Contents");
  contents.type = "button";
  contents.title = "Search file contents instead of names";
  contents.setAttribute("aria-pressed", "false");
  bar.append(input, contents);
  const note = make("div", "rp-note");
  note.hidden = true;
  const tree = make("div", "rp-tree");
  tree.setAttribute("role", "tree");
  tree.setAttribute("aria-label", "Workspace files");
  const results = make("div", "rp-results");
  results.setAttribute("role", "listbox");
  results.hidden = true;
  const more = make("div", "rp-note rp-more");
  more.hidden = true;
  el.append(bar, note, tree, results, more);

  let children = new Map();
  let expanded = new Set();
  // Folders whose listing a cap cut short.
  const cut = new Set();
  let generation = 0;
  let searchTimer = 0;
  let searchAbort = null;
  let focusedPath = null;

  const name = () => ctx.workspace();
  const searching = () => input.value.trim().length > 0;

  function showNote(text) {
    setText(note, text || "");
    note.hidden = !text;
  }

  async function load(dir, run = generation) {
    const workspace = name();
    if (!workspace) return false;
    try {
      const answer = await wsApi.listFiles(workspace, dir);
      if (run !== generation) return false;
      children.set(dir, answer.entries || []);
      if (answer.truncated) cut.add(dir);
      else cut.delete(dir);
      if (!dir) showNote(cut.size ? "Some folders hold more entries than shown (first 5000)." : "");
      return true;
    } catch (error) {
      if (run !== generation) return false;
      if (!dir) {
        children.set("", []);
        showNote(error.detail || "Could not list this folder.");
      } else {
        expanded.delete(dir);
        children.delete(dir);
      }
      return false;
    }
  }

  function renderTree() {
    const rows = flattenTree(children, expanded);
    patchList(tree, rows, { key: (row) => row.path, create: createRow, update: updateRow });
    if (!tree.querySelector(".rp-row[tabindex='0']")) {
      const first = tree.firstElementChild;
      if (first) first.tabIndex = 0;
    }
  }

  function createRow() {
    const row = make("div", "rp-row rp-tree-row");
    row.setAttribute("role", "treeitem");
    row.tabIndex = -1;
    const chevron = make("span", "rp-chevron");
    const label = make("span", "rp-name");
    const mark = make("span", "rp-git");
    row.append(chevron, label, mark);
    row.addEventListener("click", (event) => activate(row, event));
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      contextMenu(row);
    });
    row.addEventListener("focus", () => { focusedPath = itemFor(row)?.path || null; });
    return row;
  }

  function updateRow(row, item) {
    const { entry, depth, open } = item;
    row.style.setProperty("--depth", String(depth));
    const [chevron, label, mark] = row.children;
    chevron.replaceChildren(entry.dir ? icon(open ? "chevron-down" : "chevron-right", 12) : document.createTextNode(""));
    setText(label, entry.name);
    const git = gitMark(entry.git);
    setText(mark, git.text);
    setAttrs(mark, { title: git.title || false });
    setClass(row, "dir", entry.dir);
    setClass(row, "ignored", entry.ignored);
    setClass(row, "git-new", git.tint === "git-new");
    setClass(row, "git-mod", git.tint === "git-mod");
    setAttrs(row, {
      "aria-expanded": entry.dir ? String(open) : false,
      "aria-level": String(depth + 1),
      title: item.path,
    });
    row.tabIndex = item.path === focusedPath ? 0 : -1;
  }

  async function toggle(path, open) {
    if (open) {
      expanded.add(path);
      renderTree();
      if (!children.has(path)) await load(path);
    } else {
      expanded.delete(path);
    }
    renderTree();
  }

  function activate(row, event = {}) {
    const item = itemFor(row);
    if (!item) return;
    focusedPath = item.path;
    if (event.altKey) {
      ctx.pastePaths([item.path]);
      return;
    }
    if (item.entry.dir) toggle(item.path, !item.open);
    else ctx.openFile(item.path);
  }

  function contextMenu(row) {
    const item = itemFor(row);
    if (!item) return;
    const path = item.path;
    const local = !ctx.isRemote();
    openMenu({
      anchor: row,
      label: `Actions for ${path}`,
      items: [
        ...(item.entry.dir ? [] : [{ label: "Open", run: () => ctx.openFile(path) }]),
        { label: "Paste path into terminal", hint: "Alt+click", run: () => ctx.pastePaths([path]) },
        { label: "Copy path", run: () => ctx.copyPath(path, false) },
        { label: "Copy relative path", run: () => ctx.copyPath(path, true) },
        ...(local ? [
          ...(item.entry.dir ? [] : [{ label: "Open in editor", run: () => ctx.openExternal(path, "editor") }]),
          { label: "Reveal in Explorer", run: () => ctx.openExternal(path, "explorer") },
        ] : []),
      ],
      onClose: () => row.focus(),
    });
  }

  // Up/Down walk the rows, Right opens a folder or steps in, Left closes it
  // or steps out to its parent, Enter opens; Escape hands the keyboard back.
  tree.addEventListener("keydown", (event) => {
    const rows = [...tree.children];
    const at = rows.indexOf(document.activeElement);
    if (at < 0) return;
    const item = itemFor(rows[at]);
    const go = (index) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, index))];
      if (!target) return;
      for (const each of rows) each.tabIndex = each === target ? 0 : -1;
      target.focus();
    };
    const keys = {
      ArrowDown: () => go(at + 1),
      ArrowUp: () => go(at - 1),
      Home: () => go(0),
      End: () => go(rows.length - 1),
      ArrowRight: () => {
        if (item.entry.dir && !item.open) toggle(item.path, true);
        else if (item.entry.dir) go(at + 1);
      },
      ArrowLeft: () => {
        if (item.entry.dir && item.open) toggle(item.path, false);
        else {
          const parent = splitPath(item.path).dir;
          const index = rows.findIndex((row) => itemFor(row)?.path === parent);
          if (index >= 0) go(index);
        }
      },
      Enter: () => activate(rows[at], event),
      ContextMenu: () => contextMenu(rows[at]),
    };
    const handler = keys[event.key] || (event.key === "F10" && event.shiftKey ? keys.ContextMenu : null);
    if (!handler) return;
    event.preventDefault();
    handler();
  });

  // ---- search ----

  function scheduleSearch() {
    clearTimeout(searchTimer);
    searchAbort?.abort();
    const active = searching();
    tree.hidden = active;
    results.hidden = !active;
    if (!active) {
      more.hidden = true;
      patchList(results, [], { key: () => "", create: () => make("div") });
      return;
    }
    searchTimer = setTimeout(runSearch, SEARCH_DELAY_MS);
  }

  async function runSearch() {
    const workspace = name();
    if (!workspace || !searching()) return;
    const abort = new AbortController();
    searchAbort = abort;
    const byContents = contents.getAttribute("aria-pressed") === "true";
    try {
      const answer = await wsApi.searchFiles(workspace, input.value.trim(), byContents, { signal: abort.signal });
      if (abort.signal.aborted) return;
      const hits = answer.results || [];
      patchList(results, hits, {
        key: (hit) => `${hit.path}:${hit.line ?? ""}`,
        create: createHit,
        update: updateHit,
      });
      setText(more, hits.length ? (answer.truncated ? "Showing the first matches only. Narrow the filter." : "") : "No matches.");
      more.hidden = !(answer.truncated || !hits.length);
    } catch (error) {
      if (abort.signal.aborted) return;
      patchList(results, [], { key: () => "", create: () => make("div") });
      setText(more, error.detail || "The search failed.");
      more.hidden = false;
    }
  }

  function createHit() {
    const row = make("div", "rp-row rp-hit");
    row.setAttribute("role", "option");
    row.tabIndex = 0;
    const top = make("div", "rp-hit-path");
    const label = make("span", "rp-name");
    const dir = make("span", "rp-dir");
    top.append(label, dir);
    const text = make("div", "rp-hit-text");
    row.append(top, text);
    const open = (event) => {
      const hit = itemFor(row);
      if (!hit) return;
      if (event.altKey) ctx.pastePaths([hit.path]);
      else ctx.openFile(hit.path, { line: hit.line });
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter") open(event);
      if (event.key === "ArrowDown") row.nextElementSibling?.focus();
      if (event.key === "ArrowUp") (row.previousElementSibling || input).focus();
    });
    return row;
  }

  function updateHit(row, hit) {
    const { name: base, dir } = splitPath(hit.path);
    const [top, text] = row.children;
    setText(top.children[0], hit.line ? `${base}:${hit.line}` : base);
    setText(top.children[1], dir);
    setText(text, hit.text ? hit.text.trim() : "");
    text.hidden = !hit.text;
    row.title = hit.line ? `${hit.path}:${hit.line}` : hit.path;
  }

  input.addEventListener("input", scheduleSearch);
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && !results.hidden) {
      event.preventDefault();
      results.firstElementChild?.focus();
    }
    if (event.key === "Escape" && input.value) {
      event.preventDefault();
      event.stopPropagation();
      input.value = "";
      scheduleSearch();
    }
  });
  contents.addEventListener("click", () => {
    const on = contents.getAttribute("aria-pressed") !== "true";
    contents.setAttribute("aria-pressed", String(on));
    input.placeholder = on ? "Search file contents" : "Filter files";
    if (searching()) scheduleSearch();
    input.focus();
  });

  // ---- lifecycle ----

  // A poll only re-lists the tree; the search runs again when its query
  // changes or the tab is refreshed on purpose.
  async function refresh({ poll = false } = {}) {
    const run = generation;
    if (!name()) {
      children = new Map([["", []]]);
      renderTree();
      showNote(ctx.emptyText());
      return;
    }
    const dirs = ["", ...[...expanded].sort()];
    const loaded = await Promise.all(dirs.map((dir) => load(dir, run)));
    if (run !== generation) return;
    if (loaded[0] === false && !children.has("")) return;
    renderTree();
    if (searching() && !poll) runSearch();
  }

  function reset() {
    generation++;
    children = new Map();
    expanded = new Set();
    cut.clear();
    focusedPath = null;
    input.value = "";
    scheduleSearch();
    tree.replaceChildren();
    showNote("");
  }

  return {
    id: "files",
    title: "Files",
    icon: "files",
    el,
    refresh,
    reset,
    interval: 10000,
    focus: () => input.focus(),
  };
}
