// Settings > Agents, drawn against a small DOM stand-in: the tab shows only
// Claude Code and Codex, and the environment rows keep the keyboard in the
// editor when one is removed.
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
globalThis.window.parent = globalThis.window;
globalThis.location = { search: "", pathname: "/" };
globalThis.requestAnimationFrame = (fn) => fn();

const { Panels } = await import("../../quickterm/frontend/js/panels.js");
const { renderAgentSettings, renderEnvironment } = await import("../../quickterm/frontend/js/panel_settings_agents.js");

function walk(root, out = []) {
  for (const child of root.children) {
    out.push(child);
    walk(child, out);
  }
  return out;
}
const byLabel = (root, label) => walk(root).find((node) => node.attributes["aria-label"] === label) || null;
const byClass = (root, name) => walk(root).filter((node) => node.classList.contains(name));


function panelFor(draft) {
  return {
    settingsDraft: draft,
    terminalInventory: { types: [], wsl_distributions: [] },
    services: { getAgentCatalog: async () => null },
    _sectionHeading: Panels.prototype._sectionHeading,
    _button: Panels.prototype._button,
    _field: Panels.prototype._field,
    _textInput: Panels.prototype._textInput,
  };
}

test("the Agents tab is Claude Code and Codex, nothing saved besides them", () => {
  const draft = { shell: "powershell" };
  const host = new El("div");
  globalThis.document.body.append(host);
  renderAgentSettings.call(panelFor(draft), host);
  const rows = walk(host).filter((node) => node.dataset.setting?.startsWith("agents."));
  assert.deepEqual(rows.map((node) => node.dataset.setting), ["agents.claude-code", "agents.codex"]);
  assert.deepEqual(Object.keys(draft.agents), ["claude-code", "codex"], "both entries exist after drawing");
  assert.equal(byClass(host, "config-row").length, 0, "no saved-terminal list");
});

test("removing an environment variable keeps the keyboard in the editor", () => {
  const settings = { env: { A: "1", B: "2" } };
  const host = new El("div");
  globalThis.document.body.append(host);
  let touched = 0;
  host.append(renderEnvironment.call(panelFor({}), settings, () => { touched += 1; }));
  const removes = walk(host).filter((node) => node.attributes["aria-label"] === "Remove variable");
  assert.equal(removes.length, 2);
  removes[0].fire("click");
  assert.deepEqual(settings.env, { B: "2" });
  assert.equal(touched, 1);
  const focused = globalThis.document.activeElement;
  assert.equal(focused?.attributes["aria-label"], "Environment variable name");
  assert.equal(focused.value, "B", "the row that moved up takes the focus");
  const last = walk(host).find((node) => node.attributes["aria-label"] === "Remove variable");
  last.fire("click");
  assert.equal(globalThis.document.activeElement.textContent, "Add variable");
});
