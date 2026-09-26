import test from "node:test";
import assert from "node:assert/strict";

import {
  RealInputGate, broadcastNotice, broadcastTargets, unbracketedPaste, withoutTerminalReplies,
} from "../../quickterm/frontend/js/broadcast.js";
import { createPaneCommands } from "../../quickterm/frontend/js/pane_commands.js";

// A hand-cranked macrotask queue: each tick() runs what was deferred before it.
function manualTimers() {
  let queue = [];
  return {
    defer: (fn) => queue.push(fn),
    tick() {
      const due = queue;
      queue = [];
      for (const fn of due) fn();
    },
  };
}

test("the gate is open for the task of a key or paste and closed after it", () => {
  const timers = manualTimers();
  const gate = new RealInputGate(timers.defer);
  assert.equal(gate.open, false);
  gate.arm();
  assert.equal(gate.open, true);
  timers.tick();
  // An automatic reply parsed from later output lands in a later task.
  assert.equal(gate.open, false);
});

test("a composition keeps the gate open until xterm's own zero timeout has run", () => {
  const timers = manualTimers();
  const gate = new RealInputGate(timers.defer);
  gate.arm(2);
  timers.tick();
  assert.equal(gate.open, true, "xterm sends composed text on its own setTimeout(0)");
  timers.tick();
  assert.equal(gate.open, false);
});

test("a later key never closes a composition's longer window early", () => {
  const timers = manualTimers();
  const gate = new RealInputGate(timers.defer);
  gate.arm(2);
  gate.arm(1);
  timers.tick();
  assert.equal(gate.open, true);
  timers.tick();
  assert.equal(gate.open, false);
});

function fakePane(name, live = true) {
  return { name, sent: [], acceptsInput: () => live, sendText(text) { this.sent.push(text); return live; } };
}

test("broadcast reaches every other live pane and skips the rest", () => {
  const source = fakePane("a");
  const other = fakePane("b");
  const replaying = fakePane("c", false);
  assert.deepEqual(broadcastTargets([source, other, replaying], source), [other]);
});

test("the notice says how many other panes receive the typing", () => {
  assert.equal(broadcastNotice(false, 3), "[broadcast off]");
  assert.equal(broadcastNotice(true, 0), "[broadcast on · no other live pane yet]");
  assert.equal(broadcastNotice(true, 1), "[broadcast on · typing here also reaches 1 other pane]");
  assert.equal(broadcastNotice(true, 3), "[broadcast on · typing here also reaches 3 other panes]");
});

test("the palette toggle flips the layout's switch and says so in the focused pane", () => {
  const notices = [];
  const focused = { ...fakePane("a"), flashNotice: (text) => notices.push(text) };
  const panes = [focused, fakePane("b"), fakePane("c"), fakePane("d", false)];
  const layout = {
    focused,
    broadcasting: false,
    panes: () => panes,
    setBroadcast(on) { this.broadcasting = on; return on; },
  };
  const commands = createPaneCommands({ layout, state: {} });
  assert.equal(commands.isBroadcasting(), false);
  assert.equal(commands.toggleBroadcast(), true);
  assert.equal(commands.isBroadcasting(), true);
  assert.deepEqual(notices, ["[broadcast on · typing here also reaches 2 other panes]"]);
  assert.equal(commands.toggleBroadcast(), false);
  assert.equal(notices.at(-1), "[broadcast off]");
});


test("xterm's automatic replies never reach another pane", () => {
  const replies = [
    "\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b[12;40R", "\x1b[0n", "\x1b[I", "\x1b[O",
    "\x1b[?2004;1$y", "\x1b[8;24;80t", "\x1b]11;rgb:1e1e/1e1e/1e1e\x07",
    "\x1b]10;rgb:ffff/ffff/ffff\x1b\\", "\x1bP1$r0m\x1b\\",
  ];
  for (const reply of replies) assert.equal(withoutTerminalReplies(reply), "", JSON.stringify(reply));
  // Typing, arrows, function keys and Enter pass untouched.
  for (const key of ["ls -la\r", "\x1b[A", "\x1bOB", "\x1b[15~", "\x7f", "\x03"]) {
    assert.equal(withoutTerminalReplies(key), key, JSON.stringify(key));
  }
  assert.equal(withoutTerminalReplies("a\x1b[?1;2cb"), "ab");
});

test("a paste is handed over bare so each shell frames it itself", () => {
  assert.equal(unbracketedPaste("\x1b[200~line one\nline two\x1b[201~"), "line one\nline two");
  assert.equal(unbracketedPaste("plain typing"), null);
});
