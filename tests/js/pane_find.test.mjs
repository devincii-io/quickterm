// Find in the terminal, Reset terminal and Copy terminal text: the parts that
// do not need a browser.
import test from "node:test";
import assert from "node:assert/strict";

import { Pane } from "../../quickterm/frontend/js/pane.js";
import {
  COPY_LIMIT_BYTES, findCountText, findDecorations, hexColour, terminalText,
} from "../../quickterm/frontend/js/pane_find.js";

// xterm's IBuffer, for rows given as [text, wrapped].
function buffer(rows) {
  const lines = rows.map(([text, isWrapped = false]) => ({
    isWrapped,
    length: text.length,
    translateToString: (trim) => (trim ? text.replace(/\s+$/, "") : text),
  }));
  return { length: lines.length, getLine: (y) => lines[y] };
}

test("the count reads current/total, and says when nothing matched", () => {
  assert.equal(findCountText({ resultIndex: 2, resultCount: 17 }, "err"), "3/17");
  assert.equal(findCountText({ resultIndex: -1, resultCount: 0 }, "err"), "0/0");
  assert.equal(findCountText({ resultIndex: -1, resultCount: 1000 }, "e"), "1000+");
  assert.equal(findCountText({ resultIndex: 0, resultCount: 3 }, ""), "", "nothing typed, nothing shown");
});

test("match colours come from the pane's theme as #RRGGBB", () => {
  assert.equal(hexColour("#abc"), "#aabbcc");
  assert.equal(hexColour("#11223344"), "#112233");
  assert.equal(hexColour("rgba(1,2,3,.5)"), null);
  const decorations = findDecorations({
    yellow: "#c8973f", cursor: "#d9a441", selectionBackground: "#463822", selectionInactiveBackground: "#30291c",
  });
  assert.deepEqual(decorations, {
    matchOverviewRuler: "#c8973f",
    activeMatchColorOverviewRuler: "#d9a441",
    matchBackground: "#30291c",
    activeMatchBackground: "#463822",
    activeMatchBorder: "#d9a441",
  });
  // A theme without usable colours still counts matches.
  assert.ok(findDecorations({}).matchOverviewRuler);
});

test("copy joins wrapped rows and drops trailing blank lines", () => {
  const text = terminalText(buffer([
    ["$ ls   "], ["a-very-long-line-th", false], ["at-wraps", true], ["   "], [""],
  ]));
  assert.deepEqual(text, { text: "$ ls\na-very-long-line-that-wraps", lines: 2, truncated: false });
  assert.deepEqual(terminalText(buffer([[""], ["  "]])), { text: "", lines: 0, truncated: false });
});

test("copy keeps the newest lines when the buffer is over the cap", () => {
  const rows = Array.from({ length: 10 }, (_, index) => [`line ${index}`]);
  // Seven bytes a line with its newline: 20 holds two, not three.
  const capped = terminalText(buffer(rows), 20);
  assert.deepEqual(capped, { text: "line 8\nline 9", lines: 2, truncated: true });
  assert.equal(COPY_LIMIT_BYTES, 2 * 1024 * 1024);
});

function paneWithTerm(term) {
  const pane = Object.create(Pane.prototype);
  const notices = [];
  Object.assign(pane, { term, flashNotice: (text) => notices.push(text), agentGone: false, state: "attached" });
  return { pane, notices };
}

test("reset clears the screen and the input modes locally and sends nothing", () => {
  const calls = [];
  const { pane, notices } = paneWithTerm({
    reset: () => calls.push("reset"),
    write: (data) => calls.push(data),
  });
  pane.ws = { send: () => calls.push("sent") };
  assert.equal(pane.resetTerminal(), true);
  assert.equal(calls[0], "reset");
  assert.match(calls[1], /\x1b\[\?1000l/, "mouse reporting off");
  assert.match(calls[1], /\x1b\[\?2004l/, "bracketed paste off");
  assert.ok(!calls.includes("sent"));
  assert.deepEqual(notices, ["[terminal reset]"]);
});

test("Ctrl+Shift+F opens find; Ctrl+F stays the shell's", () => {
  const { pane } = paneWithTerm({ getSelection: () => "" });
  let opened = 0;
  pane.openFind = () => { opened += 1; return true; };
  const event = (overrides) => ({
    type: "keydown", key: "F", code: "KeyF", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false,
    prevented: false, preventDefault() { this.prevented = true; }, ...overrides,
  });
  const find = event();
  assert.equal(pane._handleKey(find), false);
  assert.equal(find.prevented, true);
  assert.equal(pane._handleKey(event({ key: "f", shiftKey: false })), true, "readline forward-char");
  assert.equal(pane._handleKey(event({ type: "keyup" })), true);
  assert.equal(opened, 1);
});
