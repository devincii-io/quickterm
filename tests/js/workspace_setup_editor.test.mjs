// Workspace settings' setup editors (panel_setup_fields.js), drawn against a
// small DOM stand-in: values masked until focused, problems shown inline,
// and the start list's moves keep the keyboard on the pressed arrow.
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
    this.open = false;
    this.value = "";
    this.type = "";
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
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
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
  get nextElementSibling() {
    const kids = this.parentNode?.children || [];
    return kids[kids.indexOf(this) + 1] || null;
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
  focus() {
    const previous = globalThis.document.activeElement;
    if (previous && previous !== this) previous.fire("blur");
    globalThis.document.activeElement = this;
    this.fire("focus");
  }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
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

const { envEditor, startupEditor } = await import("../../quickterm/frontend/js/panel_setup_fields.js");
const { startupItems } = await import("../../quickterm/frontend/js/workspace_setup.js");

function walk(root, out = []) {
  for (const child of root.children) {
    out.push(child);
    walk(child, out);
  }
  return out;
}
const byLabel = (root, label) => walk(root).filter((node) => node.attributes["aria-label"] === label);
const byClass = (root, name) => walk(root).filter((node) => node.classList.contains(name));
const type = (input, text) => {
  input.value = text;
  input.fire("input");
};

test("a value is masked until its field has the keyboard", () => {
  const editor = envEditor({ env: { TOKEN: "s3cret" } });
  document.body.append(editor.el);
  const [value] = byLabel(editor.el, "Variable value");
  assert.equal(value.value, "s3cret");
  assert.equal(value.type, "password");
  value.focus();
  assert.equal(value.type, "text");
  byLabel(editor.el, "Variable name")[0].focus();
  assert.equal(value.type, "password");
});

test("name rules are checked inline and the saved object follows the rows", () => {
  const seen = [];
  const editor = envEditor({ env: { A: "1" }, onChange: (env) => seen.push(env) });
  document.body.append(editor.el);
  const add = byClass(editor.el, "setup-env-add")[0];
  add.fire("click");
  const names = byLabel(editor.el, "Variable name");
  assert.equal(document.activeElement, names[1], "a new row takes the keyboard");
  type(names[1], "QUICKTERM_X");
  const problems = byClass(editor.el, "setup-problem").filter((node) => !node.hidden);
  assert.equal(problems.length, 1);
  assert.match(problems[0].textContent, /QuickTerm's own/);
  assert.equal(names[1].attributes["aria-invalid"], "true");
  assert.equal(editor.check().ok, false);
  type(names[1], "B");
  type(byLabel(editor.el, "Variable value")[1], "2");
  assert.equal(editor.check().ok, true);
  assert.equal("aria-invalid" in names[1].attributes, false);
  assert.deepEqual(editor.value(), { A: "1", B: "2" });
  assert.deepEqual(seen.at(-1), { A: "1", B: "2" });
});

test("the start list moves an item one step and keeps the keyboard on the arrow", () => {
  let changes = 0;
  const editor = startupEditor({
    items: startupItems([{ kind: "shell", name: "dev" }, { kind: "shell", name: "logs" }, { kind: "shell", name: "tests" }]),
    catalog: async () => null,
    onChange: () => { changes += 1; },
  });
  document.body.append(editor.el);
  const names = () => editor.value().map((item) => item.name);
  const ups = () => byClass(editor.el, "setup-item-up");
  const downs = () => byClass(editor.el, "setup-item-down");
  assert.equal(ups()[0].disabled, true, "the first cannot go up");
  assert.equal(downs()[2].disabled, true, "the last cannot go down");
  const up = ups()[2];
  up.fire("click");
  assert.deepEqual(names(), ["dev", "tests", "logs"]);
  assert.equal(document.activeElement, up);
  up.fire("click");
  assert.deepEqual(names(), ["tests", "dev", "logs"]);
  assert.equal(up.disabled, true);
  assert.equal(document.activeElement.classList.contains("setup-item-down"), true, "at the top, the other arrow");
  assert.equal(changes, 2);
  const numbers = byClass(editor.el, "setup-item-number").map((node) => node.textContent);
  assert.deepEqual(numbers, ["1", "2", "3"]);
});

test("removing an item hands the keyboard to the next one; a command shows for a shell only", async () => {
  const editor = startupEditor({
    items: startupItems([{ kind: "shell", name: "dev", command: "npm run dev" }, { kind: "codex", name: "review" }]),
    catalog: async () => null,
  });
  document.body.append(editor.el);
  const fields = byClass(editor.el, "setup-item-command-field");
  assert.deepEqual(fields.map((field) => field.hidden), [false, true]);
  assert.equal(byLabel(editor.el, "Command")[0].value, "npm run dev");
  byLabel(editor.el, "Remove")[0].fire("click");
  assert.deepEqual(editor.value().map((item) => item.name), ["review"]);
  assert.equal(document.activeElement.value, "review");
  byLabel(editor.el, "Remove")[0].fire("click");
  assert.deepEqual(editor.value(), []);
  assert.equal(byClass(editor.el, "setup-start-empty")[0].hidden, false);
  assert.equal(document.activeElement.classList.contains("setup-start-add"), true);
});

test("an agent item shows the agent settings' mode until one is chosen, and writes nothing by drawing", async () => {
  const editor = startupEditor({
    items: startupItems([{ kind: "claude-code" }, { kind: "codex", agent_mode: "fork" }]),
    catalog: async () => ({ types: [{ id: "claude-code", options: [] }, { id: "codex", options: [] }] }),
    agentSettings: (kind) => (kind === "claude-code" ? { agent_mode: "new" } : null),
  });
  document.body.append(editor.el);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const modes = byLabel(editor.el, "Launch mode").map((button) => button.textContent);
  assert.deepEqual(modes, ["new conversation", "fork a session"]);
  assert.deepEqual(editor.value().map((item) => item.agent_mode), [null, "fork"]);
  assert.equal("claude_mode" in editor.value()[0], false);
});

test("a command on two lines is marked inline", () => {
  const editor = startupEditor({ items: startupItems([{ kind: "shell" }]), catalog: async () => null });
  document.body.append(editor.el);
  const [command] = byLabel(editor.el, "Command");
  type(command, "a\nb");
  assert.equal(command.attributes["aria-invalid"], "true");
  assert.equal(editor.check().ok, false);
  assert.equal(editor.focusProblem(), true);
  assert.equal(document.activeElement, command);
});
