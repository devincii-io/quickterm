import test from "node:test";
import assert from "node:assert/strict";

import {
  countPanes, displaySnippet, environmentError, formatBytes, inferTerminalType,
  layoutSessionIds, nativeFolderPickerAvailable, parseEnvLines, pickNativeFolder,
  runnableSnippet,
} from "../../quickterm/frontend/js/panel_shared.js";

test("layout helpers count panes and collect bound sessions", () => {
  const layout = {
    type: "split",
    children: [
      { type: "pane", session_id: "one" },
      { type: "split", children: [
        { type: "pane", session_id: "two" },
        { type: "pane" },
      ] },
    ],
  };
  assert.equal(countPanes(layout), 3);
  assert.deepEqual([...layoutSessionIds(layout)], ["one", "two"]);
});

test("environment editor parses comments and rejects unsafe values", () => {
  assert.deepEqual(parseEnvLines("# note\nA=one\nB=two=three\n"), {
    A: "one", B: "two=three",
  });
  assert.equal(environmentError({ Path: "a", PATH: "b" }).includes("unique"), true);
  assert.equal(environmentError({ GOOD: "value" }), "");
});

test("terminal and snippet helpers preserve their UI contracts", () => {
  assert.equal(inferTerminalType({ cmd: "C:\\Windows\\System32\\wsl.exe" }), "wsl");
  assert.equal(inferTerminalType({ cmd: "C:\\Users\\me\\bin\\claude.exe" }), "custom");
  assert.equal(inferTerminalType({ cmd: "claude.exe", terminal_type: "claude-code" }), "claude-code");
  assert.equal(displaySnippet("echo ready\r"), "echo ready");
  assert.equal(runnableSnippet("echo ready"), "echo ready\r");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
});

test("native folder picker distinguishes selection, cancel, and browser fallback", async () => {
  const previous = globalThis.pywebview;
  try {
    delete globalThis.pywebview;
    assert.equal(nativeFolderPickerAvailable(), false);
    assert.deepEqual(await pickNativeFolder("C:\\old"), {
      available: false, path: null, failed: false,
    });

    let initial = null;
    globalThis.pywebview = { api: { pick_folder: async (value) => {
      initial = value;
      return "C:\\projects\\quickterm";
    } } };
    assert.equal(nativeFolderPickerAvailable(), true);
    assert.deepEqual(await pickNativeFolder("C:\\old"), {
      available: true, path: "C:\\projects\\quickterm", failed: false,
    });
    assert.equal(initial, "C:\\old");

    globalThis.pywebview.api.pick_folder = async () => null;
    assert.deepEqual(await pickNativeFolder(""), {
      available: true, path: null, failed: false,
    });
    globalThis.pywebview.api.pick_folder = async () => { throw new Error("dialog failed"); };
    assert.deepEqual(await pickNativeFolder(""), {
      available: true, path: null, failed: true,
    });
  } finally {
    if (previous === undefined) delete globalThis.pywebview;
    else globalThis.pywebview = previous;
  }
});
