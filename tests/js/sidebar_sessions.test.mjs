import test from "node:test";
import assert from "node:assert/strict";

import {
  SIDEBAR_WIDE_AT, UNASSIGNED_GROUP, groupSummary,
  isWideSidebar, sessionState, sessionSummary, sidebarGroups,
} from "../../quickterm/frontend/js/launcher.js";

function session(id, extra = {}) {
  return {
    id,
    name: id,
    alive: true,
    attachments: 0,
    busy: null,
    profile: "pwsh",
    activity: { idle_seconds: 0, background_output_bytes: 0, background_output_age_seconds: null },
    ...extra,
  };
}

const named = (...names) => names.map((name) => ({ name, path: null, pathExists: null }));

test("every live terminal is grouped by its workspace, in name order, unassigned last", () => {
  const groups = sidebarGroups([
    session("a", { workspace: "quickterm" }),
    session("b", { workspace: "acme" }),
    session("c", { workspace: null }),
    session("d", { workspace: "quickterm" }),
    session("dead", { workspace: "acme", alive: false }),
  ], {
    workspaces: named("quickterm", "acme"),
    views: [{ workspace: "quickterm", label: "quickterm", color: "#f80", active: true }],
    attached: { a: "quickterm" },
  });

  // The active workspace does not jump to the top: the list is alphabetical.
  assert.deepEqual(groups.map((group) => group.label), ["acme", "quickterm", UNASSIGNED_GROUP]);
  assert.deepEqual(groups.map((group) => group.kind), ["workspace", "workspace", "unassigned"]);
  // Nothing is dropped but the exited session: five records, four rows.
  assert.equal(groups.reduce((sum, group) => sum + group.sessions.length, 0), 4);
  assert.deepEqual(groups[1].sessions.map((entry) => entry.session.id), ["a", "d"]);
  assert.equal(groups[1].sessions[0].attachedIn, "quickterm");
  assert.equal(groups[0].sessions[0].attachedIn, null);
  assert.equal(groups[1].active, true);
});

test("a session a view claimed before the next autosave counts as that view's", () => {
  // The backend only learns ownership on the workspace PUT, so a terminal
  // spawned a moment ago still carries the old workspace, or none at all.
  const groups = sidebarGroups([
    session("fresh", { workspace: null }),
    session("theirs", { workspace: "acme" }),
  ], { workspaces: named("quickterm", "acme"), owned: { fresh: "quickterm" } });

  assert.deepEqual(groups.map((group) => group.name), ["acme", "quickterm"]);
  assert.deepEqual(groups[1].sessions.map((entry) => entry.session.id), ["fresh"]);
});

test("a legacy scratch owner is a scratch group after the named workspaces", () => {
  const groups = sidebarGroups([
    session("a", { workspace: "scratch" }),
    session("b", { workspace: null }),
  ], { workspaces: named("acme") });

  assert.deepEqual(groups.map((group) => [group.kind, group.label]),
    [["workspace", "acme"], ["scratch", "scratch"], ["unassigned", UNASSIGNED_GROUP]]);
});

test("a workspace keeps its group with nothing running in it", () => {
  const groups = sidebarGroups([session("a", { workspace: "acme" })], { workspaces: named("quickterm", "acme") });
  const quickterm = groups.find((group) => group.name === "quickterm");
  assert.equal(quickterm.sessions.length, 0);
  assert.equal(groupSummary(quickterm), "nothing running");
});

test("rows keep their name order whatever they are doing", () => {
  const groups = sidebarGroups([
    session("zzz-quiet"),
    session("busy", { busy: true }),
    session("aaa-quiet"),
    session("unread", { activity: { background_output_bytes: 4096, idle_seconds: 9 } }),
    session("open"),
  ], {
    workspaces: named("ws"),
    owned: { "zzz-quiet": "ws", busy: "ws", "aaa-quiet": "ws", unread: "ws" },
    attached: { open: "ws" },
  });

  assert.deepEqual(groups[0].sessions.map((entry) => entry.session.id),
    ["aaa-quiet", "busy", "open", "unread", "zzz-quiet"]);
  assert.equal(groupSummary(groups[0]), "1 open · 1 new output · 1 busy · 2 background");
});

test("a null busy is never reported as idle", () => {
  // The sidebar polls with metrics:false, which costs no process snapshot and
  // therefore cannot answer "busy". Only an explicit true may claim it.
  assert.equal(sessionState(session("a", { busy: null }), false).key, "idle");
  assert.equal(sessionState(session("a", { busy: true }), false).key, "busy");
  assert.equal(sessionState(session("a", { busy: true }), true).key, "open");
  assert.equal(sessionState(session("a", { attachments: 2 }), false).label, "open elsewhere");
  assert.equal(
    sessionState(session("a", { activity: { background_output_bytes: 12 } }), false).key,
    "unread",
  );
});

test("the summary line says what kind of terminal, then why it wants you", () => {
  assert.equal(
    sessionSummary(session("a", { profile: "claude-code", activity: { background_output_bytes: 2048, background_output_age_seconds: 90 } })),
    "claude-code · +2 KB 1m 30s ago",
  );
  assert.equal(sessionSummary(session("a", { busy: true })), "pwsh · working");
  assert.equal(sessionSummary(session("a", { activity: { idle_seconds: 3600 } })), "pwsh · quiet 1h 0m");
  // Memory joins only when a metrics-carrying payload measured it.
  assert.equal(
    sessionSummary(session("a", { usage: { available: true, working_set_bytes: 200 * 1024 * 1024 } })),
    "pwsh · quiet 0s · 200 MB",
  );
  assert.equal(sessionSummary(session("a", { usage: { available: false } })), "pwsh · quiet 0s");
});

test("the extra row line unlocks only once the sidebar is wide enough for it", () => {
  assert.equal(isWideSidebar(SIDEBAR_WIDE_AT), true);
  assert.equal(isWideSidebar(SIDEBAR_WIDE_AT - 1), false);
  assert.equal(isWideSidebar(undefined), false);
});

test("a terminal shown in another workspace remains in its group and counts as open", () => {
  const groups = sidebarGroups([{ id: "other", alive: true, workspace: "Operations" }], {
    workspaces: named("Project", "Operations"),
    views: [
      { workspace: "Project", label: "Project", color: "#111", active: true },
      { workspace: "Operations", label: "Operations", color: "#222", active: false },
    ],
    attached: { other: "Operations" },
  });
  const group = groups.find((item) => item.name === "Operations");
  assert.equal(group.sessions[0].attachedIn, "Operations");
  assert.equal(group.sessions[0].state.key, "open");
  assert.equal(group.counts.open, 1);
});
