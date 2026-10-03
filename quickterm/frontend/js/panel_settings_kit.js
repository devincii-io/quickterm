// The shared vocabulary of the Settings screens: the filter box, the menu.js
// chooser that stands in for a native <select>, a text field with suggestions,
// a switch row, per-item problems and the empty states.
//
// Two rules are worth stating because they are easy to lose:
//
//   * a problem belongs at the item, not only in the footer. The footer check
//     (global_settings.js `settingsProblems`) stays as the backstop that
//     refuses the save; these markers say WHICH of eleven profiles it meant.
//   * an empty state names the thing you would make and says why, rather than
//     reporting that the list is empty.

import { icon } from "./icons.js";
import { closeMenu, toggleMenu } from "./menu.js";
import { make } from "./panel_shared.js";

/** Case-insensitive substring match over every searchable field of an item. */
export function matchesQuery(query, ...fields) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => String(field || "").toLowerCase().includes(needle));
}

/**
 * The filter box above a list.
 *
 * Repainting the list must not repaint this input, or every keystroke would
 * drop the caret, so the caller owns a separate list host and only refills
 * that. Escape clears rather than closing the panel behind it.
 */
export function configFilter({ value = "", placeholder = "Filter", hint = "", onInput, onKey }) {
  const wrap = make("div", "config-filter");
  const input = make("input", "ui-input config-filter-input");
  input.type = "search";
  input.value = value;
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.setAttribute("aria-label", placeholder);
  // The panel-wide key layer treats bare keys as shortcuts; a filter box has
  // to swallow them, and Escape here means "clear this box", not "close".
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape" && input.value) {
      event.preventDefault();
      input.value = "";
      onInput?.("");
      return;
    }
    onKey?.(event);
  });
  input.addEventListener("input", () => onInput?.(input.value));
  const count = make("span", "config-filter-count", hint);
  wrap.append(input, count);
  return { el: wrap, input, count };
}

/**
 * A menu.js menu opened from inside the sheet. The sheet closes itself on
 * Escape from a capture listener on document, which runs before the menu ever
 * sees the key. A capture listener on window runs earlier still, so Escape
 * closes the menu and only the menu.
 */
export function panelMenu({ anchor, label = "", items, align, width, onClose }) {
  const escape = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeMenu("escape");
  };
  const menu = toggleMenu({
    anchor,
    label,
    items,
    align,
    width,
    onClose: (reason) => {
      window.removeEventListener("keydown", escape, true);
      onClose?.(reason);
    },
  });
  if (!menu) return null;
  // The sheet sits above the sidebar's menu layer.
  menu.root.classList.add("in-panel");
  window.addEventListener("keydown", escape, true);
  return menu;
}

/**
 * A chooser for a Settings row: a button that opens a menu.js menu, never a
 * native <select> (AGENTS.md). `options` are {value, label, detail?};
 * `onChange(value)` runs once the button already shows the new choice.
 * Returns the button and a setter for a value changed from elsewhere.
 */
export function configChoice({ options, value, label = "", title = "", onChange }) {
  let current = value;
  const button = make("button", "config-choice");
  button.type = "button";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  if (label) button.setAttribute("aria-label", label);
  button.title = title || label;
  const text = make("span", "config-choice-label");
  button.append(text, icon("chevron-down", 12));
  const paint = () => {
    const found = options.find((option) => option.value === current);
    text.textContent = found ? found.label : String(current ?? "");
  };
  paint();
  button.addEventListener("click", () => {
    panelMenu({
      anchor: button,
      label,
      items: options.map((option) => ({
        label: option.label,
        detail: option.detail,
        disabled: option.disabled,
        selected: option.value === current,
        run: () => {
          current = option.value;
          paint();
          onChange?.(option.value);
        },
      })),
      onClose: (reason) => {
        if (reason === "run" || reason === "escape") button.focus();
      },
    });
  });
  return {
    el: button,
    set(next) {
      current = next;
      paint();
    },
  };
}

/**
 * Free text with suggestions behind a chevron: a model name, an ssh host
 * alias. `suggestions()` returns rows {value, label?, detail?} and may be
 * async. Picking one writes the input, then calls `onInput` and `onPick`.
 */
export function comboInput({ value = "", placeholder = "", label = "", suggestions, onInput, onPick }) {
  const wrap = make("span", "config-combo");
  const input = make("input", "ui-input");
  input.value = value ?? "";
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.setAttribute("aria-label", label);
  input.title = label;
  input.addEventListener("keydown", (event) => event.stopPropagation());
  input.addEventListener("input", () => onInput?.(input.value));
  const more = make("button", "icon-button config-combo-toggle");
  more.type = "button";
  more.title = `Suggestions for ${label || "this field"}`;
  more.setAttribute("aria-label", more.title);
  more.setAttribute("aria-haspopup", "menu");
  more.append(icon("chevron-down", 12));
  more.addEventListener("click", async () => {
    let rows = [];
    try { rows = (await suggestions?.()) || []; } catch (_) { rows = []; }
    const items = rows.map((row) => ({
      label: row.label || row.value,
      detail: row.detail,
      selected: row.value === input.value,
      run: () => {
        input.value = row.value;
        onInput?.(row.value);
        onPick?.(row.value);
        input.focus();
      },
    }));
    if (!items.length) items.push({ label: "No suggestions", disabled: true });
    panelMenu({
      anchor: wrap,
      label,
      items,
      onClose: (reason) => { if (reason === "escape") more.focus(); },
    });
  });
  wrap.append(input, more);
  return { el: wrap, input, toggle: more };
}

/** A switch row. `id` stamps data-setting so settings search can reveal it. */
export function configToggle({ label, checked, onChange, id = "", disabled = false, title = "" }) {
  const row = make("label", "toggle-row");
  if (id) row.dataset.setting = id;
  if (title) row.title = title;
  const box = make("input", "sr-only");
  box.type = "checkbox";
  box.checked = Boolean(checked);
  box.disabled = disabled;
  box.setAttribute("aria-label", label);
  box.addEventListener("change", () => onChange?.(box.checked));
  row.append(box, make("span", "toggle-control"), make("span", "toggle-copy", label));
  return { el: row, input: box };
}

/** A number field that keeps its value inside `min..max` once you leave it. */
export function configNumber({ value, min, max, placeholder = "", label = "", onChange }) {
  const input = make("input", "ui-input");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = "1";
  input.value = value ?? "";
  input.placeholder = placeholder;
  input.setAttribute("aria-label", label);
  input.title = `${label}: ${min} to ${max}`;
  input.addEventListener("keydown", (event) => event.stopPropagation());
  const read = () => Number.parseInt(input.value, 10);
  input.addEventListener("input", () => {
    const parsed = read();
    if (Number.isInteger(parsed) && parsed >= min && parsed <= max) onChange?.(parsed);
  });
  input.addEventListener("change", () => {
    const parsed = read();
    const clamped = Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : Number(value ?? min);
    input.value = String(clamped);
    onChange?.(clamped);
  });
  return input;
}

/**
 * The standing explanation at the top of a group: what this is, before the
 * first field asks you to fill it in.
 */
export function configPurpose(text) {
  return make("p", "config-purpose", text);
}

/**
 * Per-item problems. `problems` is a list of plain sentences; an empty list
 * renders nothing, because a marker that is always there stops being read.
 */
export function configProblems(problems) {
  const list = (problems || []).filter(Boolean);
  if (!list.length) return null;
  const box = make("ul", "config-problems");
  for (const text of list) box.append(make("li", "config-problem", text));
  return box;
}

/**
 * An empty state: one lead sentence, one paragraph that names a real thing to
 * make, and the button that makes it.
 */
export function configEmpty({ lead, body, action }) {
  const box = make("div", "config-empty");
  box.append(make("p", "config-empty-lead", lead));
  if (body) box.append(make("p", "config-empty-body", body));
  if (action) {
    const actions = make("div", "config-empty-actions");
    actions.append(action);
    box.append(actions);
  }
  return box;
}

/** "You have none" and "none match" are different situations. */
export function configNoMatch(query, what) {
  const box = make("div", "config-empty");
  box.append(make("p", "config-empty-lead", `No ${what} match "${query}".`));
  box.append(make("p", "config-empty-body", "Names, descriptions and commands are all searched."));
  return box;
}

/**
 * Settings search results, grouped by tab in tab order. `onPick(result)` runs
 * on click or Enter; the arrows move between results, and Up from the first
 * calls `onLeave` (back to the search box).
 */
export function settingsSearchResults({ results, tabs, query, onPick, onLeave }) {
  const box = make("div", "settings-search-results");
  box.setAttribute("role", "listbox");
  box.setAttribute("aria-label", "Settings search results");
  const buttons = [];
  // The results in the order they are drawn (grouped by tab), which is the
  // order Enter and ArrowDown must follow, not the score order of `results`.
  const shown = [];
  box.addEventListener("keydown", (event) => {
    const at = buttons.indexOf(event.target);
    if (at < 0 || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    const next = at + (event.key === "ArrowDown" ? 1 : -1);
    if (next < 0) onLeave?.();
    else buttons[Math.min(next, buttons.length - 1)].focus();
  });
  if (!results.length) {
    box.append(make("p", "config-empty-lead", `Nothing in Settings matches "${query}".`));
    return { el: box, buttons, shown };
  }
  for (const [tab, title] of tabs) {
    const inTab = results.filter((result) => result.tab === tab);
    if (!inTab.length) continue;
    box.append(make("h3", "settings-search-group", title));
    for (const result of inTab) {
      const button = make("button", "settings-search-result");
      button.type = "button";
      button.setAttribute("role", "option");
      button.append(make("span", "settings-search-label", result.label));
      if (result.hint) button.append(make("span", "settings-search-hint", result.hint));
      button.addEventListener("click", () => onPick(result));
      box.append(button);
      buttons.push(button);
      shown.push(result);
    }
  }
  return { el: box, buttons, shown };
}
