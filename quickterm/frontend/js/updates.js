// In-app updates in the shell: the release probe, the update state the
// backend keeps (update.py), the card at the bottom right (update_card.js)
// and the pill in the sidebar footer. Settings > About reads the same state
// through `onUpdateState` and acts through the same three functions.
//
// The state is polled every 500 ms while a download runs and never
// otherwise: every other change follows a request made here.

import * as api from "./api.js";
import {
  IDLE_STATUS, POLL_MS, cardModel, cardVisible, createUpdateCard, pillText, pillTitle, shouldPoll,
} from "./update_card.js";

const PROBE_FIRST_MS = 4000; // stay out of the boot path
const PROBE_EVERY_MS = 6 * 3600 * 1000;
const RETRY_MS = 2000;

let current = IDLE_STATUS;
let pollTimer = null;
const listeners = new Set();

export function updateState() {
  return current;
}

// `listener(status)` on every change; returns the unsubscribe.
export function onUpdateState(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(status) {
  current = { ...IDLE_STATUS, ...(status || {}) };
  for (const listener of [...listeners]) {
    try { listener(current); } catch (error) { console.error(error); }
  }
  schedulePoll();
}

function schedulePoll(delay = POLL_MS) {
  if (pollTimer || !shouldPoll(current)) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    refreshUpdateState().catch(() => {
      // A missed poll during a download tries again a little later.
      if (shouldPoll(current)) schedulePoll(RETRY_MS);
    });
  }, delay);
}

export async function refreshUpdateState() {
  publish(await api.updateStatus());
  return current;
}

export async function startUpdateDownload() {
  try {
    await api.downloadUpdate();
  } finally {
    await refreshUpdateState().catch(() => {});
  }
}

export async function installUpdateNow() {
  try {
    await api.installUpdate();
  } finally {
    await refreshUpdateState().catch(() => {});
  }
}

export async function restartForUpdate() {
  try {
    await api.restartForUpdate();
  } finally {
    await refreshUpdateState().catch(() => {});
  }
}

export async function checkForUpdate(force = false) {
  const result = await api.checkUpdate(force);
  await refreshUpdateState().catch(() => {});
  return result;
}

// --- the shell's card and footer pill ---------------------------------------

function syncPill(status, onOpen, enabled) {
  const nav = document.querySelector(".sidebar-footer");
  if (!nav) return;
  let pill = nav.querySelector(".update-pill");
  const text = enabled ? pillText(status) : null;
  if (!text) {
    pill?.remove();
    return;
  }
  if (!pill) {
    pill = document.createElement("button");
    pill.type = "button";
    pill.className = "sidebar-action sidebar-nav-button update-pill";
    pill.addEventListener("click", onOpen);
    nav.prepend(pill);
  }
  pill.dataset.state = status.state;
  if (pill.textContent !== text) pill.textContent = text;
  const title = pillTitle(status);
  if (pill.title !== title) {
    pill.title = title;
    pill.setAttribute("aria-label", title);
  }
}

export function watchUpdates({ state, handBack }) {
  if (state.cfg.elevated) return;
  const enabled = () => state.cfg.update_check !== false;
  let dismissed = null; // the version "–" or Later hid the card for

  const card = createUpdateCard({
    onAction: (id) => act(id),
    onCollapse: () => {
      dismissed = current.version;
      render();
    },
    handBack,
  });
  document.body.append(card.el);

  async function act(id) {
    if (id === "notes") {
      if (current.notes_url) api.openTarget(current.notes_url).catch(() => {});
      return;
    }
    if (id === "later") {
      dismissed = current.version;
      render();
      return;
    }
    card.busy(true);
    try {
      if (id === "install") await installUpdateNow();
      else if (id === "restart") await restartForUpdate();
      else if (id === "download" || id === "retry") await startUpdateDownload();
    } catch (_) {
      // The refreshed state carries the failure; the card shows it.
    } finally {
      card.busy(false);
    }
  }

  const reopen = () => {
    dismissed = null;
    render();
  };

  function render() {
    const on = enabled();
    card.render(on && cardVisible(current, dismissed) ? cardModel(current) : null);
    syncPill(current, reopen, on);
  }

  onUpdateState(render);
  // Installing is not polled. When Setup fails, UAC is cancelled or the
  // hand-over declined, the backend offers the install again; the user is
  // back in this window by then, so its focus is when to ask.
  window.addEventListener("focus", () => {
    if (current.state === "installing") refreshUpdateState().catch(() => {});
  });
  const probe = () => {
    if (!enabled()) {
      render();
      return;
    }
    checkForUpdate(false).catch(() => {});
  };
  // A download that started before this window opened shows at once.
  refreshUpdateState().catch(() => {});
  setTimeout(probe, PROBE_FIRST_MS);
  setInterval(probe, PROBE_EVERY_MS);
}
