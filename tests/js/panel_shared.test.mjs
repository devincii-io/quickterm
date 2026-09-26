import test from "node:test";
import assert from "node:assert/strict";

import {
  countPanes, displaySnippet, environmentError, formatBytes, inferTerminalType,
  layoutSessionIds, nativeFolderPickerAvailable, parseEnvLines, pickNativeFolder,
  runnableSnippet, sessionAlreadyGone,
} from "../../quickterm/frontend/js/panel_shared.js";

test("a forgotten session is told apart from a kill that failed", () => {
  // 404: the backend no longer knows this session, so the pane must close.
  assert.equal(sessionAlreadyGone({ status: 404, detail: "no such session" }), true);
  // 500: the process may still be running, so the pane must stay visible.
  assert.equal(sessionAlreadyGone({ status: 500, detail: "terminal process could not be stopped" }), false);
  assert.equal(sessionAlreadyGone({ status: 409 }), false);
  assert.equal(sessionAlreadyGone(new Error("network down")), false);
  assert.equal(sessionAlreadyGone(undefined), false);
});

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

test("the terminal type is inferred for every shell the launcher knows", () => {
  const cases = [
    ["pwsh", "powershell-core"], ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "powershell-core"],
    ["powershell.exe", "windows-powershell"], ["cmd", "command-prompt"], ["wsl.exe", "wsl"],
    ["plink.exe", "ssh"], ["psftp", "sftp"],
    ["bash", "bash"], ["/usr/bin/zsh", "zsh"], ["/opt/homebrew/bin/fish", "fish"],
    ["C:\\Program Files\\Git\\bin\\bash.exe", "git-bash"], ["C:\\Program Files\\Git\\usr\\bin\\bash.exe", "git-bash"],
    ["C:\\Windows\\System32\\bash.exe", "bash"],
    ["nu", "nushell"], ["C:\\Users\\me\\.cargo\\bin\\nu.exe", "nushell"],
    ["python.exe", "custom"], ["claude", "custom"], ["", "custom"], ["nushell", "custom"],
  ];
  for (const [cmd, type] of cases) assert.equal(inferTerminalType({ cmd }), type, cmd);
  // launch.py builds its own arguments for these and drops the profile's, so
  // a command that carries arguments is not inferred as one of them.
  assert.equal(inferTerminalType({ cmd: "bash", args: ["-c", "make"] }), "custom");
  assert.equal(inferTerminalType({ cmd: "wsl.exe", args: ["-d", "Ubuntu"] }), "custom");
  assert.equal(inferTerminalType({ cmd: "nu", args: ["--no-config"] }), "nushell");
  assert.equal(inferTerminalType({ cmd: "pwsh", args: ["-NoLogo"] }), "powershell-core");
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
