// Settings search: every field is indexed under the id its [data-setting]
// carries, results are ranked, and snippets join as rows.
import test from "node:test";
import assert from "node:assert/strict";

import {
  SETTINGS_INDEX, SETTINGS_TABS, matchScore, searchSettings, settingsTabId,
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
    "font_family", "font_size", "theme", "logo", "shell", "window.size", "window.remember_bounds",
    "overlay.enabled", "overlay.edge", "overlay.width_pct", "overlay.height_pct", "overlay.always_on_top",
    "overlay.hide_on_blur", "overlay.monitor", "overlay.animate", "summon_hotkey", "scrollback_bytes",
    "idle_timeout_s", "max_sessions", "scratch_dir", "host", "port", "update_check", "config_history",
  ]) assert.ok(ids.includes(id), id);
});

test("the tab ids are the frozen ones; Agents replaced Terminals and takes its old ids", () => {
  assert.deepEqual(SETTINGS_TABS.map(([id]) => id), ["general", "window", "shortcuts", "agents", "snippets", "advanced", "about"]);
  assert.deepEqual(SETTINGS_TABS.find(([id]) => id === "agents"), ["agents", "Agents", "Claude Code and Codex"]);
  assert.equal(settingsTabId("connections"), "agents");
  assert.equal(settingsTabId("terminals"), "agents");
  assert.equal(settingsTabId("snippets"), "snippets");
  assert.equal(settingsTabId("gone"), "general", "an unknown tab never lands on a blank one");
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

test("snippets and the agents are searchable; saved terminals are no rows any more", () => {
  const draft = {
    profiles: [{ name: "Deploy box", terminal_type: "ssh", ssh_host: "prod" }],
    snippets: [{ name: "git status", text: "git status\r", description: "What changed" }, { name: "" }],
  };
  assert.equal(searchSettings("deploy", draft).some((row) => row.kind === "terminal"), false);
  const snippet = searchSettings("git", draft)[0];
  assert.equal(snippet.id, "snippet:git status");
  assert.equal(snippet.tab, "snippets");
  assert.equal(searchSettings("snippet:", draft).filter((row) => row.kind === "snippet").length, 1, "an unnamed snippet is not a row");
  assert.equal(searchSettings("codex")[0].id, "agents.codex");
  assert.equal(searchSettings("claude")[0].tab, "agents");
});
