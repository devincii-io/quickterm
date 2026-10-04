import test from "node:test";
import assert from "node:assert/strict";
import { settingsPatch, settingsProblems, watchGlobalSettings } from "../../quickterm/frontend/js/global_settings.js";
import { createConfigSync } from "../../quickterm/frontend/js/config_sync.js";

test("a settings save preserves another window's unrelated changes", () => {
  const baseline = { theme: "graphite", font_size: 14, profiles: [] };
  const draft = { ...baseline, font_size: 16 };
  assert.deepEqual(settingsPatch(draft, baseline, { ...baseline, theme: "light" }), { font_size: 16 });
  assert.throws(() => settingsPatch(draft, baseline, { ...baseline, font_size: 18 }), /changed in another window/);
  assert.deepEqual(settingsPatch(draft, baseline, { ...baseline, font_size: 16 }), { font_size: 16 });
});

test("connection edits cannot silently erase another window's profiles", () => {
  assert.throws(() => settingsPatch({ profiles: [{ name: "SSH" }] }, { profiles: [] }, { profiles: [{ name: "Docker" }] }), /Terminals changed in another window/);
});

test("window and overlay are sent whole, as top-level keys", () => {
  const baseline = {
    window: { width: 1280, height: 800, remember_bounds: true },
    overlay: { enabled: false, edge: "top", width_pct: 100, height_pct: 50 },
    theme: "graphite",
  };
  const draft = structuredClone(baseline);
  draft.overlay.enabled = true;
  assert.deepEqual(settingsPatch(draft, baseline, structuredClone(baseline)), {
    overlay: { enabled: true, edge: "top", width_pct: 100, height_pct: 50 },
  });
  // Another window changed a different field of the same object: refuse, do
  // not merge, because the whole object is what goes over the wire.
  const fresh = structuredClone(baseline);
  fresh.overlay.edge = "bottom";
  assert.throws(() => settingsPatch(draft, baseline, fresh), /Overlay changed in another window/);
  // An older backend has no window key at all; the Window tab adds it on edit.
  const legacy = { theme: "graphite" };
  assert.deepEqual(
    settingsPatch({ ...legacy, window: { width: 1440, height: 900, remember_bounds: true } }, legacy, legacy),
    { window: { width: 1440, height: 900, remember_bounds: true } },
  );
});

test("the footer refuses a draft the backend would refuse, naming the first problem", () => {
  const ok = { profiles: [{ name: "Dev", env: {} }], snippets: [{ name: "s", text: "ls\r" }] };
  assert.equal(settingsProblems(ok), "");
  assert.equal(settingsProblems({ profiles: [{ name: " " }] }), "Every terminal needs a name.");
  assert.equal(settingsProblems({ profiles: [{ name: "a" }, { name: "A" }] }), "Terminal names must be unique.");
  assert.match(settingsProblems({ profiles: [{ name: "a", env: { "": "x" } }] }), /environment variable name/);
  assert.equal(settingsProblems({ snippets: [{ name: "s", text: "" }] }), "Every snippet needs a name and command.");
  assert.equal(settingsProblems({ snippets: [{ name: "s", text: "a" }, { name: "S", text: "b" }] }), "Snippet names must be unique.");
  assert.equal(
    settingsProblems(ok, { profileProblem: (profile) => [`${profile.name} is broken`] }),
    "Dev is broken",
    "the Terminals tab's own rules go first",
  );
});

test("a new global shortcut without Ctrl, Alt or Win blocks the save", () => {
  const draft = (summon, key) => ({ summon_hotkey: summon, profiles: [{ name: "Dev", env: {}, keybinding: key }] });
  assert.match(settingsProblems(draft("enter", null)), /^Summon shortcut: Add Ctrl, Alt or Win/);
  assert.match(settingsProblems(draft("ctrl+alt+grave", "shift+f5")), /^"Dev" shortcut: Add Ctrl, Alt or Win/);
  assert.match(settingsProblems(draft("ctrl+alt+1", "alt+ctrl+1")), /Already used by "Dev"/);
  assert.equal(settingsProblems(draft("ctrl+alt+grave", "ctrl+alt+1")), "");
  // 3.x took free text: a plain key already saved does not block other saves.
  const saved = draft("ctrl+alt+grave", "f5");
  assert.equal(settingsProblems(saved, { baseline: structuredClone(saved) }), "");
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
