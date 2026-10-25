// The board's Agents tab without a DOM (CONTRACTS 4.3, round 2): which
// column an agent sits in, what its card says, the idle toggle and the search.
import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_COLUMNS, AGENT_IDLE_AFTER_S, agentCards, agentColumn, agentColumns, matchesAgentSearch, subagentSummary,
} from "../../quickterm/frontend/js/board_model.js";

const agent = (fields = {}) => ({
  kind: "claude", state: "idle", prompt: null, message: null, tool: null, subagents: [],
  age_seconds: 0, last_prompt: null, last_answer: null, event_age_seconds: 0, board: undefined, ...fields,
});
const session = (id, fields = {}, agentFields = undefined) => ({
  id, name: "Claude Code", alive: true, workspace: null,
  agent: agentFields === null ? null : agent(agentFields), ...fields,
});

const workspaces = [
  { name: "web", path: "C:\\src\\web", git: { branch: "fix-login", head: "abc1234", worktree: false } },
  { name: "api", path: "C:\\src\\api", git: null },
];

test("the four columns, in order", () => {
  assert.deepEqual(AGENT_COLUMNS.map((column) => [column.id, column.label]), [
    ["needs-you", "Needs you"], ["working", "Working"], ["done", "Done"], ["idle", "Idle"],
  ]);
});

test("the backend's column wins; terminals without an agent have none", () => {
  assert.equal(agentColumn(session("a", {}, { state: "working", board: "idle" })), "idle");
  assert.equal(agentColumn(session("a", {}, { state: "idle", board: "done" })), "done");
  assert.equal(agentColumn(session("a", {}, null)), null);
  assert.equal(agentColumn(session("a", { alive: false }, { state: "working" })), null);
  // A bell or a notification from the agent's own output needs you too.
  assert.equal(agentColumn(session("a", { attention: { kind: "bell" } }, { board: "working" })), "needs-you");
});

test("without the backend's column, the same rules apply here", () => {
  const column = (fields) => agentColumn(session("a", {}, fields));
  assert.equal(column({ state: "working" }), "working");
  assert.equal(column({ state: "waiting" }), "needs-you");
  assert.equal(column({ state: "done" }), "done");
  assert.equal(column({ state: "failed" }), "done");
  assert.equal(column({ state: "idle" }), "idle");
  assert.equal(column({ state: "working", event_age_seconds: AGENT_IDLE_AFTER_S }), "idle");
  assert.equal(column({ state: "waiting", event_age_seconds: 10 * AGENT_IDLE_AFTER_S }), "needs-you");
  // The parent works on, but one of its subagents asks for a permission.
  assert.equal(column({ state: "working", subagents: [{ id: "s1", waiting: true }] }), "needs-you");
});

test("a card says what was asked, the start of the answer, where and how long ago", () => {
  const sessions = [
    session("one", { name: "Fix the login form" }, {
      state: "done", board: "done", last_prompt: "fix the login form", last_answer: "Fixed it. Tests pass.",
      prompt: "short prompt", event_age_seconds: 300,
    }),
  ];
  const [card] = agentCards(sessions, { workspaces, owners: { one: "web" } });
  assert.equal(card.column, "done");
  assert.equal(card.label, "Fix the login form");
  assert.equal(card.agent, "Claude Code");
  assert.equal(card.glyph, "✳");
  assert.equal(card.prompt, "fix the login form");
  assert.equal(card.answer, "Fixed it. Tests pass.");
  assert.equal(card.workspace, "web");
  assert.equal(card.branch, "fix-login");
  assert.equal(card.age, "5m");
  assert.equal(card.session, sessions[0]);
});

test("without an answer the card says what the agent is doing", () => {
  const cards = agentCards([
    session("w", {}, { state: "working", board: "working", tool: "Bash", last_prompt: "run it" }),
    session("q", { attention: { kind: "notify", text: "permission to use Edit" } },
      { state: "waiting", board: "needs-you" }),
    session("s", {}, { state: "working", board: "needs-you", subagents: [{ id: "x", type: "Explore", waiting: true }] }),
  ]);
  const notes = Object.fromEntries(cards.map((card) => [card.id, card.note]));
  assert.deepEqual(notes, { w: "running Bash", q: "permission to use Edit", s: "a subagent asks for permission" });
  assert.ok(cards.every((card) => card.answer === ""));
});

test("Codex cards and terminals the sidebar owns", () => {
  const [card] = agentCards(
    [session("c", { name: "", workspace: "api" }, { kind: "codex", state: "done", board: "done", last_answer: "ok" })],
    { workspaces },
  );
  assert.equal(card.agent, "Codex");
  assert.equal(card.label, "Codex");
  assert.equal(card.glyph, "◎");
  assert.equal(card.workspace, "api");
  assert.equal(card.branch, "");
});

test("the latest event comes first in a column", () => {
  const cards = agentCards([
    session("old", { name: "b" }, { state: "working", board: "working", event_age_seconds: 600 }),
    session("new", { name: "a" }, { state: "working", board: "working", event_age_seconds: 5 }),
  ]);
  assert.deepEqual(cards.map((card) => card.id), ["new", "old"]);
});

test("idle hides behind the toggle but is still counted", () => {
  const cards = agentCards([
    session("i1", {}, { board: "idle" }),
    session("i2", {}, { board: "idle" }),
    session("w", {}, { state: "working", board: "working" }),
  ]);
  const hidden = agentColumns(cards, "");
  const idle = hidden.find((column) => column.id === "idle");
  assert.equal(idle.hidden, true);
  assert.equal(idle.count, 2);
  assert.deepEqual(hidden.filter((column) => !column.hidden).map((column) => column.id),
    ["needs-you", "working", "done"]);
  const shown = agentColumns(cards, "", { showIdle: true });
  assert.ok(shown.every((column) => !column.hidden));
  assert.deepEqual(shown.map((column) => column.count), [0, 1, 0, 2]);
});

test("search looks at everything a card says", () => {
  const [card] = agentCards([
    session("one", { name: "Release notes" }, {
      state: "done", board: "done", last_prompt: "write the notes", last_answer: "Wrote CHANGELOG entries",
      subagents: [{ id: "s", description: "Scan the commits" }],
    }),
  ], { workspaces, owners: { one: "web" } });
  for (const query of ["", "release", "write notes", "changelog", "fix-login", "WEB", "claude code", "commits"]) {
    assert.ok(matchesAgentSearch(card, query), query);
  }
  assert.ok(!matchesAgentSearch(card, "deploy"));
  const columns = agentColumns([card], "deploy");
  assert.ok(columns.every((column) => column.count === 0));
});

test("folded subagents say how many, and how many wait", () => {
  assert.equal(subagentSummary([]), "");
  assert.equal(subagentSummary([{ id: "a" }]), "1 subagent");
  assert.equal(subagentSummary([{ id: "a" }, { id: "b", waiting: true }]), "2 subagents, 1 waiting");
});
