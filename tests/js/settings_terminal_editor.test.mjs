// The terminal detail editor in Settings > Terminals, drawn through
// renderConnections against a small DOM stand-in. It pins what the 3.x card
// tests pinned for the old editor: arguments come back when the command
// returns to its original kind, drawing stamps no type on a hand-edited
// profile and only a type-bound edit does, a typed profile keeps its type,
// and removing the default terminal clears `default_profile`.
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
const { renderConnections } = await import("../../quickterm/frontend/js/panel_connections.js");

function walk(root, out = []) {
  for (const child of root.children) {
    out.push(child);
    walk(child, out);
  }
  return out;
}
const byLabel = (root, label) => walk(root).find((node) => node.attributes["aria-label"] === label) || null;
const byClass = (root, name) => walk(root).filter((node) => node.classList.contains(name));

function profile(fields) {
  return {
    name: "", description: "", cmd: "", args: [], env: {}, keybinding: null, autostart: false,
    terminal_type: null, wsl_distro: null, start_command: null, agent_mode: null,
    ssh_host: null, ssh_port: null, ssh_user: null, ssh_key: null, ssh_client: null, ssh_proxy_jump: null,
    ...fields,
  };
}

// A Panels stand-in with the real field helpers and the list wiring.
function render(profiles, { focus = profiles[0]?.name, defaultProfile = profiles[0]?.name || "" } = {}) {
  const draft = { default_profile: defaultProfile, summon_hotkey: "ctrl+alt+grave", profiles };
  const host = new El("div");
  globalThis.document.body.append(host);
  const panel = {
    settingsDraft: draft,
    terminalInventory: { types: [], wsl_distributions: [] },
    app: { profiles: [] },
    services: { getSshHosts: async () => ({ hosts: [] }) },
    configFocus: focus ? { kind: "terminal", name: focus } : null,
    savedSnapshots: new WeakMap(),
    _sectionHeading: Panels.prototype._sectionHeading,
    _button: Panels.prototype._button,
    _field: Panels.prototype._field,
    _textInput: Panels.prototype._textInput,
    // The confirmation is the popover's business; here it confirms at once.
    _confirmNear: (_button, _message, _label, action) => action(),
  };
  renderConnections.call(panel, host);
  const pane = panel._configList.pane;
  const type = (label, value) => {
    const input = byLabel(pane, label);
    assert.ok(input, `${label} field is drawn`);
    input.value = value;
    input.fire("input");
  };
  return { panel, draft, host, pane, type, list: panel._configList };
}

test("back on its original kind, a command gets its own arguments again", () => {
  const pwsh = profile({ name: "Dev", cmd: "pwsh.exe", args: ["-NoLogo", "-NoProfile"], terminal_type: "powershell-core" });
  const { type } = render([pwsh]);
  type("Command", "python.exe");
  assert.equal(pwsh.terminal_type, "custom");
  assert.deepEqual(pwsh.args, [], "another kind starts from that kind's defaults");
  type("Command", "pwsh.exe");
  assert.equal(pwsh.terminal_type, "powershell-core");
  assert.deepEqual(pwsh.args, ["-NoLogo", "-NoProfile"]);
  type("Command", "powershell.exe");
  assert.deepEqual(pwsh.args, ["-NoLogo"], "Windows PowerShell's defaults");
});

test("drawing a hand-edited profile stamps nothing; a type-bound edit does", () => {
  const hand = profile({ name: "Hand", cmd: "pwsh.exe" });
  const before = JSON.stringify(hand);
  const { type } = render([hand]);
  assert.equal(JSON.stringify(hand), before, "looking at a profile must not mark it unsaved");
  type("Description", "for builds");
  assert.equal(hand.terminal_type, null, "a field every type has stamps no type");
  type("Start command", "uv run dev");
  assert.equal(hand.terminal_type, "powershell-core");
  assert.equal(hand.start_command, "uv run dev");
});

test("a typed profile keeps its type when edited", () => {
  const bash = profile({ name: "Bash", cmd: "bash.exe", terminal_type: "git-bash" });
  const { type } = render([bash]);
  type("Start command", "ls");
  type("Description", "repo shell");
  assert.equal(bash.terminal_type, "git-bash");
  const telnet = profile({ name: "Switch", terminal_type: "telnet", connection: { host: "sw1" } });
  const second = render([telnet]);
  second.type("Port", "2323");
  assert.equal(telnet.terminal_type, "telnet");
  assert.equal(telnet.connection.port, "2323", "connection values are stored as typed");
});

test("the global shortcut field says what it holds and stamps no type", () => {
  const hand = profile({ name: "Hand", cmd: "pwsh.exe" });
  const { pane } = render([hand]);
  const field = byLabel(pane, "Global shortcut: Not set");
  assert.ok(field, "the shortcut field says it is not set");
  assert.equal(hand.terminal_type, null);
  assert.equal(byClass(pane, "shortcut-error").length, 0);
});

test("removing an environment variable keeps the keyboard in the editor", () => {
  const shell = profile({ name: "Env", cmd: "pwsh.exe", env: { A: "1", B: "2" } });
  const { pane } = render([shell]);
  const removes = walk(pane).filter((node) => node.attributes["aria-label"] === "Remove variable");
  assert.equal(removes.length, 2);
  removes[0].fire("click");
  assert.deepEqual(shell.env, { B: "2" });
  const focused = globalThis.document.activeElement;
  assert.equal(focused?.attributes["aria-label"], "Environment variable name");
  assert.equal(focused.value, "B", "the row that moved up takes the focus");
  const last = walk(pane).find((node) => node.attributes["aria-label"] === "Remove variable");
  last.fire("click");
  assert.equal(globalThis.document.activeElement.textContent, "Add variable");
});

test("removing the default terminal clears default_profile", async () => {
  const first = profile({ name: "First", cmd: "pwsh.exe", terminal_type: "powershell-core" });
  const second = profile({ name: "Second", cmd: "cmd.exe", terminal_type: "command-prompt" });
  const { draft, host } = render([first, second], { defaultProfile: "First" });
  const remove = byClass(host, "config-row-remove")[0];
  remove.fire("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(draft.profiles.map((item) => item.name), ["Second"]);
  // 3.x handed the default to the first profile left; 4.0 clears it, which
  // the General tab shows as "First saved local terminal".
  assert.equal(draft.default_profile, "");
});

test("renaming one terminal onto another's name marks both rows, and renaming back clears both", () => {
  const a = profile({ name: "A", cmd: "pwsh.exe", terminal_type: "powershell-core" });
  const b = profile({ name: "Git Bash", cmd: "bash.exe", terminal_type: "git-bash" });
  const { host, type } = render([a, b]);
  const marked = () => byClass(host, "config-row").map((row) => row.classList.contains("has-problem"));
  type("Name", "Git Bash");
  assert.deepEqual(marked(), [true, true]);
  type("Name", "A");
  assert.deepEqual(marked(), [false, false]);
});
