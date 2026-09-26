// The backend's `touched` flag (idle reaper, close-to-tray) belongs to the
// user. It used to be set by every byte on the WebSocket, including xterm's
// automatic replies to terminal queries and focus reports, so a shell nobody
// typed into could never be cleaned up. The pane now says so explicitly with a
// {"type":"touch"} control frame on the first real input of each connection.
//
// Like pane_queue.test.mjs, these drive the Pane methods against a minimal
// stand-in: the rule is under test, not the DOM or xterm.
import test from "node:test";
import assert from "node:assert/strict";

import { Pane } from "../../quickterm/frontend/js/pane.js";
import { PaneAttachProtocol } from "../../quickterm/frontend/js/pane_protocol.js";

const OPEN = globalThis.WebSocket?.OPEN ?? 1;
globalThis.WebSocket ??= { OPEN };

function goLive(protocol) {
  protocol.beginReplay();
  protocol.replayComplete();
  protocol.goLive();
  return protocol;
}

function fakeSocket() {
  return {
    readyState: OPEN,
    frames: [],
    send(data) { this.frames.push(typeof data === "string" ? JSON.parse(data) : "bytes"); },
  };
}

function fakePane(protocol = goLive(new PaneAttachProtocol(1024))) {
  return {
    ws: fakeSocket(),
    _protocol: protocol,
    _exited: false,
    userWrote: false,
    notified: 0,
    onStateChange() { this.notified += 1; },
    sendText: Pane.prototype.sendText,
    _markWrote: Pane.prototype._markWrote,
    _sendTouch: Pane.prototype._sendTouch,
  };
}

test("the protocol hands out one touch per connection, only while input can flow", () => {
  const protocol = new PaneAttachProtocol(1024);
  protocol.beginReplay();
  assert.equal(protocol.takeTouch(), false); // replaying: input is not forwarded
  protocol.replayComplete();
  protocol.goLive();
  assert.equal(protocol.takeTouch(), true);
  assert.equal(protocol.takeTouch(), false);

  goLive(protocol); // reconnect: a new WebSocket
  assert.equal(protocol.takeTouch(), true);

  goLive(protocol);
  protocol.exit();
  assert.equal(protocol.takeTouch(), false);
});

test("the first sent text is preceded by exactly one touch frame", () => {
  const pane = fakePane();
  assert.equal(pane.sendText("ls\r"), true);
  assert.equal(pane.sendText("pwd\r"), true);
  assert.deepEqual(pane.ws.frames, [{ type: "touch" }, "bytes", "bytes"]);
  assert.equal(pane.userWrote, true);
  assert.equal(pane.notified, 1);
});

test("a key or a native paste touches once, and a reconnect touches again", () => {
  const pane = fakePane();
  pane._markWrote(); // onKey, or the Ctrl+V handler before the paste event
  pane._markWrote();
  assert.deepEqual(pane.ws.frames, [{ type: "touch" }]);

  pane.ws = fakeSocket();
  goLive(pane._protocol);
  pane._markWrote();
  assert.deepEqual(pane.ws.frames, [{ type: "touch" }]);
  // The scratch adoption hook still fires once per pane, not per connection.
  assert.equal(pane.notified, 1);
});

test("no touch is sent while the pane cannot forward input", () => {
  const replaying = new PaneAttachProtocol(1024);
  replaying.beginReplay();
  const pane = fakePane(replaying);
  pane._markWrote();
  assert.equal(pane.sendText("x"), false);
  assert.deepEqual(pane.ws.frames, []);

  const exited = fakePane();
  exited._exited = true;
  exited._markWrote();
  assert.deepEqual(exited.ws.frames, []);

  const closed = fakePane();
  closed.ws.readyState = 3;
  closed._markWrote();
  assert.deepEqual(closed.ws.frames, []);
  // The flag was not spent: the first input on the open socket still counts.
  closed.ws.readyState = OPEN;
  closed._markWrote();
  assert.deepEqual(closed.ws.frames, [{ type: "touch" }]);
});
