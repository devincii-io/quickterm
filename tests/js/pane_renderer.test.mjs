// A pane nobody can see gives its WebGL context back. Browsers keep about 16
// live contexts per page and silently drop the oldest, so ten agent panes
// spread over zoomed-away workspace views used to hold ten contexts and
// glyph atlases for nothing. These drive the Pane renderer methods and the
// layout's visibility rule against stand-ins that count live contexts; the
// real WebGL behaviour is checked live.
import test, { mock } from "node:test";
import assert from "node:assert/strict";

import { Pane } from "../../quickterm/frontend/js/pane.js";
import { LayoutManager } from "../../quickterm/frontend/js/layout.js";

const GRACE_MS = 5000;

function installWebgl({ broken = false } = {}) {
  const gl = { live: 0, created: 0, lost: [] };
  globalThis.WebglAddon = {
    WebglAddon: class {
      constructor() {
        if (broken) throw new Error("no WebGL");
        gl.created += 1;
        gl.live += 1;
        this.disposed = false;
        gl.lost.push(() => this._onLoss?.());
      }
      onContextLoss(handler) { this._onLoss = handler; }
      dispose() {
        if (this.disposed) return;
        this.disposed = true;
        gl.live -= 1;
      }
    },
  };
  return gl;
}

function fakePane() {
  const pane = Object.create(Pane.prototype);
  Object.assign(pane, {
    _webgl: null,
    _webglBroken: false,
    _offscreen: false,
    _releaseTimer: null,
    _disposed: false,
    refreshed: 0,
    fits: 0,
    buffer: ["the agent's last answer"],
    term: {
      rows: 24,
      loadAddon() {},
      refresh() { pane.refreshed += 1; },
    },
  });
  pane.fitSoon = () => { pane.fits += 1; };
  return pane;
}

function panesWithRenderers(count) {
  const panes = Array.from({ length: count }, fakePane);
  for (const pane of panes) pane._loadWebgl();
  return panes;
}

test("ten hidden panes hold no WebGL context after the grace period, and get one back when shown", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const gl = installWebgl();
  const panes = panesWithRenderers(10);
  assert.equal(gl.live, 10, "before: one context per pane");

  for (const pane of panes) pane.setOffscreen(true);
  mock.timers.tick(GRACE_MS - 1);
  assert.equal(gl.live, 10, "nothing is released inside the grace period");
  mock.timers.tick(1);
  assert.equal(gl.live, 0, "after: every hidden pane gave its context back");
  assert.ok(panes.every((pane) => pane.term && pane.buffer.length), "the terminal and its buffer stay");

  for (const pane of panes) pane.setOffscreen(false);
  assert.equal(gl.live, 10);
  assert.ok(panes.every((pane) => pane.refreshed === 1 && pane.fits === 1), "every row is redrawn and refitted");
});

test("a quick hide and show inside the grace period rebuilds nothing", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const gl = installWebgl();
  const [pane] = panesWithRenderers(1);
  pane.setOffscreen(true);
  mock.timers.tick(1000);
  pane.setOffscreen(false);
  mock.timers.tick(GRACE_MS * 2);
  assert.equal(gl.created, 1);
  assert.equal(gl.live, 1);
  assert.equal(pane.refreshed, 0, "a renderer that never left needs no redraw");
});

test("a context the browser dropped while hidden comes back when the pane is shown", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const gl = installWebgl();
  const [pane] = panesWithRenderers(1);
  pane.setOffscreen(true);
  gl.lost[0]();
  assert.equal(pane._webgl, null, "the lost addon is disposed, xterm falls back to the DOM renderer");
  assert.equal(gl.live, 0);
  mock.timers.tick(GRACE_MS);
  pane.setOffscreen(false);
  assert.equal(gl.live, 1);
  assert.equal(gl.created, 2);
});

test("a pane whose WebGL could not be created never retries it", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  installWebgl({ broken: true });
  const warn = mock.method(console, "warn", () => {});
  t.after(() => warn.mock.restore());
  const [pane] = panesWithRenderers(1);
  assert.equal(pane._webglBroken, true);
  installWebgl();
  pane.setOffscreen(true);
  mock.timers.tick(GRACE_MS);
  pane.setOffscreen(false);
  assert.equal(pane._webgl, null);
});

test("a disposed pane schedules no release", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const gl = installWebgl();
  const [pane] = panesWithRenderers(1);
  pane._disposed = true;
  pane.setOffscreen(true);
  mock.timers.tick(GRACE_MS);
  assert.equal(gl.live, 1, "dispose() owns the teardown of a disposed pane");
});

function layoutWith(panes, state = {}) {
  const layout = Object.create(LayoutManager.prototype);
  Object.assign(layout, { viewHidden: false, zoomed: false, zoomedPane: null, ...state });
  layout.panes = () => panes;
  return layout;
}

function recordingPane() {
  return { offscreen: null, setOffscreen(value) { this.offscreen = value; } };
}

test("a hidden view takes every pane offscreen and a shown one brings them back", () => {
  const panes = [recordingPane(), recordingPane()];
  const layout = layoutWith(panes);
  layout.setViewHidden(true);
  assert.deepEqual(panes.map((pane) => pane.offscreen), [true, true]);
  layout.setViewHidden(false);
  assert.deepEqual(panes.map((pane) => pane.offscreen), [false, false]);
});

test("a zoomed pane stays on screen and the panes it covers go offscreen", () => {
  const panes = [recordingPane(), recordingPane(), recordingPane()];
  const layout = layoutWith(panes, { zoomed: true, zoomedPane: panes[1] });
  layout._syncVisibility();
  assert.deepEqual(panes.map((pane) => pane.offscreen), [true, false, true]);
  layout.setViewHidden(true);
  assert.deepEqual(panes.map((pane) => pane.offscreen), [true, true, true], "a hidden view hides its zoomed pane too");
});

test("a broadcast Shift+Enter from an agent pane reaches shell panes as Enter", () => {
  const pane = (terminalType) => ({ terminalType, sent: [], acceptsInput: () => true, sendText(text) { this.sent.push(text); return true; } });
  const agent = pane("claude-code");
  const codex = pane("codex");
  const shell = pane("command-prompt");
  const layout = layoutWith([agent, codex, shell], { broadcasting: true });
  layout._broadcastFrom(agent, "\x1b\r");
  assert.deepEqual(codex.sent, ["\x1b\r"]);
  assert.deepEqual(shell.sent, ["\r"]);
  // Alt+Enter typed in a shell pane is not the agent newline and goes as is.
  layout._broadcastFrom(shell, "\x1b\r");
  assert.deepEqual(agent.sent, ["\x1b\r"]);
});
