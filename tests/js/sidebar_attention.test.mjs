// "Needs you", finished rows and the current folder, as the sidebar decides
// them without a DOM.

import test from "node:test";
import assert from "node:assert/strict";

import {
  UNASSIGNED_GROUP, attentionText, groupSessionsByWorkspace, groupSummary, isListedSession,
  sessionFolder, sessionState, sessionSummary, sessionTooltip,
} from "../../quickterm/frontend/js/launcher.js";
import { documentHasKeyboard, finishedAttachRecord, sessionToMarkSeen } from "../../quickterm/frontend/js/sidebar.js";
import { historySummary, historyTime } from "../../quickterm/frontend/js/panel_settings_about.js";

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

test("attention is its own state and outranks being open here", () => {
  assert.deepEqual(sessionState(session("a", { attention: bell }), false), { key: "attention", label: "needs you" });
  assert.equal(sessionState(session("a", { attention: ask, busy: true }), true).key, "attention");
  assert.equal(sessionState(session("a"), true).key, "open");
});

test("a terminal that needs you sorts first in its group", () => {
  const groups = groupSessionsByWorkspace([
    session("open"),
    session("quiet"),
    session("zz-asks", { attention: ask }),
    session("busy", { busy: true }),
  ], { currentWorkspace: "ws", ownedIds: ["open", "quiet", "zz-asks", "busy"], attachedIds: ["open"] });

  assert.deepEqual(groups[0].sessions.map((entry) => entry.session.id), ["zz-asks", "open", "busy", "quiet"]);
  assert.equal(groups[0].attention, 1);
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

  const groups = groupSessionsByWorkspace([
    session("live"),
    session("gone", { alive: false }),
    session("done", { alive: false, exit_code: 0, activity: { background_output_bytes: 900 } }),
    session("failed", { alive: false, exit_code: 2, attention: { kind: "exit", text: "exited with code 2", age_seconds: 1 } }),
  ], { currentWorkspace: "ws", ownedIds: ["live", "gone", "done", "failed"], attachedIds: [] });

  const rows = groups[0].sessions;
  assert.deepEqual(rows.map((entry) => entry.session.id), ["failed", "live", "done"]);
  assert.deepEqual(rows.map((entry) => entry.state.key), ["attention", "idle", "finished"]);
  assert.deepEqual(rows.map((entry) => entry.finished), [true, false, true]);
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

test("a foreign terminal that needs you marks its group for the rail", () => {
  const groups = groupSessionsByWorkspace([
    session("mine"),
    session("theirs", { workspace: "acme", attention: bell }),
    session("stray"),
  ], { currentWorkspace: "ws", ownedIds: ["mine"], attachedIds: [] });
  const acme = groups.find((group) => group.name === "acme");
  assert.equal(acme.attention, 1);
  assert.equal(groups.find((group) => group.name === UNASSIGNED_GROUP).attention, 0);
});

test("seen is sent for the focused terminal only while someone is looking", () => {
  const sessions = [session("a", { attention: bell }), session("b")];
  const base = { sessions, focusedId: "a", focusChanged: false, visible: true, windowFocused: true };
  assert.equal(sessionToMarkSeen(base), "a");
  // Focus moved to it while the window is visible but not in front: still seen.
  assert.equal(sessionToMarkSeen({ ...base, windowFocused: false, focusChanged: true }), "a");
  // Visible behind another application, focus unchanged: nobody looked.
  assert.equal(sessionToMarkSeen({ ...base, windowFocused: false }), null);
  assert.equal(sessionToMarkSeen({ ...base, visible: false, focusChanged: true }), null);
  assert.equal(sessionToMarkSeen({ ...base, focusedId: "b" }), null);
  assert.equal(sessionToMarkSeen({ ...base, focusedId: null }), null);
});

test("a finished row opens through attach without claiming to be alive", () => {
  const record = finishedAttachRecord(session("done", { alive: false, exit_code: 1 }));
  assert.equal("alive" in record, false);
  assert.equal(record.id, "done");
  assert.equal(record.exit_code, 1);
});

test("settings history rows say what restoring would change", () => {
  assert.equal(historySummary({ summary: "theme, profiles" }), "changes theme, profiles");
  assert.equal(historySummary({ summary: "" }), "no difference");
  assert.equal(historyTime("not a date"), "not a date");
  assert.notEqual(historyTime("2026-09-26T10:32:00Z"), "2026-09-26T10:32:00Z");
});

test("a document whose tiled view has the keyboard does not have it itself", () => {
  // The primary's document reports focus while one of its iframe views has
  // it; its own focused pane must then keep its "needs you".
  const doc = (focused, tag) => ({ hasFocus: () => focused, activeElement: tag ? { tagName: tag } : null });
  assert.equal(documentHasKeyboard(doc(true, "TEXTAREA")), true);
  assert.equal(documentHasKeyboard(doc(true, "IFRAME")), false);
  assert.equal(documentHasKeyboard(doc(false, "TEXTAREA")), false);
  assert.equal(documentHasKeyboard(doc(true, null)), true);
});
