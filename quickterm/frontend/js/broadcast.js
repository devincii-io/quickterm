// Broadcast input (tmux synchronize-panes): what the user types into the
// focused pane is also sent to every other live pane in this document. Pure
// pieces only; the layout owns the switch and pane.js feeds it. Tested under
// node.

// xterm's onData carries two kinds of data: what the user typed and what
// xterm answers on its own to the program's queries (device attributes,
// cursor position, focus reports). Only the first may be mirrored: a DA reply
// typed into four other shells is garbage on four prompts. There is no flag
// on onData that tells them apart, so the pane arms this gate on the events
// that only real input produces (a key, a paste, the end of an IME
// composition, a text insertion) and mirrors data only while it is open.
// xterm emits a key's or a paste's data in the same task as the event, so
// one macrotask is enough; a composition's text is read back from the
// textarea on a zero timeout of xterm's own, which runs after ours, so it
// needs two.
export class RealInputGate {
  constructor(defer = (fn) => setTimeout(fn, 0)) {
    this._defer = defer;
    this._armed = 0;
  }

  get open() {
    return this._armed > 0;
  }

  arm(ticks = 1) {
    this._armed += 1;
    const release = (left) => this._defer(() => {
      if (left > 1) release(left - 1);
      else this._armed -= 1;
    });
    release(Math.max(1, ticks));
  }
}

// Every other pane that can take input right now. A pane that is still
// replaying, reconnecting or has exited is skipped rather than queued: input
// typed "into all panes" must not land in one of them seconds later.
export function broadcastTargets(panes, source) {
  return panes.filter((pane) => pane !== source && pane.acceptsInput());
}

// `others` is how many panes besides the focused one receive the input.
export function broadcastNotice(on, others) {
  if (!on) return "[broadcast off]";
  if (others < 1) return "[broadcast on · no other live pane yet]";
  return `[broadcast on · typing here also reaches ${others} other pane${others === 1 ? "" : "s"}]`;
}
