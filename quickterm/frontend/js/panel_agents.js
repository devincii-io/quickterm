// The board's Agents tab: one card per agent session, in the column where
// the agent is (board_model.js `agentColumns`). Built once and patched on
// every refresh like the workspace board; listeners read itemFor(node).
//
// A card says what was asked ("You ..."), the start of the answer, where it
// runs and how long ago it last did anything. Clicking it shows that
// terminal. Idle agents wait behind a slim toggle at the end of the row, so
// the board opens on what moves.

import { AGENT_COLUMNS, agentCards, agentColumns, subagentSummary } from "./board_model.js";
import { make } from "./panel_shared.js";
import { itemFor, patchList, setAttrs, setClass, setText } from "./render.js";

const SHOW_IDLE_KEY = "quickterm.boardShowIdle";

const columnParts = new WeakMap();
const cardParts = new WeakMap();

function loadShowIdle() {
  try { return globalThis.localStorage?.getItem(SHOW_IDLE_KEY) === "1"; } catch (_) { return false; }
}

function saveShowIdle(value) {
  try { globalThis.localStorage?.setItem(SHOW_IDLE_KEY, value ? "1" : "0"); } catch (_) { /* per-viewer only */ }
}

// `host` is the board view (panel_dashboard.js): its panel, the sessions,
// the workspaces and the owners, refreshed every 5 s.
export function buildAgents(host) {
  const root = make("div", "agent-board");
  root.hidden = true;
  const view = {
    root, host,
    showIdle: loadShowIdle(),
    // Cards whose subagent list is open; kept across refreshes.
    unfolded: new Set(),
    columns: new Map(),
  };
  const columns = make("div", "board-columns agent-columns");
  for (const { id, label } of AGENT_COLUMNS) {
    const column = make("section", "board-column agent-column");
    column.dataset.column = id;
    const head = make("header", "board-column-head");
    const mark = make("span", "agent-column-mark");
    mark.dataset.column = id;
    mark.setAttribute("aria-hidden", "true");
    const count = make("span", "board-column-count");
    head.append(mark, make("h2", "board-column-title", label), count);
    if (id === "idle") {
      const hide = make("button", "agent-idle-hide", "Hide");
      hide.type = "button";
      hide.title = "Hide idle agents";
      hide.addEventListener("click", () => setShowIdle(view, false));
      head.append(hide);
    }
    const list = make("div", "board-cards");
    list.setAttribute("aria-label", label);
    const empty = make("p", "board-empty", "Empty");
    column.append(head, list, empty);
    columns.append(column);
    columnParts.set(column, { count, list, empty });
    view.columns.set(id, column);
  }
  // The toggle stands where the Idle column would be.
  view.idleToggle = make("button", "agent-idle-toggle");
  view.idleToggle.type = "button";
  view.idleToggle.addEventListener("click", () => setShowIdle(view, true));
  columns.append(view.idleToggle);
  view.grid = columns;
  view.emptyAll = make("p", "agent-board-empty",
    "No agents yet. Start Claude Code or Codex from the + menu, and each one shows up here.");
  view.emptyAll.hidden = true;
  root.append(view.emptyAll, columns);
  view.cardSpec = {
    key: (card) => card.id,
    create: () => createCard(view),
    update: (node, card) => updateCard(view, node, card),
  };
  return view;
}

function setShowIdle(view, value) {
  view.showIdle = value;
  saveShowIdle(value);
  applyAgents(view, view.query || "");
  if (value) columnParts.get(view.columns.get("idle"))?.list.querySelector(".agent-card")?.focus();
  else view.idleToggle.focus();
}

export function applyAgents(view, query = "") {
  view.query = query;
  const host = view.host;
  const cards = agentCards(host.sessions, { workspaces: host.workspaces, owners: host.owners });
  const columns = agentColumns(cards, query, { showIdle: view.showIdle });
  for (const column of columns) {
    const node = view.columns.get(column.id);
    const { count, list, empty } = columnParts.get(node);
    node.hidden = column.hidden;
    setText(count, String(column.count));
    empty.hidden = column.count > 0;
    patchList(list, column.cards, view.cardSpec);
  }
  const idle = columns.find((column) => column.id === "idle");
  view.idleToggle.hidden = !idle.hidden;
  setText(view.idleToggle, idle.count ? `Idle ${idle.count}` : "Idle");
  setAttrs(view.idleToggle, {
    title: `Show idle agents (${idle.count})`,
    "aria-label": `Show ${idle.count} idle agent${idle.count === 1 ? "" : "s"}`,
  });
  setClass(view.grid, "idle-shown", !idle.hidden);
  view.emptyAll.hidden = cards.length > 0;
  setClass(view.root, "no-agents", cards.length === 0);
}

function createCard(view) {
  const card = make("article", "board-card agent-card");
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  const head = make("div", "agent-card-head");
  const dot = make("span", "board-dot");
  const glyph = make("span", "board-glyph");
  const label = make("h3", "agent-card-label");
  const age = make("span", "board-line-age");
  head.append(dot, glyph, label, age);
  const prompt = make("p", "agent-card-prompt");
  const you = make("span", "agent-card-you", "You");
  const promptText = make("span", "agent-card-prompt-text");
  prompt.append(you, promptText);
  const answer = make("p", "agent-card-answer");
  const meta = make("div", "board-card-meta");
  const where = make("span", "board-repo");
  const branch = make("span", "board-branch");
  meta.append(where, branch);
  const subsToggle = make("button", "agent-card-subs");
  subsToggle.type = "button";
  const subs = make("div", "board-sublines");
  card.append(head, prompt, answer, meta, subsToggle, subs);
  cardParts.set(card, { dot, glyph, label, age, prompt, promptText, answer, meta, where, branch, subsToggle, subs });

  subsToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    const id = itemFor(card)?.id;
    if (!id) return;
    if (view.unfolded.has(id)) view.unfolded.delete(id);
    else view.unfolded.add(id);
    updateCard(view, card, itemFor(card));
  });
  subsToggle.addEventListener("keydown", (event) => event.stopPropagation());
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
      event.preventDefault();
      neighbourColumn(view, card, event.key === "ArrowLeft" ? -1 : 1)?.focus();
    }
  });
  return card;
}

function updateCard(view, card, data) {
  if (!data) return;
  const parts = cardParts.get(card);
  card.dataset.column = data.column;
  parts.dot.className = `board-dot state-${data.dot}`;
  setText(parts.glyph, data.glyph);
  parts.glyph.hidden = !data.glyph;
  setText(parts.label, data.label);
  setText(parts.age, data.age);
  setText(parts.promptText, data.prompt);
  parts.prompt.hidden = !data.prompt;
  setText(parts.answer, data.answer || data.note);
  parts.answer.hidden = !(data.answer || data.note);
  setClass(parts.answer, "is-note", !data.answer);
  setText(parts.where, data.workspace);
  parts.where.hidden = !data.workspace;
  setText(parts.branch, data.branch);
  parts.branch.hidden = !data.branch;
  parts.meta.hidden = !data.workspace && !data.branch;
  const summary = subagentSummary(data.subagents);
  const open = Boolean(summary) && view.unfolded.has(data.id);
  setText(parts.subsToggle, summary);
  parts.subsToggle.hidden = !summary;
  setAttrs(parts.subsToggle, { "aria-expanded": open ? "true" : "false" });
  setClass(parts.subsToggle, "has-waiting", data.subagents.some((sub) => sub.waiting));
  parts.subs.hidden = !open;
  patchList(parts.subs, open ? data.subagents : [], {
    key: (sub) => sub.id,
    create: () => make("div", "board-subline"),
    update: (node, sub) => {
      setText(node, sub.waiting ? `${sub.label} (waiting)` : sub.label);
      setClass(node, "is-waiting", sub.waiting);
    },
  });
  const said = [data.prompt && `You: ${data.prompt}`, data.answer || data.note].filter(Boolean).join(". ");
  setAttrs(card, {
    title: [data.agent, data.workspace, data.branch].filter(Boolean).join(" · ") || false,
    "aria-label": `${data.label}, ${columnLabel(data.column)}${data.age ? `, ${data.age}` : ""}. ${said}. Enter shows it.`,
  });
}

function columnLabel(id) {
  return AGENT_COLUMNS.find((column) => column.id === id)?.label.toLowerCase() || id;
}

function neighbourColumn(view, card, delta) {
  const ids = AGENT_COLUMNS.map((column) => column.id).filter((id) => !view.columns.get(id).hidden);
  let at = ids.indexOf(card.dataset.column);
  for (let step = 0; step < ids.length; step++) {
    at += delta;
    if (at < 0 || at >= ids.length) return null;
    const first = columnParts.get(view.columns.get(ids[at])).list.firstElementChild;
    if (first) return first;
  }
  return null;
}

function openCard(view, card) {
  const session = itemFor(card)?.session;
  if (!session) return;
  const panel = view.host.panel;
  panel.close();
  panel.app.activateTerminal?.(session);
}

export function focusFirstAgent(view) {
  view.root.querySelector(".agent-card")?.focus();
}
