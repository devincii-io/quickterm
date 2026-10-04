// The master-detail list behind Settings > Terminals and Snippets, drawn
// against a small DOM stand-in. What it must guarantee: typing in the editor
// patches its row and never replaces the field under the caret, a filter hides
// rows without dropping the selection, and below 820 px the detail replaces
// the list until Back.
import test from "node:test";
import assert from "node:assert/strict";

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = { setProperty() {} };
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.listeners = {};
    this._text = "";
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, on) => {
        const wanted = on === undefined ? !classes.has(name) : Boolean(on);
        if (wanted) classes.add(name); else classes.delete(name);
        return wanted;
      },
      contains: (name) => classes.has(name),
    };
  }
  set className(value) { String(value).split(/\s+/).filter(Boolean).forEach((name) => this.classList.add(name)); }
  set textContent(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = String(value);
  }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set innerHTML(_) { /* icon paths */ }
  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === "string") this._text += node;
      else this.insertBefore(node, null);
    }
  }
  insertBefore(node, ref) {
    node.parentNode?.removeChild(node);
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at < 0) this.children.push(node); else this.children.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node) {
    this.children = this.children.filter((child) => child !== node);
    node.parentNode = null;
    return node;
  }
  remove() { this.parentNode?.removeChild(this); }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === globalThis.document.body;
  }
  get nextElementSibling() {
    const kids = this.parentNode?.children || [];
    return kids[kids.indexOf(this) + 1] || null;
  }
  get previousElementSibling() {
    const kids = this.parentNode?.children || [];
    return kids[kids.indexOf(this) - 1] || null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return name in this.attributes; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== fn); }
  fire(type, init = {}) {
    const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...init };
    for (const fn of [...(this.listeners[type] || [])]) fn(event);
    return event;
  }
  focus() { globalThis.document.activeElement = this; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }; }
  scrollIntoView() {}
  querySelector() { return null; }
}

globalThis.document = {
  body: new El("body"),
  activeElement: null,
  createElement: (tag) => new El(tag),
  createElementNS: (_, tag) => new El(tag),
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1200, innerHeight: 800 };
globalThis.requestAnimationFrame = (fn) => fn();

const { identityKey, itemDirty, renderConfigList, snapshotItems } = await import("../../quickterm/frontend/js/config_list.js");

function walk(root, out = []) {
  for (const child of root.children) {
    out.push(child);
    walk(child, out);
  }
  return out;
}
const byClass = (root, name) => walk(root).filter((node) => node.classList.contains(name));

function setup({ items, narrowMedia = null, confirm } = {}) {
  const host = new El("div");
  globalThis.document.body.append(host);
  const editors = [];
  const removed = [];
  const list = renderConfigList({
    host,
    items: () => items,
    noun: "things",
    row: (item) => ({ name: item.name, kind: "Thing", summary: item.cmd, problems: item.name ? [] : ["Enter a name."], dirty: Boolean(item.dirty) }),
    editor: (item, pane, { updateRow }) => {
      const input = new El("input");
      input.value = item.name;
      input.addEventListener("input", () => {
        item.name = input.value;
        updateRow();
      });
      pane.append(input);
      editors.push({ item, input });
    },
    onRemove: (item) => {
      items.splice(items.indexOf(item), 1);
      removed.push(item);
    },
    confirm,
    narrowMedia,
  });
  const rows = () => byClass(host, "config-rows")[0].children;
  const rowName = (row) => byClass(row, "config-row-name")[0].textContent;
  return { host, list, editors, removed, rows, rowName };
}

test("typing in the editor patches its row and keeps the editor node and focus", () => {
  const items = [{ name: "Dev", cmd: "pwsh" }, { name: "Ops", cmd: "ssh" }];
  const { list, editors, rows, rowName } = setup({ items });
  const [first, second] = rows();
  first.fire("click");
  assert.equal(list.selected(), items[0]);
  assert.equal(editors.length, 1);
  const { input } = editors[0];
  input.focus();

  input.value = "Development";
  input.fire("input");
  assert.equal(rowName(rows()[0]), "Development");
  assert.equal(editors.length, 1, "the editor was not redrawn");
  assert.equal(list.pane.children[0], input, "the field under the caret is the same element");
  assert.equal(globalThis.document.activeElement, input);
  assert.equal(rows()[0], first, "rows are patched, not recreated");
  assert.equal(rows()[1], second);

  list.refresh();
  assert.equal(list.pane.children[0], input, "a refresh patches rows only");
  assert.ok(first.classList.contains("selected"));
  // A plain list with aria-current: a listbox option may not hold the Open
  // and Remove buttons.
  assert.equal(first.getAttribute("role"), "listitem");
  assert.equal(first.parentNode.getAttribute("role"), "list");
  assert.equal(first.getAttribute("aria-current"), "true");
  assert.equal(second.hasAttribute("aria-current"), false);
  assert.equal(byClass(first, "config-row-summary")[0].textContent, "Thing · pwsh");
});

test("a row shows its problem and unsaved markers", () => {
  const items = [{ name: "", cmd: "x", dirty: true }, { name: "Fine", cmd: "y" }];
  const { rows } = setup({ items });
  const [broken, fine] = rows();
  assert.equal(byClass(broken, "config-row-problem")[0].hidden, false);
  assert.equal(byClass(broken, "config-row-dirty")[0].hidden, false);
  assert.equal(byClass(fine, "config-row-problem")[0].hidden, true);
  assert.equal(byClass(fine, "config-row-dirty")[0].hidden, true);
});

test("filtering hides rows but keeps the selection and its editor", () => {
  const items = [{ name: "Dev", cmd: "pwsh" }, { name: "Ops", cmd: "ssh" }];
  const { list, editors, rows, rowName } = setup({ items });
  list.select(items[1]);
  const editor = list.pane.children[0];
  list.setFilter("dev");
  assert.deepEqual(rows().map(rowName), ["Dev"]);
  assert.equal(list.selected(), items[1]);
  assert.equal(list.pane.children[0], editor);
  assert.equal(editors.length, 1);
  list.setFilter("");
  assert.deepEqual(rows().map(rowName), ["Dev", "Ops"]);
  assert.ok(rows()[1].classList.contains("selected"));
  list.setFilter("nothing like it");
  assert.equal(rows().length, 0);
  assert.match(byClass(list.el, "config-master-empty")[0].textContent, /No things match/);
});

test("below 820 px the detail replaces the list until Back", () => {
  const media = {
    matches: false,
    addEventListener(type, fn) { this.listener = fn; },
    removeEventListener() {},
  };
  const items = [{ name: "Dev", cmd: "pwsh" }];
  const { list, rows, host } = setup({ items, narrowMedia: media });
  const layout = byClass(host, "config-layout")[0];
  const back = byClass(host, "config-back")[0];
  assert.equal(list.isNarrow(), false);
  assert.equal(back.hidden, true);

  media.listener({ matches: true });
  assert.ok(layout.classList.contains("narrow"));
  assert.equal(layout.classList.contains("detail-open"), false, "nothing selected, so the list shows");
  rows()[0].fire("click");
  assert.ok(layout.classList.contains("detail-open"));
  assert.equal(list.isDetailOpen(), true);
  assert.equal(back.hidden, false);
  back.fire("click");
  assert.equal(layout.classList.contains("detail-open"), false);
  assert.equal(list.selected(), items[0], "Back keeps the selection");
  assert.equal(globalThis.document.activeElement, rows()[0], "and returns to its row");

  list.setNarrow(false);
  assert.equal(layout.classList.contains("narrow"), false);
});

test("remove goes through the confirmation and clears the selection", async () => {
  const items = [{ name: "Dev", cmd: "pwsh" }, { name: "Ops", cmd: "ssh" }];
  const asked = [];
  const { list, rows, removed } = setup({
    items,
    confirm: (button, message, label, action, options) => asked.push({ button, message, label, action, options }),
  });
  list.select(items[0]);
  byClass(rows()[0], "config-row-remove")[0].fire("click");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].label, "Remove");
  assert.deepEqual(asked[0].options, { keyboard: false }, "a pointer opened it, so Cancel takes focus");
  assert.equal(removed.length, 0, "nothing goes before it is confirmed");
  await asked[0].action();
  assert.deepEqual(removed.map((item) => item.name), ["Dev"]);
  assert.equal(list.selected(), null);
  assert.equal(rows().length, 1);

  rows()[0].fire("keydown", { key: "Delete", target: rows()[0] });
  assert.deepEqual(asked[1].options, { keyboard: true }, "Delete on a row is the keyboard path");
});

test("adding clears the filter and selects the new item", () => {
  const items = [{ name: "Dev", cmd: "pwsh" }];
  const { list, rows, rowName } = setup({ items });
  list.setFilter("dev");
  const fresh = { name: "New", cmd: "" };
  items.push(fresh);
  list.add(fresh);
  assert.deepEqual(rows().map(rowName), ["Dev", "New"]);
  assert.equal(list.selected(), fresh);
});

test("unsaved is measured against a snapshot, and keys follow identity", () => {
  const saved = { name: "a" };
  const snapshots = new WeakMap();
  snapshotItems(snapshots, [saved]);
  assert.equal(itemDirty(snapshots, saved), false);
  saved.name = "b";
  assert.equal(itemDirty(snapshots, saved), true);
  assert.equal(itemDirty(snapshots, { name: "never saved" }), true);
  assert.equal(identityKey(saved), identityKey(saved));
  assert.notEqual(identityKey(saved), identityKey({ name: "b" }));
});
