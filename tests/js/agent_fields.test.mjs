// The agent option fields are generated from the GET /api/system/agents
// schema, so a fake catalog stands in for the backend. What must hold: every
// option kind renders as its control (never a native select), an emptied value
// deletes its key, and the codex bypass conflict is said where it happens.
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
    this.checked = false;
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
      if (typeof node === "string") { this._text += node; continue; }
      node.parentNode?.removeChild(node);
      this.children.push(node);
      node.parentNode = this;
    }
  }
  removeChild(node) {
    this.children = this.children.filter((child) => child !== node);
    node.parentNode = null;
  }
  remove() { this.parentNode?.removeChild(this); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== fn); }
  fire(type) {
    for (const fn of [...(this.listeners[type] || [])]) fn({ type, target: this, preventDefault() {}, stopPropagation() {} });
  }
  focus() {}
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }; }
  scrollIntoView() {}
}

globalThis.document = {
  body: new El("body"),
  createElement: (tag) => new El(tag),
  createElementNS: (_, tag) => new El(tag),
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1200, innerHeight: 800 };

const { renderAgentFields } = await import("../../quickterm/frontend/js/panel_agent_fields.js");

function walk(root, out = []) {
  for (const child of root.children) {
    out.push(child);
    walk(child, out);
  }
  return out;
}
const byClass = (root, name) => walk(root).filter((node) => node.classList.contains(name));
const option = (root, key) => walk(root).find((node) => node.dataset.option === key);
const tagged = (root, tag) => walk(root).find((node) => node.tagName === tag);

// Opens a configChoice and runs the menu row with this label.
function choose(button, label) {
  button.fire("click");
  const row = byClass(document.body, "qt-menu-item").find((node) => byClass(node, "qt-menu-label")[0].textContent === label);
  assert.ok(row, `menu offers ${label}`);
  row.fire("click");
}

const CODEX = {
  id: "codex", label: "Codex", available: true, default_mode: "new",
  modes: [
    { value: "new", label: "new conversation" }, { value: "continue", label: "continue latest" },
    { value: "resume", label: "choose session" }, { value: "fork", label: "fork a session" },
    { value: "agents", label: "agent manager" },
  ],
  options: [
    { key: "model", label: "Model", kind: "combo", choices: [{ value: "gpt-5-codex", label: "gpt-5-codex", detail: "medium" }], hint: "" },
    { key: "approval", label: "Approval", kind: "choice", choices: [{ value: "on-request", label: "on-request" }, { value: "never", label: "never" }], hint: "" },
    { key: "sandbox", label: "Sandbox", kind: "choice", choices: [{ value: "read-only", label: "read-only" }, { value: "workspace-write", label: "workspace-write" }], hint: "" },
    { key: "bypass", label: "Bypass approvals and sandbox", kind: "toggle", hint: "" },
    { key: "config_profile", label: "Config profile", kind: "text", hint: "" },
    { key: "add_dirs", label: "Extra folders", kind: "lines", hint: "" },
    { key: "oss", label: "Local model", kind: "toggle", advanced: true, hint: "" },
  ],
};

function render(profile, type = CODEX, options = {}) {
  const container = new El("div");
  document.body.append(container);
  const changes = [];
  renderAgentFields(container, profile, type, { onChange: (key) => changes.push(key), ...options });
  return { container, changes };
}

test("every option kind renders as its own control, and advanced ones wait under a disclosure", () => {
  const profile = { terminal_type: "codex", agent: {} };
  const { container } = render(profile);
  assert.ok(option(container, "model").children.some((node) => node.classList.contains("config-combo")));
  assert.ok(byClass(option(container, "approval"), "config-choice").length, "a choice is a menu.js button");
  assert.equal(option(container, "bypass").tagName, "LABEL");
  assert.equal(tagged(option(container, "config_profile"), "INPUT").tagName, "INPUT");
  assert.ok(tagged(option(container, "add_dirs"), "TEXTAREA"));
  const details = tagged(container, "DETAILS");
  assert.ok(details.contains(option(container, "oss")), "an advanced option sits under the disclosure");
  assert.equal(walk(container).some((node) => node.tagName === "SELECT"), false);
  assert.ok(option(container, "agent_mode"), "the launch mode comes first");
});

test("drawing the fields changes nothing in the profile", () => {
  const profile = { terminal_type: "codex" };
  render(profile);
  assert.deepEqual(profile, { terminal_type: "codex" });
});

test("advanced options and the mode can be placed elsewhere in the editor", () => {
  const modeHost = new El("div");
  const advancedHost = new El("div");
  const { container } = render({ terminal_type: "codex", agent: {} }, CODEX, { modeHost, advancedHost });
  assert.ok(option(modeHost, "agent_mode"));
  assert.ok(option(advancedHost, "oss"));
  assert.equal(tagged(container, "DETAILS"), undefined);
});

test("values are written into profile.agent, and an empty value deletes the key", () => {
  const profile = { terminal_type: "codex", agent: { model: "o3" } };
  const { container, changes } = render(profile);

  const text = tagged(option(container, "config_profile"), "INPUT");
  text.value = "work";
  text.fire("input");
  assert.equal(profile.agent.config_profile, "work");
  text.value = "";
  text.fire("input");
  assert.equal("config_profile" in profile.agent, false);

  const combo = tagged(option(container, "model"), "INPUT");
  assert.equal(combo.value, "o3");
  combo.value = "  ";
  combo.fire("input");
  assert.equal("model" in profile.agent, false);

  const lines = tagged(option(container, "add_dirs"), "TEXTAREA");
  lines.value = "C:\\one\n\n  C:\\two  \n";
  lines.fire("input");
  assert.equal(profile.agent.add_dirs, "C:\\one\nC:\\two");

  const toggle = tagged(option(container, "bypass"), "INPUT");
  toggle.checked = true;
  toggle.fire("change");
  assert.equal(profile.agent.bypass, "true");
  toggle.checked = false;
  toggle.fire("change");
  assert.equal("bypass" in profile.agent, false, "an unchecked toggle is absent, not \"false\"");

  const sandbox = byClass(option(container, "sandbox"), "config-choice")[0];
  choose(sandbox, "read-only");
  assert.equal(profile.agent.sandbox, "read-only");
  choose(sandbox, "CLI default");
  assert.equal("sandbox" in profile.agent, false);
  assert.ok(changes.includes("sandbox"));
});

test("the codex bypass conflict is said inline, as the server says it", () => {
  const profile = { terminal_type: "codex", agent: { sandbox: "read-only" } };
  const { container } = render(profile);
  assert.equal(byClass(container, "config-problem").length, 0);
  const toggle = tagged(option(container, "bypass"), "INPUT");
  toggle.checked = true;
  toggle.fire("change");
  const problems = byClass(container, "config-problem").map((node) => node.textContent);
  assert.deepEqual(problems, ["bypass replaces approval and sandbox; clear them first"]);
  choose(byClass(option(container, "sandbox"), "config-choice")[0], "CLI default");
  assert.equal(byClass(container, "config-problem").length, 0);
});

test("the launch mode comes from the catalog and keeps the legacy key for Claude Code", () => {
  const codex = { terminal_type: "codex", agent: {} };
  const first = render(codex);
  choose(byClass(option(first.container, "agent_mode"), "config-choice")[0], "fork a session");
  assert.equal(codex.agent_mode, "fork");
  assert.equal("claude_mode" in codex, false);

  const claude = { terminal_type: "claude-code", claude_mode: "continue", agent: {} };
  const type = { id: "claude-code", modes: [{ value: "new", label: "new conversation" }, { value: "agents", label: "agent manager" }], options: [] };
  const second = render(claude, type);
  const mode = byClass(option(second.container, "agent_mode"), "config-choice")[0];
  assert.equal(mode.textContent, "continue", "an older profile shows its legacy mode");
  choose(mode, "agent manager");
  assert.equal(claude.agent_mode, "agents");
  assert.equal(claude.claude_mode, "agents");
});

test("without a catalog the launch mode still works, with a note", () => {
  const profile = { terminal_type: "claude-code", agent: { model: "opus" } };
  const { container } = render(profile, null);
  const mode = byClass(option(container, "agent_mode"), "config-choice")[0];
  assert.equal(mode.textContent, "continue latest");
  choose(mode, "choose session");
  assert.equal(profile.agent_mode, "resume");
  assert.match(byClass(container, "settings-note")[0].textContent, /could not be loaded/);
  assert.equal(profile.agent.model, "opus", "saved options are kept");
});
