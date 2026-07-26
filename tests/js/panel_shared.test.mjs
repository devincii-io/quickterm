import test from "node:test";
import assert from "node:assert/strict";

import {
  countPanes, displaySnippet, environmentError, formatBytes, inferTerminalType,
  layoutSessionIds, parseEnvLines, runnableSnippet,
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
  assert.equal(displaySnippet("echo ready\r"), "echo ready");
  assert.equal(runnableSnippet("echo ready"), "echo ready\r");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
});
