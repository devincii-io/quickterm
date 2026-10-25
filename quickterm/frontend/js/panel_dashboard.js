// The workspace board: every saved workspace as a card in one of four
// columns (CONTRACTS 4.3). It lives in the panel that used to be the
// dashboard, opened by the same button, Alt+G and palette entry. Its second
// tab, Agents, shows every agent session by where it is: needs you, working,
// done, idle (panel_agents.js).
//
// Built once and patched afterwards, like every live panel (render.js): the
// 5 s refresh must not take the search text, the focused card or a drag in
// progress away. Listeners read itemFor(node) or the live view object, never
// the data they were built from.

import * as api from "./api.js";
import { isScratchWorkspace } from "./boot_context.js";
import { BOARD_COLUMNS, boardCards, boardColumns, movedStatus, statusOf } from "./board_model.js";
import { applyAgents, buildAgents, focusFirstAgent } from "./panel_agents.js";
import { make } from "./panel_shared.js";
import { itemFor, patchList, setAttrs, setClass, setText } from "./render.js";

// Same distance as a pane drag (layout.js): less is a click.
const DRAG_START_PX = 6;
const TAB_KEY = "quickterm.boardTab";
const TABS = Object.freeze([
  Object.freeze({ id: "workspaces", label: "Workspaces", placeholder: "Search workspaces",
    aria: "Search workspaces by name, repo or branch" }),
  Object.freeze({ id: "agents", label: "Agents", placeholder: "Search agents",
    aria: "Search agents by what was asked or answered, workspace or branch" }),
]);

function loadTab() {
  try {
    const value = globalThis.localStorage?.getItem(TAB_KEY);
    return TABS.some((tab) => tab.id === value) ? value : "workspaces";
  } catch (_) {
    return "workspaces";
  }
}

function saveTab(value) {
  try { globalThis.localStorage?.setItem(TAB_KEY, value); } catch (_) { /* per-viewer only */ }
}

const columnParts = new WeakMap();
const cardParts = new WeakMap();
const lineParts = new WeakMap();

async function collect(app) {
  const [names, sessions, board] = await Promise.all([
    api.listWorkspaces().catch(() => null),
    api.getSessions({ metrics: false }).catch(() => null),
    api.getBoard().catch(() => null),
  ]);
  const workspaces = names == null ? null : await Promise.all(
    names.filter((name) => !isScratchWorkspace(name)).map(async (name) => {
      const data = await api.getWorkspace(name).catch(() => null);
      return { name, path: data?.path || null, git: data?.git || null, host: data?.host || null };
    }),
  );
  // Who owns a terminal is the sidebar's answer (a pane on it, then a view's
  // claim, then the backend's tag), so a card never disagrees with the list.
  const owners = {};
  const attached = {};
  for (const entry of app.liveTerminals?.() || []) {
    if (!entry?.session?.id) continue;
    if (entry.workspace) owners[entry.session.id] = entry.workspace;
    if (entry.attachedIn) attached[entry.session.id] = entry.attachedIn;
  }
  return { workspaces, sessions, status: board?.status || null, owners, attached };
}

export async function renderDashboard() {
  const mounted = () => this._dash && this._dash.root.parentNode === this.bodyEl;
  this._dashLoading = true;
  if (!mounted()) {
    this._dash = null;
    this.bodyEl.textContent = "";
    this.bodyEl.append(make("div", "panel-loading", "Collecting your workspaces…"));
  }
  let data;
  try {
    data = await collect(this.app);
  } finally {
    this._dashLoading = false;
  }
  if (this.open !== "dashboard") return;
  if (!mounted()) {
    this.bodyEl.textContent = "";
    this._dash = buildBoard(this);
    this.bodyEl.append(this._dash.root);
  }
  const view = this._dash;
  if (this.headTools && this.headTools.firstChild !== view.tools) this.headTools.replaceChildren(view.tools);
  // A failed fetch keeps the last good picture instead of blanking the board.
  if (data.workspaces) view.workspaces = data.workspaces;
  if (data.sessions) view.sessions = data.sessions;
  if (data.status) view.status = { ...data.status, ...view.pending };
  view.owners = data.owners;
  view.attached = data.attached;
  applyBoard(view);
  applyAgents(view.agents, queryFor(view, "agents"));
}

function queryFor(view, tab) {
  return tab === view.tab ? view.search.value : view.queries[tab];
}

function selectTab(view, tab) {
  if (!TABS.some((entry) => entry.id === tab)) return;
  if (tab !== view.tab) {
    view.queries[view.tab] = view.search.value;
    view.tab = tab;
    view.search.value = view.queries[tab] || "";
    saveTab(tab);
  }
  const spec = TABS.find((entry) => entry.id === tab);
  view.search.placeholder = spec.placeholder;
  view.search.setAttribute("aria-label", spec.aria);
  for (const [id, button] of view.tabButtons) {
    const current = id === tab;
    setAttrs(button, { "aria-selected": current ? "true" : "false", tabindex: current ? "0" : "-1" });
    setClass(button, "active", current);
  }
  view.workspaceBoard.hidden = tab !== "workspaces";
  view.agents.root.hidden = tab !== "agents";
  setAttrs(view.root, { "data-tab": tab });
}

function buildBoard(panel) {
  const root = make("div", "board");
  const view = {
    root, panel,
    workspaces: [], sessions: [], status: {}, owners: {}, attached: {},
    // Moves sent but not answered yet: a refresh that read the file before
    // the PUT landed must not throw the card back for a moment.
    pending: {},
    drag: null,
    columns: new Map(),
  };

  view.search = make("input", "ui-input board-search");
  view.search.type = "search";
  view.search.spellcheck = false;
  // config-filter-input: Escape in a filled box clears it before a second one
  // closes the sheet (panels.js sheetKeyRoute).
  view.search.classList.add("config-filter-input");
  view.search.addEventListener("input", () => {
    if (view.tab === "agents") applyAgents(view.agents, view.search.value);
    else applyBoard(view);
  });
  view.search.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (view.tab === "agents") focusFirstAgent(view.agents);
      else view.workspaceBoard.querySelector(".board-card")?.focus();
    }
  });

  // Two tabs beside the title, then the search: nothing else in the head.
  const tabs = make("div", "board-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Board");
  view.tabButtons = new Map();
  for (const { id, label } of TABS) {
    const button = make("button", "board-tab", label);
    button.type = "button";
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => {
      selectTab(view, id);
      if (id === "agents") applyAgents(view.agents, view.search.value);
      else applyBoard(view);
    });
    view.tabButtons.set(id, button);
    tabs.append(button);
  }
  tabs.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const ids = TABS.map((entry) => entry.id);
    const next = ids[(ids.indexOf(view.tab) + (event.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length];
    view.tabButtons.get(next).click();
    view.tabButtons.get(next).focus();
  });
  view.tools = make("div", "board-tools");
  view.tools.append(tabs, view.search);

  view.note = make("p", "board-note");
  view.note.hidden = true;
  const columns = make("div", "board-columns");
  for (const { id, label } of BOARD_COLUMNS) {
    const column = make("section", "board-column");
    column.dataset.status = id;
    const head = make("header", "board-column-head");
    const mark = make("span", "board-status-icon");
    mark.dataset.status = id;
    mark.setAttribute("aria-hidden", "true");
    const count = make("span", "board-column-count");
    head.append(mark, make("h2", "board-column-title", label), count);
    const list = make("div", "board-cards");
    list.setAttribute("aria-label", label);
    const empty = make("p", "board-empty", "Empty");
    column.append(head, list, empty);
    columns.append(column);
    columnParts.set(column, { count, list, empty });
    view.columns.set(id, column);
  }
  view.workspaceBoard = make("div", "board-workspaces");
  view.workspaceBoard.append(view.note, columns);
  view.agents = buildAgents(view);
  root.append(view.workspaceBoard, view.agents.root);
  view.tab = loadTab();
  view.queries = { workspaces: "", agents: "" };
  selectTab(view, view.tab);

  view.cardSpec = {
    key: (card) => card.name,
    create: () => createCard(view),
    update: (node, card) => updateCard(node, card),
  };
  return view;
}

function applyBoard(view) {
  // A card being dragged keeps its place until the drop; the next refresh
  // after it catches up.
  if (view.drag?.moving) return;
  const cards = boardCards(view.workspaces, {
    sessions: view.sessions, owners: view.owners, attached: view.attached,
  });
  for (const column of boardColumns(cards, view.status, queryFor(view, "workspaces"))) {
    const node = view.columns.get(column.id);
    const { count, list, empty } = columnParts.get(node);
    setText(count, String(column.count));
    empty.hidden = column.count > 0;
    patchList(list, column.cards, view.cardSpec);
  }
}

function createCard(view) {
  const card = make("article", "board-card");
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  const name = make("h3", "board-card-name");
  const meta = make("div", "board-card-meta");
  const repo = make("span", "board-repo");
  const branch = make("span", "board-branch");
  const host = make("span", "board-host");
  const worktree = make("span", "board-worktree", "worktree");
  meta.append(host, repo, branch, worktree);
  const lines = make("div", "board-lines");
  card.append(name, meta, lines);
  cardParts.set(card, { name, meta, repo, branch, host, worktree, lines });

  card.addEventListener("click", () => {
    if (view.suppressClick) {
      view.suppressClick = false;
      return;
    }
    openCard(view, card);
  });
  card.addEventListener("keydown", (event) => {
    if (event.target !== card) return;
    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      event.stopPropagation();
      const name = itemFor(card)?.name;
      if (!name) return;
      const next = movedStatus(statusOf(name, view.status), event.key === "ArrowLeft" ? -1 : 1);
      moveCard(view, name, next, { refocus: true });
    } else if (!event.altKey && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      openCard(view, card);
    } else if (!event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const sibling = event.key === "ArrowDown" ? card.nextElementSibling : card.previousElementSibling;
      sibling?.focus();
    }
  });
  card.addEventListener("pointerdown", (event) => startDrag(view, card, event));
  return card;
}

function updateCard(card, data) {
  const parts = cardParts.get(card);
  setText(parts.name, data.name);
  setText(parts.repo, data.repo);
  parts.repo.hidden = !data.repo;
  setText(parts.branch, data.branch);
  parts.branch.hidden = !data.branch;
  setText(parts.host, data.host ? `@${data.host}` : "");
  parts.host.hidden = !data.host;
  parts.worktree.hidden = !data.worktree;
  setAttrs(parts.worktree, { title: data.worktree || false });
  parts.meta.hidden = !data.repo && !data.branch && !data.host;
  const live = data.lines.length;
  setAttrs(card, {
    title: data.path ? `${data.host ? `${data.host}:` : ""}${data.path}` : false,
    "aria-label": `${data.name}${data.repo ? `, ${data.repo}` : ""}${data.branch ? ` on ${data.branch}` : ""}, `
      + `${live} terminal${live === 1 ? "" : "s"}. Enter shows it, Alt+Left or Alt+Right moves it.`,
  });
  patchList(parts.lines, data.lines, {
    key: (line) => line.id,
    create: createLine,
    update: updateLine,
  });
}

function createLine() {
  const node = make("div", "board-line");
  const row = make("div", "board-line-row");
  const dot = make("span", "board-dot");
  const glyph = make("span", "board-glyph");
  const label = make("span", "board-line-label");
  const age = make("span", "board-line-age");
  row.append(dot, glyph, label, age);
  const subs = make("div", "board-sublines");
  node.append(row, subs);
  lineParts.set(node, { dot, glyph, label, age, subs });
  return node;
}

function updateLine(node, line) {
  const parts = lineParts.get(node);
  parts.dot.className = `board-dot state-${line.state}`;
  setText(parts.glyph, line.glyph);
  parts.glyph.hidden = !line.glyph;
  setText(parts.label, line.label);
  setText(parts.age, line.age);
  parts.subs.hidden = line.subagents.length === 0;
  patchList(parts.subs, line.subagents, {
    key: (sub) => sub.id,
    create: () => make("div", "board-subline"),
    update: (sub, item) => setText(sub, item.label),
  });
}

function openCard(view, card) {
  const name = itemFor(card)?.name;
  if (!name) return;
  view.panel.close();
  view.panel.app.openWorkspace?.(name);
}

async function moveCard(view, name, status, { refocus = false } = {}) {
  if (statusOf(name, view.status) === status) return;
  const previous = view.status[name];
  view.status = { ...view.status, [name]: status };
  view.pending = { ...view.pending, [name]: status };
  view.note.hidden = true;
  applyBoard(view);
  if (refocus) cardNode(view, name)?.focus();
  try {
    await api.setBoardStatus(name, status);
  } catch (error) {
    const restored = { ...view.status };
    if (previous === undefined) delete restored[name];
    else restored[name] = previous;
    view.status = restored;
    view.note.hidden = false;
    setText(view.note, error?.detail || `"${name}" could not be moved.`);
    applyBoard(view);
  } finally {
    if (view.pending[name] === status) {
      view.pending = { ...view.pending };
      delete view.pending[name];
    }
  }
}

function cardNode(view, name) {
  for (const column of view.columns.values()) {
    for (const node of columnParts.get(column).list.children) {
      if (itemFor(node)?.name === name) return node;
    }
  }
  return null;
}

function columnAt(view, x, y) {
  for (const [id, column] of view.columns) {
    const rect = column.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return id;
  }
  return null;
}

// Pointer drag, the pane drag's feel: nothing happens for the first few
// pixels, then a ghost with the name follows the pointer and the column under
// it lights up. Escape cancels.
function startDrag(view, card, down) {
  if (down.button !== 0 || view.drag) return;
  const name = itemFor(card)?.name;
  if (!name) return;
  const drag = { moving: false, target: null, ghost: null };
  view.drag = drag;
  const mark = (id) => {
    for (const [status, column] of view.columns) setClass(column, "drop-target", status === id);
  };
  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", stop);
    window.removeEventListener("keydown", key, true);
    view.drag = null;
    if (!drag.moving) return;
    try { card.releasePointerCapture(down.pointerId); } catch (_) { /* already released */ }
    document.body.classList.remove("dragging");
    setClass(card, "dragging", false);
    drag.ghost.remove();
    mark(null);
    // The click that follows a drag is not a click on the card.
    view.suppressClick = true;
    setTimeout(() => { view.suppressClick = false; }, 0);
  };
  const move = (event) => {
    if (!drag.moving) {
      if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < DRAG_START_PX) return;
      drag.moving = true;
      try { card.setPointerCapture(down.pointerId); } catch (_) { /* old WebView */ }
      document.body.classList.add("dragging");
      setClass(card, "dragging", true);
      drag.ghost = make("div", "board-drag-ghost", name);
      document.body.append(drag.ghost);
    }
    const ghost = drag.ghost;
    ghost.style.left = `${Math.max(0, Math.min(event.clientX + 12, window.innerWidth - ghost.offsetWidth - 4))}px`;
    ghost.style.top = `${Math.max(0, Math.min(event.clientY + 12, window.innerHeight - ghost.offsetHeight - 4))}px`;
    drag.target = columnAt(view, event.clientX, event.clientY);
    mark(drag.target);
  };
  const up = () => {
    const target = drag.moving ? drag.target : null;
    stop();
    if (target) moveCard(view, name, target);
    else applyBoard(view);
  };
  const key = (event) => {
    if (event.key !== "Escape" || !drag.moving) return;
    event.preventDefault();
    event.stopPropagation();
    stop();
    applyBoard(view);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", stop);
  window.addEventListener("keydown", key, true);
}
