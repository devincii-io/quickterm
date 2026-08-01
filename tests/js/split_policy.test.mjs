import test from "node:test";
import assert from "node:assert/strict";

import {
  normalClaudeSplitMode, splitDirectory,
} from "../../quickterm/frontend/js/split_policy.js";

test("ordinary splits inherit compatible signalled directories", () => {
  const powershell = { kind: "profile", profile: { terminal_type: "windows-powershell", cwd: "C:\\home" } };
  assert.equal(splitDirectory("C:\\work\\repo", "windows-powershell", powershell, true), "C:\\work\\repo");
  assert.equal(splitDirectory("/home/dev", "wsl", powershell, true), "C:\\home");

  const wsl = { kind: "system", id: "wsl" };
  assert.equal(splitDirectory("C:\\work\\repo", "windows-powershell", wsl, true), "C:\\work\\repo");
  assert.equal(splitDirectory("/home/dev", "wsl", wsl, true), "/home/dev");
});

test("Claude splits keep project identity and agent view is explicit", () => {
  const profile = { terminal_type: "claude-code", cwd: "C:\\projects\\app", claude_mode: "agents" };
  const choice = { kind: "profile", profile };
  assert.equal(splitDirectory("C:\\unrelated", "windows-powershell", choice, true), profile.cwd);
  assert.equal(normalClaudeSplitMode(profile), "continue");
  assert.equal(normalClaudeSplitMode({ ...profile, claude_mode: "resume" }), undefined);
});
