import test from "node:test";
import assert from "node:assert/strict";

import { workspaceRows } from "../../quickterm/frontend/js/palette_items.js";
import { besideRow, groupState } from "../../quickterm/frontend/js/sidebar_model.js";

function app(open) {
  const calls = [];
  return {
    calls,
    openWorkspaces: () => open,
    openWorkspace: (name) => calls.push(["open", name]),
    closeWorkspaceView: (name) => calls.push(["close", name]),
    newScratchView: () => calls.push(["scratch"]),
    showBeside: (name) => calls.push(["beside", name]),
    showAlone: () => calls.push(["alone"]),
  };
}

test("the palette offers every workspace not on screen as a column, and show alone during a split", () => {
  const a = app([
    { workspace: "api", label: "api", active: true, shown: true },
    { workspace: "web", label: "web", shown: true },
    { workspace: "infra", label: "infra", shown: false },
  ]);
  const rows = workspaceRows(a, ["api", "web", "infra", "docs"]);
  const beside = rows.filter((row) => row.label.startsWith("show side by side: ")).map((row) => row.label);
  assert.deepEqual(beside, ["show side by side: docs", "show side by side: infra"]);
  const alone = rows.find((row) => row.label === "show alone");
  assert.equal(alone.hint, "api fills the window again");
  rows.find((row) => row.label === "show side by side: docs").run();
  alone.run();
  assert.deepEqual(a.calls, [["beside", "docs"], ["alone"]]);
});

test("show alone names scratch by its label, not its internal id", () => {
  const a = app([
    { workspace: "scratch-view-12", label: "scratch", active: true, shown: true },
    { workspace: "api", label: "api", shown: true },
  ]);
  const alone = workspaceRows(a, ["api"]).find((row) => row.label === "show alone");
  assert.equal(alone.hint, "scratch fills the window again");
});

test("no split, no show alone row", () => {
  const a = app([{ workspace: "api", label: "api", active: true, shown: true }]);
  assert.equal(workspaceRows(a, ["api", "web"]).find((row) => row.label === "show alone"), undefined);
});

test("the ⋮ row joins a workspace to the split or takes a column out", () => {
  assert.equal(besideRow({ name: "web", kind: "workspace", shown: false }, 1).label, "Show side by side");
  assert.equal(besideRow({ name: "api", kind: "workspace", shown: true }, 2).label, "Remove from side by side");
  assert.equal(besideRow({ name: "api", kind: "workspace", shown: true }, 1), null, "the only shown one has nothing to leave");
  assert.equal(besideRow({ name: "scratch", kind: "scratch", open: false }, 1), null);
  assert.equal(besideRow({ name: null }, 2), null);
});

test("a column header's dot is the loudest state of its terminals", () => {
  assert.deepEqual(groupState({ counts: { busy: 2, attention: 1 } }), { key: "attention", label: "needs you" });
  assert.deepEqual(groupState({ counts: { busy: 1, unread: 3 } }), { key: "busy", label: "busy" });
  assert.equal(groupState({ counts: {} }), null);
  assert.equal(groupState(null), null);
});
