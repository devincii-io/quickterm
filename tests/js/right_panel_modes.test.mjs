// The right panel's modes mirror the left sidebar's: full, rail, hidden,
// stored per machine, opened and closed by the key and the left footer's
// "right panel" icon, which shows as on while the panel shows.
import test from "node:test";
import assert from "node:assert/strict";

import {
  PANEL_MODES, PANEL_MODE_KEY, chevronPanelMode, keyPanelMode, loadPanelMode, panelShows, railMarks,
  savePanelMode,
} from "../../quickterm/frontend/js/right_panel_model.js";
import { NAV_ICONS, SIDEBAR_MODES } from "../../quickterm/frontend/js/sidebar_model.js";
import { markNavToggle } from "../../quickterm/frontend/js/sidebar_dom.js";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    data,
  };
}

test("the right panel has the left sidebar's three modes", () => {
  assert.deepEqual([...PANEL_MODES], [...SIDEBAR_MODES]);
  assert.equal(PANEL_MODE_KEY, "quickterm.rightPanelMode");
});

test("the mode is stored per machine and starts hidden", () => {
  const storage = memoryStorage();
  assert.equal(loadPanelMode(storage), "hidden");
  savePanelMode(storage, "rail");
  assert.equal(storage.data.get("quickterm.rightPanelMode"), "rail");
  assert.equal(loadPanelMode(storage), "rail");
  savePanelMode(storage, "sideways");
  assert.equal(loadPanelMode(storage), "rail");
  assert.equal(loadPanelMode(memoryStorage({ "quickterm.rightPanelMode": "wide" })), "hidden");
  // Storage that throws (private window, blocked site data) means hidden.
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.equal(loadPanelMode(broken), "hidden");
  assert.doesNotThrow(() => savePanelMode(broken, "full"));
  assert.equal(loadPanelMode(null), "hidden");
});

test("the key opens to full and closes from full; the chevron steps full and rail", () => {
  assert.equal(keyPanelMode("hidden"), "full");
  assert.equal(keyPanelMode("rail"), "full");
  assert.equal(keyPanelMode("full"), "hidden");
  assert.equal(chevronPanelMode("full"), "rail");
  assert.equal(chevronPanelMode("rail"), "full");
});

test("the left footer's toggle is on while the panel shows", () => {
  assert.equal(NAV_ICONS["right panel"], "panel-right");
  assert.equal(panelShows("full"), true);
  assert.equal(panelShows("rail"), true);
  assert.equal(panelShows("hidden"), false);
  const attributes = {};
  const button = { setAttribute: (name, value) => { attributes[name] = value; } };
  const root = { querySelector: (selector) => (selector.includes('data-nav="right panel"') ? button : null) };
  assert.equal(markNavToggle(root, "right panel", panelShows("rail")), true);
  assert.equal(attributes["aria-pressed"], "true");
  markNavToggle(root, "right panel", panelShows("hidden"));
  assert.equal(attributes["aria-pressed"], "false");
  assert.equal(markNavToggle(root, "help", true), false);
  assert.equal(markNavToggle(null, "right panel", true), false);
});

test("the rail's dots: changes in the tree, the checks' colour", () => {
  assert.deepEqual(railMarks(null, null), { changes: false, pr: null });
  const committedOnly = { files: [{ path: "a", group: "committed" }] };
  assert.equal(railMarks(committedOnly, null).changes, false);
  assert.equal(railMarks({ files: [{ path: "a", group: "untracked" }] }, null).changes, true);
  const pr = (buckets) => ({ pr: { number: 1 }, checks: buckets.map((bucket, i) => ({ name: `c${i}`, bucket })) });
  assert.equal(railMarks(null, pr(["pass", "pending", "fail"])).pr, "failing");
  assert.equal(railMarks(null, pr(["pass", "pending"])).pr, "pending");
  assert.equal(railMarks(null, pr(["pass"])).pr, "passing");
  assert.equal(railMarks(null, pr([])).pr, null);
  assert.equal(railMarks(null, { pr: null, checks: [] }).pr, null);
});
