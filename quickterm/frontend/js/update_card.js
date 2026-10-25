// The update card: a small card at the bottom right of the window while an
// update downloads, once it is ready, when it waits for a click on Download,
// and when it failed. "–" and Later fold it into the sidebar footer pill.
//
// The model half (everything above `createUpdateCard`) is pure and tested in
// tests/js/update_card.test.mjs; updates.js owns the state and the polling.

import { claimFocus, releaseFocus } from "./focus.js";

export const POLL_MS = 500;
export const IDLE_STATUS = Object.freeze({
  state: "idle", version: null, received: 0, total: null, error: null, notes_url: null,
  can_restart: false,
});

// Only a running download changes on its own; every other state changes
// because somebody asked for something, and that request refreshes.
export function shouldPoll(status) {
  return status?.state === "downloading" || status?.state === "verifying";
}

// Whole percent, never 100 before the last byte; null when the total is unknown.
export function downloadPercent(status) {
  const total = Number(status?.total);
  const received = Math.max(0, Number(status?.received) || 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (received >= total) return 100;
  return Math.min(99, Math.floor((received * 100) / total));
}

export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function progressLine(status) {
  if (status.state === "verifying") return "Verifying…";
  const percent = downloadPercent(status);
  return percent === null ? `Downloading… ${formatBytes(status.received)}` : `Downloading… ${percent}%`;
}

function name(status) {
  return status.version ? `QuickTerm v${status.version}` : "The update";
}

function oneLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

// What the card shows for a status, or null for no card. `actions` are the
// buttons in order; the first `primary` one is the default.
export function cardModel(status) {
  const state = status?.state;
  if (!state || state === "idle") return null;
  const notes = Boolean(status.notes_url);
  if (state === "downloading" || state === "verifying") {
    const percent = state === "verifying" ? 100 : downloadPercent(status);
    return {
      state, title: "Downloading update", text: `${name(status)} is downloading.`, notes,
      progress: percent, progressText: progressLine(status), minimize: true, actions: [],
    };
  }
  if (state === "ready") {
    return {
      state, title: "Update ready",
      text: `${name(status)} is ready to install. Your terminals keep running.`, notes,
      progress: undefined, progressText: "", minimize: false,
      actions: [{ id: "install", label: "Install now", primary: true }, { id: "later", label: "Later" }],
    };
  }
  if (state === "available") {
    return {
      state, title: "Update available", text: `${name(status)} is available.`, notes,
      progress: undefined, progressText: "", minimize: false,
      actions: [{ id: "download", label: "Download", primary: true }, { id: "later", label: "Later" }],
    };
  }
  if (state === "installing") {
    return {
      state, title: "Installing update",
      text: `Setup is running. ${name(status)} starts when it is done.`, notes: false,
      progress: undefined, progressText: "", minimize: false, actions: [],
    };
  }
  if (state === "installed") {
    return {
      state, title: "Update installed",
      text: `${name(status)} is installed. Restart QuickTerm to use it.`, notes,
      progress: undefined, progressText: "", minimize: true,
      actions: status.can_restart ? [{ id: "restart", label: "Restart now", primary: true }] : [],
    };
  }
  if (state === "failed") {
    return {
      state, title: "Update failed", text: oneLine(status.error) || "The download did not finish.",
      notes: false, progress: undefined, progressText: "", minimize: false,
      actions: [{ id: "retry", label: "Retry", primary: true }, { id: "later", label: "Later" }],
    };
  }
  return null;
}

// The footer pill: the percentage while downloading, "up" once there is
// something to install or download, null for no pill.
export function pillText(status) {
  switch (status?.state) {
    case "downloading": {
      const percent = downloadPercent(status);
      return percent === null ? "…" : `${percent}%`;
    }
    case "verifying":
    case "installing":
      return "…";
    case "ready":
    case "available":
    case "installed":
      return "up";
    case "failed":
      return "!";
    default:
      return null;
  }
}

export function pillTitle(status) {
  const who = name(status || {});
  switch (status?.state) {
    case "downloading": return `${who} is downloading. Show the update card.`;
    case "verifying": return `${who} is being verified. Show the update card.`;
    case "ready": return `${who} is ready to install. Show the update card.`;
    case "available": return `${who} is available. Show the update card.`;
    case "installing": return `${who} is being installed.`;
    case "installed": return `${who} is installed. Show the update card.`;
    case "failed": return "The update failed. Show the update card.";
    default: return "";
  }
}

// "–" and Later hide the card for this version until the pill reopens it or
// the window reloads; a newer version brings it back on its own.
export function cardVisible(status, dismissedVersion) {
  if (!cardModel(status)) return false;
  return dismissedVersion === null || dismissedVersion === undefined || dismissedVersion !== status.version;
}

// Settings > About: the same state in one sentence.
export function aboutLine(status) {
  switch (status?.state) {
    case "downloading": {
      const percent = downloadPercent(status);
      return `${name(status)} is downloading (${percent === null ? formatBytes(status.received) : `${percent}%`}).`;
    }
    case "verifying": return `${name(status)} is downloaded and being verified.`;
    case "ready": return `${name(status)} is ready to install. Your terminals keep running.`;
    case "available": return `${name(status)} is available.`;
    case "installing": return `Setup is running. ${name(status)} starts when it is done.`;
    case "installed": return `${name(status)} is installed. Restart QuickTerm to use it.`;
    case "failed": return `The update failed: ${oneLine(status.error) || "the download did not finish."}`;
    default: return "";
  }
}

// ---------------------------------------------------------------------------
// DOM

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FOCUS_OWNER = "update-card";

// `onAction(id)` for the buttons and "Release notes" ("notes"), `onCollapse()`
// for "–" and Esc, `handBack()` returns the keyboard to the terminal.
export function createUpdateCard({ onAction, onCollapse, handBack }) {
  const card = el("section", "update-card");
  card.setAttribute("role", "status");
  card.setAttribute("aria-live", "polite");
  card.hidden = true;
  const head = el("div", "update-card-head");
  const title = el("h2", "update-card-title");
  const minimize = el("button", "update-card-minimize", "–");
  minimize.type = "button";
  minimize.title = "Minimize to the sidebar";
  minimize.setAttribute("aria-label", "Minimize to the sidebar");
  head.append(title, minimize);
  const text = el("p", "update-card-text");
  const notes = el("button", "update-card-notes", "Release notes");
  notes.type = "button";
  const bar = el("div", "update-card-bar");
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  const fill = el("div", "update-card-fill");
  bar.append(fill);
  const progress = el("p", "update-card-progress");
  const actions = el("div", "update-card-actions");
  card.append(head, text, notes, bar, progress, actions);

  let claimed = false;
  const release = () => {
    if (!claimed) return;
    claimed = false;
    releaseFocus(FOCUS_OWNER);
  };
  card.addEventListener("focusin", () => {
    if (claimed) return;
    claimed = true;
    claimFocus(FOCUS_OWNER);
  });
  card.addEventListener("focusout", (event) => {
    if (!card.contains(event.relatedTarget)) release();
  });
  // Hiding the focused card hands the keyboard back to the terminal.
  const leave = () => {
    const had = card.contains(document.activeElement);
    release();
    if (had) {
      document.activeElement?.blur?.();
      handBack?.();
    }
  };
  card.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    leave();
    onCollapse();
  });
  minimize.addEventListener("click", () => {
    leave();
    onCollapse();
  });
  notes.addEventListener("click", () => onAction("notes"));

  let actionKey = "";
  function render(model) {
    if (!model) {
      if (!card.hidden) leave();
      card.hidden = true;
      return;
    }
    if (card.hidden) {
      card.hidden = false;
      // Restart the slide-in only when the card appears, not on every poll.
      card.classList.remove("entering");
      void card.offsetWidth;
      card.classList.add("entering");
    }
    card.dataset.state = model.state;
    if (title.textContent !== model.title) title.textContent = model.title;
    if (text.textContent !== model.text) text.textContent = model.text;
    text.title = model.state === "failed" ? model.text : "";
    minimize.hidden = !model.minimize;
    notes.hidden = !model.notes;
    const hasBar = model.progress !== undefined;
    bar.hidden = !hasBar;
    progress.hidden = !hasBar;
    if (hasBar) {
      bar.classList.toggle("indeterminate", model.progress === null);
      if (model.progress === null) bar.removeAttribute("aria-valuenow");
      else bar.setAttribute("aria-valuenow", String(model.progress));
      fill.style.width = model.progress === null ? "" : `${model.progress}%`;
      progress.textContent = model.progressText;
    }
    const key = `${model.state}:${model.actions.map((action) => action.id).join(",")}`;
    if (key !== actionKey) {
      const hadFocus = actions.contains(document.activeElement);
      actionKey = key;
      actions.textContent = "";
      for (const action of model.actions) {
        const button = el("button", action.primary ? "primary-button compact" : "secondary-button compact", action.label);
        button.type = "button";
        button.dataset.action = action.id;
        button.addEventListener("click", () => {
          if (action.id === "later") leave();
          onAction(action.id);
        });
        actions.append(button);
      }
      actions.hidden = !model.actions.length;
      // A rebuilt row keeps the keyboard in the card; it never takes it.
      if (hadFocus) actions.querySelector("button")?.focus({ preventScroll: true });
    }
  }

  function busy(on) {
    for (const button of actions.querySelectorAll("button")) button.disabled = Boolean(on);
  }

  return { el: card, render, busy, leave };
}
