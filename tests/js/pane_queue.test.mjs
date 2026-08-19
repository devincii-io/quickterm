// Pane output-queue draining. The pump stops at PENDING_LIMIT and only resumes
// from an xterm write callback, which used to re-arm solely while the phase was
// "live", so an exit arriving before xterm finished parsing stranded every
// queued byte (and retained it for the pane's lifetime).
//
// These call the queue methods against a minimal stand-in rather than a real
// Pane: the drain logic is what is under test, not the DOM.
import test from "node:test";
import assert from "node:assert/strict";

import { Pane } from "../../quickterm/frontend/js/pane.js";

function fakePane({ queue = [], phase = "live" } = {}) {
  const written = [];
  return {
    _queue: queue,
    _pending: 0,
    _disposed: false,
    _exited: false,
    written,
    term: { write(data, cb) { written.push(data); if (cb) cb(); } },
    _protocol: {
      phase,
      generation: 1,
      isCurrent() { return true; },
      takeQueued() {},
    },
    get _phase() { return this._protocol.phase; },
    get _generation() { return this._protocol.generation; },
    _drainQueue: Pane.prototype._drainQueue,
    _flushQueue: Pane.prototype._flushQueue,
    _pump: Pane.prototype._pump,
  };
}

const bytes = (...values) => new Uint8Array(values);

test("exit drains everything still queued instead of dropping it", () => {
  const pane = fakePane({
    queue: [bytes(1, 2), bytes(3), bytes(4, 5, 6)],
    phase: "idle", // _onExit flips the protocol out of "live" before this ran
  });

  pane._flushQueue();

  assert.equal(pane._queue.length, 0);
  const delivered = pane.written.flatMap((chunk) => [...chunk]);
  assert.deepEqual(delivered, [1, 2, 3, 4, 5, 6]);
});

test("draining a pane whose terminal is gone clears the queue rather than retaining it", () => {
  const pane = fakePane({ queue: [bytes(1), bytes(2)] });
  pane.term = null;

  pane._flushQueue();

  assert.equal(pane._queue.length, 0);
});

test("queued chunks are merged into one write per tick", () => {
  const pane = fakePane({ queue: [bytes(1), bytes(2), bytes(3)] });

  pane._pump();

  assert.equal(pane.written.length, 1);
  assert.deepEqual([...pane.written[0]], [1, 2, 3]);
  assert.equal(pane._queue.length, 0);
});
