// The kill confirmation: where it goes, who gets the keyboard, and what a
// failed or successful kill does to it. confirmNear runs against a fake DOM
// just large enough for it; the placement maths is pure.

import test from "node:test";
import assert from "node:assert/strict";

import {
  FAILED_TEXT, closeConfirm, confirmIsOpen, confirmNear, confirmPlacement, initialFocus, triggerGone,
} from "../../quickterm/frontend/js/confirm_popover.js";
import { focusOwners, resetFocusOwners } from "../../quickterm/frontend/js/focus.js";

// ---------------------------------------------------------------- fake DOM

class FakeElement {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.style = {};
    this.className = "";
    this.textContent = "";
    this.disabled = false;
    this.type = "";
    this.rect = { left: 0, top: 0, right: 300, bottom: 40, width: 300, height: 40 };
    this.focusedWithOwners = null;
  }

  get isConnected() {
    for (let node = this; node; node = node.parentNode) if (node === this.ownerDocument.body) return true;
    return false;
  }

  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parentNode = this;
      this.children.push(node);
    }
  }

  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }

  contains(node) {
    for (let each = node; each; each = each.parentNode) if (each === this) return true;
    return false;
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    if (list.includes(fn)) list.splice(list.indexOf(fn), 1);
  }

  dispatch(type, init = {}) {
    const event = {
      type,
      target: this,
      defaultPrevented: false,
      stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
      ...init,
    };
    for (let node = this; node && !event.stopped; node = node.parentNode) {
      for (const fn of [...(node.listeners.get(type) || [])]) fn(event);
    }
    return event;
  }

  click() {
    if (!this.disabled) this.dispatch("click", { detail: 1 });
  }

  focus() {
    this.focusedWithOwners = focusOwners();
    this.ownerDocument.activeElement = this;
  }

  getBoundingClientRect() { return { ...this.rect }; }
}

function installDom({ width = 800, height = 600 } = {}) {
  const listeners = [];
  const doc = {
    activeElement: null,
    createElement: (tag) => new FakeElement(tag, doc),
    addEventListener: (type, fn, capture) => listeners.push({ on: "document", type, fn, capture }),
    removeEventListener: (type, fn) => {
      const index = listeners.findIndex((item) => item.on === "document" && item.type === type && item.fn === fn);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  doc.body = new FakeElement("body", doc);
  const win = {
    innerWidth: width,
    innerHeight: height,
    addEventListener: (type, fn, capture) => listeners.push({ on: "window", type, fn, capture }),
    removeEventListener: (type, fn) => {
      const index = listeners.findIndex((item) => item.on === "window" && item.type === type && item.fn === fn);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  globalThis.document = doc;
  globalThis.window = win;
  const fire = (on, type, event = {}) => {
    for (const item of listeners.filter((each) => each.on === on && each.type === type)) item.fn(event);
  };
  return { doc, win, listeners, fire };
}

function killButton(doc, rect = { left: 160, top: 100, right: 180, bottom: 118, width: 20, height: 18 }) {
  const row = doc.createElement("div");
  const button = doc.createElement("button");
  button.rect = rect;
  row.append(button);
  doc.body.append(row);
  return button;
}

const findButton = (box, label) => box.children[1].children.find((button) => button.textContent === label);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(t) {
  resetFocusOwners();
  closeConfirm("test");
  const dom = installDom();
  t.after(() => {
    closeConfirm("test");
    resetFocusOwners();
    delete globalThis.document;
    delete globalThis.window;
  });
  return dom;
}

function openKill(dom, { keyboard = false, action = async () => {}, onClose } = {}) {
  const trigger = killButton(dom.doc);
  const closes = [];
  const handle = confirmNear(trigger, {
    message: "Kill shell? This stops its whole process tree.",
    confirmLabel: "Kill",
    action,
    keyboard,
    owner: "sidebar-confirm",
    onClose: (reason) => { closes.push({ reason, owners: focusOwners() }); onClose?.(reason); },
  });
  return { trigger, handle, box: handle.box, closes, kill: findButton(handle.box, "Kill"), cancel: findButton(handle.box, "Cancel") };
}

// ---------------------------------------------------------------- placement

test("the box sits under its trigger, flush with its right edge", () => {
  const spot = confirmPlacement({ left: 100, right: 200, top: 100, bottom: 120 }, { width: 150, height: 40 }, { width: 800, height: 600 });
  assert.deepEqual(spot, { left: 50, top: 126 });
});

test("the box is clamped inside every viewport edge", () => {
  const viewport = { width: 800, height: 600 };
  const box = { width: 150, height: 40 };
  // right edge: never closer than the margin
  assert.equal(confirmPlacement({ left: 780, right: 800, top: 100, bottom: 120 }, box, viewport).left, 638);
  // left edge: a trigger near the left of the sidebar pulls the box to the margin
  assert.equal(confirmPlacement({ left: 10, right: 50, top: 100, bottom: 120 }, { width: 300, height: 40 }, viewport).left, 12);
  // a box wider than the viewport starts at the margin
  assert.equal(confirmPlacement({ left: 10, right: 50, top: 10, bottom: 20 }, { width: 900, height: 40 }, viewport).left, 12);
  // top edge: no room above or below still lands on the margin
  assert.equal(confirmPlacement({ left: 0, right: 50, top: 0, bottom: 10 }, box, { width: 800, height: 50 }).top, 12);
  // custom margin and gap
  assert.deepEqual(
    confirmPlacement({ left: 100, right: 200, top: 100, bottom: 120 }, box, viewport, { margin: 4, gap: 2 }),
    { left: 50, top: 122 },
  );
});

test("the box flips above a trigger near the bottom", () => {
  const spot = confirmPlacement({ left: 100, right: 200, top: 570, bottom: 590 }, { width: 150, height: 40 }, { width: 800, height: 600 });
  assert.equal(spot.top, 570 - 40 - 6);
});

test("a trigger without a box or outside the viewport is gone", () => {
  const viewport = { width: 800, height: 600 };
  assert.equal(triggerGone({ top: 10, bottom: 30, width: 20, height: 20 }, viewport), false);
  assert.equal(triggerGone({ top: -40, bottom: -2, width: 20, height: 20 }, viewport), true);
  assert.equal(triggerGone({ top: 610, bottom: 630, width: 20, height: 20 }, viewport), true);
  assert.equal(triggerGone({ top: 0, bottom: 0, width: 0, height: 0 }, viewport), true);
  assert.equal(triggerGone(null, viewport), true);
});

// ---------------------------------------------------------------- focus

test("the keyboard path focuses Kill and a pointer focuses Cancel", (t) => {
  assert.equal(initialFocus(true), "confirm");
  assert.equal(initialFocus(false), "cancel");
  const dom = setup(t);
  const pointer = openKill(dom);
  assert.equal(dom.doc.activeElement, pointer.cancel);
  pointer.handle.close();
  const keyboard = openKill(dom, { keyboard: true });
  assert.equal(dom.doc.activeElement, keyboard.kill);
});

test("the keyboard is claimed before a button is focused and released on close", (t) => {
  const dom = setup(t);
  const opened = openKill(dom, { keyboard: true });
  assert.deepEqual(opened.kill.focusedWithOwners, ["sidebar-confirm"]);
  assert.deepEqual(focusOwners(), ["sidebar-confirm"]);
  opened.cancel.click();
  assert.deepEqual(focusOwners(), []);
  // onClose runs after the release, so handing focus back is not refused.
  assert.deepEqual(opened.closes, [{ reason: "cancel", owners: [] }]);
});

test("the trigger stays visible and disabled while the box is open", (t) => {
  const dom = setup(t);
  const opened = openKill(dom);
  assert.equal(opened.trigger.isConnected, true);
  assert.equal(opened.trigger.disabled, true);
  assert.equal(opened.trigger.getAttribute("aria-expanded"), "true");
  assert.equal(opened.box.style.left, "12px");
  assert.equal(opened.box.style.top, `${118 + 6}px`);
  opened.handle.close();
  assert.equal(opened.trigger.disabled, false);
  assert.equal(opened.trigger.getAttribute("aria-expanded"), "false");
  assert.equal(opened.box.isConnected, false);
});

// ---------------------------------------------------------------- outcomes

test("a rejected kill keeps the box, shows the server's detail and offers Retry", async (t) => {
  const dom = setup(t);
  let calls = 0;
  const opened = openKill(dom, {
    action: async () => {
      calls += 1;
      if (calls === 1) throw { status: 500, detail: "Could not stop every process" };
    },
  });
  opened.kill.click();
  assert.equal(opened.kill.disabled, true);
  assert.equal(opened.cancel.disabled, true);
  await settle();
  assert.equal(opened.box.isConnected, true);
  assert.equal(opened.box.children[0].textContent, "Could not stop every process");
  assert.equal(opened.kill.textContent, "Retry");
  assert.equal(opened.kill.disabled, false);
  assert.equal(dom.doc.activeElement, opened.kill);
  assert.deepEqual(focusOwners(), ["sidebar-confirm"]);
  assert.deepEqual(opened.closes, []);

  opened.kill.click();
  await settle();
  assert.equal(calls, 2);
  assert.equal(opened.box.isConnected, false);
  assert.deepEqual(opened.closes.map((item) => item.reason), ["done"]);
});

test("a rejection without detail says the action failed", async (t) => {
  const dom = setup(t);
  const opened = openKill(dom, { action: () => Promise.reject(new Error("network")) });
  opened.kill.click();
  await settle();
  assert.equal(opened.box.children[0].textContent, FAILED_TEXT);
  assert.equal(opened.kill.textContent, "Retry");
});

test("a resolved kill closes the box and releases the keyboard", async (t) => {
  const dom = setup(t);
  let ran = false;
  const opened = openKill(dom, { keyboard: true, action: async () => { ran = true; } });
  // Enter on the focused Kill button completes it.
  const enter = opened.kill.dispatch("keydown", { key: "Enter" });
  await settle();
  assert.equal(ran, true);
  assert.equal(enter.defaultPrevented, true);
  assert.equal(opened.box.isConnected, false);
  assert.equal(confirmIsOpen(), false);
  assert.deepEqual(focusOwners(), []);
  assert.equal(opened.trigger.disabled, false);
  assert.deepEqual(opened.closes.map((item) => item.reason), ["done"]);
});

test("Escape cancels without reaching the global key layer", (t) => {
  const dom = setup(t);
  let ran = false;
  const opened = openKill(dom, { action: () => { ran = true; } });
  const escape = opened.cancel.dispatch("keydown", { key: "Escape" });
  assert.equal(escape.stopped, true);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(ran, false);
  assert.deepEqual(opened.closes.map((item) => item.reason), ["escape"]);
  assert.deepEqual(focusOwners(), []);
});

test("the box follows its trigger and closes once the trigger is gone", (t) => {
  const dom = setup(t);
  const opened = openKill(dom);
  opened.trigger.rect = { left: 160, top: 300, right: 180, bottom: 318, width: 20, height: 18 };
  dom.fire("window", "scroll");
  assert.equal(opened.box.style.top, `${318 + 6}px`);
  opened.trigger.rect = { left: 160, top: -60, right: 180, bottom: -42, width: 20, height: 18 };
  dom.fire("window", "scroll");
  assert.deepEqual(opened.closes.map((item) => item.reason), ["gone"]);

  const again = openKill(dom);
  again.trigger.parentNode.remove();
  dom.fire("window", "resize");
  assert.deepEqual(again.closes.map((item) => item.reason), ["gone"]);
  assert.equal(dom.listeners.length, 0);
});

test("a press outside cancels, but not while the action is running", async (t) => {
  const dom = setup(t);
  let finish;
  const opened = openKill(dom, { action: () => new Promise((resolve) => { finish = resolve; }) });
  opened.kill.click();
  dom.fire("document", "pointerdown", { target: dom.doc.body });
  assert.equal(opened.box.isConnected, true);
  finish();
  await settle();
  assert.deepEqual(opened.closes.map((item) => item.reason), ["done"]);

  const other = openKill(dom);
  dom.fire("document", "pointerdown", { target: other.box.children[0] });
  assert.equal(other.box.isConnected, true);
  dom.fire("document", "pointerdown", { target: dom.doc.body });
  assert.deepEqual(other.closes.map((item) => item.reason), ["outside"]);
});

test("a click into a view's frame (the window losing focus) cancels and frees the keyboard", async (t) => {
  // That press never reaches this document's pointerdown.
  const dom = setup(t);
  const opened = openKill(dom);
  dom.fire("window", "blur");
  assert.deepEqual(opened.closes.map((item) => item.reason), ["blur"]);
  assert.deepEqual(focusOwners(), []);
  assert.equal(dom.listeners.length, 0);
  // Not while the action runs: its answer has to land somewhere.
  let finish;
  const running = openKill(dom, { action: () => new Promise((resolve) => { finish = resolve; }) });
  running.kill.click();
  dom.fire("window", "blur");
  assert.equal(running.box.isConnected, true);
  finish();
  await settle();
  assert.deepEqual(running.closes.map((item) => item.reason), ["done"]);
});

test("opening a second confirmation replaces the first", (t) => {
  const dom = setup(t);
  const first = openKill(dom);
  const second = openKill(dom, { keyboard: true });
  assert.deepEqual(first.closes.map((item) => item.reason), ["replaced"]);
  assert.equal(first.trigger.disabled, false);
  assert.equal(second.box.isConnected, true);
  assert.deepEqual(focusOwners(), ["sidebar-confirm"]);
});
