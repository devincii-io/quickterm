// Ctrl+Tab: a small centred list of the terminals focused last, drawn by the
// shell over whichever workspace is shown. Tab and Shift+Tab move while Ctrl
// is held (keys.js forwards them from any document), releasing Ctrl shows the
// selected terminal, Escape cancels. The order comes from recent_terminals.js
// and stays frozen while the list is up.
//
// The list takes the keyboard (focus.js) the moment it opens, so the release
// of Ctrl and the next Tab arrive here and not in the terminal behind it.

import { claimFocus, focusOwners, releaseFocus } from "./focus.js";

const OWNER = "switcher";

export function createSwitcher({ recent, current, alive, rows, choose, handBack }) {
  let el = null;
  let list = [];
  let closing = false;
  const onBlur = () => cancel();

  function paint() {
    if (!el) return;
    const selected = recent.selected();
    for (const row of el.querySelectorAll(".qt-switcher-row")) {
      const on = row.dataset.id === selected;
      row.classList.toggle("active", on);
      row.setAttribute("aria-selected", on ? "true" : "false");
      if (on) row.scrollIntoView?.({ block: "nearest" });
    }
  }

  function render(entries) {
    el = document.createElement("div");
    el.className = "qt-switcher";
    el.tabIndex = -1;
    el.setAttribute("role", "listbox");
    el.setAttribute("aria-label", "Recent terminals");
    const head = document.createElement("div");
    head.className = "qt-switcher-head";
    head.textContent = "Recent terminals";
    el.append(head);
    entries.forEach((entry, index) => {
      const row = document.createElement("div");
      row.className = "qt-switcher-row";
      row.dataset.id = entry.id;
      row.setAttribute("role", "option");
      const dot = document.createElement("span");
      dot.className = "qt-switcher-dot";
      if (entry.color) dot.style.setProperty("--switcher-color", entry.color);
      const name = document.createElement("span");
      name.className = "qt-switcher-name";
      name.textContent = entry.name;
      const where = document.createElement("span");
      where.className = "qt-switcher-where";
      where.textContent = entry.current ? `${entry.where} · here` : entry.where;
      row.append(dot, name, where);
      row.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        recent.select(index);
        commit();
      });
      el.append(row);
    });
    el.addEventListener("keydown", onKey);
    el.addEventListener("focusout", (event) => {
      if (!closing && el && !el.contains(event.relatedTarget)) cancel();
    });
    document.body.append(el);
  }

  function onKey(event) {
    const moves = { ArrowDown: 1, ArrowUp: -1, Tab: event.shiftKey ? -1 : 1 };
    if (event.key in moves) recent.move(moves[event.key]);
    else if (event.key === "Enter") commit();
    else if (event.key === "Escape") cancel();
    else return;
    event.preventDefault();
    event.stopPropagation();
    paint();
  }

  // Ctrl+Tab (1) or Ctrl+Shift+Tab (-1): opens the list, or moves in it.
  // False when there is nothing to list or another overlay has the keyboard.
  function step(delta) {
    if (el) {
      recent.move(delta);
      paint();
      return true;
    }
    if (focusOwners().length) return false;
    list = recent.open({ current: current(), alive });
    if (!list.length) {
      recent.close();
      return false;
    }
    // A list opened with Shift starts at the oldest entry instead.
    if (delta < 0) recent.select(list.length - 1);
    render(rows(list));
    claimFocus(OWNER);
    el.focus({ preventScroll: true });
    window.addEventListener("blur", onBlur);
    paint();
    return true;
  }

  function teardown() {
    closing = true;
    window.removeEventListener("blur", onBlur);
    el?.remove();
    el = null;
    closing = false;
    releaseFocus(OWNER);
  }

  function commit() {
    if (!el) return null;
    const id = recent.close({ choose: true });
    teardown();
    if (id) choose(id);
    else handBack();
    return id;
  }

  function cancel() {
    if (!el) return;
    recent.close();
    teardown();
    handBack();
  }

  return {
    step,
    release: commit,
    cancel,
    get open() { return Boolean(el); },
  };
}
