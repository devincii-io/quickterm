// The rules the Settings screens state about a configured thing: what it
// actually runs, and what is wrong with it. These are pure functions on the
// draft config, so they are testable without a DOM, and they are the part that
// must not quietly disagree with the backend validation.

import test from "node:test";
import assert from "node:assert/strict";

import { commandPreview, snippetProblems } from "../../quickterm/frontend/js/panel_settings_snippets.js";
import { matchesQuery } from "../../quickterm/frontend/js/panel_settings_kit.js";
import { agentConflicts, agentModeOf } from "../../quickterm/frontend/js/agent_profile.js";

test("a snippet preview hides the carriage return that runs it", () => {
  assert.equal(commandPreview("git status\r"), "git status");
  assert.equal(commandPreview(""), "no command yet");
  assert.equal(commandPreview("one\ntwo\nthree\r"), "one … (+2 more)");
});

test("a snippet reports its own missing name, command and duplicate", () => {
  const named = { name: "build", text: "npm run build\r" };
  const twin = { name: "BUILD", text: "make\r" };
  assert.deepEqual(snippetProblems(named, [named]), []);
  assert.match(snippetProblems(named, [named, twin])[0], /Names must be unique/);
  assert.match(snippetProblems({ name: "", text: "x\r" }, [])[0], /no name/);
  assert.match(snippetProblems({ name: "x", text: "\r" }, [])[0], /no command/);
});

test("the agent mode reads agent_mode, then the legacy claude_mode, then the type's default", () => {
  assert.equal(agentModeOf({ agent_mode: "fork" }, "codex"), "fork");
  assert.equal(agentModeOf({ claude_mode: "resume" }, "claude-code"), "resume");
  assert.equal(agentModeOf({}, "claude-code"), "continue");
  assert.equal(agentModeOf({}, "codex"), "new");
});

test("codex bypass cannot be combined with approval or sandbox", () => {
  assert.deepEqual(agentConflicts("codex", { bypass: "true" }), []);
  assert.deepEqual(agentConflicts("codex", { bypass: "true", sandbox: "read-only" }), ["bypass replaces approval and sandbox; clear them first"]);
  assert.equal(agentConflicts("codex", { bypass: "true", approve_for_me: "true" }).length, 1);
  assert.deepEqual(agentConflicts("claude-code", { bypass: "true", sandbox: "x" }), []);
});

test("filtering searches every field", () => {
  assert.ok(matchesQuery("", "anything"));
  assert.ok(matchesQuery("LOG", "tail logs", "Follow the app log"));
  assert.ok(matchesQuery("follow", "tail logs", "Follow the app log"));
  assert.ok(!matchesQuery("deploy", "tail logs", "Follow the app log"));
});
