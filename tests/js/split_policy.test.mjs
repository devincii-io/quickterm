import test from "node:test";
import assert from "node:assert/strict";

import {
  normalAgentSplitMode, normalClaudeSplitMode, splitDirectory,
} from "../../quickterm/frontend/js/split_policy.js";

test("ordinary splits inherit compatible signalled directories", () => {
  const powershell = { kind: "profile", profile: { terminal_type: "windows-powershell", cwd: "C:\\home" } };
  assert.equal(splitDirectory("C:\\work\\repo", "windows-powershell", powershell, true), "C:\\work\\repo");
  assert.equal(splitDirectory("/home/dev", "wsl", powershell, true), null);

  const wsl = { kind: "system", id: "wsl" };
  assert.equal(splitDirectory("C:\\work\\repo", "windows-powershell", wsl, true), "C:\\work\\repo");
  assert.equal(splitDirectory("/home/dev", "wsl", wsl, true), "/home/dev");
});

test("Claude splits keep project identity and agent view is explicit", () => {
  const profile = { terminal_type: "claude-code", cwd: "C:\\projects\\app", claude_mode: "agents" };
  const choice = { kind: "profile", profile };
  assert.equal(splitDirectory("C:\\unrelated", "windows-powershell", choice, true), null);
  assert.equal(splitDirectory(null, null, choice, true), null);
  assert.equal(normalClaudeSplitMode(profile), "continue");
  assert.equal(normalClaudeSplitMode({ ...profile, claude_mode: "resume" }), undefined);
});

test("Codex splits use the workspace root like Claude", () => {
  const codex = { kind: "profile", profile: { terminal_type: "codex", agent_mode: "new" } };
  assert.equal(splitDirectory("C:\\unrelated", "windows-powershell", codex, true), null);
  assert.equal(splitDirectory("C:\\unrelated", "windows-powershell", { kind: "system", id: "codex" }, true), null);
});

test("an agent-manager profile of either type splits into a normal conversation", () => {
  assert.equal(normalClaudeSplitMode, normalAgentSplitMode);
  assert.equal(normalAgentSplitMode({ terminal_type: "codex", agent_mode: "agents" }), "continue");
  assert.equal(normalAgentSplitMode({ terminal_type: "claude-code", agent_mode: "agents" }), "continue");
  // agent_mode wins over the legacy key, which is only read when it is absent.
  assert.equal(normalAgentSplitMode({ terminal_type: "claude-code", agent_mode: "new", claude_mode: "agents" }), undefined);
  assert.equal(normalAgentSplitMode({ terminal_type: "codex", agent_mode: "fork" }), undefined);
  // The defaults (Claude continue, Codex new) are not the agent manager.
  assert.equal(normalAgentSplitMode({ terminal_type: "codex" }), undefined);
  assert.equal(normalAgentSplitMode({ terminal_type: "claude-code" }), undefined);
  assert.equal(normalAgentSplitMode({ terminal_type: "bash", agent_mode: "agents" }), undefined);
  assert.equal(normalAgentSplitMode(null), undefined);
});
