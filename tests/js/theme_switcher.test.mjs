// The theme switcher's pure model: which cards it shows in which group, what
// a search keeps, where the arrows go, and what each way of leaving the sheet
// does to the theme (theme_switcher_model.js).
import test from "node:test";
import assert from "node:assert/strict";

import {
  GROUPS, apply, closePlan, createSwitcherModel, editCustom, filterEntries, groupEntries, hover,
  select, stepId, switcherEntries,
} from "../../quickterm/frontend/js/theme_switcher_model.js";
import { CUSTOM_THEME, TERMINAL_THEMES, themeGroups } from "../../quickterm/frontend/js/themes.js";

const ids = (entries) => entries.map((entry) => entry.id);

test("every built-in theme gets one card, then the custom one, in group order", () => {
  const entries = switcherEntries();
  assert.equal(entries.length, Object.keys(TERMINAL_THEMES).length + 1);
  const [[, dark], [, light]] = themeGroups();
  assert.deepEqual(ids(entries), [...dark, ...light, CUSTOM_THEME]);
  for (const entry of entries) {
    assert.ok(GROUPS.includes(entry.group), entry.id);
    assert.equal(entry.group === "Light", entry.id !== CUSTOM_THEME && TERMINAL_THEMES[entry.id].light);
    assert.equal(typeof entry.label, "string");
  }
});

test("groups come out Dark, Light, Custom and empty ones are dropped", () => {
  const all = groupEntries(switcherEntries());
  assert.deepEqual(all.map((group) => group.heading), ["Dark", "Light", "Custom"]);
  const lightOnly = groupEntries(filterEntries(switcherEntries(), "light"));
  assert.deepEqual(lightOnly.map((group) => group.heading), ["Light"]);
});

test("a group word keeps that group; other words match the start of a word", () => {
  const entries = switcherEntries();
  const dark = filterEntries(entries, "dark");
  assert.ok(dark.length > 10);
  assert.ok(dark.every((entry) => entry.group === "Dark"));
  // "Tokyo Night Day" says "daylight" and a dark note says "lights": neither
  // is a light theme or a match for "light" as a group.
  assert.ok(!ids(filterEntries(entries, "light")).includes("tokyo-night"));
  assert.deepEqual(ids(filterEntries(entries, "one dark")), ["one-dark"]);
  assert.deepEqual(ids(filterEntries(entries, "  CATPPUCCIN   latte ")), ["catppuccin-latte"]);
  assert.ok(ids(filterEntries(entries, "rose")).includes("rose-pine-moon"));
  assert.deepEqual(ids(filterEntries(entries, "custom")), [CUSTOM_THEME]);
  assert.deepEqual(filterEntries(entries, "zzz-nothing"), []);
  assert.equal(filterEntries(entries, "   "), entries);
});

test("the arrows clamp at both ends and restart from the first card when filtered away", () => {
  const list = ["a", "b", "c", "d", "e"];
  assert.equal(stepId(list, "c", 1), "d");
  assert.equal(stepId(list, "c", -4), "a");
  assert.equal(stepId(list, "d", 4), "e");
  assert.equal(stepId(list, "gone", 1), "a");
  assert.equal(stepId([], "a", 1), null);
});

test("selecting and hovering preview; leaving the grid shows the selection again", () => {
  let model = createSwitcherModel({ theme: "graphite" });
  assert.deepEqual([model.original, model.applied, model.selected, model.previewed],
    ["graphite", "graphite", "graphite", "graphite"]);
  model = select(model, "nord");
  assert.equal(model.previewed, "nord");
  assert.equal(model.applied, "graphite");
  model = hover(model, "dracula");
  assert.equal(model.previewed, "dracula");
  assert.equal(model.selected, "nord");
  model = hover(model, null);
  assert.equal(model.previewed, "nord");
});

test("a retired id opens on the theme it resolves to", () => {
  assert.equal(createSwitcherModel({ theme: "monokai" }).selected, "dracula");
  assert.equal(createSwitcherModel({ theme: undefined }).selected, "graphite");
});

test("Escape or Cancel goes back to the opening theme and saves it again only if needed", () => {
  let model = createSwitcherModel({ theme: "nord" });
  model = select(model, "dracula");
  assert.deepEqual(closePlan(model, "cancel"), { theme: "nord", custom: model.originalCustom, persist: false });
  model = apply(model, "dracula");
  model = select(model, "github-light");
  const plan = closePlan(model, "cancel");
  assert.equal(plan.theme, "nord");
  assert.equal(plan.persist, true);
});

test("Done keeps the selected card, saving it when it was only previewed", () => {
  let model = createSwitcherModel({ theme: "nord" });
  assert.equal(closePlan(model, "done").persist, false);
  model = select(model, "dracula");
  assert.deepEqual(closePlan(model, "done"), { theme: "dracula", custom: model.custom, persist: true });
  model = apply(model);
  assert.equal(closePlan(model, "done").persist, false);
});

test("a click outside keeps what was applied and drops a mere preview", () => {
  let model = createSwitcherModel({ theme: "nord" });
  model = apply(select(model, "dracula"));
  model = hover(select(model, "one-dark"), "solarized-light");
  assert.deepEqual(closePlan(model, "outside"), { theme: "dracula", custom: model.appliedCustom, persist: false });
});

test("editing a custom colour previews the custom theme and is saved with it", () => {
  let model = createSwitcherModel({ theme: CUSTOM_THEME, custom: { accent: "#112233" } });
  assert.equal(model.custom.accent, "#112233");
  model = editCustom(select(model, "nord"), "accent", "#aabbcc");
  assert.equal(model.selected, CUSTOM_THEME);
  assert.equal(model.previewed, CUSTOM_THEME);
  assert.equal(model.custom.accent, "#AABBCC");
  // Unsaved colour edits: Done saves them, Cancel restores the opening ones.
  assert.equal(closePlan(model, "done").persist, true);
  assert.equal(closePlan(model, "cancel").persist, false);
  assert.equal(closePlan(model, "cancel").custom.accent, "#112233");
  model = apply(model);
  assert.equal(closePlan(model, "cancel").persist, true);
  assert.equal(closePlan(model, "outside").custom.accent, "#AABBCC");
});
