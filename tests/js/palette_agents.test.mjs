// The palette's 4.2 parts: `@` ranks terminals that want you first without
// touching the sidebar.
import test from "node:test";
import assert from "node:assert/strict";
import { Palette } from "../../quickterm/frontend/js/palette.js";
import { placeRank, terminalRows } from "../../quickterm/frontend/js/palette_items.js";

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
  assert.equal(palette.filtered.at(-1).label, "open scratch");
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

test("the palette has no worktree rows", () => {
  const items = Palette.prototype._staticItems.call({ app: { profiles: [], snippets: [] } });
  assert.ok(!items.some((item) => /worktree/.test(item.label)));
});
