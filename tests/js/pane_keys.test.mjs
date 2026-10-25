// Shift+Enter in Claude Code and Codex is a newline in the prompt. xterm.js
// 6.0 sends a bare CR for it, which submits. An agent pane sends ESC CR (the
// bytes of Alt+Enter) instead; a shell pane keeps xterm's own behaviour.
import test from "node:test";
import assert from "node:assert/strict";

import { Pane } from "../../quickterm/frontend/js/pane.js";
import { PaneAttachProtocol } from "../../quickterm/frontend/js/pane_protocol.js";
import { AGENT_NEWLINE, agentNewlineFor } from "../../quickterm/frontend/js/agent_profile.js";
import { RealInputGate } from "../../quickterm/frontend/js/broadcast.js";

const OPEN = globalThis.WebSocket?.OPEN ?? 1;
globalThis.WebSocket ??= { OPEN };

function key(type, overrides = {}) {
  return {
    type, key: "Enter", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, isComposing: false,
    prevented: false,
    preventDefault() { this.prevented = true; },
    ...overrides,
  };
}

function livePane(terminalType) {
  const protocol = new PaneAttachProtocol(1024);
  protocol.beginReplay();
  protocol.replayComplete();
  protocol.goLive();
  const pane = Object.create(Pane.prototype);
  const frames = [];
  const typed = [];
  Object.assign(pane, {
    terminalType,
    state: "attached",
    _protocol: protocol,
    _exited: false,
    _inputGate: new RealInputGate(() => {}),
    userWrote: false,
    onStateChange() {},
    ws: { readyState: OPEN, send(data) { frames.push(typeof data === "string" ? JSON.parse(data) : "bytes"); } },
    term: { input(data, wasUser) { typed.push([data, wasUser]); }, getSelection: () => "" },
  });
  return { pane, frames, typed };
}

test("only a plain Shift+Enter in an agent pane becomes the newline sequence", () => {
  assert.equal(AGENT_NEWLINE, "\x1b\r");
  assert.equal(agentNewlineFor(key("keydown"), "claude-code"), AGENT_NEWLINE);
  assert.equal(agentNewlineFor(key("keydown"), "codex"), AGENT_NEWLINE);
  assert.equal(agentNewlineFor(key("keydown"), "pwsh"), null, "a shell keeps Shift+Enter as Enter");
  assert.equal(agentNewlineFor(key("keydown"), null), null);
  assert.equal(agentNewlineFor(key("keydown", { shiftKey: false }), "codex"), null);
  assert.equal(agentNewlineFor(key("keydown", { ctrlKey: true }), "codex"), null);
  assert.equal(agentNewlineFor(key("keydown", { altKey: true }), "codex"), null);
  assert.equal(agentNewlineFor(key("keydown", { isComposing: true }), "codex"), null, "an IME owns the key");
  assert.equal(agentNewlineFor(key("keydown", { key: "a" }), "codex"), null);
});

test("Shift+Enter in an agent pane is typed once, as real input, and xterm sends nothing of its own", () => {
  const { pane, frames, typed } = livePane("claude-code");
  const down = key("keydown");
  assert.equal(pane._handleKey(down), false);
  assert.equal(down.prevented, true);
  assert.equal(pane._handleKey(key("keypress")), false, "the keypress cannot add xterm's CR");
  assert.equal(pane._handleKey(key("keyup")), false);
  assert.deepEqual(typed, [[AGENT_NEWLINE, true]], "through xterm's onData, flagged as the user's");
  assert.deepEqual(frames, [{ type: "touch" }], "the touch frame leaves first, as for any keystroke");
  assert.equal(pane.userWrote, true);
  assert.equal(pane._inputGate.open, true, "a broadcast mirrors it like any other key");
});

test("Shift+Enter in a shell pane is left to xterm", () => {
  const { pane, frames, typed } = livePane("bash");
  assert.equal(pane._handleKey(key("keydown")), true);
  assert.deepEqual(typed, []);
  assert.deepEqual(frames, []);
});

test("once the agent has left its shell, Shift+Enter is the shell's again", () => {
  const { pane, typed } = livePane("claude-code");
  Object.assign(pane, { _renderActivity() {}, _agentSeen: false, agentGone: false });
  pane.noteAgent(false);
  assert.equal(pane.agentGone, false, "not before the agent was ever seen");
  pane.noteAgent(true);
  assert.equal(pane._handleKey(key("keydown")), false);
  pane.noteAgent(false);
  assert.equal(pane.agentGone, true);
  assert.equal(pane._handleKey(key("keydown")), true, "left to xterm, as in any shell");
  assert.deepEqual(typed, [[AGENT_NEWLINE, true]]);
  pane.noteAgent(true);
  assert.equal(pane.agentGone, false, "an agent started again at the prompt counts");
});

test("an agent in WSL keeps Shift+Enter from launch until the wrap's exit marker", () => {
  const { pane, typed } = livePane("claude-code");
  Object.assign(pane, { _renderActivity() {}, _agentSeen: false, agentGone: false, _agentExitMarked: false });
  // No hook state ever arrives from WSL, wsl.exe always looks busy, and the
  // classic renderer draws on the main screen: only the marker can tell.
  pane.term.buffer = { active: { type: "normal" } };
  pane.noteAgent(true, { byMarker: true });
  assert.equal(pane._handleKey(key("keydown")), false, "the agent runs: a newline");
  pane.noteAgentExit();
  assert.equal(pane._handleKey(key("keydown")), true, "the bash prompt: Enter, left to xterm");
  assert.deepEqual(typed, [[AGENT_NEWLINE, true]]);
});

test("an agent pane that cannot take input swallows Shift+Enter without sending", () => {
  const { pane, frames, typed } = livePane("codex");
  pane._protocol.beginReplay();
  assert.equal(pane._handleKey(key("keydown")), false);
  assert.deepEqual(typed, []);
  assert.deepEqual(frames, []);
  assert.equal(pane.userWrote, false);
});

test("plain Enter on an exited pane still restarts it, and Ctrl+C without a selection passes through", () => {
  const { pane } = livePane("codex");
  pane.state = "exited";
  let restarts = 0;
  pane.requestRestart = () => { restarts += 1; return true; };
  assert.equal(pane._handleKey(key("keydown", { shiftKey: false })), false);
  assert.equal(restarts, 1);
  pane.state = "attached";
  assert.equal(pane._handleKey(key("keydown", { key: "c", shiftKey: false, ctrlKey: true })), true);
});
