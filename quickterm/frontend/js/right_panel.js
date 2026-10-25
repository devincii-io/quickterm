// The files panel (the right panel): Files, Changes and Pull request for the
// workspace in the active column. It is hidden by default and, when opened,
// slides over the right edge of the stage with a shadow; the terminals under
// it keep their size. It hides by itself when the keyboard or a click goes
// back to a terminal, on Escape, and when the active column shows a
// workspace with no folder, unless the pin in its header holds it. The width
// is dragged at the inner edge and remembered per machine. The file view and
// the diff open over the stage, one at a time, with the terminals still
// loaded behind them.

import * as api from "./api.js";
import * as wsApi from "./ws_api.js";
import { claimFocus, releaseFocus } from "./focus.js";
import { quoteDroppedPath, windowsPathForWsl } from "./pane.js";
import {
  PANEL_WIDTH_DEFAULT, clampPanelWidth, loadPanelPin, panelHides, savePanelPin,
} from "./right_panel_model.js";
import { copyText, icon, make } from "./rp_dom.js";
import { createFilesTab } from "./rp_files.js";
import { createChangesTab } from "./rp_changes.js";
import { createPrTab } from "./rp_pr.js";
import { createFileView } from "./file_view.js";
import { createDiffView } from "./diff_view.js";

const STORE_KEY = "quickterm.rightPanel.v1";
// How long the Changes tab's last answer stands in for a new request.
const CHANGES_FRESH_MS = 10000;
const OVERLAY_OWNER = "rp-viewer";
const PANEL_OWNER = "right-panel";

function windowStorage() {
  try { return window.sessionStorage; } catch (_) { return null; }
}

function loadStored() {
  try {
    const value = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch (_) {
    return {};
  }
}

function saveStored(value) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(value)); } catch (_) { /* per-machine nicety only */ }
}

// The absolute path of `rel` in `folder`, with the folder's own separator.
export function joinPath(folder, rel) {
  if (!folder) return rel;
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(folder);
  const sep = windows ? "\\" : "/";
  const base = folder.replace(/[\\/]+$/, "");
  return rel ? `${base}${sep}${windows ? rel.replaceAll("/", "\\") : rel}` : base;
}

// `views` is the stage (workspace_views.js); `shownWorkspace()` names the
// workspace in the active column (".scratch" for the scratch view), or null
// for an empty stage; `details(name)` resolves to its record ({path, host,
// ...}); `activeApp()` is the active column's app; `fixWithClaude(name,
// build)` starts Claude Code in that workspace; `focusBack()` hands the
// keyboard to the active column's terminal; `onOpen(open)` hears every show
// and hide (the left footer's toggle).
export function createRightPanel({
  views, shownWorkspace, details, activeApp, fixWithClaude, focusBack, showError, onOpen = () => {},
}) {
  const stored = loadStored();
  let width = clampPanelWidth(Number(stored.width) || PANEL_WIDTH_DEFAULT, window.innerWidth);
  let tabId = ["files", "changes", "pr"].includes(stored.tab) ? stored.tab : "files";
  let pinned = loadPanelPin(windowStorage());
  let open = false;
  let workspace = null;
  let record = null;
  let timer = 0;
  let overlay = null;
  let changesSeen = null;

  const el = make("aside", "right-panel");
  el.setAttribute("aria-label", "Files, changes and pull request");
  const grip = make("div", "rp-grip");
  grip.tabIndex = 0;
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-orientation", "vertical");
  grip.setAttribute("aria-label", "Resize the files panel");
  grip.title = "Drag to resize the files panel, double-click to reset";
  const head = make("div", "rp-head");
  const tabsRow = make("div", "rp-tabs");
  tabsRow.setAttribute("role", "tablist");
  const pin = make("button", "sidebar-nav-button rp-pin");
  pin.type = "button";
  pin.append(icon("pin", 14));
  const closeButton = make("button", "sidebar-nav-button rp-close");
  closeButton.type = "button";
  closeButton.title = "Hide the files panel (Alt+Shift+E)";
  closeButton.setAttribute("aria-label", "Hide the files panel");
  closeButton.append(icon("x", 14));
  head.append(tabsRow, pin, closeButton);
  const bodyEl = make("div", "rp-body");
  el.append(grip, head, bodyEl);
  // Over the stage, not beside it: the stage's grid never makes room for it.
  views.stage.append(el);

  const overlayHost = make("div", "rp-overlay-host");
  overlayHost.hidden = true;
  views.stage.append(overlayHost);

  // ---- what the tabs and views ask ----

  const ctx = {
    workspace: () => workspace,
    emptyText: () => "No workspace open.",
    isRemote: () => Boolean(record?.host),
    showError,
    openFile: (path, options = {}) => openViewer("file", path, options),
    openDiff: (path, group) => openViewer("diff", path, { group }),
    close: () => closeOverlay(),
    pastePaths,
    copyPath: async (path, relative) => {
      const text = relative ? path : joinPath(record?.path, path);
      if (!(await copyText(text))) showError("Could not copy to the clipboard.");
    },
    openExternal: (path, app) => {
      if (!workspace) return;
      wsApi.openPath(workspace, path, app).catch((error) => showError(error.detail || "Could not open that."));
    },
    // `build(max)` makes the prompt in at most `max` characters; `target` is
    // the workspace the failure belongs to, which need not be on screen.
    fixWithClaude: (build, target = workspace) => {
      if (!target) return;
      Promise.resolve(fixWithClaude(target, build)).catch((error) => {
        showError(error?.detail || "Could not start Claude Code.");
      });
    },
    noteChanges: (name, answer) => {
      changesSeen = { name, at: Date.now(), answer };
    },
    // Whether git reports `path` changed: from the Changes tab's last answer
    // while it is fresh, else from one request that refreshes it.
    modifiedGroup: async (path) => {
      const asked = workspace;
      if (!asked) return null;
      let answer = changesSeen?.name === asked && Date.now() - changesSeen.at < CHANGES_FRESH_MS
        ? changesSeen.answer : null;
      if (!answer) {
        try {
          answer = await wsApi.getChanges(asked);
          changesSeen = { name: asked, at: Date.now(), answer };
        } catch (_) {
          return null;
        }
      }
      const file = (answer.files || []).find((item) => item.path === path && item.group !== "committed");
      return file ? (file.group === "staged" ? "staged" : "changes") : null;
    },
  };

  const tabs = [createFilesTab(ctx), createChangesTab(ctx), createPrTab(ctx)];
  const tabButtons = new Map();
  // The tabs use the left footer's icon-button component, so both sides
  // draw the same buttons at the same size.
  for (const tab of tabs) {
    const button = make("button", "sidebar-nav-button rp-tab");
    button.type = "button";
    button.title = tab.title;
    button.setAttribute("aria-label", tab.title);
    button.dataset.tab = tab.id;
    button.append(icon(tab.icon, 14));
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => select(tab.id, { focus: false }));
    tabsRow.append(button);
    tabButtons.set(tab.id, button);
    tab.el.setAttribute("role", "tabpanel");
    bodyEl.append(tab.el);
  }
  tabsRow.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const at = tabs.findIndex((tab) => tab.id === tabId);
    const next = tabs[(at + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    select(next.id, { focus: false });
    tabButtons.get(next.id).focus();
  });

  const currentTab = () => tabs.find((tab) => tab.id === tabId);

  function paintTabs() {
    for (const tab of tabs) {
      const selected = tab.id === tabId;
      const button = tabButtons.get(tab.id);
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      tab.el.hidden = !selected;
    }
  }

  function paintPin() {
    const label = pinned ? "Unpin: hide when a terminal takes the keyboard" : "Pin: keep the panel open";
    pin.title = label;
    pin.setAttribute("aria-label", label);
    pin.setAttribute("aria-pressed", String(pinned));
    document.body.classList.toggle("rp-pinned", pinned);
  }

  // ---- polling ----
  // Open polls the tab on screen; hidden polls nothing. A tick while the
  // last one still waits is skipped, so a slow git or ssh never piles
  // requests up.

  const ticking = new Set();
  const tick = (tab) => {
    if (ticking.has(tab.id)) return;
    ticking.add(tab.id);
    Promise.resolve(tab.refresh({ poll: true })).finally(() => ticking.delete(tab.id));
  };
  function polled() {
    if (document.hidden || !workspace || !open) return [];
    return [currentTab()];
  }
  function schedule() {
    for (const id of timer || []) clearInterval(id);
    timer = polled().map((tab) => setInterval(() => tick(tab), tab.interval));
  }
  function refreshShown() {
    for (const tab of polled()) tab.refresh();
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshShown();
    schedule();
  });
  // Coming back from an editor or a terminal elsewhere: what changed there
  // shows at once rather than on the next poll.
  window.addEventListener("focus", () => refreshShown());

  // ---- open and hidden ----

  function applyWidth() {
    document.documentElement.style.setProperty("--rp-width", `${width}px`);
  }

  function applyOpen() {
    document.body.classList.toggle("rp-open", open);
    el.inert = !open;
    el.setAttribute("aria-hidden", String(!open));
    onOpen(open);
  }

  // `handBack` gives the keyboard to the terminal when it was in the panel;
  // a hide because a terminal already took it leaves it there.
  function setOpen(next, { handBack = true } = {}) {
    if (next === open) return;
    open = next;
    if (!open) {
      const inside = el.contains(document.activeElement);
      releasePanelFocus();
      if (inside && handBack) focusBack();
    }
    applyOpen();
    // A workspace change refreshes inside follow; asking again would run
    // every tab's git calls twice.
    if (open && !follow(true)) refreshShown();
    schedule();
  }

  // A hide nobody asked for, if the rules let it happen.
  function autoHide(reason) {
    if (!open || !panelHides(reason, { pinned, viewer: Boolean(overlay) })) return false;
    setOpen(false, { handBack: reason !== "terminal" });
    return true;
  }

  function select(id, { focus = true } = {}) {
    if (!tabs.some((tab) => tab.id === id)) return;
    tabId = id;
    saveStored({ width, tab: tabId });
    paintTabs();
    // Choosing the tab already shown refreshes it.
    if (!open) setOpen(true);
    else currentTab().refresh();
    schedule();
    if (!focus) return;
    currentTab().focus();
    // A tab with nothing to focus yet (a note while it loads) still takes
    // the keyboard on its button.
    if (!el.contains(document.activeElement)) tabButtons.get(tabId).focus();
  }

  // The key and the left footer's toggle: a hidden panel opens (on `id`
  // when named), an open one hides, pinned or not.
  function toggle(id = null) {
    if (open && (!id || id === tabId)) {
      if (panelHides("toggle")) setOpen(false);
      return;
    }
    select(id || tabId);
  }

  pin.addEventListener("click", () => {
    pinned = !pinned;
    savePanelPin(windowStorage(), pinned);
    paintPin();
  });
  closeButton.addEventListener("click", () => setOpen(false));

  // The active column changed (or the panel opened): start over on it. True
  // when it refreshed the tabs.
  function follow(force = false) {
    const name = shownWorkspace();
    if (!force && name === workspace) return false;
    const changed = name !== workspace;
    workspace = name;
    if (changed) {
      record = null;
      closeOverlay({ handBack: false });
      for (const tab of tabs) tab.reset();
      if (workspace) {
        const asked = workspace;
        Promise.resolve(details(asked)).then((value) => {
          if (workspace !== asked) return;
          record = value || null;
          if (record && !record.path) autoHide("no-folder");
        }, () => {});
      }
      if (open) refreshShown();
      schedule();
    }
    return changed && open;
  }

  // ---- the keyboard inside the panel ----

  let panelClaimed = false;
  function releasePanelFocus() {
    if (!panelClaimed) return;
    panelClaimed = false;
    releaseFocus(PANEL_OWNER);
  }
  el.addEventListener("focusin", () => {
    if (panelClaimed) return;
    panelClaimed = true;
    claimFocus(PANEL_OWNER);
  });
  el.addEventListener("focusout", (event) => {
    if (!el.contains(event.relatedTarget)) releasePanelFocus();
  });
  // Escape hides it; pinned, it only hands the keyboard back.
  el.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    if (autoHide("escape")) return;
    releasePanelFocus();
    focusBack();
  });

  // ---- width: the left sidebar's grip, on this side's inner edge ----

  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !open) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    grip.classList.add("dragging");
    document.body.classList.add("rp-resizing");
    const right = el.getBoundingClientRect().right;
    let frame = 0;
    let pending = width;
    const move = (moveEvent) => {
      pending = clampPanelWidth(right - moveEvent.clientX, window.innerWidth);
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; width = pending; applyWidth(); });
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      if (frame) cancelAnimationFrame(frame);
      width = pending;
      applyWidth();
      grip.classList.remove("dragging");
      document.body.classList.remove("rp-resizing");
      saveStored({ width, tab: tabId });
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  grip.addEventListener("dblclick", () => {
    width = clampPanelWidth(PANEL_WIDTH_DEFAULT, window.innerWidth);
    applyWidth();
    saveStored({ width, tab: tabId });
  });
  grip.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 32 : 8;
    const delta = event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
    if (!delta) return;
    event.preventDefault();
    width = clampPanelWidth(width + delta, window.innerWidth);
    applyWidth();
    saveStored({ width, tab: tabId });
  });
  window.addEventListener("resize", () => {
    const next = clampPanelWidth(width, window.innerWidth);
    if (next !== width) {
      width = next;
      applyWidth();
    }
  });

  // ---- the file view and the diff, over the stage ----

  const viewerCtx = {
    ...ctx,
    close: () => closeOverlay(),
    openFile: (path, options = {}) => openViewer("file", path, options),
    openDiff: (path, group) => openViewer("diff", path, { group }),
  };

  function openViewer(kind, path, options = {}) {
    if (!workspace) return;
    if (overlay?.kind !== kind) {
      closeOverlay({ handBack: false });
      overlay = kind === "file" ? createFileView(viewerCtx) : createDiffView(viewerCtx);
      overlayHost.replaceChildren(overlay.el);
      overlayHost.hidden = false;
      claimFocus(OVERLAY_OWNER);
      overlay.el.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeOverlay();
          return;
        }
        if (overlay?.handleKey(event)) {
          event.preventDefault();
          event.stopPropagation();
        }
      });
    }
    if (kind === "file") overlay.open(workspace, path, options);
    else overlay.open(workspace, path, options.group || "changes");
    overlay.el.focus();
  }

  function closeOverlay({ handBack = true } = {}) {
    if (!overlay) return;
    overlay.dispose();
    overlay = null;
    overlayHost.replaceChildren();
    overlayHost.hidden = true;
    releaseFocus(OVERLAY_OWNER);
    if (!handBack) return;
    // Back where the file was opened from: the panel, while it is open.
    if (open) currentTab().focus?.();
    else focusBack();
  }

  // ---- Alt+click and "paste path into terminal" ----

  async function pastePaths(paths) {
    const app = activeApp();
    const id = app?.focusedSessionId?.();
    if (!id) {
      showError("No terminal is focused to paste the path into.");
      return false;
    }
    const type = app.focusedTerminalType?.() || "";
    if (!record?.host && (type === "ssh" || type === "sftp")) {
      showError("Local file paths are not available inside a remote terminal.");
      return false;
    }
    const absolute = paths.map((path) => joinPath(record?.path, path));
    const mapped = type === "wsl" ? absolute.map(windowsPathForWsl) : absolute;
    const text = mapped.map((path) => quoteDroppedPath(path, record?.host ? "bash" : type)).join(" ");
    try {
      await api.sendInput(id, text);
    } catch (error) {
      showError(error.detail || "Could not paste the path into the terminal.");
      return false;
    }
    focusBack();
    return true;
  }

  // The stored width lands before anything can slide, so a start does not
  // animate the panel from the stylesheet's default. A pinned panel comes
  // back open after a reload of this window, without taking the keyboard.
  document.body.classList.add("rp-sizing");
  applyWidth();
  paintTabs();
  paintPin();
  applyOpen();
  if (pinned) setOpen(true);
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove("rp-sizing")));

  return {
    el,
    toggle,
    show: (id) => select(id || tabId),
    close: () => setOpen(false),
    open: () => select(tabId),
    follow: () => follow(false),
    isOpen: () => open,
    isPinned: () => pinned,
    // A click or the keyboard went into a terminal (WorkspaceViews.onTouch).
    terminalTouched: () => autoHide("terminal"),
    closeViewer: () => closeOverlay(),
  };
}
