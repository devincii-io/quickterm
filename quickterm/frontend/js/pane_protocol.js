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
  }

  beginReplay() {
    this.phase = "replay";
    this.replayDone = false;
    this.replayWrites = 0;
    this.queuedBytes = 0;
    this.generation += 1;
    return this.generation;
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
