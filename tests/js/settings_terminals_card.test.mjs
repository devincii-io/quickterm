// The simple profile editor, drawn against a small DOM stand-in: a card shows
// a name, a command (or a host), a start command and a remove control, with
// everything else behind one "More"; drawing it changes nothing in the draft;
// and typing a command re-infers the type in place, without a redraw.
import test from "node:test";
import assert from "node:assert/strict";

class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.listeners = {};
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.value = "";
    this.title = "";
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
    this.children = [];
    this._text = String(value);
  }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set innerHTML(_) { /* icon paths */ }
  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === "string") { this._text += node; continue; }
      if (node.parentNode) node.parentNode.children = node.parentNode.children.filter((n) => n !== node);
      node.parentNode = this;
      this.children.push(node);
    }
  }
  replaceWith(node) {
    const parent = this.parentNode;
    const at = parent.children.indexOf(this);
    node.parentNode = parent;
    parent.children[at] = node;
    this.parentNode = null;
  }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, init = {}) {
    for (const fn of this.listeners[type] || []) fn({ type, target: this, stopPropagation() {}, preventDefault() {}, ...init });
  }
  focus() {}
  scrollIntoView() {}
}

function all(root, predicate, out = []) {
  for (const child of root.children) {
    if (predicate(child)) out.push(child);
    all(child, predicate, out);
  }
  return out;
}
const byClass = (root, name) => all(root, (node) => node.classList.contains(name));
const fieldNamed = (card, label) => byClass(card, "settings-field")
  .find((field) => field.children[0]?.textContent === label);
const controlOf = (field) => field.children[1];

let created = [];
globalThis.document = {
  createElement(tag) { const node = new Node(tag); created.push(node); return node; },
  createElementNS(_, tag) { return new Node(tag); },
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const { make } = await import("../../quickterm/frontend/js/panel_shared.js");
const { renderTerminalSettings } = await import("../../quickterm/frontend/js/panel_settings_terminals.js");

const INVENTORY = {
  types: [
    { id: "claude-code", label: "Claude Code", executable: "C:\\bin\\claude.exe", available: true },
    { id: "powershell-core", label: "PowerShell 7", executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", available: true },
    { id: "wsl", label: "WSL", executable: "C:\\Windows\\System32\\wsl.exe", available: true },
    { id: "ssh", label: "SSH (PuTTY plink)", executable: "C:\\putty\\plink.exe", available: true },
    { id: "custom", label: "Custom command", executable: null, available: true },
  ],
  wsl_distributions: ["Ubuntu"],
};

function profile(fields) {
  return {
    name: "", description: "", cmd: "", args: [], env: {}, keybinding: null, autostart: false,
    terminal_type: null, wsl_distro: null, start_command: null, claude_mode: null,
    ssh_host: null, ssh_port: null, ssh_user: null, ssh_key: null, ...fields,
  };
}

function render(profiles) {
  created = [];
  const draft = { default_profile: profiles[0]?.name || "", profiles };
  let rerenders = 0;
  const host = make("div", "settings-content");
  const panel = {
    settingsDraft: draft,
    terminalInventory: INVENTORY,
    _sectionHeading: (title) => make("div", "section-heading", title),
    _button: (label, className) => {
      const button = make("button", className, label);
      button.type = "button";
      return button;
    },
    _field: (label, control) => {
      const field = make("label", "settings-field");
      field.append(make("span", "field-label", label), control);
      return field;
    },
    _textInput: (value, placeholder) => {
      const input = make("input", "ui-input");
      input.value = value == null ? "" : value;
      input.placeholder = placeholder;
      return input;
    },
    _terminalLabel: (item) => item.terminal_type || "custom",
  };
  renderTerminalSettings.call(panel, host, () => { rerenders += 1; });
  const cards = byClass(host, "terminal-profile-card");
  return { draft, host, cards, rerenders: () => rerenders, panel };
}

const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

test("a card shows a name, a command, a start command and remove; the rest waits behind More", () => {
  const profiles = [
    profile({ name: "Dev", cmd: PWSH, args: ["-NoLogo"], terminal_type: "powershell-core", start_command: "uv run dev", env: { A: "1" }, keybinding: "ctrl+alt+1" }),
    profile({ name: "Box", terminal_type: "ssh", ssh_host: "box", ssh_user: "deploy", ssh_port: 2222 }),
    profile({ name: "Py", cmd: "python", args: ["-m", "http.server"], terminal_type: "custom" }),
  ];
  const before = JSON.stringify(profiles);
  const { cards } = render(profiles);
  assert.equal(JSON.stringify(profiles), before, "drawing the editor changes nothing in the draft");
  assert.equal(created.some((node) => node.tagName === "SELECT"), false, "no native select anywhere");

  const labels = (card) => byClass(byClass(card, "profile-main")[0], "settings-field")
    .filter((field) => !field.hidden).map((field) => field.children[0].textContent);
  const [dev, box, py] = cards;
  assert.deepEqual(labels(dev), ["Profile name", "Command", "Start command"]);
  assert.deepEqual(labels(box), ["Profile name", "Host", "Remote command"], "a remote card shows its host up front");
  assert.deepEqual(labels(py), ["Profile name", "Command"], "a custom command takes no start command");
  for (const card of cards) {
    assert.equal(byClass(card, "profile-remove").length, 1);
    assert.equal(byClass(card, "profile-more")[0].hidden, true, "More starts closed on a healthy card");
    assert.equal(byClass(card, "profile-more-toggle")[0].getAttribute("aria-expanded"), "false");
    assert.equal(byClass(card, "field-hint").length, 0, "no hint lines under the fields");
  }
  assert.equal(controlOf(fieldNamed(py, "Command")).value, "python -m http.server", "a custom card types its whole command line");
  assert.equal(controlOf(fieldNamed(dev, "Command")).value, PWSH, "a shell card types its executable");
  assert.equal(controlOf(fieldNamed(dev, "Arguments")).value, "-NoLogo");
  assert.ok(fieldNamed(dev, "Global shortcut"), "the shortcut is still there, behind More");
  assert.ok(fieldNamed(dev, "Environment variables"));
  assert.ok(fieldNamed(box, "Port") && fieldNamed(box, "Private key"));
});

test("More opens by itself for a problem or a type the command does not show", () => {
  const { cards } = render([
    profile({ name: "Empty", cmd: "", terminal_type: "custom" }),
    profile({ name: "Odd", cmd: "pwsh.exe", terminal_type: "custom" }),
    profile({ name: "Bad env", cmd: PWSH, terminal_type: "powershell-core", args: ["-NoLogo"], env: { "A=B": "x" } }),
    profile({ name: "Fine", cmd: "wsl.exe", terminal_type: "wsl" }),
  ]);
  // Cards are grouped by kind in inventory order, so read them by name.
  const open = Object.fromEntries(cards.map((card) => [
    controlOf(fieldNamed(card, "Profile name")).value,
    !byClass(card, "profile-more")[0].hidden,
  ]));
  assert.deepEqual(open, { Empty: true, Odd: true, "Bad env": true, Fine: false });
  const empty = cards.find((card) => controlOf(fieldNamed(card, "Profile name")).value === "Empty");
  assert.equal(byClass(empty, "config-problem").length, 1);
  // WSL builds its own arguments, so it offers no field for them.
  const fine = cards.find((card) => controlOf(fieldNamed(card, "Profile name")).value === "Fine");
  assert.equal(fieldNamed(fine, "Arguments").hidden, true);
  assert.equal(fieldNamed(fine, "Linux distribution").hidden, false);
  assert.equal(fieldNamed(fine, "Claude launch").hidden, true);
});

test("typing a command line re-infers the type in place, without a redraw", () => {
  const custom = profile({ name: "Mine", cmd: "", terminal_type: "custom" });
  const { cards, rerenders } = render([custom]);
  const card = cards[0];
  const command = controlOf(fieldNamed(card, "Command"));
  const start = fieldNamed(card, "Start command");
  assert.equal(start.hidden, true);

  command.value = "pwsh -NoLogo";
  command.fire("input");
  assert.equal(custom.terminal_type, "powershell-core");
  assert.equal(custom.cmd, "pwsh");
  assert.deepEqual(custom.args, ["-NoLogo"]);
  assert.equal(start.hidden, false, "a shell takes a start command, so its field appears");
  assert.equal(card.dataset.kind, "powershell-core");

  command.value = "\"C:\\Program Files\\Git\\bin\\bash.exe\"";
  command.fire("input");
  assert.equal(custom.terminal_type, "git-bash");
  assert.equal(custom.cmd, "C:\\Program Files\\Git\\bin\\bash.exe");

  // Claude Code stays opt-in and a host is not a command: neither is inferred.
  for (const line of ["claude --continue", "plink -ssh box"]) {
    command.value = line;
    command.fire("input");
    assert.equal(custom.terminal_type, "custom", line);
  }
  assert.equal(start.hidden, true);
  assert.equal(rerenders(), 0, "the card was patched, never redrawn");
  assert.equal(controlOf(fieldNamed(card, "Command")), command, "the field under the caret is the same element");
});

test("editing a shell's executable keeps its own arguments when it comes back to that shell", () => {
  const dev = profile({ name: "Dev", cmd: "pwsh.exe", args: ["-NoLogo", "-NoProfile"], terminal_type: "powershell-core" });
  const { cards } = render([dev]);
  const command = controlOf(fieldNamed(cards[0], "Command"));
  const args = controlOf(fieldNamed(cards[0], "Arguments"));

  command.value = "python.exe";
  command.fire("input");
  assert.equal(dev.terminal_type, "custom");
  assert.deepEqual(dev.args, [], "PowerShell's arguments are not handed to another program");
  assert.equal(args.value, "");

  command.value = PWSH;
  command.fire("input");
  assert.equal(dev.terminal_type, "powershell-core");
  assert.deepEqual(dev.args, ["-NoLogo", "-NoProfile"]);
  assert.equal(args.value, "-NoLogo -NoProfile");
});

test("remove splices the profile it belongs to and hands the default on", () => {
  const a = profile({ name: "A", cmd: "cmd.exe", terminal_type: "command-prompt" });
  const b = profile({ name: "B", cmd: "cmd.exe", terminal_type: "command-prompt" });
  const { draft, cards, rerenders } = render([a, b]);
  byClass(cards[0], "profile-remove")[0].fire("click");
  assert.deepEqual(draft.profiles, [b]);
  assert.equal(draft.default_profile, "B");
  assert.equal(rerenders(), 1);
});

test("the More disclosure survives a redraw", () => {
  const dev = profile({ name: "Dev", cmd: "cmd.exe", terminal_type: "command-prompt" });
  const first = render([dev]);
  byClass(first.cards[0], "profile-more-toggle")[0].fire("click");
  assert.equal(byClass(first.cards[0], "profile-more")[0].hidden, false);
  // The same Panels object draws the next render; the choice is kept per profile.
  created = [];
  const host = make("div");
  renderTerminalSettings.call(first.panel, host, () => {});
  const again = byClass(host, "terminal-profile-card")[0];
  assert.equal(byClass(again, "profile-more")[0].hidden, false);
});
