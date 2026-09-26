import test from "node:test";
import assert from "node:assert/strict";

import { codeUnitOffset, findInBuffer, logicalLines } from "../../quickterm/frontend/js/buffer_search.js";

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠￠-￦\u{1F300}-\u{1FAFF}]/u;

// Enough of xterm's IBuffer: rows of cells, a wide character followed by a
// width-0 continuation cell, `isWrapped` on a row that continues the one above.
function fakeBuffer(cols, text) {
  const rows = [];
  for (const logical of text.split("\n")) {
    let cells = [];
    let wrapped = false;
    const flush = () => {
      while (cells.length < cols) cells.push({ chars: "", width: 1 });
      rows.push({ cells, isWrapped: wrapped });
      cells = [];
      wrapped = true;
    };
    for (const ch of logical) {
      const width = WIDE.test(ch) ? 2 : 1;
      if (cells.length + width > cols) flush();
      cells.push({ chars: ch, width });
      if (width === 2) cells.push({ chars: "", width: 0 });
    }
    flush();
  }
  const line = (row) => ({
    isWrapped: row.isWrapped,
    length: cols,
    getCell: (x) => ({ getChars: () => row.cells[x].chars, getWidth: () => row.cells[x].width }),
    translateToString(trimRight) {
      const out = row.cells.filter((c) => c.width !== 0).map((c) => c.chars || " ").join("");
      return trimRight ? out.replace(/\s+$/, "") : out;
    },
  });
  return { length: rows.length, getLine: (y) => (rows[y] ? line(rows[y]) : undefined) };
}

test("offsets from Python count code points, not UTF-16 units", () => {
  assert.equal(codeUnitOffset("ab", 1), 1);
  assert.equal(codeUnitOffset("\u{1F600}x", 1), 2);
  assert.equal(codeUnitOffset("x", 5), 1);
});

test("wrapped rows join into the line the program wrote", () => {
  const buffer = fakeBuffer(10, "short\n0123456789abcdef\nend");
  assert.deepEqual(logicalLines(buffer).map((line) => line.text), ["short", "0123456789abcdef", "end"]);
  assert.deepEqual(logicalLines(buffer)[1].rows, [1, 2]);
});

test("a hit is selected where xterm drew it", () => {
  const buffer = fakeBuffer(20, "$ make\nError: missing file\n$ ");
  assert.deepEqual(findInBuffer(buffer, { text: "Error: missing file", start: 0, length: 5, line: 1 }),
    { row: 1, col: 0, cells: 5 });
  assert.deepEqual(findInBuffer(buffer, { text: "Error: missing file", start: 7, length: 7, line: 1 }),
    { row: 1, col: 7, cells: 7 });
});

test("a match across a wrap selects through the row boundary", () => {
  const buffer = fakeBuffer(10, "0123456789NEEDLE here");
  const found = findInBuffer(buffer, { text: "0123456789NEEDLE here", start: 8, length: 4, line: 0 });
  assert.deepEqual(found, { row: 0, col: 8, cells: 4 });
});

test("wide characters before the match shift its column, not its offset", () => {
  const buffer = fakeBuffer(20, "日本 error");
  const found = findInBuffer(buffer, { text: "日本 error", start: 3, length: 5, line: 0 });
  assert.deepEqual(found, { row: 0, col: 5, cells: 5 });
  const wide = findInBuffer(buffer, { text: "日本 error", start: 0, length: 2, line: 0 });
  assert.deepEqual(wide, { row: 0, col: 0, cells: 4 });
});

test("an emoji before the match does not shift the selection", () => {
  const buffer = fakeBuffer(20, "\u{1F600} done ok");
  const found = findInBuffer(buffer, { text: "\u{1F600} done ok", start: 2, length: 4, line: 0 });
  assert.deepEqual(found, { row: 0, col: 3, cells: 4 });
});

test("the backend line number picks between repeated lines", () => {
  const buffer = fakeBuffer(20, "$ make\nok\n$ make\nok\n$ make");
  const at = (line) => findInBuffer(buffer, { text: "$ make", start: 2, length: 4, line }).row;
  assert.equal(at(0), 0);
  assert.equal(at(2), 2);
  assert.equal(at(99), 4);
});

test("when the excerpt differs, the matched words alone are found", () => {
  const buffer = fakeBuffer(40, "progress 100% build FAILED here");
  const found = findInBuffer(buffer, { text: "progress  50% build FAILED here", start: 20, length: 6, line: 0 });
  assert.deepEqual(found, { row: 0, col: 20, cells: 6 });
});

test("text that is not in the buffer is reported as not found", () => {
  const buffer = fakeBuffer(20, "nothing here");
  assert.equal(findInBuffer(buffer, { text: "missing", start: 0, length: 7, line: 0 }), null);
  assert.equal(findInBuffer(buffer, { text: "", start: 0, length: 0, line: 0 }), null);
});
