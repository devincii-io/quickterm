// The shared vocabulary of the Settings screens.
//
// Every list of configurable things in QuickTerm answers the same four
// questions in the same order: what is it called, what is it for, what does it
// actually run, and what is wrong with it right now. Snippets and terminal
// profiles are two kinds of one shape, so the row furniture lives here once
// instead of drifting apart in two files.
//
// Two rules are worth stating because they are easy to lose:
//
//   * a problem belongs at the item, not only in the footer. The footer check
//     in panels.js `_settings()` stays as the backstop that refuses the save;
//     these markers are what tell you WHICH of eleven profiles it meant.
//   * an empty state names the thing you would make and says why, rather than
//     reporting that the list is empty. "No snippets yet" is a fact about the
//     screen; "a snippet is a command you already type, kept with a note about
//     when you reach for it" is a fact about the product.

import { icon } from "./icons.js";
import { closeMenu, toggleMenu } from "./menu.js";
import { make } from "./panel_shared.js";

// Below this a filter box is noise: you can see the whole list at once, and an
// extra input above three cards only makes the screen look busier.
export const FILTER_THRESHOLD = 6;

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
export function configFilter({ value = "", placeholder = "Filter", hint = "", onInput }) {
  const wrap = make("div", "config-filter");
  const input = make("input", "ui-input config-filter-input");
  input.type = "search";
  input.value = value;
  input.placeholder = placeholder;
  input.spellcheck = false;
  // The panel-wide key layer treats bare keys as shortcuts; a filter box has
  // to swallow them, and Escape here means "clear this box", not "close".
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key !== "Escape") return;
    event.preventDefault();
    input.value = "";
    onInput?.("");
  });
  input.addEventListener("input", () => onInput?.(input.value));
  const count = make("span", "config-filter-count", hint);
  wrap.append(input, count);
  return { el: wrap, input, count };
}

/** The single line that says what an item actually runs. */
export function configSummary(text) {
  const line = make("code", "config-summary");
  line.textContent = text || "";
  line.title = text || "";
  return line;
}

/**
 * The description an item carries, or an honest stand-in for a missing one.
 * `missing` replaces that stand-in; an empty string leaves the line empty,
 * for a row that has no room to nag.
 */
export function configDescription(text, missing = "No description yet. Say what this is for.") {
  const written = String(text || "").trim();
  const line = make("p", written ? "config-description" : "config-description missing");
  line.textContent = written || missing;
  return line;
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
  if (title) button.title = title;
  const text = make("span", "config-choice-label");
  button.append(text, icon("chevron-down", 12));
  const paint = () => {
    const found = options.find((option) => option.value === current);
    text.textContent = found ? found.label : String(current ?? "");
  };
  paint();
  // The sheet closes itself on Escape from a capture listener on document,
  // which runs before the menu ever sees the key. A capture listener on
  // window runs earlier still, so Escape closes the menu and only the menu.
  const escape = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeMenu("escape");
  };
  button.addEventListener("click", () => {
    const menu = toggleMenu({
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
        window.removeEventListener("keydown", escape, true);
        if (reason === "run" || reason === "escape") button.focus();
      },
    });
    if (!menu) return;
    // The sheet sits above the sidebar's menu layer.
    menu.root.classList.add("in-panel");
    window.addEventListener("keydown", escape, true);
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
 * The standing explanation at the top of an editor: what this kind of thing
 * is, before the first field asks you to fill it in.
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

/** The different sentence a filter that matched nothing needs. "You have none"
 *  and "none match" are different situations; showing the first for the second
 *  is a lie about the user's own configuration. */
export function configNoMatch(query, what) {
  const box = make("div", "config-empty");
  box.append(make("p", "config-empty-lead", `No ${what} match "${query}".`));
  box.append(make("p", "config-empty-body", "Names, descriptions and commands are all searched."));
  return box;
}

/** A heading over one kind inside a grouped list. */
export function configGroupHeading(title, count, note) {
  const heading = make("div", "config-group-heading");
  heading.append(make("h3", "config-group-title", title), make("span", "config-group-count", String(count)));
  if (note) heading.append(make("span", "config-group-note", note));
  return heading;
}
