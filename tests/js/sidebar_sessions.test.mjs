import test from "node:test";
import assert from "node:assert/strict";

import {
  SIDEBAR_WIDE_AT, UNASSIGNED_GROUP, groupSessionsByWorkspace, groupSummary,
  isWideSidebar, sessionState, sessionSummary,
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

test("every live terminal is grouped, with the current workspace first", () => {
  const groups = groupSessionsByWorkspace([
    session("a", { workspace: "quickterm" }),
    session("b", { workspace: "acme" }),
    session("c", { workspace: null }),
    session("d", { workspace: "quickterm" }),
    session("dead", { workspace: "acme", alive: false }),
  ], { currentWorkspace: "quickterm", ownedIds: ["a"], attachedIds: ["a"] });

  assert.deepEqual(groups.map((group) => group.name), ["quickterm", "acme", UNASSIGNED_GROUP]);
  assert.deepEqual(groups.map((group) => group.kind), ["current", "workspace", "unassigned"]);
  // Nothing is dropped but the exited session: five records, four rows.
  assert.equal(groups.reduce((sum, group) => sum + group.sessions.length, 0), 4);
  assert.deepEqual(groups[0].sessions.map((entry) => entry.session.id), ["a", "d"]);
  assert.equal(groups[0].sessions[0].isAttached, true);
  assert.equal(groups[1].sessions[0].isHere, false);
});

test("a session this window claimed before the next autosave counts as ours", () => {
  // The backend only learns ownership on the workspace PUT, so a terminal
  // spawned a moment ago still carries the old workspace, or none at all.
  const groups = groupSessionsByWorkspace([
    session("fresh", { workspace: null }),
    session("theirs", { workspace: "acme" }),
  ], { currentWorkspace: "quickterm", ownedIds: ["fresh"], attachedIds: [] });

  assert.deepEqual(groups.map((group) => group.name), ["quickterm", "acme"]);
  assert.deepEqual(groups[0].sessions.map((entry) => entry.session.id), ["fresh"]);
});

test("scratch is the current group when no workspace is named", () => {
  const groups = groupSessionsByWorkspace([
    session("a", { workspace: "scratch" }),
    session("b", { workspace: null }),
  ], { currentWorkspace: null, ownedIds: [], attachedIds: [] });

  assert.deepEqual(groups.map((group) => group.name), ["scratch", UNASSIGNED_GROUP]);
});

test("the current workspace keeps its heading even with nothing running in it", () => {
  const groups = groupSessionsByWorkspace([session("a", { workspace: "acme" })], {
    currentWorkspace: "quickterm", ownedIds: [], attachedIds: [],
  });
  assert.equal(groups[0].name, "quickterm");
  assert.equal(groups[0].sessions.length, 0);
  assert.equal(groupSummary(groups[0]), "nothing running");
  // No live terminal at all is the caller's empty state, not an empty group.
  assert.deepEqual(groupSessionsByWorkspace([], { currentWorkspace: "quickterm" }), []);
});

test("rows are ordered by how much they want you", () => {
  const groups = groupSessionsByWorkspace([
    session("zzz-quiet"),
    session("busy", { busy: true }),
    session("aaa-quiet"),
    session("unread", { activity: { background_output_bytes: 4096, idle_seconds: 9 } }),
    session("open"),
  ], { currentWorkspace: "ws", ownedIds: ["zzz-quiet", "busy", "aaa-quiet", "unread", "open"], attachedIds: ["open"] });

  assert.deepEqual(groups[0].sessions.map((entry) => entry.session.id),
    ["open", "unread", "busy", "aaa-quiet", "zzz-quiet"]);
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
