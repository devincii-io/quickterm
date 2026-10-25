// The files panel slides over the stage (4.7): hidden by default, hiding by
// itself when a terminal takes the keyboard, on Escape and on a workspace
// with no folder, unless pinned. The pin is remembered per window. The left
// footer's "right panel" icon shows as on while the panel is open.
import test from "node:test";
import assert from "node:assert/strict";

import * as model from "../../quickterm/frontend/js/right_panel_model.js";
import { AUTO_HIDE_REASONS, PANEL_PIN_KEY, loadPanelPin, panelHides, savePanelPin } from "../../quickterm/frontend/js/right_panel_model.js";
import { NAV_ICONS } from "../../quickterm/frontend/js/sidebar_model.js";
import { markNavToggle } from "../../quickterm/frontend/js/sidebar_dom.js";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    data,
  };
}

test("the rail and the pushed modes are gone", () => {
  for (const gone of ["PANEL_MODES", "PANEL_MODE_KEY", "loadPanelMode", "keyPanelMode", "chevronPanelMode", "railMarks"]) {
    assert.equal(gone in model, false, gone);
  }
});

test("an unpinned panel hides when a terminal takes the keyboard, on Escape and on a folderless workspace", () => {
  assert.deepEqual([...AUTO_HIDE_REASONS], ["terminal", "escape", "no-folder"]);
  for (const reason of AUTO_HIDE_REASONS) assert.equal(panelHides(reason), true, reason);
  assert.equal(panelHides("toggle"), true);
  assert.equal(panelHides("column"), false, "an unknown reason never hides it");
});

test("the pin holds it through every automatic hide; only the toggle hides a pinned panel", () => {
  for (const reason of AUTO_HIDE_REASONS) assert.equal(panelHides(reason, { pinned: true }), false, reason);
  assert.equal(panelHides("toggle", { pinned: true }), true);
});

test("a file view opened from the panel keeps it while a terminal blurs the window", () => {
  assert.equal(panelHides("terminal", { viewer: true }), false);
  assert.equal(panelHides("escape", { viewer: true }), true);
});

test("the pin is remembered per window and survives storage that throws", () => {
  const storage = memoryStorage();
  assert.equal(loadPanelPin(storage), false, "unpinned by default");
  savePanelPin(storage, true);
  assert.equal(storage.data.get(PANEL_PIN_KEY), "1");
  assert.equal(loadPanelPin(storage), true);
  savePanelPin(storage, false);
  assert.equal(loadPanelPin(storage), false);
  assert.equal(loadPanelPin(memoryStorage({ [PANEL_PIN_KEY]: "yes" })), false);
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.equal(loadPanelPin(broken), false);
  assert.doesNotThrow(() => savePanelPin(broken, true));
  assert.equal(loadPanelPin(null), false);
});

test("the left footer's toggle is on while the panel is open", () => {
  assert.equal(NAV_ICONS["right panel"], "panel-right");
  const attributes = {};
  const button = { setAttribute: (name, value) => { attributes[name] = value; } };
  const root = { querySelector: (selector) => (selector.includes('data-nav="right panel"') ? button : null) };
  assert.equal(markNavToggle(root, "right panel", true), true);
  assert.equal(attributes["aria-pressed"], "true");
  markNavToggle(root, "right panel", false);
  assert.equal(attributes["aria-pressed"], "false");
  assert.equal(markNavToggle(root, "help", true), false);
  assert.equal(markNavToggle(null, "right panel", true), false);
});
