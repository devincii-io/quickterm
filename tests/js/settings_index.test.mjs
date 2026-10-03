// Settings search: every field is indexed under the id its [data-setting]
// carries, results are ranked, and saved terminals and snippets join as rows.
import test from "node:test";
import assert from "node:assert/strict";

import {
  SETTINGS_INDEX, SETTINGS_TABS, matchScore, searchSettings,
} from "../../quickterm/frontend/js/settings_index.js";

test("ids are unique and every entry belongs to a real tab", () => {
  const ids = SETTINGS_INDEX.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  const tabs = new Set(SETTINGS_TABS.map(([id]) => id));
  for (const entry of SETTINGS_INDEX) {
    assert.ok(tabs.has(entry.tab), entry.id);
    assert.ok(entry.label && entry.hint !== undefined, entry.id);
  }
  for (const id of [
    "font_family", "font_size", "theme", "logo", "default_profile", "window.size", "window.remember_bounds",
    "overlay.enabled", "overlay.edge", "overlay.width_pct", "overlay.height_pct", "overlay.always_on_top",
    "overlay.hide_on_blur", "overlay.monitor", "overlay.animate", "summon_hotkey", "scrollback_bytes",
    "idle_timeout_s", "max_sessions", "scratch_dir", "host", "port", "update_check", "config_history",
  ]) assert.ok(ids.includes(id), id);
});

test("the tab ids are the frozen ones, Terminals keeping the id connections", () => {
  assert.deepEqual(SETTINGS_TABS.map(([id]) => id), ["general", "window", "shortcuts", "connections", "snippets", "advanced", "about"]);
  assert.equal(SETTINGS_TABS.find(([id]) => id === "connections")[1], "Terminals");
});

test("a label match outranks a keyword match, and a prefix outranks a substring", () => {
  assert.equal(searchSettings("summon")[0].id, "summon_hotkey");
  assert.equal(searchSettings("port")[0].id, "port");
  assert.equal(searchSettings("scratch")[0].id, "scratch_dir");
  // "quake" is only a keyword of the overlay, which is still found.
  assert.equal(searchSettings("quake")[0].id, "overlay.enabled");
  assert.ok(matchScore("theme", { label: "Theme" }) > matchScore("theme", { label: "Overlay", keywords: "theme" }));
  assert.ok(matchScore("over", { label: "Overlay edge" }) > matchScore("edge", { label: "Overlay edge" }));
  assert.equal(matchScore("", { label: "Theme" }), 0);
  assert.deepEqual(searchSettings("zzzz qqqq"), []);
});

test("saved terminals and snippets are searchable rows that name what to select", () => {
  const draft = {
    profiles: [{ name: "Deploy box", terminal_type: "ssh", ssh_host: "prod" }, { name: "" }],
    snippets: [{ name: "git status", text: "git status\r", description: "What changed" }],
  };
  const terminal = searchSettings("deploy", draft)[0];
  assert.deepEqual(
    { id: terminal.id, tab: terminal.tab, kind: terminal.kind, name: terminal.name },
    { id: "terminal:Deploy box", tab: "connections", kind: "terminal", name: "Deploy box" },
  );
  assert.equal(searchSettings("prod", draft)[0].id, "terminal:Deploy box", "a host finds its terminal");
  const snippet = searchSettings("git", draft)[0];
  assert.equal(snippet.id, "snippet:git status");
  assert.equal(snippet.tab, "snippets");
  assert.equal(searchSettings("terminal:", draft).filter((row) => row.kind === "terminal").length, 1, "an unnamed profile is not a row");
});
