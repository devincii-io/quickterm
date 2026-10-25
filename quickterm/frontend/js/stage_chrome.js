// What the stage draws around side by side columns, and only then: a one-line
// header over each column (colour dot, name, branch, state dot, ×) and the
// 1px gutter between two columns, dragged to resize them. With one column
// none of it exists. Headers and gutters are plain elements in the stage's
// grid, so they are added and removed freely; the views' iframes never move.

import { icon } from "./icons.js";
import { GUTTER_PX, columnTrack, dragFractions, equalFractions, gutterTrack } from "./stage_columns.js";

const KEY_STEP_PX = 16;

function make(tag, className) {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}

// `stage` is the views' grid. `activate(view)` gives a column the keyboard,
// `remove(view)` takes it out of the split, `resize(fractions, done)` hears
// every width change (`done` once a drag or a key press is over).
export function createStageChrome({ stage, activate, remove, resize }) {
  const headers = new Map();
  const gutters = [];
  let columns = [];
  let fractions = [1];

  function header(key) {
    let parts = headers.get(key);
    if (parts) return parts;
    const el = make("div", "stage-column-head");
    const dot = make("span", "stage-column-dot");
    const name = make("span", "stage-column-name");
    const branch = make("small", "stage-column-branch");
    const state = make("span", "stage-column-state");
    const close = make("button", "stage-column-close");
    close.type = "button";
    close.append(icon("x", 12));
    el.append(dot, name, branch, state, close);
    parts = { el, dot, name, branch, state, close, column: null };
    // Listeners read the column the header shows now, never the one it was
    // built for.
    el.addEventListener("click", (event) => {
      if (!event.target.closest?.(".stage-column-close") && parts.column) activate(parts.column.view);
    });
    close.addEventListener("click", () => { if (parts.column) remove(parts.column.view); });
    headers.set(key, parts);
    stage.append(el);
    return parts;
  }

  function paintHeader(parts, column, at) {
    parts.column = column;
    parts.el.style.gridColumn = String(columnTrack(at));
    parts.el.classList.toggle("active", Boolean(column.active));
    parts.el.title = column.active ? `${column.label}: has the keyboard` : `${column.label}: click to type here`;
    parts.dot.style.setProperty("--column-color", column.color || "var(--accent)");
    if (parts.name.textContent !== column.label) parts.name.textContent = column.label;
    const branch = column.branch || "";
    if (parts.branch.textContent !== branch) parts.branch.textContent = branch;
    parts.branch.hidden = !branch;
    parts.state.dataset.state = column.state?.key || "";
    parts.state.hidden = !column.state;
    parts.state.title = column.state?.label || "";
    const label = `Remove ${column.label} from side by side; it stays open and keeps running`;
    parts.close.title = label;
    parts.close.setAttribute("aria-label", label);
  }

  function gutter(at) {
    if (gutters[at]) return gutters[at];
    const el = make("div", "stage-gutter");
    el.tabIndex = 0;
    el.setAttribute("role", "separator");
    el.setAttribute("aria-orientation", "vertical");
    el.title = "Drag to resize the columns, double-click to make them equal";
    el.setAttribute("aria-label", "Resize the columns");
    el.addEventListener("pointerdown", (event) => drag(event, el));
    el.addEventListener("dblclick", () => {
      fractions = equalFractions(columns.length);
      resize(fractions, true);
    });
    el.addEventListener("keydown", (event) => {
      const delta = event.key === "ArrowLeft" ? -KEY_STEP_PX : event.key === "ArrowRight" ? KEY_STEP_PX : 0;
      if (!delta) return;
      event.preventDefault();
      fractions = dragFractions(fractions, gutters.indexOf(el), delta * (event.shiftKey ? 4 : 1), space());
      resize(fractions, true);
    });
    gutters[at] = el;
    stage.append(el);
    return el;
  }

  // The pixels the columns share: the stage less its gutters.
  const space = () => stage.getBoundingClientRect().width - GUTTER_PX * Math.max(0, columns.length - 1);

  function drag(event, el) {
    if (event.button !== 0) return;
    event.preventDefault();
    const index = gutters.indexOf(el);
    const start = [...fractions];
    const startX = event.clientX;
    const total = space();
    el.setPointerCapture?.(event.pointerId);
    el.classList.add("dragging");
    // The iframes would swallow the pointer once it crosses into them.
    document.body.classList.add("stage-resizing");
    let frame = 0;
    const move = (moveEvent) => {
      fractions = dragFractions(start, index, moveEvent.clientX - startX, total);
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; resize(fractions, false); });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (frame) cancelAnimationFrame(frame);
      el.classList.remove("dragging");
      document.body.classList.remove("stage-resizing");
      resize(fractions, true);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("lostpointercapture", up, { once: true });
  }

  // `next` is [{key, view, label, color, branch, state, active}] in column
  // order: two or more draw, fewer clear everything.
  function paint(next, nextFractions) {
    columns = next.length > 1 ? next : [];
    fractions = [...nextFractions];
    const keys = new Set(columns.map((column) => column.key));
    for (const [key, parts] of [...headers]) {
      if (keys.has(key)) continue;
      parts.el.remove();
      headers.delete(key);
    }
    columns.forEach((column, at) => paintHeader(header(column.key), column, at));
    while (gutters.length > Math.max(0, columns.length - 1)) {
      gutters.pop().remove();
      // A drag on a gutter that is gone can never end on its own.
      document.body?.classList.remove("stage-resizing");
    }
    for (let at = 0; at < columns.length - 1; at += 1) gutter(at).style.gridColumn = String(gutterTrack(at));
  }

  return { paint };
}
