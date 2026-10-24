// The palette's 4.2 parts: `@` ranks terminals that want you first without
// touching the sidebar, and "new worktree…" asks for a branch inline.
import test from "node:test";
import assert from "node:assert/strict";
import { Palette } from "../../quickterm/frontend/js/palette.js";
import { placeRank, terminalRows, worktreeSources } from "../../quickterm/frontend/js/palette_items.js";

function fakePalette(app) {
  const palette = Object.create(Palette.prototype);
  Object.assign(palette, {
    app, open: true, items: [], filtered: [], sel: 0, prompt: null,
    foreignMode: false, windowMode: false, searchMode: false,
    killMode: false, killTarget: null, killPending: false, treeMode: false, treePending: false,
    foreignSessions: [], requestId: 1,
    late: { names: [], details: new Map(), attach: [], agentSessions: [] },
    input: { value: "", placeholder: "", focus() {}, setAttribute() {}, removeAttribute() {} },
    overlay: { hidden: false },
    listEl: { textContent: "" },
    _renderList() {},
    focusInput() {},
  });
  return palette;
}

const press = (key) => ({ key, preventDefault() {}, stopPropagation() {} });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function terminal(id, extra = {}, attachedIn = null) {
  return {
    session: { id, name: id, alive: true, busy: false, attention: null, agent: null, ...extra },
    workspace: "qt", label: "qt", attachedIn,
  };
}

const agent = (state) => ({ kind: "claude", state, prompt: null, message: null, tool: null, subagents: [], age_seconds: 1 });

const terminals = [
  terminal("a-plain"),
  terminal("b-working", { agent: agent("working") }),
  terminal("c-done", { agent: agent("done") }),
  terminal("d-waiting", { agent: agent("waiting") }),
  terminal("e-failed", { agent: agent("failed") }),
  terminal("f-ringing", { attention: { kind: "bell" } }),
  terminal("g-busy", { busy: true }),
];

test("terminal hints name the agent state", () => {
  const hints = terminalRows({ liveTerminals: () => terminals }).map((row) => row.hint);
  assert.deepEqual(hints, [
    "qt · background", "qt · working", "qt · done", "qt · needs you", "qt · failed", "qt · needs you", "qt · busy",
  ]);
  assert.equal(placeRank({ kind: "workspace" }), 3);
});

test("@ lists what needs you first, then finished turns, then working, then the rest", () => {
  const palette = fakePalette({ liveTerminals: () => terminals, profiles: [], snippets: [] });
  palette._compose();
  palette.input.value = "@";
  palette._refilter();
  const names = palette.filtered.filter((item) => item.terminal).map((item) => item.terminal.session.id);
  assert.deepEqual(names, ["d-waiting", "f-ringing", "c-done", "e-failed", "b-working", "g-busy", "a-plain"]);
  // Workspace rows keep their place after the terminals.
  assert.equal(palette.filtered.at(-1).label, "new scratch view");
});

test("with a query typed the match leads and the rank only breaks ties", () => {
  const palette = fakePalette({ liveTerminals: () => terminals, profiles: [], snippets: [] });
  palette._compose();
  palette.input.value = "@a-plain";
  palette._refilter();
  assert.equal(palette.filtered[0].terminal.session.id, "a-plain");
});

test("the plain command list is not ranked", () => {
  const palette = fakePalette({ liveTerminals: () => terminals, profiles: [], snippets: [] });
  palette._compose();
  palette.input.value = "go to terminal";
  palette._refilter();
  assert.equal(palette.filtered[0].terminal.session.id, "a-plain");
});

test("worktrees start from saved workspaces in a git folder, the front one first", () => {
  const details = new Map([
    ["web", { path: "C:\\src\\web", git: { branch: "main", head: null, worktree: false, main_path: null } }],
    ["notes", { path: "C:\\notes", git: null }],
    ["qt", { path: "C:\\src\\qt", git: { branch: "dev", head: null, worktree: false, main_path: null } }],
    ["api", { path: "C:\\src\\api", git: { branch: null, head: "abc1234", worktree: false, main_path: null } }],
    ["scratch-view-abcdefgh", { path: "C:\\tmp", git: { branch: "x" } }],
  ]);
  assert.deepEqual(worktreeSources(details, "qt").map((row) => [row.name, row.branch]), [
    ["qt", "dev"], ["api", "abc1234"], ["web", "main"],
  ]);
});

test("new worktree from the sidebar asks only for the branch and closes once created", async () => {
  const calls = [];
  const palette = fakePalette({
    createWorktree: async (from, branch) => { calls.push([from, branch]); },
    refocusTerm: () => calls.push("refocus"),
  });
  palette.worktreeMode("qt");
  assert.ok(palette.prompt);
  palette.input.value = "feat/x";
  palette._key(press("Enter"));
  await settle();
  assert.deepEqual(calls, [["qt", "feat/x"], "refocus"]);
  assert.equal(palette.open, false);
});

test("a refused branch stays in the input with the reason under it, and Enter retries", async () => {
  let refuse = true;
  const calls = [];
  const palette = fakePalette({
    createWorktree: async (from, branch) => {
      calls.push(branch);
      if (refuse) throw { detail: "branch feat/x already exists" };
    },
  });
  palette.worktreeMode("qt");
  palette.input.value = "feat/x";
  palette._key(press("Enter"));
  await settle();
  assert.equal(palette.open, true);
  assert.equal(palette.input.value, "feat/x");
  assert.equal(palette.filtered[0].label, "branch feat/x already exists");
  refuse = false;
  palette._key(press("Enter"));
  await settle();
  assert.deepEqual(calls, ["feat/x", "feat/x"]);
  assert.equal(palette.open, false);
});

test("the palette row lists git workspaces and goes on to the branch", async () => {
  const palette = fakePalette({
    createWorktree: async () => {},
    currentWorkspace: () => null,
    profiles: [], snippets: [],
  });
  palette.late.details.set("qt", { path: "C:\\src\\qt", git: { branch: "main" } });
  const row = palette._staticItems().find((item) => item.label === "new worktree…");
  assert.ok(row?.keepOpen);
  row.run();
  assert.equal(palette.treeMode, true);
  assert.deepEqual(palette.filtered.map((item) => item.label), ["new worktree from: qt", "back to commands"]);
  palette.filtered[0].run();
  assert.equal(palette.treeMode, false);
  assert.ok(palette.prompt);
  // The fresh read of the workspaces lands after the branch prompt and leaves it alone.
  await settle();
  await settle();
  assert.ok(palette.prompt);
});

test("no createWorktree on the app, no row", () => {
  const items = Palette.prototype._staticItems.call({ app: { profiles: [], snippets: [] } });
  assert.ok(!items.some((item) => item.label === "new worktree…"));
});
