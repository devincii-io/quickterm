// A global shortcut is set by pressing it, never by typing "ctrl+alt+1".
//
// The binding grammar is shared with hotkeys.parse_binding: modifiers in the
// order ctrl, alt, shift, win, then one key name. Keys come from `e.code`, the
// physical key, so a binding does not change with the keyboard layout. Old
// configs may still hold a single punctuation character; it is shown as typed.

import * as api from "./api.js";
import { claimFocus, releaseFocus } from "./focus.js";
import { PASS_THROUGH_ALT, SHORTCUTS } from "./keys.js";
import { make } from "./panel_shared.js";

const MODIFIERS = ["ctrl", "alt", "shift", "win"];

const NAMED_CODES = {
  Backquote: "grave", Space: "space", Tab: "tab", Escape: "esc", Enter: "enter",
  Minus: "minus", Equal: "equal", Comma: "comma", Period: "period", Slash: "slash",
  Semicolon: "semicolon", Quote: "quote", BracketLeft: "bracketleft", BracketRight: "bracketright",
  Backslash: "backslash", ArrowLeft: "left", ArrowUp: "up", ArrowRight: "right", ArrowDown: "down",
  Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown", Insert: "insert", Delete: "delete",
};

const KEY_LABELS = {
  grave: "`", space: "Space", tab: "Tab", esc: "Esc", enter: "Enter", minus: "-", equal: "=",
  comma: ",", period: ".", slash: "/", semicolon: ";", quote: "'", bracketleft: "[",
  bracketright: "]", backslash: "\\", left: "←", up: "↑", right: "→", down: "↓", home: "Home",
  end: "End", pageup: "PgUp", pagedown: "PgDn", insert: "Ins", delete: "Del", backtick: "`",
};

const MODIFIER_LABELS = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", win: "Win" };

function keyFromCode(code) {
  const text = String(code || "");
  let match = /^Key([A-Z])$/.exec(text);
  if (match) return match[1].toLowerCase();
  match = /^Digit([0-9])$/.exec(text);
  if (match) return match[1];
  match = /^F([1-9]|1[0-9]|2[0-4])$/.exec(text);
  if (match) return `f${match[1]}`;
  match = /^Numpad([0-9])$/.exec(text);
  if (match) return `numpad${match[1]}`;
  return NAMED_CODES[text] || null;
}

/**
 * The tokens of a binding: modifiers first, the key last. A trailing "+" is the
 * legacy single character "+" (as in "ctrl+alt++"), not an empty token.
 */
export function bindingParts(binding) {
  const text = String(binding || "").trim().toLowerCase();
  if (!text) return [];
  const legacyPlus = text.endsWith("++") || text === "+";
  const parts = text.split("+").filter(Boolean).map((part) => (part === "control" ? "ctrl" : part));
  if (legacyPlus) parts.push("+");
  return parts;
}

/** One spelling per binding, so "Control+Alt+X" and "alt+ctrl+x" compare equal. */
export function normalizeBinding(binding) {
  const parts = bindingParts(binding);
  if (!parts.length) return "";
  const key = parts[parts.length - 1];
  const mods = MODIFIERS.filter((mod) => parts.slice(0, -1).includes(mod));
  return [...mods, key].join("+");
}

/** The chips a binding is shown as: ["Ctrl", "Alt", "`"]. */
export function bindingLabels(binding) {
  return bindingParts(binding).map((part, index, all) => {
    if (index < all.length - 1 && MODIFIER_LABELS[part]) return MODIFIER_LABELS[part];
    if (KEY_LABELS[part]) return KEY_LABELS[part];
    if (/^numpad[0-9]$/.test(part)) return `Num ${part.slice(6)}`;
    if (/^f[0-9]+$/.test(part)) return part.toUpperCase();
    return part.length === 1 ? part.toUpperCase() : part;
  });
}

export function bindingLabel(binding) {
  return bindingLabels(binding).join("+");
}

/**
 * The binding a keydown stands for, or null while only modifiers are held,
 * for a key outside the grammar, and for plain Tab (focus has to leave).
 */
export function bindingFromEvent(event) {
  const key = keyFromCode(event.code);
  if (!key) return null;
  const mods = [];
  if (event.ctrlKey) mods.push("ctrl");
  if (event.altKey) mods.push("alt");
  if (event.shiftKey) mods.push("shift");
  if (event.metaKey) mods.push("win");
  if (key === "tab" && !event.ctrlKey && !event.altKey && !event.metaKey) return null;
  const binding = [...mods, key].join("+");
  return { binding, label: bindingLabel(binding) };
}

const CLAIMED = new Map();
for (const shortcut of SHORTCUTS) {
  for (const binding of shortcut.bindings || []) CLAIMED.set(binding, shortcut);
}

/**
 * What is wrong with a global binding, as `{level, text}` rows. Errors are the
 * ones validate_config refuses on save; warnings say what the key takes away.
 * `selfIndex` is the profile being edited (-1 for the summon key itself).
 */
export function shortcutWarnings(binding, { summon = "", profiles = [], selfIndex = -1 } = {}) {
  const wanted = normalizeBinding(binding);
  if (!wanted) return [];
  const rows = [];
  const parts = wanted.split("+");
  const mods = parts.slice(0, -1);
  const key = parts[parts.length - 1];
  if (!mods.some((mod) => mod === "ctrl" || mod === "alt" || mod === "win")) {
    rows.push({ level: "error", text: "Add Ctrl, Alt or Win. Without one, the shortcut would swallow normal typing." });
  }
  if (selfIndex !== -1 && summon && normalizeBinding(summon) === wanted) {
    rows.push({ level: "error", text: "This is already the summon shortcut." });
  }
  profiles.forEach((profile, index) => {
    if (index === selfIndex || !profile?.keybinding) return;
    if (normalizeBinding(profile.keybinding) === wanted) {
      rows.push({ level: "error", text: `Already used by "${profile.name || "another terminal"}".` });
    }
  });
  const claimed = CLAIMED.get(wanted);
  if (claimed) {
    rows.push({ level: "warning", text: `QuickTerm uses ${claimed.keys} for "${claimed.label}". A global shortcut takes it everywhere.` });
  }
  if (mods.length === 1 && mods[0] === "alt" && PASS_THROUGH_ALT.includes(key)) {
    rows.push({ level: "warning", text: `Alt+${bindingLabels(wanted).pop()} belongs to shells and agents. A global shortcut takes it from every terminal.` });
  }
  return rows;
}

let capturing = 0;

/** True while a shortcut field is recording; the sheet's key layer steps aside. */
export function captureActive() {
  return capturing > 0;
}

const PROMPT = "Press a shortcut… Esc cancels, Backspace clears";

/**
 * A button that records the next key combination. `suspend(on)` pauses the
 * global hotkeys while recording, so pressing a combination QuickTerm already
 * registered is recorded instead of fired. Every way out resumes them.
 */
export function shortcutInput({
  value = null, onChange, label = "Shortcut", disabled = false,
  suspend = (on) => api.suspendHotkeys?.(on),
} = {}) {
  let current = value || null;
  let active = false;
  const button = make("button", "shortcut-input");
  button.type = "button";
  button.disabled = disabled;
  button.setAttribute("aria-label", label);
  button.title = `${label}: click, then press the keys`;

  const paint = () => {
    button.textContent = "";
    button.classList.toggle("capturing", active);
    if (active) {
      button.append(make("span", "shortcut-prompt", PROMPT));
      return;
    }
    const chips = bindingLabels(current);
    if (!chips.length) {
      button.append(make("span", "shortcut-empty", "Not set"));
      return;
    }
    for (const chip of chips) button.append(make("kbd", "", chip));
  };

  const pause = (on) => {
    try { Promise.resolve(suspend?.(on)).catch(() => {}); } catch (_) { /* best effort */ }
  };

  const finish = () => {
    if (!active) return;
    active = false;
    capturing -= 1;
    window.removeEventListener("keydown", onKey, true);
    button.removeEventListener("blur", finish);
    releaseFocus("shortcut");
    pause(false);
    paint();
  };

  const commit = (next) => {
    current = next;
    finish();
    onChange?.(next);
  };

  const onKey = (event) => {
    const plain = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
    if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) {
      finish();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (plain && event.key === "Escape") { finish(); return; }
    if (plain && event.key === "Backspace") { commit(null); return; }
    const result = bindingFromEvent(event);
    if (result) commit(result.binding);
  };

  const start = () => {
    if (active || button.disabled) return;
    claimFocus("shortcut");
    active = true;
    capturing += 1;
    pause(true);
    paint();
    window.addEventListener("keydown", onKey, true);
    button.focus();
    button.addEventListener("blur", finish);
  };

  button.addEventListener("click", start);
  paint();
  return {
    el: button,
    start,
    cancel: finish,
    get value() { return current; },
    set(next) {
      current = next || null;
      paint();
    },
  };
}
