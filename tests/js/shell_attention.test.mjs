import test from "node:test";
import assert from "node:assert/strict";

import { documentHasKeyboard, finishedAttachRecord, sessionToMarkSeen } from "../../quickterm/frontend/js/sidebar.js";

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

test("a document whose tiled view has the keyboard does not have it itself", () => {
  // The primary's document reports focus while one of its iframe views has
  // it; its own focused pane must then keep its "needs you".
  const doc = (focused, tag) => ({ hasFocus: () => focused, activeElement: tag ? { tagName: tag } : null });
  assert.equal(documentHasKeyboard(doc(true, "TEXTAREA")), true);
  assert.equal(documentHasKeyboard(doc(true, "IFRAME")), false);
  assert.equal(documentHasKeyboard(doc(false, "TEXTAREA")), false);
  assert.equal(documentHasKeyboard(doc(true, null)), true);
});
