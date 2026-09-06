// The popover menu's decisions that need no DOM: where it opens and which
// row the keyboard lands on next.
import test from "node:test";
import assert from "node:assert/strict";

import {
  firstSelectable, lastSelectable, menuPosition, stepIndex, typeaheadIndex,
} from "../../quickterm/frontend/js/menu.js";

const items = [
  { heading: "Personal" },
  { label: "Claude" },
  { label: "PowerShell", disabled: true },
  { separator: true },
  { label: "cmd" },
  { label: "Git Bash" },
];

test("arrow keys skip headings, separators and disabled rows, and wrap", () => {
  assert.equal(firstSelectable(items), 1);
  assert.equal(lastSelectable(items), 5);
  assert.equal(stepIndex(items, 1, 1), 4);
  assert.equal(stepIndex(items, 5, 1), 1);
  assert.equal(stepIndex(items, 1, -1), 5);
  assert.equal(stepIndex(items, 4, -1), 1);
  assert.equal(stepIndex([{ heading: "x" }, { label: "a", disabled: true }], -1, 1), null);
});

test("typing a letter lands on the next label that starts with it", () => {
  assert.equal(typeaheadIndex(items, -1, "c"), 1);
  assert.equal(typeaheadIndex(items, 1, "c"), 4);
  assert.equal(typeaheadIndex(items, 4, "c"), 1);
  assert.equal(typeaheadIndex(items, -1, "g"), 5);
  assert.equal(typeaheadIndex(items, -1, "p"), null, "a disabled row is never a typeahead hit");
  assert.equal(typeaheadIndex(items, -1, ""), null);
});

test("the menu opens under its trigger and stays inside the viewport", () => {
  const viewport = { width: 1000, height: 600 };
  const anchor = { left: 20, top: 40, right: 180, bottom: 60, width: 160, height: 20 };
  const below = menuPosition(anchor, { width: 200, height: 150 }, viewport);
  assert.deepEqual(below, { left: 20, top: 64, width: 200, maxHeight: 530, above: false });

  // Near the right edge the list slides left instead of being clipped.
  const right = menuPosition({ ...anchor, left: 900, right: 990 }, { width: 200, height: 150 }, viewport);
  assert.equal(right.left, 794);

  // Near the bottom, with more room above, it opens upward and ends at the
  // trigger's top edge.
  const low = menuPosition({ left: 20, top: 560, right: 180, bottom: 580, width: 160, height: 20 },
    { width: 200, height: 150 }, viewport);
  assert.equal(low.above, true);
  assert.equal(low.top + 150, 556);

  // A list taller than the window scrolls inside the room it has.
  const tall = menuPosition(anchor, { width: 200, height: 2000 }, viewport);
  assert.equal(tall.maxHeight, 530);
  assert.equal(tall.above, false);
});

test("align end hangs the menu off the trigger's right edge", () => {
  const place = menuPosition({ left: 500, top: 10, right: 540, bottom: 30, width: 40, height: 20 },
    { width: 220, height: 100 }, { width: 1000, height: 600 }, { align: "end" });
  assert.equal(place.left, 320);
});
