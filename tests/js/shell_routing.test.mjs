// Where a sidebar row's click, kill, detach and move go. The shell holds no
// terminal, so each gesture lands in the view that holds the terminal or owns
// it, and only falls back to the shell when no view of this window has
// anything to do with it.
import test from "node:test";
import assert from "node:assert/strict";

import {
  createTerminalRouting, finishedAttachRecord, killRoute, rowAction, sessionOwner,
} from "../../quickterm/frontend/js/shell_routing.js";

const live = (id, extra = {}) => ({ id, name: id, alive: true, ...extra });

test("a row's owner is the view holding it, then a view's claim, then the backend tag", () => {
  const ctx = { attached: { a: "api" }, owned: { a: "docs", b: "docs" } };
  assert.equal(sessionOwner(live("a", { workspace: "ops" }), ctx), "api");
  assert.equal(sessionOwner(live("b", { workspace: "ops" }), ctx), "docs");
  assert.equal(sessionOwner(live("c", { workspace: "ops" }), ctx), "ops");
  assert.equal(sessionOwner(live("d"), ctx), null);
});

test("every row click has one meaning", () => {
  const ctx = {
    attached: { held: "api" },
    owned: { claimed: "docs" },
    openWorkspaces: ["api", "docs", "scratch-view-0123456789ab"],
    activeWorkspace: "docs",
  };
  assert.deepEqual(rowAction(live("held"), ctx), { kind: "focus", workspace: "api", finished: false });
  assert.deepEqual(rowAction(live("claimed"), ctx), { kind: "attach", workspace: "docs", finished: false });
  assert.deepEqual(rowAction(live("tagged", { workspace: "api" }), ctx), { kind: "attach", workspace: "api", finished: false });
  assert.deepEqual(rowAction(live("closed", { workspace: "ops" }), ctx),
    { kind: "open-then-focus", workspace: "ops", finished: false });
  assert.deepEqual(rowAction(live("loose"), ctx), { kind: "adopt", workspace: "docs", finished: false });
  assert.deepEqual(rowAction(live("loose"), { ...ctx, activeWorkspace: null }),
    { kind: "adopt-new-scratch", workspace: null, finished: false });
  // A scratch view is never reopened, so what it left behind is adopted.
  assert.deepEqual(rowAction(live("orphan", { workspace: "scratch-view-9999999999zz" }), ctx),
    { kind: "adopt", workspace: "docs", finished: false });
  // A finished row says so, whatever its route.
  assert.equal(rowAction({ id: "done", alive: false, workspace: "ops" }, ctx).finished, true);
  assert.equal(rowAction({ id: "done", alive: false, workspace: "ops" }, ctx).kind, "open-then-focus");
});

test("every kill goes through the view that holds or owns the terminal", () => {
  const ctx = { attached: { held: "api" }, owned: { claimed: "docs" }, openWorkspaces: ["api", "docs"] };
  assert.deepEqual(killRoute(live("held", { workspace: "docs" }), ctx), { kind: "view-pane", workspace: "api" });
  assert.deepEqual(killRoute(live("claimed"), ctx), { kind: "view-owner", workspace: "docs" });
  assert.deepEqual(killRoute(live("tagged", { workspace: "api" }), ctx), { kind: "view-owner", workspace: "api" });
  assert.deepEqual(killRoute(live("closed", { workspace: "ops" }), ctx), { kind: "shell", workspace: "ops" });
  assert.deepEqual(killRoute(live("loose"), ctx), { kind: "shell", workspace: null });
});

test("a finished row opens through attach without claiming to be alive", () => {
  const record = finishedAttachRecord({ id: "done", alive: false, exit_code: 1 });
  assert.equal("alive" in record, false);
  assert.equal(record.exit_code, 1);
});

// ---- the gestures, against fake views ----

function fakeApp(name, calls, { attached = [] } = {}) {
  const record = (what) => (...args) => { calls.push([name, what, ...args]); return true; };
  return {
    attachedSessionIds: () => attached,
    attachSession: record("attachSession"),
    focusSession: record("focusSession"),
    moveSessionHere: record("moveSessionHere"),
    killSessionById: async (id) => { calls.push([name, "killSessionById", id]); return true; },
    detachSessionById: async (id, options) => {
      calls.push([name, "detachSessionById", id, ...(options ? [options] : [])]);
      return true;
    },
  };
}

function setup({ open = ["api", "docs"], active = "docs", context = {}, api = {}, opened = {} } = {}) {
  const calls = [];
  const views = new Map(open.map((name) => [name, { name, app: fakeApp(name, calls, opened[name]) }]));
  const fake = {
    get active() { return active ? views.get(active) : null; },
    appFor: (view) => view?.app || null,
    viewForWorkspace: (name) => views.get(name) || null,
    workspaceOf: (view) => view.name,
    focusView: (view) => { calls.push(["focusView", view?.name]); active = view?.name; },
    focusWorkspace: (name) => { calls.push(["focusWorkspace", name]); active = name; return true; },
    focusSession: (id) => { calls.push(["focusSession", id]); return true; },
    open: async (name) => {
      const key = name || "scratch-view-new0000000";
      calls.push(["open", name]);
      const view = { name: key, app: fakeApp(key, calls, opened[key]) };
      views.set(key, view);
      return view;
    },
  };
  const removed = [];
  const routing = createTerminalRouting({
    api: { killSession: async () => {}, ...api },
    views: fake,
    context: () => ({
      attached: {}, owned: {}, openWorkspaces: [...views.keys()], activeWorkspace: active, ...context,
    }),
    removeSessionsFromSavedWorkspaces: async (ids) => { removed.push([...ids]); },
    markSeen: (id) => calls.push(["markSeen", id]),
    refreshSoon: () => {},
  });
  return { routing, calls, removed };
}

test("a click marks the row seen first, then focuses the pane that shows it", async () => {
  const { routing, calls } = setup({ context: { attached: { s: "api" } } });
  await routing.activateTerminal(live("s"));
  assert.deepEqual(calls, [["markSeen", "s"], ["focusSession", "s"]]);
});

test("a click on a terminal its open workspace owns attaches it in that view", async () => {
  const { routing, calls } = setup();
  await routing.activateTerminal(live("s", { workspace: "api" }));
  assert.deepEqual(calls.slice(1), [["focusWorkspace", "api"], ["api", "attachSession", live("s", { workspace: "api" })]]);
});

test("a finished row is attached replay-only", async () => {
  const { routing, calls } = setup();
  await routing.activateTerminal({ id: "s", alive: false, workspace: "api" });
  assert.deepEqual(calls.at(-1), ["api", "attachSession", { id: "s", workspace: "api" }]);
});

test("a click on a closed workspace's terminal opens that view, whose restore attaches it", async () => {
  const restored = setup({ opened: { ops: { attached: ["s"] } } });
  await restored.routing.activateTerminal(live("s", { workspace: "ops" }));
  assert.deepEqual(restored.calls.slice(1), [["open", "ops"], ["focusSession", "s"]]);
  // A terminal the workspace owns but its layout does not show is attached.
  const owned = setup();
  await owned.routing.activateTerminal(live("s", { workspace: "ops" }));
  assert.deepEqual(owned.calls.slice(1), [["open", "ops"], ["ops", "attachSession", live("s", { workspace: "ops" })]]);
});

test("an unassigned row is adopted by the active view, or by a new scratch view", async () => {
  const active = setup();
  await active.routing.activateTerminal(live("s"));
  assert.deepEqual(active.calls.slice(1), [["focusView", "docs"], ["docs", "attachSession", live("s")]]);
  const none = setup({ open: [], active: null });
  await none.routing.activateTerminal(live("s"));
  assert.deepEqual(none.calls.slice(1), [
    ["open", null], ["focusView", "scratch-view-new0000000"], ["scratch-view-new0000000", "attachSession", live("s")],
  ]);
  // What a closed scratch view left behind is moved out of its file first.
  const orphan = setup();
  const session = live("s", { workspace: "scratch-view-9999999999zz" });
  await orphan.routing.activateTerminal(session);
  assert.deepEqual(orphan.calls.at(-1), ["docs", "moveSessionHere", session, "scratch-view-9999999999zz"]);
});

test("a kill of a terminal a view shows goes through that view", async () => {
  const { routing, calls, removed } = setup({ context: { attached: { s: "api" } } });
  assert.equal(await routing.killTerminal(live("s")), true);
  assert.deepEqual(calls, [["api", "killSessionById", "s"]]);
  assert.deepEqual(removed, []);
});

test("a kill of a terminal an open workspace owns goes through its view", async () => {
  const { routing, calls } = setup({ context: { owned: { s: "docs" } } });
  await routing.killTerminal(live("s"));
  assert.deepEqual(calls, [["docs", "killSessionById", "s"]]);
});

test("a kill nobody here holds is the shell's, and it edits the saved workspaces", async () => {
  const killed = [];
  const { routing, removed } = setup({ api: { killSession: async (id) => { killed.push(id); } } });
  await routing.killTerminal(live("s", { workspace: "ops" }));
  assert.deepEqual(killed, ["s"]);
  assert.deepEqual(removed, [["s"]]);
});

test("a 404 from the shell's kill falls through like a verified kill", async () => {
  const gone = Object.assign(new Error("404"), { status: 404 });
  const { routing, removed } = setup({ api: { killSession: async () => { throw gone; } } });
  assert.equal(await routing.killTerminal(live("s")), true);
  assert.deepEqual(removed, [["s"]]);
});

test("a 500 is thrown unchanged and nothing is removed", async () => {
  const failed = Object.assign(new Error("500"), { status: 500, detail: "access denied" });
  const shellKill = setup({ api: { killSession: async () => { throw failed; } } });
  await assert.rejects(shellKill.routing.killTerminal(live("s")), (error) => error === failed);
  assert.deepEqual(shellKill.removed, []);
  // From a view, the view's own failure travels the same way.
  const removed = [];
  const routing = createTerminalRouting({
    api: {},
    views: {
      viewForWorkspace: () => ({}),
      appFor: () => ({ killSessionById: async () => { throw failed; } }),
      active: null,
    },
    context: () => ({ attached: { s: "api" }, owned: {}, openWorkspaces: ["api"] }),
    removeSessionsFromSavedWorkspaces: async (ids) => { removed.push([...ids]); },
  });
  await assert.rejects(routing.killTerminal(live("s")), (error) => error.status === 500 && error.detail === "access denied");
  assert.deepEqual(removed, []);
});

test("detach retains through the view that shows the terminal and never kills", async () => {
  const killed = [];
  const { routing, calls } = setup({
    context: { attached: { s: "api" } },
    api: { killSession: async (id) => { killed.push(id); } },
  });
  assert.equal(await routing.detachTerminal(live("s")), true);
  assert.deepEqual(calls, [["api", "detachSessionById", "s"]]);
  assert.deepEqual(killed, []);
  // Not shown anywhere here: nothing to detach.
  const idle = setup();
  assert.equal(await idle.routing.detachTerminal(live("s", { workspace: "api" })), false);
  assert.deepEqual(idle.calls, []);
});

test("move here lets the owning view go of the terminal before the active view takes it", async () => {
  const { routing, calls } = setup({ context: { attached: { s: "api" } } });
  const session = live("s", { workspace: "api" });
  await routing.moveTerminalHere(session);
  assert.deepEqual(calls, [
    ["api", "detachSessionById", "s", { forget: true }],
    ["focusView", "docs"],
    ["docs", "moveSessionHere", session, null],
  ]);
  // From a closed workspace the active view edits that workspace's file.
  const closed = setup();
  const loose = live("t", { workspace: "ops" });
  await closed.routing.moveTerminalHere(loose);
  assert.deepEqual(closed.calls, [["focusView", "docs"], ["docs", "moveSessionHere", loose, "ops"]]);
  // Already here: just the click.
  const here = setup({ context: { attached: { u: "docs" } } });
  await here.routing.moveTerminalHere(live("u"));
  assert.deepEqual(here.calls, [["markSeen", "u"], ["focusSession", "u"]]);
});
