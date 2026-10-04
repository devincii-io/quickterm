// Where a sidebar row's click, kill, detach and move go. The shell holds no
// terminal, so each gesture lands in the view that holds the terminal or owns
// it, and only falls back to the shell when no view of this window has
// anything to do with it.
import test from "node:test";
import assert from "node:assert/strict";

import {
  createTerminalRouting, finishedAttachRecord, killRoute, rowAction, sessionOwner,
} from "../../quickterm/frontend/js/shell_routing.js";
import { createPaneCommands } from "../../quickterm/frontend/js/pane_commands.js";

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

function setup({ open = ["api", "docs"], active = "docs", context = {}, api = {}, opened = {}, whenReady } = {}) {
  const calls = [];
  const views = new Map(open.map((name) => [name, { name, app: fakeApp(name, calls, opened[name]) }]));
  const fake = {
    get active() { return active ? views.get(active) : null; },
    views: () => [...views.values()],
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
    ...(whenReady ? { whenReady } : {}),
  };
  const removed = [];
  const forgotten = [];
  const routing = createTerminalRouting({
    api: { killSession: async () => {}, ...api },
    views: fake,
    context: () => ({
      attached: {}, owned: {}, openWorkspaces: [...views.keys()], activeWorkspace: active, ...context,
    }),
    removeSessionsFromSavedWorkspaces: async (ids) => { removed.push([...ids]); },
    markSeen: (id) => calls.push(["markSeen", id]),
    refreshSoon: () => {},
    forgetSession: (id) => forgotten.push(id),
  });
  return { routing, calls, removed, forgotten };
}

test("a click into a view that is still loading waits for its document", async () => {
  const waited = [];
  const { routing, calls } = setup({ whenReady: async (view) => { waited.push(view.name); return true; } });
  assert.equal(await routing.activateTerminal(live("s", { workspace: "api" })), true);
  assert.deepEqual(waited, ["api"]);
  assert.ok(calls.some((call) => call[1] === "attachSession"));
  const gone = setup({ whenReady: async () => false });
  assert.equal(await gone.routing.activateTerminal(live("s", { workspace: "api" })), false);
});

test("a verified kill drops the row at once, not after the backend's grace period", async () => {
  const { routing, forgotten } = setup();
  await routing.killTerminal(live("s", { workspace: "closed-scratch" }));
  assert.deepEqual(forgotten, ["s"]);
  const failed = Object.assign(new Error("500"), { status: 500 });
  const refused = setup({ api: { killSession: async () => { throw failed; } } });
  await assert.rejects(refused.routing.killTerminal(live("s")));
  assert.deepEqual(refused.forgotten, []);
});

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

// ---- kill all: the window's, not the active view's ----

// One view's real pane commands over a layout of fake panes, so the test
// sees what each view keeps after the shell's kill-all.
function paneView(name, sessionIds) {
  const panes = sessionIds.map((id) => ({ session: { id } }));
  const forgotten = [];
  let saves = 0;
  const layout = {
    focused: null,
    panes: () => panes,
    closePane: (pane) => { panes.splice(panes.indexOf(pane), 1); },
  };
  const app = createPaneCommands({
    api: {}, state: {}, layout,
    forgetSession: (id) => forgotten.push(id),
    scheduleWorkspaceSave: () => { saves += 1; },
    refreshStatusSoon: () => {},
    showError: () => {},
  });
  return {
    name, app, forgotten,
    shown: () => panes.map((pane) => pane.session.id),
    saves: () => saves,
  };
}

function killAllSetup(result, viewList, { whenReady } = {}) {
  const order = [];
  const removed = [];
  const forgotten = [];
  let refreshed = 0;
  const views = {
    active: viewList[0] || null,
    views: () => viewList,
    appFor: (view) => view?.app || null,
    ...(whenReady ? { whenReady } : {}),
  };
  const routing = createTerminalRouting({
    api: { killAllSessions: async () => { order.push("api"); return result; } },
    views,
    context: () => ({ attached: {}, owned: {}, openWorkspaces: [] }),
    removeSessionsFromSavedWorkspaces: async (ids) => { order.push("saved"); removed.push([...ids]); },
    refreshSoon: () => { refreshed += 1; },
    forgetSession: (id) => { order.push(`forget ${id}`); forgotten.push(id); },
  });
  return { routing, order, removed, forgotten, refreshed: () => refreshed };
}

test("kill all drops the verified ids from every view, not only the active one", async () => {
  const api = paneView("api", ["a", "b", "keep"]);
  const docs = paneView("docs", ["c", "stuck"]);
  const idle = paneView("idle", ["other"]);
  const { routing, removed, forgotten, refreshed } = killAllSetup(
    { killed: 3, killed_ids: ["a", "b", "c"], failed_ids: ["stuck"] },
    [api, docs, idle],
  );
  assert.deepEqual(await routing.killAllSessions(), { killed: 3, failed: 1 });
  // Each view closes its own panes on verified ids and nothing else.
  assert.deepEqual(api.shown(), ["keep"]);
  assert.deepEqual(docs.shown(), ["stuck"], "a terminal that could not be stopped stays on screen");
  assert.deepEqual(idle.shown(), ["other"]);
  // Every view forgets every verified id, so no autosave writes one back.
  for (const view of [api, docs, idle]) {
    assert.deepEqual(view.forgotten, ["a", "b", "c"], view.name);
    assert.equal(view.saves(), 1, view.name);
  }
  // The sidebar forgets the rows, the saved files lose them once, and the
  // sidebar refreshes.
  assert.deepEqual(forgotten, ["a", "b", "c"]);
  assert.deepEqual(removed, [["a", "b", "c"]]);
  assert.ok(refreshed() >= 1);
});

test("kill all forgets the sidebar rows before waiting for a loading view", async () => {
  let release;
  const loading = paneView("loading", ["a"]);
  const { routing, order } = killAllSetup(
    { killed: 1, killed_ids: ["a"], failed_ids: [] },
    [loading],
    { whenReady: () => new Promise((resolve) => { release = resolve; }) },
  );
  const done = routing.killAllSessions();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ["api", "forget a"], "the row goes at once");
  assert.deepEqual(loading.shown(), ["a"]);
  release(true);
  await done;
  assert.deepEqual(loading.shown(), [], "the view drops it once its document is ready");
  assert.deepEqual(order, ["api", "forget a", "saved"]);
});

test("kill all with nothing verified touches no view and no saved file", async () => {
  const api = paneView("api", ["stuck"]);
  const { routing, removed, forgotten } = killAllSetup(
    { killed: 0, killed_ids: [], failed_ids: ["stuck"] },
    [api],
  );
  assert.deepEqual(await routing.killAllSessions(), { killed: 0, failed: 1 });
  assert.deepEqual(api.shown(), ["stuck"]);
  assert.deepEqual(api.forgotten, []);
  assert.equal(api.saves(), 0);
  assert.deepEqual(forgotten, []);
  assert.deepEqual(removed, []);
});

test("one view failing to drop does not keep the others or the saved files stale", async () => {
  const broken = { name: "broken", app: { dropKilledSessions: () => { throw new Error("gone"); } } };
  const docs = paneView("docs", ["a"]);
  const { routing, removed } = killAllSetup({ killed: 1, killed_ids: ["a"], failed_ids: [] }, [broken, docs]);
  assert.deepEqual(await routing.killAllSessions(), { killed: 1, failed: 0 });
  assert.deepEqual(docs.shown(), []);
  assert.deepEqual(removed, [["a"]]);
});

test("a kill-all failure from the backend is thrown and changes nothing", async () => {
  const api = paneView("api", ["a"]);
  const failed = Object.assign(new Error("500"), { status: 500 });
  const routing = createTerminalRouting({
    api: { killAllSessions: async () => { throw failed; } },
    views: { views: () => [api], appFor: (view) => view.app },
    context: () => ({}),
    removeSessionsFromSavedWorkspaces: async () => { throw new Error("must not run"); },
  });
  await assert.rejects(routing.killAllSessions(), (error) => error === failed);
  assert.deepEqual(api.shown(), ["a"]);
});
