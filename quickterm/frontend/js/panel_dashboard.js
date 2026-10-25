// The workspace board: every saved workspace as a card in the column its
// state puts it in (CONTRACTS 4.5 wave 2): Needs you, Working, In review,
// Changes, Done, Idle. Nobody drags a card; GET /api/board says where each
// one belongs and why, and a card whose status changed slides over by
// itself. It lives in the panel that used to be the dashboard, opened by the
// same button, Alt+G and palette entry. Its second tab, Agents, shows every
// agent session by where it is (panel_agents.js).
//
// Built once and patched afterwards, like every live panel (render.js): the
// 5 s refresh must not take the search text or the focused card away.
// Listeners read itemFor(node) or the live view object, never the data they
// were built from.

import * as api from "./api.js";
import { isScratchWorkspace } from "./boot_context.js";
import { locationPath, locationTag } from "./locations.js";
import { BOARD_COLUMNS, boardCards, boardColumns, columnLabel } from "./board_model.js";
import { applyAgents, buildAgents, focusFirstAgent } from "./panel_agents.js";
import { make } from "./panel_shared.js";
import { itemFor, patchList, setAttrs, setClass, setText } from "./render.js";

const TAB_KEY = "quickterm.boardTab";
const SLIDE_MS = 220;
const TABS = Object.freeze([
  Object.freeze({ id: "workspaces", label: "Workspaces", placeholder: "Search workspaces",
    aria: "Search workspaces by name, repo, branch or status" }),
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
  const states = board?.workspaces && typeof board.workspaces === "object" ? board.workspaces : null;
  return { workspaces, sessions, board: states, owners, attached };
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
  if (data.board) view.board = data.board;
  view.note.hidden = Boolean(data.board) || !view.workspaces.length;
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
    workspaces: [], sessions: [], board: {}, owners: {}, attached: {},
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

  view.note = make("p", "board-note", "The board's status could not be read; every card waits in Idle until it can.");
  view.note.hidden = true;
  const columns = make("div", "board-columns");
  for (const { id, label, meaning } of BOARD_COLUMNS) {
    const column = make("section", "board-column");
    column.dataset.status = id;
    const head = make("header", "board-column-head");
    const mark = make("span", "board-status-icon");
    mark.dataset.status = id;
    mark.setAttribute("aria-hidden", "true");
    const count = make("span", "board-column-count");
    const title = make("div", "board-column-heading");
    const line = make("div", "board-column-line");
    line.append(mark, make("h2", "board-column-title", label), count);
    title.append(line, make("p", "board-column-meaning", meaning));
    head.append(title);
    const list = make("div", "board-cards");
    list.setAttribute("aria-label", `${label}: ${meaning}`);
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
  const cards = boardCards(view.workspaces, {
    sessions: view.sessions, owners: view.owners, attached: view.attached, board: view.board,
  });
  const columns = boardColumns(cards, queryFor(view, "workspaces"));
  // A card whose status changed keeps its node: it is carried over to its
  // new column before the patch (which then updates it in place) and slides
  // from where it was. Positions are read before anything moves.
  const target = new Map();
  for (const column of columns) for (const card of column.cards) target.set(card.name, column.id);
  const moving = [];
  for (const [id, column] of view.columns) {
    for (const node of columnParts.get(column).list.children) {
      const next = target.get(itemFor(node)?.name);
      if (next && next !== id) moving.push({ node, next, from: node.getBoundingClientRect() });
    }
  }
  for (const move of moving) {
    move.focused = move.node.contains(document.activeElement);
    columnParts.get(view.columns.get(move.next)).list.append(move.node);
  }
  for (const column of columns) {
    const node = view.columns.get(column.id);
    const { count, list, empty } = columnParts.get(node);
    setText(count, String(column.count));
    empty.hidden = column.count > 0;
    patchList(list, column.cards, view.cardSpec);
  }
  for (const move of moving) {
    if (move.focused) move.node.focus({ preventScroll: true });
    slide(move.node, move.from);
  }
}

// The usual slide. A column's list scrolls and would clip the card on its
// way over, so a copy travels above the board from the old place to the new
// one while the card itself waits there unseen.
function slide(node, from) {
  if (!node.isConnected || node.hidden) return;
  if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
  const to = node.getBoundingClientRect();
  const dx = to.left - from.left;
  const dy = to.top - from.top;
  if ((!dx && !dy) || !from.width || !to.width) return;
  const ghost = node.cloneNode(true);
  ghost.classList.add("board-card-ghost");
  ghost.removeAttribute("tabindex");
  ghost.removeAttribute("role");
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.left = `${from.left}px`;
  ghost.style.top = `${from.top}px`;
  ghost.style.width = `${to.width}px`;
  document.body.append(ghost);
  node.classList.add("arriving");
  void ghost.offsetWidth;
  ghost.style.transform = `translate(${dx}px, ${dy}px)`;
  setTimeout(() => {
    ghost.remove();
    node.classList.remove("arriving");
  }, SLIDE_MS + 40);
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
  const reason = make("p", "board-reason");
  const lines = make("div", "board-lines");
  card.append(name, meta, reason, lines);
  cardParts.set(card, { name, meta, repo, branch, host, worktree, reason, lines });

  card.addEventListener("click", () => openCard(view, card));
  card.addEventListener("keydown", (event) => {
    if (event.target !== card || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openCard(view, card);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const sibling = event.key === "ArrowDown" ? card.nextElementSibling : card.previousElementSibling;
      sibling?.focus();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      // To the first card of the nearest column that has one.
      event.preventDefault();
      focusNextColumn(view, card, event.key === "ArrowLeft" ? -1 : 1);
    }
  });
  return card;
}

function focusNextColumn(view, card, step) {
  const ids = BOARD_COLUMNS.map((column) => column.id);
  const here = ids.indexOf(itemFor(card)?.status);
  for (let at = here + step; at >= 0 && at < ids.length; at += step) {
    const first = columnParts.get(view.columns.get(ids[at])).list.firstElementChild;
    if (first) {
      first.focus();
      return;
    }
  }
}

function updateCard(card, data) {
  const parts = cardParts.get(card);
  setText(parts.name, data.name);
  setText(parts.repo, data.repo);
  parts.repo.hidden = !data.repo;
  setText(parts.branch, data.branch);
  parts.branch.hidden = !data.branch;
  setText(parts.host, locationTag(data.host));
  parts.host.hidden = !data.host;
  parts.worktree.hidden = !data.worktree;
  setAttrs(parts.worktree, { title: data.worktree || false });
  parts.meta.hidden = !data.repo && !data.branch && !data.host;
  setText(parts.reason, data.reason);
  parts.reason.hidden = !data.reason;
  setAttrs(card, { "data-status": data.status });
  const live = data.lines.length;
  setAttrs(card, {
    title: data.path ? locationPath(data.host, data.path) : false,
    "aria-label": `${data.name}${data.repo ? `, ${data.repo}` : ""}${data.branch ? ` on ${data.branch}` : ""}, `
      + `${columnLabel(data.status)}${data.reason ? `: ${data.reason}` : ""}, `
      + `${live} terminal${live === 1 ? "" : "s"}. Enter shows it.`,
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
