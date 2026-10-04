// The sidebar's view menu, decided without a DOM: which workspaces show, how
// rows are grouped and sorted, and what a stored choice falls back to.

import test from "node:test";
import assert from "node:assert/strict";

import {
  SIDEBAR_VIEW_DEFAULTS, isDefaultView, normalizeView, sidebarGroups, visibleGroups,
} from "../../quickterm/frontend/js/sidebar_model.js";

function session(id, extra = {}) {
  return {
    id,
    name: id,
    alive: true,
    attachments: 0,
    busy: false,
    profile: "pwsh",
    attention: null,
    activity: { idle_seconds: 100, background_output_bytes: 0, background_output_age_seconds: null },
    ...extra,
  };
}

const workspaces = ["asm", "fs-teams", "mes", "qt"].map((name) => ({ name, path: `C:\\src\\${name}`, pathExists: true }));
const labels = (groups) => groups.map((group) => group.label);

test("empty workspaces are hidden by default and counted", () => {
  const all = sidebarGroups([session("a", { workspace: "fs-teams" })], {
    workspaces, views: [{ workspace: "qt", label: "qt", active: true }],
  });
  const { groups, hidden } = visibleGroups(all);
  // fs-teams holds a terminal, qt is open in this window; asm and mes are empty.
  assert.deepEqual(labels(groups), ["fs-teams", "qt"]);
  assert.equal(hidden, 2);
});

test("the view menu can show empty workspaces again", () => {
  const all = sidebarGroups([], { workspaces });
  const { groups, hidden } = visibleGroups(all, { empty: true });
  assert.deepEqual(labels(groups), ["asm", "fs-teams", "mes", "qt"]);
  assert.equal(hidden, 0);
});

test("hiding finished terminals keeps one that still asks for you", () => {
  const sessions = [
    session("done", { workspace: "qt", alive: false, activity: { background_output_bytes: 10 } }),
    session("asks", { workspace: "qt", alive: false, attention: { kind: "exit" } }),
    session("live", { workspace: "qt" }),
  ];
  const [qt] = visibleGroups(sidebarGroups(sessions, { workspaces, view: { finished: false } })).groups;
  assert.deepEqual(qt.sessions.map((entry) => entry.session.id), ["asks", "live"]);
});

test("grouping by nothing gives one list that names each terminal's workspace", () => {
  const sessions = [session("b", { workspace: "qt" }), session("a", { workspace: "mes" }), session("c")];
  const groups = sidebarGroups(sessions, { workspaces, view: { group: "none" } });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "flat");
  assert.deepEqual(groups[0].sessions.map((entry) => [entry.session.id, entry.owner]),
    [["a", "mes"], ["b", "qt"], ["c", "Unassigned"]]);
  assert.deepEqual(visibleGroups(groups).groups, groups);
});

test("recent activity puts busy and fresh terminals and their workspaces first", () => {
  const sessions = [
    session("old", { workspace: "asm", activity: { idle_seconds: 900 } }),
    session("busy", { workspace: "mes", busy: true }),
    session("fresh", { workspace: "asm", activity: { idle_seconds: 5 } }),
  ];
  const byName = visibleGroups(sidebarGroups(sessions, { workspaces })).groups;
  assert.deepEqual(labels(byName), ["asm", "mes"]);
  const recent = visibleGroups(sidebarGroups(sessions, { workspaces, view: { sort: "activity" } })).groups;
  assert.deepEqual(labels(recent), ["mes", "asm"]);
  assert.deepEqual(recent[1].sessions.map((entry) => entry.session.id), ["fresh", "old"]);
});

test("a stored view is normalised and the default is recognised", () => {
  assert.deepEqual(normalizeView(null), { ...SIDEBAR_VIEW_DEFAULTS });
  assert.deepEqual(normalizeView({ empty: "yes", group: "tree", sort: "activity", finished: false }),
    { empty: false, finished: false, group: "workspace", sort: "activity" });
  assert.equal(isDefaultView({}), true);
  assert.equal(isDefaultView({ empty: true }), false);
});
