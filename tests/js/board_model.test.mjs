// The workspace board's pure model (CONTRACTS 4.5 wave 2): six derived
// columns, the status and reason from GET /api/board, missing means Idle,
// the search and what a card says.
import test from "node:test";
import assert from "node:assert/strict";

import {
  BOARD_COLUMNS, BOARD_STATUSES, DEFAULT_STATUS, boardCards, boardColumns, branchName, cardLines, columnLabel,
  matchesSearch, reasonOf, repoName, statusOf,
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

const board = {
  web: { status: "needs-you", reason: "Claude waits for permission", since: 1, git: null, pr: null },
  "web/fix-login": {
    status: "in-review", reason: "PR #12 open · checks passing", since: 2,
    git: { branch: "fix-login", dirty: false, ahead: 0, behind: 0 }, pr: { number: 12, state: "open" },
  },
  gone: { status: "done", reason: "PR #3 merged" },
};

test("six columns in the contract's order, each with its one-line meaning; Idle is the default", () => {
  assert.deepEqual(BOARD_STATUSES, ["needs-you", "working", "in-review", "changes", "done", "idle"]);
  assert.deepEqual(BOARD_COLUMNS.map((column) => column.label),
    ["Needs you", "Working", "In review", "Changes", "Done", "Idle"]);
  for (const column of BOARD_COLUMNS) assert.ok(column.meaning && !column.meaning.includes("\u2014"), column.id);
  assert.equal(DEFAULT_STATUS, "idle");
  assert.equal(columnLabel("changes"), "Changes");
  assert.equal(columnLabel("blocked"), "Idle");
});

test("a status comes from the board answer; unknown, missing or unreadable is Idle", () => {
  assert.equal(statusOf("web", board), "needs-you");
  assert.equal(statusOf("api", board), "idle", "missing from the answer");
  assert.equal(statusOf("web", { web: { status: "blocked" } }), "idle");
  assert.equal(statusOf("web", { web: "done" }), "idle", "the old flat shape is not a status");
  assert.equal(statusOf("web", null), "idle");
  assert.equal(reasonOf("web", board), "Claude waits for permission");
  assert.equal(reasonOf("api", board), "");
  assert.equal(reasonOf("web", { web: { reason: 3 } }), "");
});

test("every saved workspace is one card in exactly one column; scratch is none", () => {
  const cards = boardCards(workspaces, { board });
  assert.deepEqual(cards.map((card) => card.name), ["api", "web", "web/fix-login"]);
  const columns = boardColumns(cards);
  assert.deepEqual(columns.map((column) => [column.id, column.count]), [
    ["needs-you", 1], ["working", 0], ["in-review", 1], ["changes", 0], ["done", 0], ["idle", 1],
  ]);
  assert.deepEqual(columns.map((column) => column.cards.map((card) => card.name)),
    [["web"], [], ["web/fix-login"], [], [], ["api"]]);
  assert.equal(columns[0].meaning, BOARD_COLUMNS[0].meaning);
});

test("the reason passes through to the card unchanged", () => {
  const cards = boardCards(workspaces, { board });
  assert.equal(cards.find((card) => card.name === "web").reason, "Claude waits for permission");
  assert.equal(cards.find((card) => card.name === "web/fix-login").reason, "PR #12 open · checks passing");
  assert.equal(cards.find((card) => card.name === "api").reason, "");
});

test("inside a column cards stay in name order, whatever the answer's order or time", () => {
  const many = [{ name: "b" }, { name: "C" }, { name: "a" }];
  const states = { a: { status: "working", since: 30 }, b: { status: "working", since: 10 }, C: { status: "working", since: 20 } };
  const [, working] = boardColumns(boardCards(many, { board: states }));
  assert.deepEqual(working.cards.map((card) => card.name), ["a", "b", "C"]);
  // A changed status moves the card and nothing else.
  const moved = boardColumns(boardCards(many, { board: { ...states, b: { status: "done" } } }));
  assert.deepEqual(moved[1].cards.map((card) => card.name), ["a", "C"]);
  assert.deepEqual(moved[4].cards.map((card) => card.name), ["b"]);
});

test("a card names its repo and branch; the board's git fills a branch the folder scan lacks", () => {
  const [api, web, tree] = boardCards(workspaces, { board });
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
  const remote = boardCards([{ name: "api", path: "/srv/api", git: null, host: "devbox" }], {
    board: { api: { status: "changes", git: { branch: "feature", dirty: true, ahead: 2, behind: 0 } } },
  })[0];
  assert.equal(remote.branch, "feature");
  assert.equal(remote.repo, "api");
});

test("the search keeps cards whose name, repo, branch or reason holds every word", () => {
  const cards = boardCards(workspaces, { board });
  const names = (query) => boardColumns(cards, query).flatMap((column) => column.cards.map((card) => card.name));
  assert.deepEqual(names(""), ["web", "web/fix-login", "api"]);
  assert.deepEqual(names("LOGIN"), ["web/fix-login"]);
  assert.deepEqual(names("main"), ["web"]);
  assert.deepEqual(names("web fix"), ["web/fix-login"]);
  assert.deepEqual(names("permission"), ["web"]);
  assert.deepEqual(names("nothing"), []);
  assert.equal(matchesSearch({ name: "x", repo: "", branch: "" }, "  "), true);
  // Counts follow the filter.
  assert.deepEqual(boardColumns(cards, "api").map((column) => column.count), [0, 0, 0, 0, 0, 1]);
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
  assert.equal(web.status, "idle", "no board answer: every card is Idle");
  assert.equal(cardLines([{ id: "c1", alive: true, agent: { kind: "codex", state: "waiting" } }])[0].glyph, "\u25ce");
  assert.equal(cardLines([{ id: "abcdef0123456789", alive: true }])[0].label, "abcdef01");
});
