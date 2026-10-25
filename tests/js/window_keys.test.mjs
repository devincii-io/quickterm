// The window's keys behind keys.js: which workspace Alt+Shift+n shows, where
// Alt+N opens, and the Ctrl+Tab list's keyboard hand-over.
import test from "node:test";
import assert from "node:assert/strict";

import { workspaceSlots } from "../../quickterm/frontend/js/workspace_views.js";
import { sameFolderCwd } from "../../quickterm/frontend/js/spawner.js";
import { RecentTerminals } from "../../quickterm/frontend/js/recent_terminals.js";
import { claimFocus, focusOwners, releaseFocus, resetFocusOwners } from "../../quickterm/frontend/js/focus.js";

const group = (name, kind = "workspace", open = false) => ({ name, kind, open });

test("Alt+Shift+n counts the workspaces the sidebar draws, in its order", () => {
  const groups = [
    group("api"), group("api/feature-x"), group("web", "workspace", true),
    group("scratch-view-00000001", "scratch", true), group("scratch-view-00000002", "scratch", false),
    { name: null, kind: "unassigned" },
  ];
  assert.deepEqual(workspaceSlots(groups), ["api", "api/feature-x", "web", "scratch-view-00000001"]);
});

test("at most nine slots, and open views stand in for an ungrouped sidebar", () => {
  const many = Array.from({ length: 12 }, (_, index) => group(`ws${index + 1}`));
  assert.equal(workspaceSlots(many).length, 9);
  const flat = [{ name: null, kind: "flat" }];
  assert.deepEqual(
    workspaceSlots(flat, ["web", "scratch-view-00000003", "Api"]),
    ["Api", "web", "scratch-view-00000003"],
  );
});

test("Alt+N opens in the focused terminal's folder only inside the workspace", () => {
  assert.equal(sameFolderCwd("C:\\Repo\\src", "c:/repo/"), "C:\\Repo\\src");
  assert.equal(sameFolderCwd("C:\\Repo", "C:\\Repo"), "C:\\Repo");
  assert.equal(sameFolderCwd("C:\\Repository", "C:\\Repo"), null, "a sibling with a longer name");
  assert.equal(sameFolderCwd("D:\\elsewhere", "C:\\Repo"), null);
  assert.equal(sameFolderCwd("/home/me/project/app", "/home/me/project"), "/home/me/project/app");
  assert.equal(sameFolderCwd("/mnt/c/Repo/src", "C:\\Repo"), null, "a WSL path is not the Windows folder");
  assert.equal(sameFolderCwd(null, "C:\\Repo"), null);
  assert.equal(sameFolderCwd("C:\\Repo\\src", null), null, "no workspace folder: the caller decides");
});

// Just enough DOM for switcher.js.
function fakeDom() {
  class Node {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.parent = null;
      this.dataset = {};
      this.attributes = {};
      this.listeners = {};
      this.style = { setProperty() {} };
      const classes = new Set();
      this.classList = {
        add: (name) => classes.add(name),
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
        contains: (name) => classes.has(name),
      };
      this.textContent = "";
    }
    set className(value) { this.classList.add(value); }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this);
      this.parent = null;
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    focus() { dom.focused = this; }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    querySelectorAll(selector) {
      const name = selector.slice(1);
      const out = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (child.classList.contains(name)) out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    }
    fire(type, init = {}) {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...init };
      for (const fn of this.listeners[type] || []) fn(event);
      return event;
    }
  }
  const dom = { focused: null, body: new Node("body") };
  globalThis.document = { body: dom.body, createElement: (tag) => new Node(tag) };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  return dom;
}

async function switcherWith(ids, current) {
  const dom = fakeDom();
  const { createSwitcher } = await import("../../quickterm/frontend/js/switcher.js");
  const recent = new RecentTerminals();
  for (const id of ids) recent.note(id);
  const events = [];
  const switcher = createSwitcher({
    recent,
    current: () => current,
    alive: () => true,
    rows: (list) => list.map((id) => ({ id, name: `term ${id}`, where: "web", color: null, current: id === current })),
    choose: (id) => events.push(`choose:${id}`),
    handBack: () => events.push("handBack"),
  });
  return { dom, switcher, events, recent };
}

test("Ctrl+Tab opens the list with the keyboard, releasing Ctrl shows the selection", async () => {
  resetFocusOwners();
  const { dom, switcher, events } = await switcherWith(["a", "b", "c"], "c");
  assert.equal(switcher.step(1), true);
  const box = dom.body.children[0];
  assert.equal(dom.focused, box, "the list takes the keyboard");
  assert.deepEqual(focusOwners(), ["switcher"]);
  const rows = box.querySelectorAll(".qt-switcher-row");
  assert.deepEqual(rows.map((row) => row.dataset.id), ["c", "b", "a"]);
  assert.equal(rows[1].attributes["aria-selected"], "true");
  switcher.step(1);
  assert.equal(rows[2].attributes["aria-selected"], "true");
  switcher.release();
  assert.deepEqual(events, ["choose:a"]);
  assert.deepEqual(focusOwners(), [], "released before the terminal is shown");
  assert.equal(dom.body.children.length, 0);
  // A release with no list open does nothing.
  switcher.release();
  assert.deepEqual(events, ["choose:a"]);
});

test("Escape cancels and hands the keyboard back to the terminal", async () => {
  resetFocusOwners();
  const { dom, switcher, events, recent } = await switcherWith(["a", "b"], "b");
  switcher.step(1);
  const escape = dom.body.children[0].fire("keydown", { key: "Escape" });
  assert.equal(escape.defaultPrevented, true);
  assert.deepEqual(events, ["handBack"]);
  assert.deepEqual(focusOwners(), []);
  assert.deepEqual(recent.ids, ["b", "a"], "the order did not change");
});

test("Ctrl+Shift+Tab opens on the oldest entry", async () => {
  resetFocusOwners();
  const { switcher, events } = await switcherWith(["a", "b", "c"], "c");
  switcher.step(-1);
  switcher.release();
  assert.deepEqual(events, ["choose:a"]);
});

test("the list stays shut while another overlay has the keyboard or nothing is listed", async () => {
  resetFocusOwners();
  const { dom, switcher } = await switcherWith(["a", "b"], "b");
  claimFocus("palette");
  assert.equal(switcher.step(1), false);
  assert.equal(dom.body.children.length, 0);
  releaseFocus("palette");
  const empty = await switcherWith([], null);
  assert.equal(empty.switcher.step(1), false);
  assert.equal(empty.dom.body.children.length, 0);
});
