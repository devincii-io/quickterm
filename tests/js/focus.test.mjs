import test from "node:test";
import assert from "node:assert/strict";

import {
  claimFocus, focusOwners, releaseFocus, resetFocusOwners, terminalMayFocus,
} from "../../quickterm/frontend/js/focus.js";

test("nothing owns the keyboard until an overlay claims it", () => {
  resetFocusOwners();
  assert.equal(terminalMayFocus(), true);
  claimFocus("palette");
  assert.equal(terminalMayFocus(), false);
  releaseFocus("palette");
  assert.equal(terminalMayFocus(), true);
});

// The Alt+K failure this module exists for: togglePalette closes any open panel
// first, panel close calls refocusTerm(), and that schedules term.focus() on a
// frame and on a timeout. Both land after the palette has focused its input.
// The palette's claim is what makes those deferred calls stand down.
test("a claim outlives the panel close that scheduled a terminal refocus", () => {
  resetFocusOwners();
  claimFocus("panel");
  releaseFocus("panel");        // panels.close()
  assert.equal(terminalMayFocus(), true);
  claimFocus("palette");        // palette opens and focuses its input
  // The frame and the timeout the closing panel scheduled fire about here.
  assert.equal(terminalMayFocus(), false);
  releaseFocus("palette");
  assert.equal(terminalMayFocus(), true);
});

// A folder browser opens over the dashboard panel. Releasing the browser must
// not hand the keyboard back to the terminal while the panel is still up.
test("claims are counted, so a nested overlay releases cleanly", () => {
  resetFocusOwners();
  claimFocus("panel");
  claimFocus("folder-browser");
  releaseFocus("folder-browser");
  assert.equal(terminalMayFocus(), false);
  assert.deepEqual(focusOwners(), ["panel"]);
  releaseFocus("panel");
  assert.equal(terminalMayFocus(), true);
});

test("the same owner claiming twice needs two releases", () => {
  resetFocusOwners();
  claimFocus("panel");
  claimFocus("panel");
  releaseFocus("panel");
  assert.equal(terminalMayFocus(), false);
  releaseFocus("panel");
  assert.equal(terminalMayFocus(), true);
  // An unbalanced release must not go negative and wedge the guard shut.
  releaseFocus("panel");
  assert.equal(terminalMayFocus(), true);
});
