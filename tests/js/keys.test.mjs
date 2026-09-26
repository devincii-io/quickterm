// The global keyboard layer runs in the window capture phase, so anything it
// claims never reaches xterm's textarea. These tests pin the boundary: the
// zoom gestures are claimed, and the keys that shells and TUIs bind are not.
import test from "node:test";
import assert from "node:assert/strict";

async function captureHandler({ paletteOpen = false } = {}) {
  let handler = null;
  globalThis.window = {
    addEventListener(type, fn, capture) {
      if (type === "keydown" && capture) handler = fn;
    },
  };
  const { initKeys } = await import("../../quickterm/frontend/js/keys.js");
  const calls = [];
  initKeys({
    togglePalette: () => calls.push("togglePalette"),
    paletteOpen: () => paletteOpen,
    toggleDashboard: () => calls.push("toggleDashboard"),
    toggleSettings: () => calls.push("toggleSettings"),
    toggleHelp: () => calls.push("toggleHelp"),
    splitH: () => calls.push("splitH"),
    splitV: () => calls.push("splitV"),
    newTerminal: () => calls.push("newTerminal"),
    cycleTerminal: (delta) => calls.push(`cycleTerminal:${delta}`),
    zoom: () => calls.push("zoom"),
    closePane: () => calls.push("closePane"),
    killSession: () => calls.push("killSession"),
    focusDir: (dir) => calls.push(`focusDir:${dir}`),
    fontBigger: () => calls.push("fontBigger"),
    fontSmaller: () => calls.push("fontSmaller"),
    fontReset: () => calls.push("fontReset"),
    toggleSidebar: () => calls.push("toggleSidebar"),
    openExplorer: () => calls.push("openExplorer"),
    openEditor: () => calls.push("openEditor"),
  });
  return { handler, calls };
}

function keyEvent(init) {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    ...init,
  };
}

test("Ctrl+] and Ctrl+/ reach the shell instead of zooming the font", async () => {
  const { handler, calls } = await captureHandler();

  // US/UK layout: these are the vim tag jump and the readline/PSReadLine undo.
  // They used to be matched by their physical codes, which are only the
  // QWERTZ positions of -/+ (already covered by the e.key tests below).
  const bracket = keyEvent({ key: "]", code: "BracketRight", ctrlKey: true });
  handler(bracket);
  assert.equal(bracket.defaultPrevented, false);

  const slash = keyEvent({ key: "/", code: "Slash", ctrlKey: true });
  handler(slash);
  assert.equal(slash.defaultPrevented, false);

  assert.deepEqual(calls, []);
});

test("Ctrl+plus/minus/zero still zoom, on ANSI and QWERTZ alike", async () => {
  const { handler, calls } = await captureHandler();

  const bigger = keyEvent({ key: "+", code: "BracketRight", ctrlKey: true });
  handler(bigger);
  assert.equal(bigger.defaultPrevented, true);

  const smaller = keyEvent({ key: "-", code: "Slash", ctrlKey: true });
  handler(smaller);
  assert.equal(smaller.defaultPrevented, true);

  const reset = keyEvent({ key: "0", code: "Digit0", ctrlKey: true });
  handler(reset);
  assert.equal(reset.defaultPrevented, true);

  assert.deepEqual(calls, ["fontBigger", "fontSmaller", "fontReset"]);
});

test("the Alt layer claims only its documented combinations", async () => {
  const { handler, calls } = await captureHandler();

  handler(keyEvent({ key: "d", altKey: true }));
  handler(keyEvent({ key: "w", altKey: true }));

  // Claude Code image paste, model switch, PSReadLine help and readline digit
  // arguments must all pass through untouched.
  for (const key of ["v", "p", "h", "0", "9", "-"]) {
    const event = keyEvent({ key, altKey: true });
    handler(event);
    assert.equal(event.defaultPrevented, false, `Alt+${key} must reach the shell`);
  }

  assert.deepEqual(calls, ["closePane", "killSession"]);
});

test("the panel keys open their panel and stay cold for the shell", async () => {
  const { handler, calls } = await captureHandler();

  for (const key of ["g", "s", "i"]) {
    const event = keyEvent({ key, altKey: true });
    handler(event);
    assert.equal(event.defaultPrevented, true, `Alt+${key} opens its panel`);
  }
  assert.deepEqual(calls, ["toggleDashboard", "toggleSettings", "toggleHelp"]);

  // Claude Code binds Alt+M/T/O and readline binds Alt+B/F: a panel key must
  // never be chosen from that set.
  for (const key of ["m", "t", "o", "b", "f"]) {
    const event = keyEvent({ key, altKey: true });
    handler(event);
    assert.equal(event.defaultPrevented, false, `Alt+${key} must reach the shell`);
  }
});

test("a panel key still closes its own panel", async () => {
  // Everything else yields the keyboard once a panel owns it. A toggle that
  // could only open would strand the user on the mouse to undo one keystroke.
  const { handler, calls } = await captureHandler({ paletteOpen: true });

  handler(keyEvent({ key: "s", altKey: true }));
  handler(keyEvent({ key: "n", altKey: true })); // new terminal must stay blocked

  assert.deepEqual(calls, ["toggleSettings"]);
});

test("Alt+Shift+S cycles the sidebar; plain Alt+S is still Settings and Alt+B is the shell's", async () => {
  const { handler, calls } = await captureHandler();
  const cycle = keyEvent({ key: "S", altKey: true, shiftKey: true });
  handler(cycle);
  assert.equal(cycle.defaultPrevented, true);
  const settings = keyEvent({ key: "s", altKey: true });
  handler(settings);
  // readline backward-word: never ours.
  const back = keyEvent({ key: "b", altKey: true });
  handler(back);
  assert.equal(back.defaultPrevented, false);
  assert.deepEqual(calls, ["toggleSidebar", "toggleSettings"]);
});

test("Alt+Shift+E and Alt+Shift+C open the folder; plain Alt+E and Alt+C stay with the shell", async () => {
  const { handler, calls } = await captureHandler();

  const explorer = keyEvent({ key: "E", altKey: true, shiftKey: true });
  handler(explorer);
  assert.equal(explorer.defaultPrevented, true);
  const editor = keyEvent({ key: "C", altKey: true, shiftKey: true });
  handler(editor);
  assert.equal(editor.defaultPrevented, true);

  // Alt+C is readline's capitalize-word; Alt+E is left alone as well.
  for (const key of ["c", "e"]) {
    const event = keyEvent({ key, altKey: true });
    handler(event);
    assert.equal(event.defaultPrevented, false, `Alt+${key} must reach the shell`);
  }
  assert.deepEqual(calls, ["openExplorer", "openEditor"]);
});

test("Ctrl+_ is readline's undo, not a zoom, on the Minus key it shares with -", async () => {
  const { handler, calls } = await captureHandler();

  // US layout: Ctrl+Shift+- reports "_" on the Minus key. The physical code
  // used to be enough to claim it.
  const undo = keyEvent({ key: "_", code: "Minus", ctrlKey: true, shiftKey: true });
  handler(undo);
  assert.equal(undo.defaultPrevented, false);

  // QWERTZ: the same character sits on the Slash position.
  const qwertz = keyEvent({ key: "_", code: "Slash", ctrlKey: true, shiftKey: true });
  handler(qwertz);
  assert.equal(qwertz.defaultPrevented, false);

  assert.deepEqual(calls, []);
});

test("Ctrl+* is not a zoom key, from the digit row or the numpad", async () => {
  const { handler, calls } = await captureHandler();

  for (const code of ["Digit8", "NumpadMultiply", "BracketRight"]) {
    const event = keyEvent({ key: "*", code, ctrlKey: true, shiftKey: code !== "NumpadMultiply" });
    handler(event);
    assert.equal(event.defaultPrevented, false, `Ctrl+* on ${code} must reach the shell`);
  }
  assert.deepEqual(calls, []);
});

test("a physical code zooms only when the layout named no character", async () => {
  const { handler, calls } = await captureHandler();

  // Characters that are not +, - or 0 on those positions stay with the shell:
  // ")" is Ctrl+Shift+0 on US, "=" is Ctrl+Shift+0 on QWERTZ, "ß" is the
  // QWERTZ Minus position and Insert is Numpad0 with NumLock off (copy).
  const passing = [[")", "Digit0"], ["=", "Digit0"], ["ß", "Minus"], ["Insert", "Numpad0"], ["Dead", "Equal"]];
  for (const [key, code] of passing) {
    const event = keyEvent({ key, code, ctrlKey: true });
    handler(event);
    assert.equal(event.defaultPrevented, false, `Ctrl+${key} on ${code} must reach the shell`);
  }
  assert.deepEqual(calls, []);

  // A layout that reports nothing still gets the US positions.
  for (const code of ["Equal", "Minus", "Digit0"]) {
    const event = keyEvent({ key: "Unidentified", code, ctrlKey: true });
    handler(event);
    assert.equal(event.defaultPrevented, true, `unnamed ${code} still zooms`);
  }
  assert.deepEqual(calls, ["fontBigger", "fontSmaller", "fontReset"]);
});

test("the numpad and the US = key still zoom", async () => {
  const { handler, calls } = await captureHandler();

  for (const [key, code] of [["+", "NumpadAdd"], ["-", "NumpadSubtract"], ["0", "Numpad0"], ["=", "Equal"]]) {
    const event = keyEvent({ key, code, ctrlKey: true });
    handler(event);
    assert.equal(event.defaultPrevented, true, `Ctrl+${key} on ${code} zooms`);
  }
  assert.deepEqual(calls, ["fontBigger", "fontSmaller", "fontReset", "fontBigger"]);
});

test("Ctrl+0 resets on AZERTY, where the 0 key types a grave-accented a unshifted", async () => {
  const { handler, calls } = await captureHandler();
  const reset = keyEvent({ key: "à", code: "Digit0", ctrlKey: true });
  handler(reset);
  assert.equal(reset.defaultPrevented, true);
  // The same letter on another key is not a zoom gesture.
  const other = keyEvent({ key: "à", code: "Quote", ctrlKey: true });
  handler(other);
  assert.equal(other.defaultPrevented, false);
  assert.deepEqual(calls, ["fontReset"]);
});
