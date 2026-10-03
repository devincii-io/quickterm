import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_MODES, AGENT_TYPES, ALL_AGENT_MODES, agentLabel, agentModeOf, agentTypeOf, continueCommand,
  isAgentMode, isAgentSessionId, isAgentType, modeLabel, pickerCommand,
} from "../../quickterm/frontend/js/agent_profile.js";

test("Claude Code and Codex are the agent types", () => {
  assert.deepEqual(AGENT_TYPES, ["claude-code", "codex"]);
  assert.equal(isAgentType("codex"), true);
  assert.equal(isAgentType("claude-code"), true);
  assert.equal(isAgentType("bash"), false);
  assert.equal(isAgentType(undefined), false);
  assert.equal(agentTypeOf({ terminal_type: "codex" }), "codex");
  assert.equal(agentTypeOf({ terminal_type: "custom", cmd: "codex" }), null);
  assert.equal(agentLabel("claude-code"), "Claude");
  assert.equal(agentLabel("codex"), "Codex");
});

test("each type has its own modes and only Codex forks", () => {
  assert.deepEqual(AGENT_MODES["claude-code"], ["new", "continue", "resume", "agents"]);
  assert.deepEqual(AGENT_MODES.codex, ["new", "continue", "resume", "fork", "agents"]);
  assert.deepEqual([...ALL_AGENT_MODES].sort(), ["agents", "continue", "fork", "new", "resume"]);
  assert.equal(isAgentMode("fork", "codex"), true);
  assert.equal(isAgentMode("fork", "claude-code"), false);
  assert.equal(isAgentMode("fork"), true);
  assert.equal(isAgentMode("default"), false);
});

test("a profile's mode reads agent_mode, then the legacy claude_mode, then the type default", () => {
  assert.equal(agentModeOf({ terminal_type: "claude-code" }), "continue");
  assert.equal(agentModeOf({ terminal_type: "codex" }), "new");
  assert.equal(agentModeOf({ terminal_type: "claude-code", claude_mode: "agents" }), "agents");
  assert.equal(agentModeOf({ terminal_type: "claude-code", agent_mode: "new", claude_mode: "agents" }), "new");
  assert.equal(agentModeOf({ terminal_type: "codex", agent_mode: null }), "new");
  assert.equal(agentModeOf({ terminal_type: "bash", agent_mode: "new" }), null);
});

test("modes and recovery commands have their UI words", () => {
  assert.equal(modeLabel("new"), "new conversation");
  assert.equal(modeLabel("continue"), "continue latest");
  assert.equal(modeLabel("resume"), "choose session");
  assert.equal(modeLabel("fork"), "fork a session");
  assert.equal(modeLabel("agents"), "agent manager");
  assert.equal(continueCommand("claude-code"), "claude --continue");
  assert.equal(continueCommand("codex"), "codex resume --last");
  assert.equal(pickerCommand("codex"), "codex resume");
  // A shell that was running claude recovers through claude.
  assert.equal(continueCommand("bash"), "claude --continue");
});

test("an agent session id is a UUID and nothing else", () => {
  assert.equal(isAgentSessionId("0199a6f2-1c2d-7e3f-8a9b-0c1d2e3f4a5b"), true);
  assert.equal(isAgentSessionId("0199A6F2-1C2D-7E3F-8A9B-0C1D2E3F4A5B"), true);
  assert.equal(isAgentSessionId("--resume"), false);
  assert.equal(isAgentSessionId("0199a6f2-1c2d-7e3f-8a9b-0c1d2e3f4a5b; rm"), false);
  assert.equal(isAgentSessionId("------------------------------------"), false);
  assert.equal(isAgentSessionId(undefined), false);
  assert.equal(isAgentSessionId(42), false);
});
