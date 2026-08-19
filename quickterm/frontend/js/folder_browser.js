// In-app directory browser: pick a folder without leaving the page.
//
// It replaced the native pywebview dialog as the primary picker for two
// reasons. The dialog only exists in the installed desktop app, so Browse was
// dead in a plain browser tab. And opening it moves focus out of the document
// entirely, which is one half of the bug where picking a folder silently did
// nothing. This modal is ordinary DOM, so it works in every viewer and the
// focus rules below are ours to enforce.
//
// Backed by GET /api/fs/dirs (quickterm/browse.py): directories only, one
// level at a time, hidden entries skipped, a `.git` child reported as a flag.

import * as api from "./api.js";
import { claimFocus, releaseFocus } from "./focus.js";
import { icon } from "./icons.js";

const FOCUS_OWNER = "folder-browser";

/** The keyboard contract, as a pure function, so it is testable without a DOM.
 *
 *  `where` is "path" (the caret is in the path bar), "row" (a folder row has
 *  focus), or "other" (a footer button has focus). A key with no action here is
 *  left entirely alone by the handler.
 *
 *  | key                  | path   | row     | other  |
 *  |----------------------|--------|---------|--------|
 *  | Escape               | cancel | cancel  | cancel |
 *  | Ctrl/Cmd+Enter       | use    | use     | use    |
 *  | Enter                | go     | descend | -      |
 *  | ArrowDown / ArrowUp  | down   | down/up | down/up|
 *  | ArrowRight           | -      | descend | -      |
 *  | ArrowLeft, Backspace | -      | parent  | -      |
 *  | Home / End           | -      | first/last | -   |
 *
 *  Three states rather than one flag, because each has a key it must not lose.
 *  Left/Right and Backspace stay editing keys while the caret is in the path
 *  bar. Enter on a footer button has to activate that button, so it maps to
 *  nothing and the browser does its job. ArrowDown works everywhere, so the
 *  list is one key away wherever focus happens to be.
 */
export function folderBrowserAction(key, { ctrl = false, where = "other" } = {}) {
  if (key === "Escape") return "cancel";
  if (key === "Enter" && ctrl) return "use";
  if (key === "ArrowDown") return "down";
  if (key === "ArrowUp") return "up";
  if (where === "path") return key === "Enter" ? "go" : null;
  if (where !== "row") return null;
  if (key === "Enter" || key === "ArrowRight") return "descend";
  if (key === "ArrowLeft" || key === "Backspace") return "parent";
  if (key === "Home") return "first";
  if (key === "End") return "last";
  return null;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Open the browser and resolve to an absolute path, or `null` if cancelled.
 *
 *  `options.startPath` is where it opens; the backend falls back to the home
 *  folder when that is blank or unreadable. `options.nativePicker` is the
 *  optional escape hatch to the OS dialog, injected rather than imported so
 *  this module stays free of a cycle with panel_shared.js: it is
 *  `{available(), pick(startIn)}` where `pick` resolves
 *  `{available, path, failed}`.
 */
export function openFolderBrowser(options = {}) {
  const native = options.nativePicker || null;
  const overlay = el("div", "fb-overlay");
  const dialog = el("div", "fb");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", options.label || "Choose a folder");

  const head = el("div", "fb-head");
  head.append(el("strong", "fb-title", options.title || "Choose a folder"));
  const closeBtn = el("button", "fb-close");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Cancel");
  closeBtn.append(icon("x", 14));
  head.append(closeBtn);

  const bar = el("div", "fb-bar");
  const upBtn = el("button", "fb-up");
  upBtn.type = "button";
  upBtn.title = "Parent folder";
  upBtn.setAttribute("aria-label", "Parent folder");
  upBtn.textContent = "↑";
  const pathInput = el("input", "fb-path");
  pathInput.type = "text";
  pathInput.spellcheck = false;
  pathInput.autocomplete = "off";
  pathInput.setAttribute("aria-label", "Folder path");
  pathInput.placeholder = "Type or paste a path, then press Enter";
  const goBtn = el("button", "fb-go", "Go");
  goBtn.type = "button";
  bar.append(upBtn, pathInput, goBtn);

  const rootsRow = el("div", "fb-roots");
  rootsRow.hidden = true;
  const listEl = el("div", "fb-list");
  listEl.setAttribute("role", "listbox");
  const msgEl = el("div", "fb-msg");
  msgEl.setAttribute("role", "status");

  const foot = el("div", "fb-foot");
  const nativeBtn = el("button", "fb-native", "OS dialog…");
  nativeBtn.type = "button";
  nativeBtn.title = "Open the operating system's own folder dialog";
  // Secondary on purpose: some people prefer the dialog they know, but it is
  // absent outside the installed app, so it can never be the only way through.
  nativeBtn.hidden = !(native && native.available());
  const spacer = el("span", "fb-foot-gap");
  const cancelBtn = el("button", "fb-cancel", "Cancel");
  cancelBtn.type = "button";
  const useBtn = el("button", "fb-use", "Use this folder");
  useBtn.type = "button";
  useBtn.disabled = true;
  foot.append(nativeBtn, spacer, cancelBtn, useBtn);

  dialog.append(head, bar, rootsRow, listEl, msgEl, foot);
  overlay.append(dialog);
  document.body.append(overlay);

  // Claim before focusing anything. A focused terminal pane re-asserts
  // term.focus() on a requestAnimationFrame and again on a zero timeout, so an
  // overlay that focuses its own input without claiming loses it a frame later
  // and looks broken. See focus.js.
  claimFocus(FOCUS_OWNER);

  let here = "";
  let parent = null;
  let settled = false;
  let requestId = 0;

  return new Promise((resolve) => {
    function finish(value) {
      if (settled) return;
      settled = true;
      overlay.remove();
      // Release before handing control back, or whatever the caller focuses
      // next is refused by the guard this modal installed.
      releaseFocus(FOCUS_OWNER);
      resolve(value);
    }

    function rows() {
      return [...listEl.querySelectorAll(".fb-row")];
    }

    function focusRow(index) {
      const all = rows();
      if (!all.length) return;
      const clamped = Math.max(0, Math.min(all.length - 1, index));
      all[clamped].focus();
      all[clamped].scrollIntoView({ block: "nearest" });
    }

    function step(delta) {
      const all = rows();
      if (!all.length) return;
      const current = all.indexOf(document.activeElement);
      if (current < 0) {
        focusRow(delta > 0 ? 0 : all.length - 1);
        return;
      }
      const next = current + delta;
      // Stepping up off the first row returns to the path bar, so the caret is
      // always one key away from the top of the list.
      if (next < 0) pathInput.focus();
      else focusRow(next);
    }

    function renderRoots(list) {
      rootsRow.textContent = "";
      // Only offered where climbing has run out: at C:\ the useful next move is
      // D:\, and there is no parent row to take you there.
      if (parent || !list.length) {
        rootsRow.hidden = true;
        return;
      }
      rootsRow.hidden = false;
      rootsRow.append(el("span", "fb-roots-label", "Roots"));
      for (const root of list) {
        const btn = el("button", "fb-root", root.name);
        btn.type = "button";
        btn.addEventListener("click", () => go(root.path));
        rootsRow.append(btn);
      }
    }

    async function go(path) {
      const mine = ++requestId;
      msgEl.textContent = "";
      msgEl.classList.remove("fb-msg-error");
      listEl.setAttribute("aria-busy", "true");
      let data;
      try {
        data = await api.listDirs(path);
      } catch (err) {
        if (mine !== requestId || settled) return null;
        listEl.removeAttribute("aria-busy");
        msgEl.textContent = err.detail || err.message || "could not read that folder";
        msgEl.classList.add("fb-msg-error");
        // The listing that is still on screen is still valid, so it stays:
        // a typo in the path bar must not wipe out where you were.
        return null;
      }
      if (mine !== requestId || settled) return null;
      listEl.removeAttribute("aria-busy");
      here = data.path;
      parent = data.parent;
      pathInput.value = here;
      upBtn.disabled = !parent;
      useBtn.disabled = false;
      useBtn.title = `Use ${here}`;
      renderRoots(data.roots || []);

      listEl.textContent = "";
      for (const dir of data.dirs || []) {
        const row = el("button", "fb-row");
        row.type = "button";
        // Roving focus: Tab steps between the modal's controls, arrows move
        // inside the list. Tabbing through 200 folders one at a time is not a
        // keyboard contract anybody wants.
        row.tabIndex = -1;
        row.dataset.path = dir.path;
        row.setAttribute("role", "option");
        row.append(icon("folder", 13));
        row.append(el("span", "fb-name", dir.name));
        if (dir.is_git) row.append(el("span", "fb-git", "git"));
        listEl.append(row);
      }
      if (!(data.dirs || []).length) {
        listEl.append(el("div", "fb-empty", "No sub-folders here."));
      } else if (data.truncated) {
        listEl.append(el("div", "fb-empty", "Too many folders to list; type a path instead."));
      }
      return data;
    }

    function descend(target) {
      const path = target || document.activeElement?.dataset?.path;
      if (path) go(path);
    }

    async function useHere() {
      const typed = pathInput.value.trim();
      if (!typed || typed === here) {
        if (here) finish(here);
        return;
      }
      // A path pasted into the bar and never confirmed with Enter. Resolve it
      // first: a typo then shows an error in this modal instead of quietly
      // becoming a workspace folder that does not exist. The answer handed
      // back is the resolved absolute path, not the string as typed.
      useBtn.disabled = true;
      const data = await go(typed);
      useBtn.disabled = false;
      if (data) finish(data.path);
    }

    listEl.addEventListener("click", (e) => {
      const row = e.target.closest(".fb-row");
      if (row) descend(row.dataset.path);
    });
    upBtn.addEventListener("click", () => { if (parent) go(parent); });
    goBtn.addEventListener("click", () => go(pathInput.value.trim()));
    cancelBtn.addEventListener("click", () => finish(null));
    closeBtn.addEventListener("click", () => finish(null));
    useBtn.addEventListener("click", useHere);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) finish(null); });

    nativeBtn.addEventListener("click", async () => {
      if (!native) return;
      nativeBtn.disabled = true;
      const result = await native.pick(pathInput.value.trim() || here || "");
      nativeBtn.disabled = false;
      if (settled) return;
      if (result.path) { finish(result.path); return; }
      if (result.failed) {
        msgEl.textContent = "The OS folder dialog failed. Use this browser instead.";
        msgEl.classList.add("fb-msg-error");
      }
      // Cancel in the OS dialog means "keep choosing here", and the dialog took
      // the keyboard with it, so take it back.
      pathInput.focus();
    });

    // A path that has been typed but not yet listed is still a usable answer:
    // "Use this folder" resolves it before handing it back.
    pathInput.addEventListener("input", () => {
      useBtn.disabled = !pathInput.value.trim() && !here;
    });

    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        // The panel behind this modal traps Tab inside its own element from a
        // document-level listener. This overlay is not inside that element, so
        // Tab would jump out of the modal and back into the panel unless the
        // event stops here and the trap is re-implemented for this dialog.
        const focusable = [...dialog.querySelectorAll(
          'button:not([disabled]):not([tabindex="-1"]), input:not([disabled])',
        )].filter((node) => !node.hidden && node.offsetParent !== null);
        if (!focusable.length) return;
        e.stopPropagation();
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        return;
      }
      let where = "other";
      if (e.target === pathInput) where = "path";
      else if (e.target.classList?.contains("fb-row")) where = "row";
      const action = folderBrowserAction(e.key, { ctrl: e.ctrlKey || e.metaKey, where });
      if (!action) return;
      // Only claimed keys are swallowed, so typing in the path bar and Tab
      // between the controls behave exactly as they look.
      e.preventDefault();
      e.stopPropagation();
      if (action === "cancel") finish(null);
      else if (action === "use") useHere();
      else if (action === "go") go(pathInput.value.trim());
      else if (action === "descend") descend();
      else if (action === "parent") { if (parent) go(parent); }
      else if (action === "down") step(1);
      else if (action === "up") step(-1);
      else if (action === "first") focusRow(0);
      else if (action === "last") focusRow(rows().length - 1);
    });

    async function start() {
      const wanted = options.startPath || "";
      // Seeded before the request so a path that fails to open is still on
      // screen to be corrected rather than silently replaced.
      pathInput.value = wanted;
      if (await go(wanted) || settled || !wanted) return;
      // The field held a folder that has since been deleted, or a file path.
      // An empty modal is a dead end, so fall back to the default listing and
      // keep the reason visible.
      const why = msgEl.textContent;
      if (await go("")) {
        msgEl.textContent = why;
        msgEl.classList.add("fb-msg-error");
      }
    }

    start();
    // The overlay was appended a moment ago; WebView2 does not reliably move
    // focus into an element that only just entered the layout, so ask twice.
    pathInput.focus();
    requestAnimationFrame(() => { if (!settled) pathInput.focus(); });
  });
}
