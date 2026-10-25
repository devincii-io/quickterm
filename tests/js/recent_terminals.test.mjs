// Ctrl+Tab's list: most recent first, the current terminal first and the one
// before it selected, the order frozen while the list is open, at most eight,
// and terminals that are gone left out.
import test from "node:test";
import assert from "node:assert/strict";

import { RECENT_LIMIT, RecentTerminals } from "../../quickterm/frontend/js/recent_terminals.js";

const noted = (...ids) => {
  const recent = new RecentTerminals();
  for (const id of ids) recent.note(id);
  return recent;
};

test("the current terminal comes first and the one before it is selected", () => {
  const recent = noted("a", "b", "c");
  assert.deepEqual(recent.open({ current: "c" }), ["c", "b", "a"]);
  assert.equal(recent.selected(), "b");
});

test("a tap flips between the last two terminals", () => {
  const recent = noted("a", "b");
  recent.open({ current: "b" });
  assert.equal(recent.close({ choose: true }), "a");
  recent.open({ current: "a" });
  assert.equal(recent.close({ choose: true }), "b");
  recent.open({ current: "b" });
  assert.equal(recent.close({ choose: true }), "a");
});

test("the order is frozen while the list is open", () => {
  const recent = noted("a", "b", "c");
  recent.open({ current: "c" });
  // The view behind keeps reporting focus while Tab moves the selection.
  recent.note("a");
  assert.equal(recent.move(1), "a");
  recent.note("b");
  assert.deepEqual(recent.list, ["c", "b", "a"]);
  assert.equal(recent.move(1), "c", "wraps to the first");
  assert.equal(recent.move(-1), "a", "and back");
  assert.equal(recent.close({ choose: true }), "a");
  assert.deepEqual(recent.ids, ["a", "c", "b"]);
});

test("Escape leaves the order as it was", () => {
  const recent = noted("a", "b", "c");
  recent.open({ current: "c" });
  recent.move(1);
  assert.equal(recent.close(), null);
  assert.deepEqual(recent.ids, ["c", "b", "a"]);
  assert.equal(recent.isOpen, false);
});

test("at most eight terminals are kept, the oldest go first", () => {
  const recent = noted(..."abcdefghij");
  assert.equal(RECENT_LIMIT, 8);
  assert.deepEqual(recent.open({ current: "j" }), [..."jihgfedc"]);
});

test("closed terminals are dropped, the focused one never", () => {
  const recent = noted("a", "b", "c", "d");
  const running = new Set(["a", "c"]);
  assert.deepEqual(recent.open({ current: "d", alive: (id) => running.has(id) }), ["d", "c", "a"]);
  recent.close();
  // Dropped for good, not only hidden this once.
  assert.deepEqual(recent.ids, ["d", "c", "a"]);
  recent.drop("c");
  assert.deepEqual(recent.ids, ["d", "a"]);
});

test("the current terminal is listed even when nothing noted it yet", () => {
  const recent = noted("a");
  assert.deepEqual(recent.open({ current: "z" }), ["z", "a"]);
  assert.equal(recent.selected(), "a");
});

test("one terminal selects itself; none lists nothing", () => {
  const one = new RecentTerminals();
  assert.deepEqual(one.open({ current: "a" }), ["a"]);
  assert.equal(one.selected(), "a");
  const none = new RecentTerminals();
  assert.deepEqual(none.open({ current: null }), []);
  assert.equal(none.move(1), null);
  assert.equal(none.close({ choose: true }), null);
});

test("a pointer can pick any row", () => {
  const recent = noted("a", "b", "c");
  recent.open({ current: "c" });
  assert.equal(recent.select(2), "a");
  assert.equal(recent.select(7), null);
  assert.equal(recent.close({ choose: true }), "a");
});
