// Alt+J jumps to the next terminal that needs you. It is a cold Alt combo:
// claimed only when a jump is wired, never while an overlay owns the keyboard,
// and listed in the one SHORTCUTS table Help and Settings render from.
import test from "node:test";
import assert from "node:assert/strict";

let handler = null;
globalThis.window = {
  addEventListener(type, fn, capture) {
    if (type === "keydown" && capture) handler = fn;
  },
};
const { initKeys, PASS_THROUGH_ALT, SHORTCUTS } = await import("../../quickterm/frontend/js/keys.js");

function keyEvent(init) {
  return {
    key: "", code: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
    ...init,
  };
}

function wire({ jump = true, overlay = false } = {}) {
  const calls = [];
  initKeys({
    paletteOpen: () => overlay,
    ...(jump ? { nextNeedsYou: () => calls.push("jump") } : {}),
  });
  return calls;
}

test("Alt+J jumps when the document wires it", () => {
  const calls = wire();
  const event = keyEvent({ key: "j", code: "KeyJ", altKey: true });
  handler(event);
  assert.deepEqual(calls, ["jump"]);
  assert.equal(event.defaultPrevented, true);
});

test("Alt+J reaches the terminal when nothing is wired, and Alt+Shift+J always", () => {
  wire({ jump: false });
  const plain = keyEvent({ key: "j", code: "KeyJ", altKey: true });
  handler(plain);
  assert.equal(plain.defaultPrevented, false);
  const calls = wire();
  const shifted = keyEvent({ key: "J", code: "KeyJ", altKey: true, shiftKey: true });
  handler(shifted);
  assert.equal(shifted.defaultPrevented, false);
  assert.deepEqual(calls, []);
});

test("an open overlay keeps Alt+J", () => {
  const calls = wire({ overlay: true });
  const event = keyEvent({ key: "j", code: "KeyJ", altKey: true });
  handler(event);
  assert.deepEqual(calls, []);
  assert.equal(event.defaultPrevented, false);
});

test("Alt+J is listed once and is not a pass-through key", () => {
  const rows = SHORTCUTS.filter((row) => row.bindings.includes("alt+j"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].keys, "Alt+J");
  assert.ok(!PASS_THROUGH_ALT.includes("j"));
});
