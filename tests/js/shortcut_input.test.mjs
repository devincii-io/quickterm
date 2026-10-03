// A global shortcut is captured by pressing it. The binding comes from the
// physical key (e.code) in the grammar hotkeys.parse_binding reads, and the
// warnings say what validate_config would refuse and what the key takes away.
import test from "node:test";
import assert from "node:assert/strict";

import {
  bindingFromEvent, bindingLabel, captureActive, normalizeBinding, shortcutInput, shortcutWarnings,
} from "../../quickterm/frontend/js/shortcut_input.js";
import { focusOwners, resetFocusOwners } from "../../quickterm/frontend/js/focus.js";

// Just enough DOM for one button: listeners, text, children and a class list.
function element(tag) {
  const listeners = {};
  const classes = new Set();
  const node = {
    tagName: tag.toUpperCase(), children: [], attributes: {}, dataset: {}, disabled: false, title: "", type: "",
    _text: "",
    classList: {
      add: (name) => classes.add(name),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    set className(value) { String(value).split(/\s+/).filter(Boolean).forEach((name) => classes.add(name)); },
    set textContent(value) { node.children = []; node._text = String(value); },
    get textContent() { return node._text + node.children.map((child) => child.textContent).join(""); },
    append(...kids) { node.children.push(...kids); },
    setAttribute(name, value) { node.attributes[name] = String(value); },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((item) => item !== fn); },
    fire(type) { for (const fn of [...(listeners[type] || [])]) fn({ type, target: node }); },
    focus() {},
  };
  return node;
}

const windowListeners = [];
globalThis.document = { createElement: element };
globalThis.window = {
  addEventListener(type, fn, capture) { windowListeners.push({ type, fn, capture }); },
  removeEventListener(type, fn) {
    const at = windowListeners.findIndex((item) => item.type === type && item.fn === fn);
    if (at >= 0) windowListeners.splice(at, 1);
  },
};

function key(init) {
  const event = {
    key: "", code: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
    prevented: false, stopped: false,
    preventDefault() { event.prevented = true; },
    stopImmediatePropagation() { event.stopped = true; },
    ...init,
  };
  for (const { type, fn, capture } of [...windowListeners]) if (type === "keydown" && capture) fn(event);
  return event;
}

function capture(value = "ctrl+alt+1") {
  const suspended = [];
  const changes = [];
  const input = shortcutInput({ value, label: "Test", suspend: (on) => suspended.push(on), onChange: (binding) => changes.push(binding) });
  return { input, suspended, changes };
}

test("capturing claims the keyboard, pauses global hotkeys and records the press", () => {
  resetFocusOwners();
  const { input, suspended, changes } = capture();
  assert.equal(input.el.textContent, "CtrlAlt1");
  input.el.fire("click");
  assert.equal(captureActive(), true);
  assert.deepEqual(focusOwners(), ["shortcut"]);
  assert.deepEqual(suspended, [true]);
  assert.match(input.el.textContent, /Press a shortcut/);

  const modifier = key({ key: "Control", code: "ControlLeft", ctrlKey: true });
  assert.equal(modifier.prevented, true, "the press is swallowed while modifiers are held");
  assert.equal(captureActive(), true);
  const press = key({ key: "s", code: "KeyS", altKey: true });
  assert.equal(press.prevented, true);
  assert.equal(press.stopped, true, "nothing else on the page sees the key");
  assert.deepEqual(changes, ["alt+s"]);
  assert.equal(input.value, "alt+s");
  assert.equal(captureActive(), false);
  assert.deepEqual(focusOwners(), []);
  assert.deepEqual(suspended, [true, false]);
  assert.equal(windowListeners.length, 0);
});

test("Escape cancels, Backspace clears, and plain Tab is let through", () => {
  resetFocusOwners();
  const { input, suspended, changes } = capture();
  input.el.fire("click");
  key({ key: "Escape", code: "Escape" });
  assert.deepEqual(changes, []);
  assert.equal(input.value, "ctrl+alt+1");

  input.el.fire("click");
  key({ key: "Backspace", code: "Backspace" });
  assert.deepEqual(changes, [null]);
  assert.match(input.el.textContent, /Not set/);

  input.el.fire("click");
  const tab = key({ key: "Tab", code: "Tab" });
  assert.equal(tab.prevented, false, "focus has to be able to leave");
  assert.equal(captureActive(), false);

  input.el.fire("click");
  input.el.fire("blur");
  assert.equal(captureActive(), false);
  assert.deepEqual(suspended, [true, false, true, false, true, false, true, false], "every exit resumes the hotkeys");
  assert.deepEqual(focusOwners(), []);
});

const press = (code, mods = {}) => bindingFromEvent({ code, key: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods })?.binding ?? null;
const ctrlAlt = { ctrlKey: true, altKey: true };

test("every key family maps from its physical code", () => {
  assert.equal(press("KeyA", ctrlAlt), "ctrl+alt+a");
  assert.equal(press("KeyZ", ctrlAlt), "ctrl+alt+z");
  assert.equal(press("Digit1", ctrlAlt), "ctrl+alt+1");
  assert.equal(press("Digit0", ctrlAlt), "ctrl+alt+0");
  assert.equal(press("F1", ctrlAlt), "ctrl+alt+f1");
  assert.equal(press("F24", ctrlAlt), "ctrl+alt+f24");
  assert.equal(press("F25", ctrlAlt), null, "beyond f24 is outside the grammar");
  assert.equal(press("Numpad7", ctrlAlt), "ctrl+alt+numpad7");
  const named = {
    Backquote: "grave", Minus: "minus", Equal: "equal", BracketLeft: "bracketleft", BracketRight: "bracketright",
    Backslash: "backslash", Semicolon: "semicolon", Quote: "quote", Comma: "comma", Period: "period", Slash: "slash",
    ArrowLeft: "left", ArrowUp: "up", ArrowRight: "right", ArrowDown: "down", Home: "home", End: "end",
    PageUp: "pageup", PageDown: "pagedown", Insert: "insert", Delete: "delete", Space: "space", Escape: "esc", Enter: "enter",
  };
  for (const [code, key] of Object.entries(named)) assert.equal(press(code, ctrlAlt), `ctrl+alt+${key}`, code);
  assert.equal(press("NumpadAdd", ctrlAlt), null);
  assert.equal(press("IntlBackslash", ctrlAlt), null);
});

test("the layout does not matter, only the physical key", () => {
  // QWERTZ: the key labelled Z sits where KeyY is, and types "z".
  assert.equal(bindingFromEvent({ code: "KeyY", key: "z", ctrlKey: true, altKey: true }).binding, "ctrl+alt+y");
});

test("modifiers come first in the order ctrl, alt, shift, win", () => {
  assert.equal(press("KeyK", { metaKey: true, shiftKey: true, altKey: true, ctrlKey: true }), "ctrl+alt+shift+win+k");
  assert.equal(press("KeyK", { shiftKey: true, metaKey: true }), "shift+win+k");
  assert.equal(normalizeBinding("Shift+Control+ALT+k"), "ctrl+alt+shift+k");
  assert.equal(bindingLabel("ctrl+alt+grave"), "Ctrl+Alt+`");
  assert.equal(bindingLabel("ctrl+shift+numpad3"), "Ctrl+Shift+Num 3");
  assert.equal(bindingLabel("ctrl+alt++"), "Ctrl+Alt++", "a legacy single + still reads as one key");
});

test("a lone modifier is not a binding, and plain Tab leaves the field", () => {
  for (const code of ["ControlLeft", "AltRight", "ShiftLeft", "MetaLeft"]) {
    assert.equal(press(code, { ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }), null, code);
  }
  assert.equal(press("Tab"), null);
  assert.equal(press("Tab", { shiftKey: true }), null, "Shift+Tab moves focus back");
  assert.equal(press("Tab", { ctrlKey: true }), "ctrl+tab");
});

test("a binding without Ctrl, Alt or Win is refused", () => {
  const rows = shortcutWarnings("shift+f5");
  assert.equal(rows[0].level, "error");
  assert.match(rows[0].text, /Ctrl, Alt or Win/);
  assert.deepEqual(shortcutWarnings("ctrl+alt+1"), []);
  assert.deepEqual(shortcutWarnings(""), []);
  assert.deepEqual(shortcutWarnings(null), []);
});

test("duplicates of the summon key or another terminal are refused, never against itself", () => {
  const profiles = [{ name: "Dev", keybinding: "ctrl+alt+1" }, { name: "Ops", keybinding: "Control+Alt+2" }];
  const own = shortcutWarnings("ctrl+alt+1", { summon: "ctrl+alt+grave", profiles, selfIndex: 0 });
  assert.deepEqual(own, []);
  const clash = shortcutWarnings("alt+ctrl+2", { summon: "ctrl+alt+grave", profiles, selfIndex: 0 });
  assert.equal(clash.length, 1);
  assert.match(clash[0].text, /Already used by "Ops"/);
  const summon = shortcutWarnings("ctrl+alt+grave", { summon: "ctrl+alt+grave", profiles, selfIndex: 1 });
  assert.match(summon[0].text, /summon shortcut/);
  // The summon key checks itself against every terminal.
  const fromSummon = shortcutWarnings("ctrl+alt+1", { profiles, selfIndex: -1 });
  assert.match(fromSummon[0].text, /Already used by "Dev"/);
});

test("a cold Alt key QuickTerm claims gets a warning, not an error", () => {
  const rows = shortcutWarnings("alt+k");
  assert.deepEqual(rows.map((row) => row.level), ["warning"]);
  assert.match(rows[0].text, /Alt\+K/);
  assert.equal(shortcutWarnings("alt+shift+right")[0].level, "warning");
  assert.equal(shortcutWarnings("ctrl+alt+k").length, 0, "Ctrl+Alt+K is not an in-app key");
});

test("a plain Alt key the shell or an agent binds gets a warning", () => {
  for (const binding of ["alt+v", "alt+p", "alt+h", "alt+b", "alt+f", "alt+0", "alt+9", "alt+minus"]) {
    const rows = shortcutWarnings(binding);
    assert.equal(rows.length, 1, binding);
    assert.equal(rows[0].level, "warning", binding);
    assert.match(rows[0].text, /shells and agents/, binding);
  }
  assert.deepEqual(shortcutWarnings("alt+shift+v").filter((row) => /shells/.test(row.text)), []);
});
