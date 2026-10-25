// Find in one terminal (Ctrl+Shift+F) and the whole-buffer copy. The find
// field is small and sits at the pane's top right, never a bar across it:
// the query, the match count ("3/17"), case and regex toggles, previous and
// next. Enter and Shift+Enter step, Alt+C and Alt+R toggle, Escape closes and
// hands the keyboard back to the terminal. Matching is xterm's own search
// addon (vendor/addon-search.js), loaded into a terminal the first time
// someone searches it.
//
// The field claims the keyboard (focus.js) only while it has focus: a click
// back into the terminal leaves it open with its matches marked, and the
// terminal keeps focus instead of being pulled back into the field.

import { claimFocus, releaseFocus } from "./focus.js";
import { logicalLines } from "./buffer_search.js";

export const COPY_LIMIT_BYTES = 2 * 1024 * 1024;
const OWNER = "pane-find";
const ENC = new TextEncoder();

// "3/17", "0/0" for nothing found, "1000+" once the addon stops counting,
// "" before anything was typed.
export function findCountText({ resultIndex = -1, resultCount = 0 } = {}, query = "") {
  if (!query) return "";
  if (!resultCount) return "0/0";
  if (resultIndex < 0) return `${resultCount}+`;
  return `${resultIndex + 1}/${resultCount}`;
}

// The addon wants #RRGGBB for its backgrounds.
export function hexColour(value) {
  const text = String(value || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) return text;
  if (/^#[0-9a-f]{8}$/i.test(text)) return text.slice(0, 7);
  if (/^#[0-9a-f]{3}$/i.test(text)) return `#${[...text.slice(1)].map((c) => c + c).join("")}`;
  return null;
}

// Match colours from the pane's own terminal theme: every match like an
// unfocused selection, the current one like the selection with the cursor's
// colour around it. Without decorations the addon counts nothing.
export function findDecorations(theme = {}) {
  const ruler = hexColour(theme.yellow) || hexColour(theme.cursor) || hexColour(theme.foreground);
  const decorations = {
    matchOverviewRuler: ruler || "currentColor",
    activeMatchColorOverviewRuler: hexColour(theme.cursor) || ruler || "currentColor",
  };
  const match = hexColour(theme.selectionInactiveBackground) || hexColour(theme.selectionBackground);
  const active = hexColour(theme.selectionBackground);
  const border = hexColour(theme.cursor);
  if (match) decorations.matchBackground = match;
  if (active) decorations.activeMatchBackground = active;
  if (border) decorations.activeMatchBorder = border;
  return decorations;
}

// The buffer as plain text: wrapped rows joined into the lines the program
// wrote, trailing blank lines dropped. Past `limit` UTF-8 bytes only the
// newest whole lines are kept, since those are the ones someone is after.
export function terminalText(buffer, limit = COPY_LIMIT_BYTES) {
  const lines = logicalLines(buffer).map((line) => line.text.replace(/\s+$/, ""));
  while (lines.length && !lines.at(-1)) lines.pop();
  let bytes = 0;
  let first = lines.length;
  while (first > 0) {
    const size = ENC.encode(lines[first - 1]).length + 1;
    if (bytes + size > limit) break;
    bytes += size;
    first -= 1;
  }
  return { text: lines.slice(first).join("\n"), lines: lines.length - first, truncated: first > 0 };
}

export class PaneFind {
  constructor(pane) {
    this.pane = pane;
    this.addon = null;
    this.el = null;
    this.input = null;
    this.count = null;
    this.caseSensitive = false;
    this.regex = false;
    this.claimed = false;
    this.results = { resultIndex: -1, resultCount: 0 };
  }

  get isOpen() {
    return Boolean(this.el && !this.el.hidden);
  }

  _ensureAddon() {
    const term = this.pane.term;
    if (this.addon || !term || typeof SearchAddon === "undefined") return this.addon;
    try {
      this.addon = new SearchAddon.SearchAddon({ highlightLimit: 1000 });
      term.loadAddon(this.addon);
      this.addon.onDidChangeResults((results) => {
        this.results = results || { resultIndex: -1, resultCount: 0 };
        this._paintCount();
      });
    } catch (_) {
      this.addon = null;
    }
    return this.addon;
  }

  _build() {
    const el = document.createElement("div");
    el.className = "pane-find";
    el.setAttribute("role", "search");
    el.innerHTML =
      '<input class="pane-find-input" type="text" spellcheck="false" autocomplete="off" placeholder="Find" aria-label="Find in terminal">' +
      '<span class="pane-find-count" aria-live="polite"></span>' +
      '<button class="pane-find-toggle" type="button" data-toggle="case" title="Match case (Alt+C)" aria-pressed="false">Aa</button>' +
      '<button class="pane-find-toggle" type="button" data-toggle="regex" title="Regular expression (Alt+R)" aria-pressed="false">.*</button>' +
      '<button class="pane-find-step" type="button" data-step="-1" title="Previous match (Shift+Enter)" aria-label="Previous match">↑</button>' +
      '<button class="pane-find-step" type="button" data-step="1" title="Next match (Enter)" aria-label="Next match">↓</button>' +
      '<button class="pane-find-close" type="button" title="Close (Escape)" aria-label="Close find">×</button>';
    this.input = el.querySelector("input");
    this.count = el.querySelector(".pane-find-count");
    this.input.addEventListener("input", () => this.search(1, true));
    this.input.addEventListener("keydown", (event) => this._onKey(event));
    this.input.addEventListener("focus", () => this._claim());
    this.input.addEventListener("blur", () => this._release());
    // Buttons never take the keyboard away from the field.
    el.addEventListener("mousedown", (event) => {
      if (event.target.closest("button")) event.preventDefault();
    });
    el.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      event.stopPropagation();
      if (button.dataset.toggle) this.toggle(button.dataset.toggle);
      else if (button.dataset.step) this.search(Number(button.dataset.step));
      else this.close();
    });
    this.el = el;
    this.pane.el.append(el);
  }

  _claim() {
    if (this.claimed) return;
    this.claimed = true;
    claimFocus(OWNER);
  }

  _release() {
    if (!this.claimed) return;
    this.claimed = false;
    releaseFocus(OWNER);
  }

  open() {
    if (!this.pane.term) return false;
    if (!this.el) this._build();
    this.el.hidden = false;
    // A one-line selection is what someone wants to find more of.
    const selection = this.pane.term.getSelection?.() || "";
    if (selection && !selection.includes("\n") && selection.length <= 200) this.input.value = selection;
    this._claim();
    this.input.focus();
    this.input.select();
    if (this.input.value) this.search(1, true);
    else this._paintCount();
    return true;
  }

  close({ refocus = true } = {}) {
    if (!this.el || this.el.hidden) return;
    this.el.hidden = true;
    try { this.addon?.clearDecorations(); } catch (_) { /* terminal gone */ }
    this.results = { resultIndex: -1, resultCount: 0 };
    this._release();
    if (refocus) this.pane.focusSoon();
  }

  toggle(which) {
    if (which === "case") this.caseSensitive = !this.caseSensitive;
    else if (which === "regex") this.regex = !this.regex;
    else return;
    for (const button of this.el.querySelectorAll("[data-toggle]")) {
      const on = button.dataset.toggle === "case" ? this.caseSensitive : this.regex;
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    }
    this.search(1, true);
  }

  // Next (1) or previous (-1) match. `incremental` keeps the current match
  // while it still matches the query being typed.
  search(direction = 1, incremental = false) {
    const addon = this._ensureAddon();
    const query = this.input?.value || "";
    this.el?.classList.remove("invalid");
    if (!addon) return false;
    if (!query) {
      try { addon.clearDecorations(); } catch (_) { /* nothing marked */ }
      this.results = { resultIndex: -1, resultCount: 0 };
      this._paintCount();
      return false;
    }
    if (this.regex) {
      try { new RegExp(query); } catch (_) {
        this.el.classList.add("invalid");
        this.count.textContent = "bad regex";
        return false;
      }
    }
    const options = {
      caseSensitive: this.caseSensitive,
      regex: this.regex,
      incremental: incremental && direction > 0,
      decorations: findDecorations(this.pane.theme),
    };
    let found = false;
    try {
      found = direction < 0 ? addon.findPrevious(query, options) : addon.findNext(query, options);
    } catch (_) {
      found = false;
    }
    if (!found) {
      this.results = { resultIndex: -1, resultCount: 0 };
      this._paintCount();
    }
    return found;
  }

  _paintCount() {
    if (this.count) this.count.textContent = findCountText(this.results, this.input?.value || "");
  }

  _onKey(event) {
    const key = event.key.toLowerCase();
    let handled = true;
    if (event.key === "Escape") this.close();
    else if (event.key === "Enter") this.search(event.shiftKey ? -1 : 1);
    else if (event.altKey && !event.ctrlKey && !event.metaKey && (key === "c" || event.code === "KeyC")) this.toggle("case");
    else if (event.altKey && !event.ctrlKey && !event.metaKey && (key === "r" || event.code === "KeyR")) this.toggle("regex");
    else if (event.ctrlKey && event.shiftKey && (key === "f" || event.code === "KeyF")) this.input.select();
    else handled = false;
    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
  }

  dispose() {
    this._release();
    try { this.addon?.dispose(); } catch (_) { /* terminal already disposed */ }
    this.addon = null;
    this.el?.remove();
    this.el = null;
  }
}
