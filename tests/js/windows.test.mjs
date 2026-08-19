import test from "node:test";
import assert from "node:assert/strict";

import {
  claimOutcome, claimRefusalMessage, conflictHolder, describeHolder, newWindowUrl,
  normalizeWindows, windowChoiceMessage, windowChoices, workspaceHolder,
} from "../../quickterm/frontend/js/windows.js";

const REGISTRY = [
  { id: "w1", workspace: "Alpha" },
  { id: "w2", workspace: null },
  { id: "w3", workspace: "Beta", label: "Beta window" },
];

test("registry answers are read defensively, in either shape", () => {
  assert.deepEqual(normalizeWindows({ windows: [{ id: 7, workspace: "Alpha", title: "QuickTerm - Alpha" }] }),
    [{ id: "7", workspace: "Alpha", label: "QuickTerm - Alpha", primary: false }]);
  assert.deepEqual(normalizeWindows([{ id: "a" }]),
    [{ id: "a", workspace: null, label: "", primary: false }]);
  // Nothing usable must ever throw inside a boot path or a workspace switch.
  for (const payload of [null, undefined, "", 3, {}, { windows: "no" }, [null, {}]]) {
    assert.deepEqual(normalizeWindows(payload), []);
  }
});

test("a workspace is held only by another live window", () => {
  assert.equal(workspaceHolder(REGISTRY, "w9", "Alpha").id, "w1");
  // This window re-claiming what it already holds is not a conflict.
  assert.equal(workspaceHolder(REGISTRY, "w1", "Alpha"), null);
  // Scratch is nobody's: an unadopted scratch layout has no file to overwrite.
  assert.equal(workspaceHolder(REGISTRY, "w9", null), null);
  assert.equal(workspaceHolder(REGISTRY, "w9", "Gamma"), null);
});

test("a refusal names the consequence, not the mechanism", () => {
  const message = claimRefusalMessage("Alpha", workspaceHolder(REGISTRY, "w9", "Alpha"));
  assert.match(message, /“Alpha” is already open in another window/);
  assert.match(message, /overwrite each other's saved layout/);
  assert.match(message, /stayed where it was/);
  // The window the user started is the one they can point at; any other is
  // identified by its title when the registry has one.
  assert.equal(describeHolder({ id: "w0", primary: true }), "the main window");
  assert.equal(describeHolder({ id: "w3", label: "Beta window" }), "another window (Beta window)");
  assert.equal(describeHolder({ id: "w1", label: "" }), "another window");
  assert.equal(describeHolder(null), "another window");
});

test("the new-window picker shows taken workspaces instead of hiding them", () => {
  const rows = windowChoices(["Alpha", "Beta", "Gamma"], REGISTRY, "w2", null);
  assert.deepEqual(rows.map((row) => [row.name, row.taken, row.mine]), [
    ["Alpha", true, false],
    ["Beta", true, false],
    ["Gamma", false, false],
  ]);
  assert.equal(rows[1].hint, "already open in another window (Beta window)");
  assert.equal(rows[2].hint, "");
  assert.match(windowChoiceMessage(rows[0]), /already open in another window/);
  assert.equal(windowChoiceMessage(rows[2]), "");
});

test("the workspace this window is on is taken by this window", () => {
  const [mine] = windowChoices(["Alpha"], REGISTRY, "w1", "Alpha");
  assert.equal(mine.taken, true);
  assert.equal(mine.mine, true);
  assert.equal(mine.hint, "already open in this window");
  assert.match(windowChoiceMessage(mine), /this window is already on/);

  // Still ours when the registry is unreachable and answered with nothing.
  const [degraded] = windowChoices(["Alpha"], [], null, "Alpha");
  assert.equal(degraded.mine, true);
});

test("only a 409 is a refusal; every other failure degrades to carrying on", () => {
  assert.equal(claimOutcome({ status: 409 }), "refused");
  assert.equal(claimOutcome({ status: 404 }), "unavailable");
  assert.equal(claimOutcome({ status: 500 }), "unavailable");
  assert.equal(claimOutcome(new TypeError("Failed to fetch")), "unavailable");
  assert.equal(claimOutcome(null), "unavailable");
});

test("a browser window is opened with the token and an explicit workspace", () => {
  assert.equal(newWindowUrl("/", "My Repo", "abc123"),
    "/?workspace=My%20Repo#t=abc123");
  // null forces a disposable scratch instead of inheriting the shared
  // localStorage memory of the window that opened it.
  assert.equal(newWindowUrl("/", null, "abc"), "/?workspace=#t=abc");
  // Absent means "restore whatever you remember".
  assert.equal(newWindowUrl("/", undefined, "abc"), "/#t=abc");
  // No token, no /api access: never silently drop it, but never invent one.
  assert.equal(newWindowUrl("/", null, ""), "/?workspace=");
  assert.equal(newWindowUrl("", "Alpha", "t/oken"), "/?workspace=Alpha#t=t%2Foken");
});

test("a 409 names the window that holds the workspace", () => {
  // The refusal body carries the owner, so the message can name it without a
  // second round trip that may already be out of date.
  const error = {
    status: 409,
    payload: {
      detail: "workspace 'Alpha' is already open in another window",
      error: "workspace_claimed",
      workspace: "Alpha",
      owner: { id: "w1", workspace: "Alpha", title: "QuickTerm", primary: true },
    },
  };
  assert.deepEqual(conflictHolder(error),
    { id: "w1", workspace: "Alpha", label: "QuickTerm", primary: true });
  assert.match(claimRefusalMessage("Alpha", conflictHolder(error)), /the main window/);
  // A refusal without a body still refuses, it just cannot name anyone.
  assert.equal(conflictHolder({ status: 409 }), null);
  assert.equal(conflictHolder(null), null);
});
