// The right panel: the left sidebar's mirror on the right of the stage, with
// the same three modes. Full shows three icon tabs (Files, Changes, Pull
// request) in a header row as tall as the left one and a footer with the
// collapse chevron in its outer corner; rail is the three icons with their
// state dots; hidden takes no space. It belongs to the window and always
// shows the shown workspace. The width is dragged at the inner edge and
// remembered per machine. The file view and the diff open over the stage,
// one at a time, with the terminals still loaded behind them.

import * as api from "./api.js";
import * as wsApi from "./ws_api.js";
import { claimFocus, releaseFocus } from "./focus.js";
import { quoteDroppedPath, windowsPathForWsl } from "./pane.js";
import {
  PANEL_WIDTH_DEFAULT, chevronPanelMode, clampPanelWidth, keyPanelMode, loadPanelMode, railMarks,
  savePanelMode,
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
// The slide's length in sidebar.css plus a margin, for when no transitionend
// comes (reduced motion, a hidden window).
const SLIDE_FALLBACK_MS = 260;

function storage() {
  try { return window.localStorage; } catch (_) { return null; }
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
// workspace on it (".scratch" for the scratch view), or null for an empty
// stage; `details(name)` resolves to its record ({path, host, ...});
// `activeApp()` is the shown view's app; `fixWithClaude(name, build)` starts
// Claude Code in that workspace; `focusBack()` hands the keyboard to the
// shown terminal; `fit()` re-fits the terminals after the stage changed
// size; `onMode(mode)` hears every mode change (the left footer's toggle).
export function createRightPanel({
  views, shownWorkspace, details, activeApp, fixWithClaude, focusBack, fit, showError, onMode = () => {},
}) {
  const stored = loadStored();
  let width = clampPanelWidth(Number(stored.width) || PANEL_WIDTH_DEFAULT, window.innerWidth);
  let tabId = ["files", "changes", "pr"].includes(stored.tab) ? stored.tab : "files";
  let mode = loadPanelMode(storage());
  let workspace = null;
  let record = null;
  let timer = 0;
  let overlay = null;
  let changesSeen = null;
  let prSeen = null;

  const el = make("aside", "right-panel");
  el.setAttribute("aria-label", "Files, changes and pull request");
  const grip = make("div", "rp-grip");
  grip.tabIndex = 0;
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-orientation", "vertical");
  grip.setAttribute("aria-label", "Resize the right panel");
  grip.title = "Drag to resize the right panel, double-click to reset";
  const tabsRow = make("div", "rp-tabs");
  tabsRow.setAttribute("role", "tablist");
  const bodyEl = make("div", "rp-body");
  const rail = make("nav", "rp-railbar");
  rail.setAttribute("aria-label", "Right panel");
  const footer = make("div", "rp-footer");
  const collapse = make("button", "sidebar-collapse rp-collapse");
  collapse.type = "button";
  collapse.append(icon("chevron-right", 14));
  footer.append(collapse);
  el.append(grip, tabsRow, rail, bodyEl, footer);
  document.getElementById("app").append(el);

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
      paintRail();
    },
    notePr: (name, answer) => {
      prSeen = { name, answer };
      paintRail();
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
  const railButtons = new Map();
  // The tabs use the left footer's icon-button component, so both sides
  // draw the same buttons at the same size.
  const navButton = (tab, className) => {
    const button = make("button", `sidebar-nav-button ${className}`);
    button.type = "button";
    button.title = tab.title;
    button.setAttribute("aria-label", tab.title);
    button.dataset.tab = tab.id;
    button.append(icon(tab.icon, 14));
    return button;
  };
  for (const tab of tabs) {
    const button = navButton(tab, "rp-tab");
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => select(tab.id, { focus: false }));
    tabsRow.append(button);
    tabButtons.set(tab.id, button);
    tab.el.setAttribute("role", "tabpanel");
    bodyEl.append(tab.el);
    const railButton = navButton(tab, "rp-rail-button");
    const dot = make("span", "rp-rail-dot");
    dot.hidden = true;
    railButton.append(dot);
    railButton.addEventListener("click", () => select(tab.id));
    rail.append(railButton);
    railButtons.set(tab.id, railButton);
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
  const tabById = (id) => tabs.find((tab) => tab.id === id);

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

  function paintRail() {
    const marks = railMarks(
      changesSeen?.name === workspace ? changesSeen.answer : null,
      prSeen?.name === workspace ? prSeen.answer : null,
    );
    const changes = railButtons.get("changes").querySelector(".rp-rail-dot");
    changes.hidden = !marks.changes;
    const pr = railButtons.get("pr").querySelector(".rp-rail-dot");
    pr.hidden = !marks.pr;
    pr.dataset.state = marks.pr || "";
    railButtons.get("changes").title = marks.changes ? "Changes: the working tree has changes" : "Changes";
    railButtons.get("pr").title = marks.pr ? `Pull request: checks ${marks.pr}` : "Pull request";
  }

  // ---- polling ----
  // Full polls the tab on screen; rail polls Changes and Pull request for
  // their dots; hidden polls nothing. A tick while the last one still waits
  // is skipped, so a slow git or ssh never piles requests up.

  const ticking = new Set();
  const tick = (tab) => {
    if (ticking.has(tab.id)) return;
    ticking.add(tab.id);
    Promise.resolve(tab.refresh({ poll: true })).finally(() => ticking.delete(tab.id));
  };
  function polled() {
    if (document.hidden || !workspace) return [];
    if (mode === "full") return [currentTab()];
    if (mode === "rail") return [tabById("changes"), tabById("pr")];
    return [];
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

  // ---- modes ----

  function applyWidth() {
    document.documentElement.style.setProperty("--rp-width", `${width}px`);
  }

  // The terminals refit once, when the slide has ended, never per frame.
  let fitWait = null;
  function fitAfterSlide() {
    const app = document.getElementById("app");
    if (fitWait) fitWait();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      app.removeEventListener("transitionend", onEnd);
      clearTimeout(timeout);
      fitWait = null;
      fit();
    };
    const onEnd = (event) => {
      if (event.target === app && event.propertyName === "grid-template-columns") finish();
    };
    const timeout = setTimeout(finish, SLIDE_FALLBACK_MS);
    app.addEventListener("transitionend", onEnd);
    fitWait = () => { done = true; app.removeEventListener("transitionend", onEnd); clearTimeout(timeout); };
  }

  function describeCollapse() {
    const title = mode === "rail" ? "Expand the right panel" : "Collapse the right panel to icons";
    collapse.title = `${title} (Alt+Shift+E opens and closes it)`;
    collapse.setAttribute("aria-label", title);
    collapse.setAttribute("aria-expanded", String(mode === "full"));
  }

  function applyMode(previous) {
    const body = document.body.classList;
    body.toggle("rp-mode-full", mode === "full");
    body.toggle("rp-mode-rail", mode === "rail");
    body.toggle("rp-mode-hidden", mode === "hidden");
    // Hidden from the rail slides the rail out, not the full panel.
    body.toggle("rp-mode-was-rail", mode === "hidden" && previous === "rail");
    el.inert = mode === "hidden";
    el.setAttribute("aria-hidden", String(mode === "hidden"));
    describeCollapse();
    onMode(mode);
  }

  function setMode(next) {
    if (next === mode) return;
    const previous = mode;
    mode = next;
    savePanelMode(storage(), mode);
    if (mode !== "full") {
      const inside = el.contains(document.activeElement);
      releasePanelFocus();
      if (inside) focusBack();
    }
    applyMode(previous);
    // A workspace change refreshes inside follow; asking again would run
    // every tab's git calls twice.
    if (mode !== "hidden" && !follow(true)) refreshShown();
    schedule();
    fitAfterSlide();
  }

  function select(id, { focus = true } = {}) {
    if (!tabs.some((tab) => tab.id === id)) return;
    tabId = id;
    saveStored({ width, tab: tabId });
    paintTabs();
    // Choosing the tab already shown refreshes it.
    if (mode !== "full") setMode("full");
    else currentTab().refresh();
    schedule();
    if (focus) currentTab().focus();
  }

  // The key and the left footer's toggle: hidden or rail opens full, full
  // closes. With a tab named, a closed panel opens on that tab.
  function toggle(id = null) {
    if (mode === "full" && (!id || id === tabId)) {
      setMode(keyPanelMode(mode));
      return;
    }
    select(id || tabId);
  }

  collapse.addEventListener("click", () => setMode(chevronPanelMode(mode)));

  // The shown workspace changed (or the panel opened): start over on it.
  // True when it refreshed the tabs.
  function follow(force = false) {
    const name = shownWorkspace();
    if (!force && name === workspace) return false;
    const changed = name !== workspace;
    workspace = name;
    if (changed) {
      record = null;
      closeOverlay({ handBack: false });
      for (const tab of tabs) tab.reset();
      paintRail();
      if (workspace) {
        const asked = workspace;
        Promise.resolve(details(asked)).then((value) => {
          if (workspace === asked) record = value || null;
        }, () => {});
      }
      if (mode !== "hidden") refreshShown();
      schedule();
    }
    return changed && mode !== "hidden";
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
  el.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    releasePanelFocus();
    focusBack();
  });

  // ---- width: the left sidebar's grip, on this side's inner edge ----

  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || mode !== "full") return;
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
      fit();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  grip.addEventListener("dblclick", () => {
    width = clampPanelWidth(PANEL_WIDTH_DEFAULT, window.innerWidth);
    applyWidth();
    saveStored({ width, tab: tabId });
    fit();
  });
  grip.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 32 : 8;
    const delta = event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
    if (!delta) return;
    event.preventDefault();
    width = clampPanelWidth(width + delta, window.innerWidth);
    applyWidth();
    saveStored({ width, tab: tabId });
    fit();
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
    if (handBack) focusBack();
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

  // The stored width and mode land before the grid can animate, so a start
  // does not slide the panel in from the stylesheet's default.
  document.body.classList.add("sidebar-sizing");
  applyWidth();
  paintTabs();
  paintRail();
  applyMode(null);
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove("sidebar-sizing")));
  if (mode !== "hidden") follow(true);

  return {
    el,
    toggle,
    show: (id) => select(id || tabId),
    close: () => setMode("hidden"),
    setMode: (next) => setMode(next),
    mode: () => mode,
    follow: () => follow(false),
    isOpen: () => mode === "full",
    closeViewer: () => closeOverlay(),
  };
}
