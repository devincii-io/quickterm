// "Needs you", finished rows and the current folder, as the sidebar decides
// them without a DOM.

import test from "node:test";
import assert from "node:assert/strict";

import {
  UNASSIGNED_GROUP, attentionText, groupSummary, isListedSession,
  sessionFolder, sessionState, sessionSummary, sessionTooltip, sidebarGroups,
} from "../../quickterm/frontend/js/launcher.js";

function session(id, extra = {}) {
  return {
    id,
    name: id,
    alive: true,
    exit_code: null,
    attachments: 0,
    busy: false,
    profile: "pwsh",
    cwd: "C:\\start",
    current_cwd: null,
    attention: null,
    activity: { idle_seconds: 0, background_output_bytes: 0, background_output_age_seconds: null },
    ...extra,
  };
}

const bell = { kind: "bell", text: null, age_seconds: 5 };
const ask = { kind: "notify", text: "Approve the edit?", age_seconds: 70 };
const ws = [{ name: "ws", path: null, pathExists: null }];

test("attention is its own state and outranks being open here", () => {
  assert.deepEqual(sessionState(session("a", { attention: bell }), false), { key: "attention", label: "needs you" });
  assert.equal(sessionState(session("a", { attention: ask, busy: true }), true).key, "attention");
  assert.equal(sessionState(session("a"), true).key, "open");
});

test("a terminal that needs you keeps its place and is counted for its group", () => {
  const groups = sidebarGroups([
    session("open"),
    session("quiet"),
    session("zz-asks", { attention: ask }),
    session("busy", { busy: true }),
  ], { workspaces: ws, owned: { quiet: "ws", "zz-asks": "ws", busy: "ws" }, attached: { open: "ws" } });

  assert.deepEqual(groups[0].sessions.map((entry) => entry.session.id), ["busy", "open", "quiet", "zz-asks"]);
  assert.equal(groups[0].sessions[3].state.key, "attention");
  assert.equal(groups[0].counts.attention, 1);
  assert.equal(groupSummary(groups[0]), "1 needs you · 1 open · 1 busy · 1 background");
});

test("busy is shown from the cheap poll now that it carries busy", () => {
  assert.equal(sessionState(session("a", { busy: true }), false).key, "busy");
  assert.equal(sessionState(session("a", { busy: false }), false).key, "idle");
});

test("an exited terminal is listed only while the backend holds it for you", () => {
  assert.equal(isListedSession(session("gone", { alive: false })), false);
  assert.equal(isListedSession(session("asked", { alive: false, attention: { kind: "exit", text: "exited with code 1" } })), true);
  assert.equal(isListedSession(session("unread", {
    alive: false, activity: { background_output_bytes: 10 },
  })), true);
  assert.equal(isListedSession(null), false);

  const groups = sidebarGroups([
    session("live"),
    session("gone", { alive: false }),
    session("done", { alive: false, exit_code: 0, activity: { background_output_bytes: 900 } }),
    session("failed", { alive: false, exit_code: 2, attention: { kind: "exit", text: "exited with code 2", age_seconds: 1 } }),
  ], { workspaces: ws, owned: { live: "ws", gone: "ws", done: "ws", failed: "ws" } });

  const rows = groups[0].sessions;
  assert.deepEqual(rows.map((entry) => entry.session.id), ["done", "failed", "live"]);
  assert.deepEqual(rows.map((entry) => entry.state.key), ["finished", "attention", "idle"]);
  assert.deepEqual(rows.map((entry) => entry.finished), [true, true, false]);
  assert.equal(groupSummary(groups[0]), "1 needs you · 1 background · 1 finished");
});

test("a finished row says how it ended in the tooltip", () => {
  const done = session("done", { alive: false, exit_code: 3, activity: { background_output_bytes: 9 } });
  assert.equal(sessionSummary(done), "pwsh · exited with code 3");
  assert.match(sessionTooltip(done, "ws"), /finished, exited with code 3; click to read its output/);
});

test("attention reads as words, with its text when it has one", () => {
  assert.equal(attentionText(ask), "Approve the edit?");
  assert.equal(attentionText(bell), "rang the bell");
  assert.equal(attentionText({ kind: "exit" }), "finished");
  assert.equal(attentionText({ kind: "notify" }), "sent a notification");
  assert.equal(attentionText(null), "");
  assert.equal(sessionSummary(session("a", { attention: ask })), "pwsh · needs you 1m 10s ago");
  const tip = sessionTooltip(session("a", { attention: ask }), "ws");
  assert.match(tip, /needs you: Approve the edit\?/);
});

test("the folder is where the shell is now, and the tooltip names both when they differ", () => {
  const moved = session("a", { current_cwd: "C:\\start\\sub" });
  assert.equal(sessionFolder(moved), "C:\\start\\sub");
  assert.equal(sessionFolder(session("a")), "C:\\start");
  assert.equal(sessionFolder({}), "");
  const tip = sessionTooltip(moved, "ws").split("\n");
  assert.ok(tip.includes("in C:\\start\\sub"));
  assert.ok(tip.includes("started in C:\\start"));
  const still = sessionTooltip(session("a", { current_cwd: "C:\\start" }), "ws").split("\n");
  assert.ok(still.includes("C:\\start"));
  assert.ok(!still.some((line) => line.startsWith("started in")));
});

test("a terminal that needs you in another workspace marks that group for the rail", () => {
  const groups = sidebarGroups([
    session("mine"),
    session("theirs", { workspace: "acme", attention: bell }),
    session("stray"),
  ], { workspaces: [...ws, { name: "acme" }], owned: { mine: "ws" } });
  const acme = groups.find((group) => group.name === "acme");
  assert.equal(acme.counts.attention, 1);
  assert.equal(groups.find((group) => group.label === UNASSIGNED_GROUP).counts.attention, 0);
});
