// The inline confirmation for a destructive action: a small box beside the
// control that asked for it, with the action and Cancel. One is open at a time.
//
// The rules come from AGENTS.md and each one cost a bug before:
// - The trigger is measured before it is touched. Hiding it first made
//   getBoundingClientRect() return a zero rectangle and dropped the box in the
//   window's corner. It stays visible, disabled and aria-expanded instead.
// - The box is position:fixed, so a scrolling list moves the trigger out from
//   under it. It follows the trigger and closes once the trigger has left the
//   viewport or the document.
// - A pane re-asserts terminal focus on a frame and on a timeout, so the box
//   claims the keyboard in focus.js before it focuses a button, and releases it
//   before handing focus back.
// - A pointer press focuses Cancel. The keyboard path asked for the action, so
//   it focuses the action and Enter completes it.

import { claimFocus, releaseFocus } from "./focus.js";

let current = null;

// Where the box goes: under the trigger, flush with its right edge, flipped
// above when there is no room below, and always inside the viewport margins.
export function confirmPlacement(triggerRect, boxSize, viewport, { margin = 12, gap = 6 } = {}) {
  const maxLeft = Math.max(margin, viewport.width - boxSize.width - margin);
  const left = Math.max(margin, Math.min(maxLeft, triggerRect.right - boxSize.width));
  let top = triggerRect.bottom + gap;
  if (top + boxSize.height > viewport.height - margin) top = triggerRect.top - boxSize.height - gap;
  top = Math.max(margin, Math.min(viewport.height - boxSize.height - margin, top));
  return { left: Math.round(left), top: Math.round(top) };
}

// Which button takes the focus when the box opens.
export function initialFocus(keyboard) {
  return keyboard ? "confirm" : "cancel";
}

// A trigger scrolled out of view, or one with no box at all (display:none, a
// folded group), has nothing left to anchor the box to.
export function triggerGone(rect, viewport) {
  if (!rect) return true;
  if (rect.width === 0 && rect.height === 0) return true;
  return rect.bottom < 0 || rect.top > viewport.height;
}

export const FAILED_TEXT = "Action failed. Try again.";

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function closeConfirm(reason = "close") {
  current?.close(reason);
}

export function confirmIsOpen() {
  return Boolean(current);
}

// Opens the box and returns { close, box }. `action` may return a promise: a
// rejection keeps the box, shows `error.detail` and relabels the action Retry;
// a resolution closes it. `onClose(reason)` runs once, after the keyboard claim
// is released; reason is "done", "cancel", "escape", "outside", "gone",
// "replaced" or "close".
export function confirmNear(trigger, {
  message, confirmLabel, action, keyboard = false, owner = "confirm", onClose,
} = {}) {
  closeConfirm("replaced");
  const triggerRect = trigger.getBoundingClientRect();
  const wasDisabled = Boolean(trigger.disabled);
  trigger.disabled = true;
  trigger.setAttribute("aria-expanded", "true");

  const box = make("div", "inline-confirmation confirm-popover");
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", "Confirm destructive action");
  const copy = make("span", "inline-confirmation-copy", message);
  const buttons = make("span", "inline-confirmation-actions");
  const confirm = make("button", "secondary-button danger-text compact confirm-popover-accept", confirmLabel);
  confirm.type = "button";
  const cancel = make("button", "text-button compact confirm-popover-cancel", "Cancel");
  cancel.type = "button";
  buttons.append(confirm, cancel);
  box.append(copy, buttons);
  document.body.append(box);

  let closed = false;
  let busy = false;

  const place = (rect) => {
    const size = box.getBoundingClientRect();
    const spot = confirmPlacement(rect, { width: size.width, height: size.height }, viewport());
    box.style.left = `${spot.left}px`;
    box.style.top = `${spot.top}px`;
  };

  const close = (reason = "close") => {
    if (closed) return;
    closed = true;
    if (current?.box === box) current = null;
    window.removeEventListener("scroll", reposition, true);
    window.removeEventListener("resize", reposition);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("pointerdown", onOutside, true);
    box.remove();
    if (trigger.isConnected) {
      trigger.disabled = wasDisabled;
      trigger.setAttribute("aria-expanded", "false");
    }
    releaseFocus(owner);
    onClose?.(reason);
  };

  const reposition = () => {
    if (closed) return;
    if (!trigger.isConnected) { close("gone"); return; }
    const rect = trigger.getBoundingClientRect();
    if (triggerGone(rect, viewport())) { close("gone"); return; }
    place(rect);
  };

  // A press anywhere else is a cancel, except while the action is running:
  // its answer has to land somewhere.
  const onOutside = (event) => {
    if (busy || box.contains(event.target)) return;
    close("outside");
  };
  // A click into a workspace view's iframe never reaches this document's
  // pointerdown; the window losing focus is how that press shows here (the
  // rule menu.js follows). Left open, the bar kept the keyboard owner and
  // every view's terminal stood down.
  const onBlur = () => {
    if (!busy) close("blur");
  };

  const run = async () => {
    if (busy || closed) return;
    busy = true;
    confirm.disabled = true;
    cancel.disabled = true;
    try {
      await action?.();
      busy = false;
      close("done");
    } catch (error) {
      busy = false;
      if (closed) return;
      copy.textContent = error?.detail || FAILED_TEXT;
      confirm.textContent = "Retry";
      confirm.disabled = false;
      cancel.disabled = false;
      confirm.focus();
    }
  };

  confirm.addEventListener("click", run);
  cancel.addEventListener("click", () => close("cancel"));
  box.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) close("escape");
      return;
    }
    if (event.key === "Enter" && (event.target === confirm || event.target === cancel)) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.target.disabled) event.target.click();
    }
  });

  place(triggerRect);
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);
  window.addEventListener("blur", onBlur);
  document.addEventListener("pointerdown", onOutside, true);

  const handle = { close, box };
  current = handle;
  claimFocus(owner);
  (initialFocus(keyboard) === "confirm" ? confirm : cancel).focus();
  return handle;
}
