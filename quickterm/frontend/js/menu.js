// One popover menu for every chooser in the chrome. The sidebar used native
// <select> elements, which draw the OS list: no folder under a workspace
// name, no colour dot for a workspace shown in another view, no second
// action on a row. This one is a fixed-position list under its trigger,
// clamped inside the viewport, owning the keyboard while open (focus.js) and
// handing it back to the terminal when it closes.
//
// Items:
//   { heading }                        a group label, not selectable
//   { separator: true }
//   { label, detail?, hint?, icon?, color?, selected?, disabled?, danger?,
//     run(), keepOpen?, actions?: [{ icon, title, run(), keepOpen? }] }
//
// `run` fires on click or Enter. `actions` are small icon buttons at the end
// of the row, shown while the row is active: a second verb on the same
// subject without a submenu.

import { claimFocus, releaseFocus } from "./focus.js";
import { icon } from "./icons.js";

export const MENU_MIN_WIDTH = 190;
export const MENU_MAX_WIDTH = 340;
const MENU_GAP = 4;
const MENU_MARGIN = 6;
const TYPEAHEAD_MS = 600;

let current = null;

export function isSelectable(item) {
  return Boolean(item) && !item.heading && !item.separator && !item.disabled;
}

// The next selectable index from `from` in direction `delta`, wrapping.
// `from` -1 means "nothing active yet". null when nothing is selectable.
export function stepIndex(items, from, delta) {
  const count = items.length;
  if (!count) return null;
  let index = from;
  for (let step = 0; step < count; step++) {
    index = from < 0 && step === 0
      ? (delta > 0 ? 0 : count - 1)
      : (index + (delta > 0 ? 1 : -1) + count) % count;
    if (isSelectable(items[index])) return index;
  }
  return null;
}

export function firstSelectable(items) {
  return stepIndex(items, -1, 1);
}

export function lastSelectable(items) {
  return stepIndex(items, -1, -1);
}

// Type a letter, land on the next item starting with it. Cycles from the
// active item so repeated presses walk through matches.
export function typeaheadIndex(items, from, prefix) {
  const wanted = String(prefix || "").toLowerCase();
  if (!wanted) return null;
  const count = items.length;
  for (let step = 1; step <= count; step++) {
    const index = (from + step + count) % count;
    const item = items[index];
    if (isSelectable(item) && String(item.label || "").toLowerCase().startsWith(wanted)) return index;
  }
  return null;
}

// Where the menu goes: under the anchor, flush with its start edge, unless
// that leaves it poking out of the viewport. Then it moves left, and if the
// space below is too small for even half the list it opens above instead.
// `maxHeight` is what the list may take before it scrolls.
export function menuPosition(anchor, size, viewport, { align = "start", gap = MENU_GAP, margin = MENU_MARGIN } = {}) {
  const width = Math.min(size.width, Math.max(0, viewport.width - 2 * margin));
  let left = align === "end" ? anchor.right - width : anchor.left;
  left = Math.max(margin, Math.min(left, viewport.width - width - margin));
  const below = viewport.height - anchor.bottom - gap - margin;
  const above = anchor.top - gap - margin;
  const opensAbove = size.height > below && above > below;
  const room = Math.max(40, opensAbove ? above : below);
  const height = Math.min(size.height, room);
  const top = opensAbove ? anchor.top - gap - height : anchor.bottom + gap;
  return { left: Math.round(left), top: Math.round(top), width: Math.round(width), maxHeight: Math.round(room), above: opensAbove };
}

export function closeMenu(reason = "close") {
  if (current) current.close(reason);
}

export function menuIsOpen() {
  return Boolean(current);
}

// For a trigger's click handler: opens the menu, unless the press that made
// this click just closed the same menu, in which case the click is the
// second half of a toggle and does nothing.
let recentlyToggled = null;
const TOGGLE_MS = 600;

export function toggleMenu(options) {
  const trigger = options.trigger || options.anchor;
  if (recentlyToggled && recentlyToggled.trigger === trigger && Date.now() - recentlyToggled.at < TOGGLE_MS) {
    recentlyToggled = null;
    return null;
  }
  recentlyToggled = null;
  return openMenu(options);
}

function make(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

// Opens the menu and returns { close }. `anchor` is the box the menu hangs
// under and takes its width from; `trigger` (default: the anchor) is the
// button that carries aria-expanded and whose press toggles rather than
// reopens. `onClose(reason)` runs exactly once, after the DOM is gone, so the
// caller can hand the keyboard back. `reason` is "run" after an item ran,
// "escape", "outside", "toggle", "blur", "replaced" (another menu opened) or
// "close".
export function openMenu({ anchor, trigger = anchor, items, label, align = "start", width, onClose }) {
  closeMenu("replaced");
  const rows = items.filter(Boolean);
  const root = make("div", "qt-menu");
  root.setAttribute("role", "menu");
  root.tabIndex = -1;
  if (label) root.setAttribute("aria-label", label);
  const nodes = [];
  let active = -1;
  let closed = false;
  let typed = "";
  let typedTimer = null;

  const setActive = (index, { scroll = true } = {}) => {
    if (active >= 0 && nodes[active]) nodes[active].classList.remove("active");
    active = index ?? -1;
    if (active < 0 || !nodes[active]) {
      root.removeAttribute("aria-activedescendant");
      return;
    }
    nodes[active].classList.add("active");
    root.setAttribute("aria-activedescendant", nodes[active].id);
    if (scroll) nodes[active].scrollIntoView({ block: "nearest" });
  };

  const close = (reason = "close") => {
    if (closed) return;
    closed = true;
    if (current && current.root === root) current = null;
    clearTimeout(typedTimer);
    document.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("resize", onWindowChange);
    window.removeEventListener("blur", onWindowChange);
    root.remove();
    releaseFocus("menu");
    trigger.setAttribute?.("aria-expanded", "false");
    onClose?.(reason);
  };

  const run = (item, fn, keepOpen) => {
    if (!fn) return;
    if (!keepOpen) close("run");
    fn(item);
  };

  rows.forEach((item, index) => {
    if (item.heading) {
      const heading = make("div", "qt-menu-heading", item.heading);
      heading.setAttribute("role", "presentation");
      root.append(heading);
      nodes.push(heading);
      return;
    }
    if (item.separator) {
      const sep = make("div", "qt-menu-sep");
      sep.setAttribute("role", "separator");
      root.append(sep);
      nodes.push(sep);
      return;
    }
    const row = make("div", "qt-menu-item");
    row.id = `qt-menu-item-${index}`;
    row.setAttribute("role", "menuitem");
    if (item.disabled) {
      row.classList.add("disabled");
      row.setAttribute("aria-disabled", "true");
    }
    if (item.danger) row.classList.add("danger");
    if (item.selected) row.setAttribute("aria-checked", "true");
    if (item.title) row.title = item.title;
    const mark = make("span", "qt-menu-mark");
    if (item.selected) mark.append(icon("check", 12));
    else if (item.color) {
      const dot = make("span", "qt-menu-dot");
      dot.style.setProperty("--menu-color", item.color);
      mark.append(dot);
    } else if (item.icon) mark.append(icon(item.icon, 12));
    const copy = make("div", "qt-menu-copy");
    copy.append(make("span", "qt-menu-label", item.label));
    if (item.detail) copy.append(make("span", "qt-menu-detail", item.detail));
    row.append(mark, copy);
    if (item.hint) row.append(make("span", "qt-menu-hint", item.hint));
    if (item.actions?.length) {
      const actions = make("span", "qt-menu-actions");
      for (const action of item.actions) {
        const button = make("button", "qt-menu-action");
        button.type = "button";
        button.title = action.title || "";
        button.setAttribute("aria-label", action.title || "");
        button.append(icon(action.icon || "arrow-up-right", 12));
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          run(item, action.run, action.keepOpen);
        });
        actions.append(button);
      }
      row.append(actions);
    }
    row.addEventListener("pointermove", () => { if (!item.disabled && active !== index) setActive(index, { scroll: false }); });
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      if (item.disabled) return;
      run(item, item.run, item.keepOpen);
    });
    root.append(row);
    nodes.push(row);
  });

  const onOutside = (event) => {
    if (root.contains(event.target)) return;
    // A press on the trigger toggles. The click that follows this pointerdown
    // would reopen the menu, so toggleMenu() is told to let that click pass.
    if (trigger.contains?.(event.target)) {
      recentlyToggled = { trigger, at: Date.now() };
      close("toggle");
      return;
    }
    close("outside");
  };
  const onWindowChange = () => close("blur");

  root.addEventListener("keydown", (event) => {
    const key = event.key;
    if (key === "Escape" || key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      close("escape");
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      setActive(stepIndex(rows, active, key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (key === "Home" || key === "End") {
      event.preventDefault();
      event.stopPropagation();
      setActive(key === "Home" ? firstSelectable(rows) : lastSelectable(rows));
      return;
    }
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      event.stopPropagation();
      const item = rows[active];
      if (isSelectable(item)) run(item, item.run, item.keepOpen);
      return;
    }
    if (key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      clearTimeout(typedTimer);
      typed += key;
      typedTimer = setTimeout(() => { typed = ""; }, TYPEAHEAD_MS);
      const hit = typeaheadIndex(rows, typed.length > 1 ? active - 1 : active, typed);
      if (hit !== null) setActive(hit);
    }
  });

  // Placed once measured: the list is drawn hidden, sized, then shown where
  // it fits. Width follows the trigger so the menu reads as its extension.
  claimFocus("menu");
  root.style.visibility = "hidden";
  document.body.append(root);
  const anchorRect = anchor.getBoundingClientRect();
  const wanted = width || Math.min(MENU_MAX_WIDTH, Math.max(MENU_MIN_WIDTH, anchorRect.width));
  root.style.width = `${wanted}px`;
  const natural = root.getBoundingClientRect();
  const place = menuPosition(anchorRect, { width: wanted, height: natural.height },
    { width: window.innerWidth, height: window.innerHeight }, { align });
  root.style.left = `${place.left}px`;
  root.style.top = `${place.top}px`;
  root.style.width = `${place.width}px`;
  root.style.maxHeight = `${place.maxHeight}px`;
  root.classList.toggle("above", place.above);
  root.style.visibility = "";
  trigger.setAttribute?.("aria-expanded", "true");
  document.addEventListener("pointerdown", onOutside, true);
  window.addEventListener("resize", onWindowChange);
  window.addEventListener("blur", onWindowChange);
  const initial = rows.findIndex((item) => item.selected && isSelectable(item));
  setActive(initial >= 0 ? initial : firstSelectable(rows));
  root.focus();
  current = { root, close };
  return { close, root };
}
