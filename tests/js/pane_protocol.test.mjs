import test from "node:test";
import assert from "node:assert/strict";

import { PaneAttachProtocol } from "../../quickterm/frontend/js/pane_protocol.js";

test("replay gates input until every xterm write is acknowledged", () => {
  const protocol = new PaneAttachProtocol(1024);
  const generation = protocol.beginReplay();

  assert.equal(protocol.phase, "replay");
  assert.equal(protocol.canSendInput(), false);
  assert.equal(protocol.acceptBinary(12), "replay");
  assert.equal(protocol.acceptBinary(8), "replay");
  assert.equal(protocol.replayComplete(), false);
  assert.equal(protocol.phase, "prelive");

  assert.deepEqual(protocol.completeReplayWrite(generation), {
    stale: false, acknowledge: true, goLive: false,
  });
  assert.deepEqual(protocol.completeReplayWrite(generation), {
    stale: false, acknowledge: true, goLive: true,
  });
  protocol.goLive();
  assert.equal(protocol.canSendInput(), true);
});

test("an empty replay becomes live immediately", () => {
  const protocol = new PaneAttachProtocol(1024);
  protocol.beginReplay();
  assert.equal(protocol.replayComplete(), true);
  protocol.goLive();
  assert.equal(protocol.phase, "live");
});

test("callbacks from an old connection cannot advance the new replay", () => {
  const protocol = new PaneAttachProtocol(1024);
  const staleGeneration = protocol.beginReplay();
  protocol.acceptBinary(10);
  const currentGeneration = protocol.beginReplay();
  protocol.acceptBinary(20);

  assert.deepEqual(protocol.completeReplayWrite(staleGeneration), {
    stale: true, acknowledge: false, goLive: false,
  });
  assert.equal(protocol.replayWrites, 1);
  assert.equal(protocol.isCurrent(currentGeneration), true);
});

test("live queue overflow requests resync instead of dropping VT bytes", () => {
  const protocol = new PaneAttachProtocol(32);
  protocol.beginReplay();
  protocol.replayComplete();
  protocol.goLive();

  assert.equal(protocol.acceptBinary(20), "queue");
  assert.equal(protocol.acceptBinary(13), "overflow");
  protocol.takeQueued(20);
  assert.equal(protocol.queuedBytes, 0);

  protocol.invalidate();
  assert.equal(protocol.canSendInput(), true);
  protocol.exit();
  assert.equal(protocol.canSendInput(), false);
});
