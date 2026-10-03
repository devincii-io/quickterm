// The flat sidebar list, decided without a DOM: one group per saved workspace,
// scratch views next, Unassigned last, and an order that state never changes.

import test from "node:test";
import assert from "node:assert/strict";

import { UNASSIGNED_GROUP, groupSummary, sidebarGroups } from "../../quickterm/frontend/js/launcher.js";

function session(id, extra = {}) {
  return {
    id,
    name: id,
    alive: true,
    attachments: 0,
    busy: false,
    profile: "pwsh",
    attention: null,
    activity: { idle_seconds: 0, background_output_bytes: 0, background_output_age_seconds: null },
    ...extra,
  };
}

const SCRATCH = "scratch-view-abcdef1234";
const workspaces = [
  { name: "zeta", path: "C:\\src\\zeta", pathExists: true },
  { name: "Alpha", path: "C:\\src\\alpha", pathExists: false },
  { name: "beta", path: null, pathExists: null },
];

test("every saved workspace is listed, empty ones included, in name order", () => {
  const groups = sidebarGroups([], { workspaces });
  assert.deepEqual(groups.map((group) => group.key), ["ws:Alpha", "ws:beta", "ws:zeta"]);
  assert.ok(groups.every((group) => group.kind === "workspace" && group.sessions.length === 0));
  assert.equal(groupSummary(groups[0]), "nothing running");
  // Nothing to list at all is an empty list, not an Unassigned group.
  assert.deepEqual(sidebarGroups([], {}), []);
});

test("folder facts come from the saved workspace", () => {
  const groups = sidebarGroups([], { workspaces });
  const alpha = groups.find((group) => group.name === "Alpha");
  assert.equal(alpha.path, "C:\\src\\alpha");
  assert.equal(alpha.pathExists, false);
  assert.equal(groups.find((group) => group.name === "beta").path, null);
});

test("the order is the same whatever the terminals are doing", () => {
  const calm = [
    session("b-shell", { workspace: "zeta" }),
    session("a-shell", { workspace: "zeta" }),
    session("c-shell", { workspace: "Alpha" }),
  ];
  const loud = [
    session("b-shell", { workspace: "zeta", attention: { kind: "bell", age_seconds: 1 } }),
    session("a-shell", { workspace: "zeta", alive: false, attention: { kind: "exit", text: "exited" } }),
    session("c-shell", { workspace: "Alpha", busy: true }),
  ];
  const shape = (groups) => groups.map((group) => [group.key, group.sessions.map((entry) => entry.session.id)]);
  const before = shape(sidebarGroups(calm, { workspaces }));
  const after = shape(sidebarGroups(loud, { workspaces, views: [{ workspace: "zeta", label: "zeta", color: "#f00", active: true }] }));
  assert.deepEqual(after, before);
  assert.deepEqual(before.find(([key]) => key === "ws:zeta")[1], ["a-shell", "b-shell"]);
});

test("an attention row does not move, it only marks its group", () => {
  const groups = sidebarGroups([
    session("alpha"),
    session("beta", { attention: { kind: "notify", text: "Approve?" } }),
    session("gamma"),
  ], { workspaces: [{ name: "ws" }], owned: { alpha: "ws", beta: "ws", gamma: "ws" } });
  const [ws] = groups;
  assert.deepEqual(ws.sessions.map((entry) => entry.session.id), ["alpha", "beta", "gamma"]);
  assert.equal(ws.sessions[1].state.key, "attention");
  assert.equal(ws.counts.attention, 1);
});

test("rows sort by name with numbers in order, then by id", () => {
  const groups = sidebarGroups([
    session("id-3", { name: "shell 10", workspace: "ws" }),
    session("id-2", { name: "shell 2", workspace: "ws" }),
    session("id-b", { name: "same", workspace: "ws" }),
    session("id-a", { name: "same", workspace: "ws" }),
  ], { workspaces: [{ name: "ws" }] });
  assert.deepEqual(groups[0].sessions.map((entry) => entry.session.id), ["id-a", "id-b", "id-2", "id-3"]);
});

test("scratch views follow the named workspaces, ordered by label", () => {
  const other = "scratch-view-0000zzzz";
  const groups = sidebarGroups([
    session("s1", { workspace: SCRATCH }),
    session("orphan", { workspace: other }),
  ], {
    workspaces,
    views: [{ workspace: SCRATCH, label: "a scratch", color: "#0f0", active: false }],
  });
  const scratch = groups.filter((group) => group.kind === "scratch");
  assert.deepEqual(scratch.map((group) => group.name), [SCRATCH, other]);
  assert.equal(scratch[0].label, "a scratch");
  assert.equal(scratch[0].open, true);
  // A scratch owner with no view still gets its group, so its terminal shows.
  assert.equal(scratch[1].label, "scratch zzzz");
  assert.equal(scratch[1].open, false);
  assert.deepEqual(groups.slice(0, 3).map((group) => group.kind), ["workspace", "workspace", "workspace"]);
});

test("an open scratch view is listed even with nothing running in it", () => {
  const groups = sidebarGroups([], { views: [{ workspace: SCRATCH, label: "scratch 1234", color: "#00f", active: true }] });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "scratch");
  assert.equal(groups[0].active, true);
});

test("Unassigned is last and only there when something is unowned", () => {
  const groups = sidebarGroups([
    session("stray"),
    session("mine", { workspace: "zeta" }),
  ], { workspaces, views: [{ workspace: SCRATCH, label: "scratch", color: "#000", active: true }] });
  const last = groups.at(-1);
  assert.equal(last.key, "unassigned");
  assert.equal(last.kind, "unassigned");
  assert.equal(last.label, UNASSIGNED_GROUP);
  assert.equal(last.name, null);
  assert.deepEqual(last.sessions.map((entry) => entry.session.id), ["stray"]);
  assert.equal(sidebarGroups([session("x", { workspace: "zeta" })], { workspaces }).some((group) => group.kind === "unassigned"), false);
});

test("a view's pane and an unsaved claim override the backend's workspace", () => {
  const groups = sidebarGroups([
    session("moved", { workspace: "zeta" }),
    session("fresh", { workspace: null }),
    session("both", { workspace: "zeta" }),
    session("plain", { workspace: "zeta" }),
  ], {
    workspaces,
    attached: { moved: "Alpha", both: "beta" },
    owned: { fresh: "beta", both: "Alpha" },
  });
  const ids = (name) => groups.find((group) => group.name === name).sessions.map((entry) => entry.session.id);
  assert.deepEqual(ids("Alpha"), ["moved"]);
  // attached wins over owned for the same id
  assert.deepEqual(ids("beta"), ["both", "fresh"]);
  assert.deepEqual(ids("zeta"), ["plain"]);
  const moved = groups.find((group) => group.name === "Alpha").sessions[0];
  assert.equal(moved.attachedIn, "Alpha");
  assert.equal(moved.state.key, "open");
  assert.equal(groups.find((group) => group.name === "beta").sessions[1].attachedIn, null);
});

test("Map-shaped claims work like plain objects", () => {
  const groups = sidebarGroups([session("a")], { workspaces, attached: new Map([["a", "zeta"]]) });
  assert.deepEqual(groups.find((group) => group.name === "zeta").sessions.map((entry) => entry.session.id), ["a"]);
});

test("an owner that is not a saved workspace still gets a group", () => {
  const groups = sidebarGroups([session("a", { workspace: "deleted-ws" })], { workspaces });
  const group = groups.find((each) => each.name === "deleted-ws");
  assert.equal(group.kind, "workspace");
  assert.equal(group.path, null);
});

test("counts add up per group", () => {
  const groups = sidebarGroups([
    session("open"),
    session("asks", { attention: { kind: "bell" } }),
    session("busy", { busy: true }),
    session("unread", { activity: { background_output_bytes: 9 } }),
    session("done", { alive: false, activity: { background_output_bytes: 9 } }),
    session("quiet"),
    session("gone", { alive: false }),
  ], { workspaces: [{ name: "ws" }], attached: { open: "ws" }, owned: { asks: "ws", busy: "ws", unread: "ws", done: "ws", quiet: "ws", gone: "ws" } });
  const [ws] = groups;
  assert.deepEqual(ws.counts, { attention: 1, open: 1, busy: 1, unread: 1, finished: 1 });
  assert.equal(ws.sessions.length, 6);
  assert.equal(groupSummary(ws), "1 needs you · 1 open · 1 new output · 1 busy · 1 background · 1 finished");
});

test("open, active and colour come from this window's views", () => {
  const groups = sidebarGroups([], {
    workspaces,
    views: [
      { workspace: "zeta", label: "zeta", color: "#e0a", active: false },
      { workspace: "beta", label: "beta", color: "#0ae", active: true },
    ],
  });
  const byName = Object.fromEntries(groups.map((group) => [group.name, group]));
  assert.deepEqual([byName.zeta.open, byName.zeta.active, byName.zeta.color], [true, false, "#e0a"]);
  assert.deepEqual([byName.beta.open, byName.beta.active, byName.beta.color], [true, true, "#0ae"]);
  assert.deepEqual([byName.Alpha.open, byName.Alpha.active, byName.Alpha.color], [false, false, null]);
});
