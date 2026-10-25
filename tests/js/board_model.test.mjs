// The workspace board's pure model (CONTRACTS 4.3): columns, the default
// column, the search and what a card says.
import test from "node:test";
import assert from "node:assert/strict";

import {
  BOARD_STATUSES, DEFAULT_STATUS, boardCards, boardColumns, branchName, cardLines, matchesSearch,
  movedStatus, repoName, statusOf,
} from "../../quickterm/frontend/js/board_model.js";

const workspaces = [
  { name: "web", path: "C:\\src\\web", git: { branch: "main", head: "abc1234", worktree: false, main_path: null } },
  { name: "api", path: "C:\\src\\api", git: null, host: "devbox" },
  {
    name: "web/fix-login", path: "C:\\src\\web-worktrees\\fix-login",
    git: { branch: "fix-login", head: "def5678", worktree: true, main_path: "C:\\src\\web" },
  },
  { name: "scratch", path: null, git: null },
  { name: "scratch-view-0123456789ab", path: null, git: null },
];

test("the four columns, in order, with in-progress the default", () => {
  assert.deepEqual(BOARD_STATUSES, ["todo", "in-progress", "in-review", "done"]);
  assert.equal(DEFAULT_STATUS, "in-progress");
  assert.equal(statusOf("web", {}), "in-progress");
  assert.equal(statusOf("web", { web: "done" }), "done");
  assert.equal(statusOf("web", { web: "blocked" }), "in-progress");
  assert.equal(statusOf("web", null), "in-progress");
});

test("every saved workspace is one card in exactly one column; scratch is none", () => {
  const cards = boardCards(workspaces);
  assert.deepEqual(cards.map((card) => card.name), ["api", "web", "web/fix-login"]);
  const columns = boardColumns(cards, { api: "todo", "web/fix-login": "in-review", gone: "done" });
  assert.deepEqual(columns.map((column) => [column.id, column.label, column.count]), [
    ["todo", "Todo", 1], ["in-progress", "In progress", 1], ["in-review", "In review", 1], ["done", "Done", 0],
  ]);
  assert.deepEqual(columns.map((column) => column.cards.map((card) => card.name)),
    [["api"], ["web"], ["web/fix-login"], []]);
});

test("a card names its repo and branch; a worktree checkout only says so", () => {
  const [api, web, tree] = boardCards(workspaces);
  assert.equal(api.repo, "");
  assert.equal(api.branch, "");
  assert.equal(web.repo, "web");
  assert.equal(web.branch, "main");
  assert.equal(web.worktree, null);
  assert.equal(tree.repo, "fix-login");
  assert.equal(tree.branch, "fix-login");
  assert.equal(tree.worktree, "worktree of C:\\src\\web");
  assert.equal(branchName({ branch: null, head: "abc1234" }), "@abc1234");
  assert.equal(repoName(null, "C:\\src\\web"), "");
  assert.equal(api.host, "devbox");
  assert.equal(web.host, null);
});

test("the search keeps cards whose name, repo or branch holds every word", () => {
  const cards = boardCards(workspaces);
  const names = (query) => boardColumns(cards, {}, query).flatMap((column) => column.cards.map((card) => card.name));
  assert.deepEqual(names(""), ["api", "web", "web/fix-login"]);
  assert.deepEqual(names("LOGIN"), ["web/fix-login"]);
  assert.deepEqual(names("main"), ["web"]);
  assert.deepEqual(names("web fix"), ["web/fix-login"]);
  assert.deepEqual(names("nothing"), []);
  assert.equal(matchesSearch({ name: "x", repo: "", branch: "" }, "  "), true);
  // Counts follow the filter.
  assert.deepEqual(boardColumns(cards, {}, "api").map((column) => column.count), [0, 1, 0, 0]);
});

test("card lines: live terminals of the workspace, agent mark, state, age and subagents", () => {
  const sessions = [
    {
      id: "s1", name: "Open issues", alive: true, workspace: "web",
      agent: {
        kind: "claude", state: "working",
        subagents: [{ id: "a", description: "Explore auth" }, { id: "b", type: "general" }, { description: "no id" }],
      },
      activity: { idle_seconds: 900 },
    },
    { id: "s2", name: "build", alive: true, workspace: "web", activity: { idle_seconds: 120 } },
    { id: "s3", name: "old", alive: false, workspace: "web" },
    { id: "s4", name: "moved", alive: true, workspace: "api" },
    { id: "s5", name: "loose", alive: true, workspace: null },
  ];
  const cards = boardCards(workspaces, { sessions, owners: { s4: "web" }, attached: { s2: "web" } });
  const web = cards.find((card) => card.name === "web");
  assert.deepEqual(web.lines, [
    { id: "s2", state: "open", glyph: "", label: "build", age: "2m", subagents: [] },
    { id: "s4", state: "idle", glyph: "", label: "moved", age: "", subagents: [] },
    {
      id: "s1", state: "busy", glyph: "\u2733", label: "Open issues", age: "now",
      subagents: [{ id: "a", label: "Explore auth" }, { id: "b", label: "general" }],
    },
  ].sort((a, b) => a.label.localeCompare(b.label)));
  assert.deepEqual(cards.find((card) => card.name === "api").lines, []);
  assert.equal(cardLines([{ id: "c1", alive: true, agent: { kind: "codex", state: "waiting" } }])[0].glyph, "\u25ce");
  assert.equal(cardLines([{ id: "abcdef0123456789", alive: true }])[0].label, "abcdef01");
});

test("Alt+Left and Alt+Right step one column and stop at the edges", () => {
  assert.equal(movedStatus("todo", 1), "in-progress");
  assert.equal(movedStatus("in-progress", 1), "in-review");
  assert.equal(movedStatus("done", 1), "done");
  assert.equal(movedStatus("todo", -1), "todo");
  assert.equal(movedStatus("in-review", -1), "in-progress");
  assert.equal(movedStatus(undefined, 1), "in-review");
});
