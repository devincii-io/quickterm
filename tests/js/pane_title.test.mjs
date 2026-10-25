// A pane's title follows the agent's own conversation title (the backend
// renames the session), and a title someone typed wins (CONTRACTS 4.3, round 2).
import test from "node:test";
import assert from "node:assert/strict";

import { Pane } from "../../quickterm/frontend/js/pane.js";

const pane = (fields) => {
  const renders = [];
  return Object.assign(Object.create(Pane.prototype), {
    title: null, session: { id: "s1", name: "Claude Code" }, profileName: "claude-code", launchSpec: null,
    _renderTab() { renders.push(this.displayName()); }, renders,
  }, fields);
};

test("the session list's name replaces the one the pane attached with", () => {
  const p = pane();
  assert.equal(p.displayName(), "Claude Code");
  p.noteName("Fix the login form");
  assert.equal(p.displayName(), "Fix the login form");
  p.noteName("Fix the login form");
  assert.deepEqual(p.renders, ["Fix the login form"]);
  // The agent left and the backend named it back.
  p.noteName("Claude Code");
  assert.equal(p.displayName(), "Claude Code");
});

test("a title someone typed wins over the conversation's", () => {
  const p = pane({ title: "api work" });
  p.noteName("Fix the login form");
  assert.equal(p.displayName(), "api work");
});

test("an empty name falls back to what the pane knew", () => {
  const p = pane();
  p.noteName("  ");
  assert.equal(p.displayName(), "Claude Code");
});
