// Pure attach/replay/backpressure state for one terminal pane. Keeping this
// independent from DOM/xterm/WebSocket objects makes the binding protocol
// executable under Node's built-in test runner.
export class PaneAttachProtocol {
  constructor(queueLimit) {
    this.queueLimit = queueLimit;
    this.phase = "idle";
    this.replayDone = false;
    this.replayWrites = 0;
    this.queuedBytes = 0;
    this.generation = 0;
    this.touchSent = false;
  }

  // Every connection is a new WebSocket, and the server may be a restarted
  // backend or a reattach after an overflow, so each one says "touch" afresh.
  beginReplay() {
    this.phase = "replay";
    this.replayDone = false;
    this.replayWrites = 0;
    this.queuedBytes = 0;
    this.generation += 1;
    this.touchSent = false;
    return this.generation;
  }

  // True exactly once per connection, on the first real user input that can
  // reach the PTY. The backend's `touched` flag comes only from this frame:
  // onData alone also carries xterm's automatic replies (DA, DSR, focus
  // reports), which must never make a shell look used.
  takeTouch() {
    if (this.touchSent || !this.canSendInput()) return false;
    this.touchSent = true;
    return true;
  }

  isCurrent(generation) {
    return generation === this.generation;
  }

  replayComplete() {
    this.replayDone = true;
    if (this.replayWrites === 0) return true;
    this.phase = "prelive";
    return false;
  }

  acceptBinary(byteLength) {
    if (byteLength === 0) return "ignore";
    if (this.phase === "replay") {
      this.replayWrites += 1;
      return "replay";
    }
    if (this.queuedBytes + byteLength > this.queueLimit) return "overflow";
    this.queuedBytes += byteLength;
    return "queue";
  }

  completeReplayWrite(generation) {
    if (!this.isCurrent(generation)) return { stale: true, acknowledge: false, goLive: false };
    this.replayWrites = Math.max(0, this.replayWrites - 1);
    return {
      stale: false,
      acknowledge: true,
      goLive: this.replayDone && this.replayWrites === 0,
    };
  }

  takeQueued(byteLength) {
    this.queuedBytes = Math.max(0, this.queuedBytes - byteLength);
  }

  goLive() {
    this.phase = "live";
  }

  canSendInput() {
    return this.phase === "live";
  }

  exit() {
    this.phase = "idle";
  }

  invalidate() {
    this.generation += 1;
  }
}
