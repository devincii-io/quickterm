import test from "node:test";
import assert from "node:assert/strict";

import {
  collectViewContext, documentHasKeyboard, finishedAttachRecord, sessionToMarkSeen, sidebarModel,
} from "../../quickterm/frontend/js/sidebar.js";

function session(id, extra = {}) {
  return {
    id,
    name: id,
    alive: true,
    exit_code: null,
    attachments: 0,
    busy: false,
    profile: "pwsh",
    cwd: "C:\\start",
    current_cwd: null,
    attention: null,
    activity: { idle_seconds: 0, background_output_bytes: 0, background_output_age_seconds: null },
    ...extra,
  };
}

const bell = { kind: "bell", text: null, age_seconds: 5 };

test("seen is sent for the focused terminal only while someone is looking", () => {
  const sessions = [session("a", { attention: bell }), session("b")];
  const base = { sessions, focusedId: "a", focusChanged: false, visible: true, windowFocused: true };
  assert.equal(sessionToMarkSeen(base), "a");
  // Focus moved to it while the window is visible but not in front: still seen.
  assert.equal(sessionToMarkSeen({ ...base, windowFocused: false, focusChanged: true }), "a");
  // Visible behind another application, focus unchanged: nobody looked.
  assert.equal(sessionToMarkSeen({ ...base, windowFocused: false }), null);
  assert.equal(sessionToMarkSeen({ ...base, visible: false, focusChanged: true }), null);
  assert.equal(sessionToMarkSeen({ ...base, focusedId: "b" }), null);
  assert.equal(sessionToMarkSeen({ ...base, focusedId: null }), null);
});

test("a finished row opens through attach without claiming to be alive", () => {
  const record = finishedAttachRecord(session("done", { alive: false, exit_code: 1 }));
  assert.equal("alive" in record, false);
  assert.equal(record.id, "done");
  assert.equal(record.exit_code, 1);
});

test("a document whose tiled view has the keyboard does not have it itself", () => {
  // A document reports focus while one of its iframes has it, so a document
  // with panes of its own must not count its focused pane as looked at.
  const doc = (focused, tag) => ({ hasFocus: () => focused, activeElement: tag ? { tagName: tag } : null });
  assert.equal(documentHasKeyboard(doc(true, "TEXTAREA")), true);
  assert.equal(documentHasKeyboard(doc(true, "IFRAME")), false);
  assert.equal(documentHasKeyboard(doc(false, "TEXTAREA")), false);
  assert.equal(documentHasKeyboard(doc(true, null)), true);
});

function fakeViews(entries, activeName) {
  const views = entries.map(([workspace, app]) => ({ workspace, app }));
  return {
    views: () => views,
    get active() { return views.find((view) => view.workspace === activeName) || null; },
    workspaceOf: (view) => view.workspace,
    appFor: (view) => view.app,
  };
}

test("the shell reads what every view shows and owns, a pane winning over a claim", () => {
  const views = fakeViews([
    ["api", { attachedSessionIds: () => ["a"], ownedSessionIds: () => ["a", "b"] }],
    ["docs", { attachedSessionIds: () => ["c"], ownedSessionIds: () => ["b", "c", "d"] }],
    ["scratch-view-0123456789ab", null],
  ], "docs");
  assert.deepEqual(collectViewContext(views), {
    attached: { a: "api", c: "docs" },
    owned: { a: "api", b: "api", c: "docs", d: "docs" },
    openWorkspaces: ["api", "docs", "scratch-view-0123456789ab"],
    activeWorkspace: "docs",
  });
  assert.deepEqual(collectViewContext(null), { attached: {}, owned: {}, openWorkspaces: [], activeWorkspace: null });
});

test("the sidebar model lists saved workspaces with their folders, the views and who holds what", () => {
  const state = {
    profiles: [{ name: "pwsh" }],
    terminalInventory: { types: [] },
    cfg: { default_profile: "pwsh" },
    selectedTerminal: null,
    workspaceNames: ["api", "scratch-view-0123456789ab", "scratch", "docs"],
  };
  const sessions = [session("a")];
  const here = { action: "create", name: "proj", folder: "/work/proj" };
  const model = sidebarModel({
    state,
    sessions,
    views: [{ workspace: "api", label: "api", color: "#fff", active: true, window: {} }],
    context: { attached: { a: "api" }, owned: { a: "api" } },
    folders: new Map([["api", { path: "/work/api", pathExists: false }]]),
    here,
    logoUrl: "/logo",
  });
  assert.deepEqual(model.workspaces, [
    { name: "api", path: "/work/api", pathExists: false },
    { name: "docs", path: null, pathExists: null },
  ], "scratch is never a saved workspace, and an unread folder is unknown, not missing");
  assert.deepEqual(model.views, [{ workspace: "api", label: "api", color: "#fff", active: true }]);
  assert.equal(model.sessions, sessions);
  assert.deepEqual(model.attached, { a: "api" });
  assert.deepEqual(model.owned, { a: "api" });
  assert.equal(model.here, here);
  assert.equal(model.defaultProfile, "pwsh");
  assert.equal(model.logoUrl, "/logo");
  assert.deepEqual(Object.keys(model).sort(), [
    "attached", "defaultProfile", "here", "inventory", "logoUrl", "owned", "profiles", "selectedTerminal",
    "sessions", "views", "workspaces",
  ], "exactly the SidebarModel of spec 4.2");
});
