import test from "node:test";
import assert from "node:assert/strict";

import { createTerminalActions, resultLabel } from "../../quickterm/frontend/js/terminal_actions.js";

function fakePane(overrides = {}) {
  return {
    session: null,
    canRestart: false,
    notices: [],
    revealed: [],
    kept: false,
    flashNotice(text) { this.notices.push(text); },
    keepScreenOnNextAttach() { this.kept = true; },
    revealWhenReady(match) { this.revealed.push(match); return true; },
    ...overrides,
  };
}

function harness({ panes = [], sessions = [], fetchReply = null } = {}) {
  const calls = { restarted: [], attached: [], errors: [], opened: [], fetched: [] };
  const layout = {
    focused: panes[0] || null,
    panes: () => panes,
    focusPane(pane) { this.focused = pane; },
  };
  const api = {
    authHeaders: () => ({ "X-QuickTerm-Token": "t" }),
    getSessions: async () => sessions,
    openTarget: async (target) => { calls.opened.push(target); return { action: "opened" }; },
  };
  globalThis.fetch = async (path, init) => {
    calls.fetched.push({ path, init });
    const { status = 200, body = {} } = fetchReply || {};
    return { ok: status < 400, status, json: async () => body };
  };
  const actions = createTerminalActions({
    api,
    layout,
    attachSession(info) {
      calls.attached.push(info.id);
      const pane = fakePane({ session: info });
      panes.push(pane);
      layout.focused = pane;
      return true;
    },
    restartSavedPane: async (pane) => { calls.restarted.push(pane); return { id: "new" }; },
    showError: (text) => calls.errors.push(text),
  });
  return { actions, calls, layout };
}

test("restart keeps the screen and repeats the pane's own launch", async () => {
  const pane = fakePane({ canRestart: true });
  const { actions, calls } = harness({ panes: [pane] });
  assert.equal(actions.canRestartFocused(), true);
  await actions.restartTerminal();
  assert.equal(pane.kept, true);
  assert.deepEqual(calls.restarted, [pane]);
});

test("a running terminal is not restarted", async () => {
  const pane = fakePane({ canRestart: false });
  const { actions, calls } = harness({ panes: [pane] });
  assert.equal(actions.canRestartFocused(), false);
  await actions.restartTerminal();
  assert.deepEqual(calls.restarted, []);
  assert.match(pane.notices[0], /still running/);
});

const RESULT = { session_id: "s1", name: "build", workspace: null, alive: true, line: 4, text: "Error: x", start: 0 };

test("a hit in a pane here focuses it and scrolls there", async () => {
  const other = fakePane({ session: { id: "s0" } });
  const pane = fakePane({ session: { id: "s1" } });
  const { actions, calls, layout } = harness({ panes: [other, pane] });
  assert.equal(await actions.revealSearchResult(RESULT, "error"), true);
  assert.equal(layout.focused, pane);
  assert.deepEqual(pane.revealed, [{ text: "Error: x", start: 0, length: 5, line: 4 }]);
  assert.deepEqual(calls.attached, []);
});

test("a hit elsewhere is attached here through attachSession", async () => {
  const { actions, calls, layout } = harness({
    panes: [fakePane({ session: { id: "s0" } })],
    sessions: [{ id: "s1", alive: true, attachments: 0 }],
  });
  assert.equal(await actions.revealSearchResult(RESULT, "\u{1F600}x"), true);
  assert.deepEqual(calls.attached, ["s1"]);
  assert.equal(layout.focused.session.id, "s1");
  // The query length is counted in code points, as the backend counts.
  assert.equal(layout.focused.revealed[0].length, 2);
});

test("an exited, vanished or elsewhere-open terminal is explained, not attached", async () => {
  for (const sessions of [[], [{ id: "s1", alive: false }], [{ id: "s1", alive: true, attachments: 1 }]]) {
    const { actions, calls } = harness({ panes: [fakePane()], sessions });
    assert.equal(await actions.revealSearchResult(RESULT, "error"), false);
    assert.deepEqual(calls.attached, []);
    assert.equal(calls.errors.length, 1);
    assert.match(calls.errors[0], /"build"/);
  }
});

test("search asks the backend with the query encoded", async () => {
  const { actions, calls } = harness({ fetchReply: { body: [RESULT] } });
  assert.deepEqual(await actions.searchTerminals("a&b c"), [RESULT]);
  assert.equal(calls.fetched[0].path, "/api/search?q=a%26b%20c");
  assert.equal(calls.fetched[0].init.headers["X-QuickTerm-Token"], "t");
});

test("saving says where the file went and makes it openable", async () => {
  const pane = fakePane({ session: { id: "s 1" } });
  const { actions, calls } = harness({ panes: [pane], fetchReply: { body: { path: "C:\\Users\\me\\Downloads\\QuickTerm\\x.txt" } } });
  assert.equal(actions.lastSavedOutput(), null);
  await actions.saveTerminalOutput();
  assert.equal(calls.fetched[0].path, "/api/sessions/s%201/export");
  assert.equal(calls.fetched[0].init.method, "POST");
  assert.equal(pane.notices[0], "[saved to C:\\Users\\me\\Downloads\\QuickTerm\\x.txt]");
  assert.equal(actions.lastSavedOutput(), "C:\\Users\\me\\Downloads\\QuickTerm\\x.txt");
  assert.equal(await actions.openLastSavedOutput(), true);
  assert.deepEqual(calls.opened, ["C:\\Users\\me\\Downloads\\QuickTerm\\x.txt"]);
});

test("a failed save says so in the pane and remembers nothing", async () => {
  const pane = fakePane({ session: { id: "s1" } });
  const { actions } = harness({ panes: [pane], fetchReply: { status: 404, body: { detail: "no such session" } } });
  assert.equal(await actions.saveTerminalOutput(), null);
  assert.match(pane.notices[0], /output is gone/);
  assert.equal(actions.lastSavedOutput(), null);
  const empty = fakePane();
  const second = harness({ panes: [empty] });
  assert.equal(await second.actions.saveTerminalOutput(), null);
  assert.match(empty.notices[0], /no terminal output/);
});

test("a long result row keeps the match in view", () => {
  assert.equal(resultLabel({ text: "  short line ", start: 2 }), "short line");
  const text = `${"a".repeat(200)}NEEDLE${"b".repeat(200)}`;
  const label = resultLabel({ text, start: 200 }, 60);
  assert.ok(label.includes("NEEDLE"));
  assert.ok(label.startsWith("…") && label.endsWith("…"));
});
