import test from "node:test";
import assert from "node:assert/strict";
import { settingsPatch, watchGlobalSettings } from "../../quickterm/frontend/js/global_settings.js";
import { createConfigSync } from "../../quickterm/frontend/js/config_sync.js";

test("a settings save preserves another window's unrelated changes", () => {
  const baseline = { theme: "graphite", font_size: 14, profiles: [] };
  const draft = { ...baseline, font_size: 16 };
  assert.deepEqual(settingsPatch(draft, baseline, { ...baseline, theme: "light" }), { font_size: 16 });
  assert.throws(() => settingsPatch(draft, baseline, { ...baseline, font_size: 18 }), /changed in another window/);
  assert.deepEqual(settingsPatch(draft, baseline, { ...baseline, font_size: 16 }), { font_size: 16 });
});

test("connection edits cannot silently erase another window's profiles", () => {
  assert.throws(() => settingsPatch({ profiles: [{ name: "SSH" }] }, { profiles: [] }, { profiles: [{ name: "Docker" }] }), /Terminals and connections/);
});

test("unrelated config refreshes preserve pane-local font zoom", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { documentElement: { style: { setProperty() {} }, dataset: {} } };
  let fresh = { theme: "graphite", font_size: 14, font_family: "Mono", profiles: [], snippets: [] };
  const state = { cfg: structuredClone(fresh), profiles: [], snippets: [], terminalInventory: {}, scratchRoot: "old folder" };
  const sizes = [];
  const fonts = [];
  try {
    const sync = createConfigSync({
      api: { getConfig: async () => fresh, getTerminalOptions: async () => ({}) }, state, app: {},
      layout: { setTheme() {}, setFontFamily: (value) => fonts.push(value) },
      setFontSize: (value) => sizes.push(value), buildLauncher() {}, showError() {},
    });
    await sync.onConfigSaved();
    assert.equal(state.scratchRoot, null);
    assert.deepEqual(sizes, []);
    assert.deepEqual(fonts, []);
    fresh = { ...fresh, font_size: 16, font_family: "Other mono" };
    await sync.onConfigSaved();
    assert.deepEqual(sizes, [16]);
    assert.deepEqual(fonts, ["Other mono"]);
  } finally { globalThis.document = previousDocument; }
});

test("preference events carry no settings or secrets and do not rebroadcast", async () => {
  const listeners = new Map();
  const writes = [];
  let refreshes = 0;
  const target = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name) => listeners.delete(name),
  };
  const watch = watchGlobalSettings({ target, storage: { setItem: (...args) => writes.push(args) }, refresh: () => { refreshes++; } });
  watch.publish();
  assert.equal(writes.length, 1);
  assert.match(writes[0][1], /^\d+:0\./);
  listeners.get("storage")({ key: "unrelated" });
  assert.equal(refreshes, 0);
  listeners.get("storage")({ key: writes[0][0] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(refreshes, 1);
  assert.equal(writes.length, 1);
  listeners.get("focus")();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(refreshes, 2);
  watch.dispose();
  assert.equal(listeners.size, 0);
});
