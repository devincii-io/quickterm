// The theme switcher: a centred sheet of theme cards that stays open while
// you try them. Each card is a miniature of the window in that theme (a
// sidebar with the shown workspace and two rows, a terminal with a prompt, a
// command and its output in the theme's ANSI colours). Moving the selection,
// with the arrows, by typing a filter or under the pointer, previews the
// theme on the whole window and every view; Enter or a click saves it and
// the sheet stays; Escape or Cancel goes back to the theme it opened on;
// Done keeps the card the keyboard is on. The rules live in
// theme_switcher_model.js.

import * as api from "./api.js";
import { claimFocus, releaseFocus } from "./focus.js";
import { icon } from "./icons.js";
import { make } from "./panel_shared.js";
import {
  apply, closePlan, createSwitcherModel, editCustom, filterEntries, groupEntries, hover, select,
  stepId, switcherEntries,
} from "./theme_switcher_model.js";
import { CUSTOM_THEME, CUSTOM_THEME_DEFAULTS, chromeTokens, getTheme } from "./themes.js";

const FOCUS_OWNER = "theme-switcher";
// A pointer sweeping across the grid would repaint every terminal per card.
const HOVER_DELAY_MS = 90;

let current = null;

export function themeSwitcherOpen() {
  return Boolean(current);
}

// The terminal lines a card shows: [ansi key or "fg", text] runs.
const SAMPLE = [
  [["green", "❯ "], ["fg", "git "], ["blue", "status"]],
  [["magenta", "main"], ["fg", " · "], ["yellow", "2 changed"]],
  [["red", "✗ "], ["fg", "1 failing "], ["cyan", "test"]],
];

// The miniature: chrome colours from chromeTokens(), terminal colours from
// the xterm theme, all handed over as custom properties.
export function paintMiniature(node, id, custom = {}) {
  const def = getTheme(id, custom);
  const { values } = chromeTokens(id, custom);
  const set = (name, value) => node.style.setProperty(name, value);
  set("--m-bg", values["--bg"]);
  set("--m-surface", values["--surface"]);
  set("--m-active", values["--surface-active"]);
  set("--m-text", values["--text"]);
  set("--m-muted", values["--muted"]);
  set("--m-accent", values["--accent"]);
  set("--m-line", values["--line"]);
  set("--m-term-bg", def.xterm.background);
  set("--m-term-fg", def.xterm.foreground);
  set("--m-cursor", def.xterm.cursor);
  for (const line of node.querySelectorAll("[data-ansi]")) {
    line.style.color = line.dataset.ansi === "fg" ? def.xterm.foreground : def.xterm[line.dataset.ansi];
  }
}

// A painted miniature on its own, for the Settings row.
export function themeMiniature(id, custom = {}) {
  const node = miniature();
  paintMiniature(node, id, custom);
  return node;
}

function miniature() {
  const mini = make("span", "ts-mini");
  mini.setAttribute("aria-hidden", "true");
  const side = make("span", "ts-mini-side");
  const card = make("span", "ts-mini-card");
  card.append(make("i", "ts-mini-dot"), make("i", "ts-mini-bar ts-mini-name"));
  const rowA = make("span", "ts-mini-row");
  rowA.append(make("i", "ts-mini-dot hollow"), make("i", "ts-mini-bar"));
  const rowB = make("span", "ts-mini-row");
  rowB.append(make("i", "ts-mini-dot hollow"), make("i", "ts-mini-bar short"));
  side.append(card, rowA, rowB);
  const term = make("span", "ts-mini-term");
  for (const runs of SAMPLE) {
    const line = make("span", "ts-mini-line");
    for (const [key, text] of runs) {
      const run = make("span", "", text);
      run.dataset.ansi = key;
      line.append(run);
    }
    term.append(line);
  }
  const prompt = make("span", "ts-mini-line");
  const arrow = make("span", "", "❯ ");
  arrow.dataset.ansi = "green";
  prompt.append(arrow, make("i", "ts-mini-cursor"));
  term.append(prompt);
  mini.append(side, term);
  return mini;
}

function card(entry) {
  const button = make("button", "ts-card");
  button.type = "button";
  button.dataset.id = entry.id;
  button.id = `ts-card-${entry.id}`;
  button.setAttribute("role", "option");
  button.tabIndex = -1;
  const label = make("span", "ts-card-label");
  label.append(make("strong", "", entry.label), make("small", "", entry.note));
  const mark = make("span", "ts-card-mark");
  mark.append(icon("check", 12));
  button.append(miniature(), label, mark);
  return button;
}

/**
 * Open the switcher. `app` needs previewTheme, appliedTheme, onConfigSaved
 * and refocusTerm. `returnFocus` gets the keyboard back when the sheet came
 * from a control (Settings); `onApplied(theme, custom)` hears every save.
 */
export function openThemeSwitcher(app, { returnFocus = null, onApplied = null } = {}) {
  if (current) {
    current.focus();
    return current;
  }
  const start = app.appliedTheme?.() || { theme: "graphite", custom_theme: {} };
  let model = createSwitcherModel({ theme: start.theme, custom: start.custom_theme });
  const entries = () => switcherEntries(model.custom);

  const overlay = make("div", "ts-overlay");
  const sheet = make("section", "ts-sheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", "Color theme");

  const head = make("header", "ts-head");
  const titles = make("div", "ts-titles");
  titles.append(
    make("h2", "ts-title", "Color theme"),
    make("p", "ts-subtitle", "Arrows or the pointer preview a theme on the whole window. Enter or a click applies it."),
  );
  const searchBox = make("label", "ts-search");
  searchBox.append(icon("search", 13));
  const search = make("input", "ts-search-input");
  search.type = "search";
  search.placeholder = "Search themes";
  search.spellcheck = false;
  search.setAttribute("aria-label", "Search themes");
  searchBox.append(search);
  const cancel = make("button", "secondary-button compact ts-cancel", "Cancel");
  cancel.type = "button";
  cancel.title = "Back to the theme you started with (Esc)";
  const done = make("button", "primary-button compact ts-done", "Done");
  done.type = "button";
  done.title = "Keep the selected theme and close";
  const actions = make("div", "ts-actions");
  actions.append(cancel, done);
  head.append(titles, searchBox, actions);

  const list = make("div", "ts-list");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Themes");

  const editor = make("div", "ts-custom");
  const editorTitle = make("p", "ts-custom-title", "Custom colours");
  editor.append(editorTitle);
  const colorInputs = {};
  for (const key of Object.keys(CUSTOM_THEME_DEFAULTS)) {
    const field = make("label", "ts-custom-field");
    const input = make("input");
    input.type = "color";
    input.dataset.key = key;
    colorInputs[key] = input;
    field.append(input, make("span", "", key.replace(/^./, (char) => char.toUpperCase())));
    editor.append(field);
  }
  const applyCustom = make("button", "secondary-button compact ts-custom-apply", "Apply custom");
  applyCustom.type = "button";
  editor.append(applyCustom);

  const foot = make("footer", "ts-foot");
  const status = make("span", "ts-status");
  status.setAttribute("aria-live", "polite");
  foot.append(status, make("span", "ts-keys", "↑↓←→ preview · Enter apply · Esc back"));

  sheet.append(head, list, editor, foot);
  overlay.append(sheet);
  document.body.append(overlay);

  // ---- drawing ----
  const cards = new Map();
  let shownIds = [];
  const renderList = () => {
    const shown = filterEntries(entries(), search.value);
    shownIds = shown.map((entry) => entry.id);
    list.textContent = "";
    if (!shown.length) {
      list.append(make("p", "ts-empty", `No theme matches "${search.value.trim()}".`));
      return;
    }
    for (const group of groupEntries(shown)) {
      const section = make("section", "ts-group");
      section.setAttribute("role", "group");
      section.setAttribute("aria-label", group.heading);
      section.append(make("h3", "ts-group-title", `${group.heading} · ${group.entries.length}`));
      const grid = make("div", "ts-grid");
      for (const entry of group.entries) {
        let node = cards.get(entry.id);
        if (!node) {
          node = card(entry);
          cards.set(entry.id, node);
        }
        grid.append(node);
      }
      section.append(grid);
      list.append(section);
    }
    paintCards();
  };
  const paintCards = () => {
    for (const [id, node] of cards) {
      if (!node.isConnected) continue;
      if (id === CUSTOM_THEME || !node.dataset.painted) {
        paintMiniature(node.querySelector(".ts-mini"), id, model.custom);
        node.dataset.painted = "1";
      }
      const selected = id === model.selected;
      node.classList.toggle("selected", selected);
      node.classList.toggle("applied", id === model.applied);
      node.setAttribute("aria-selected", String(selected));
    }
    editor.hidden = model.selected !== CUSTOM_THEME;
    for (const [key, input] of Object.entries(colorInputs)) {
      if (document.activeElement !== input) input.value = model.custom[key].toLowerCase();
    }
    // The keyboard stays in the search field; the listbox names the card.
    const node = cards.get(model.selected);
    if (node?.isConnected) search.setAttribute("aria-activedescendant", node.id);
    else search.removeAttribute("aria-activedescendant");
  };

  let previewShown = null;
  const showPreview = () => {
    const key = `${model.previewed}:${model.previewed === CUSTOM_THEME ? JSON.stringify(model.custom) : ""}`;
    if (key === previewShown) return;
    previewShown = key;
    app.previewTheme(model.previewed, model.custom);
  };
  const setModel = (next, { scroll = false } = {}) => {
    model = next;
    paintCards();
    showPreview();
    if (scroll) cards.get(model.selected)?.scrollIntoView?.({ block: "nearest" });
  };

  // The window re-reads the saved config whenever it gains focus (another
  // window may have saved Settings) and paints the saved theme over the shell
  // and every view. While the sheet is open its preview is what must show, so
  // any root that drifts from the preview gets it again.
  const roots = () => [document, ...[...document.querySelectorAll("iframe")]
    .map((frame) => { try { return frame.contentDocument; } catch (_) { return null; } })
    .filter(Boolean)].map((doc) => doc.documentElement);
  let driftTimer = 0;
  const checkDrift = () => {
    if (!current) return;
    const expected = chromeTokens(model.previewed, model.custom).values;
    const drifted = roots().some((root) => ["--bg", "--accent", "--surface"]
      .some((key) => root.style.getPropertyValue(key) !== expected[key]));
    if (drifted) {
      previewShown = null;
      showPreview();
    }
  };
  const drift = new MutationObserver(() => {
    clearTimeout(driftTimer);
    driftTimer = setTimeout(checkDrift, 60);
  });
  const watchRoots = () => {
    for (const root of roots()) drift.observe(root, { attributes: true, attributeFilter: ["style"] });
  };

  // ---- saving ----
  let saving = Promise.resolve();
  const persist = (theme, custom) => {
    saving = saving.then(async () => {
      status.textContent = "Saving…";
      status.classList.remove("error");
      try {
        await api.putConfig({ theme, custom_theme: custom });
        await app.onConfigSaved?.();
        onApplied?.(theme, custom);
        status.textContent = `${getTheme(theme, custom).label} is now your theme.`;
      } catch (error) {
        status.textContent = `Could not save the theme (${error?.status || "connection error"}).`;
        status.classList.add("error");
      }
      // onConfigSaved re-applied the saved theme; the sheet's preview wins.
      previewShown = null;
      if (current) showPreview();
    });
    return saving;
  };
  const applyId = (id = model.selected) => {
    if (!id) return;
    setModel(apply(model, id));
    persist(model.applied, model.appliedCustom);
  };

  // ---- leaving ----
  const close = async (how) => {
    if (!current) return;
    current = null;
    const plan = closePlan(model, how);
    window.removeEventListener("keydown", onKey, true);
    clearTimeout(hoverTimer);
    clearTimeout(driftTimer);
    drift.disconnect();
    overlay.remove();
    releaseFocus(FOCUS_OWNER);
    app.previewTheme(plan.theme, plan.custom);
    if (returnFocus?.isConnected) returnFocus.focus();
    else app.refocusTerm?.();
    if (plan.persist) {
      model = { ...model, applied: plan.theme, appliedCustom: plan.custom };
      await persist(plan.theme, plan.custom);
      app.previewTheme(plan.theme, plan.custom);
    }
  };

  // ---- the keyboard ----
  // Rows of the visible grid, read from the layout, so Up and Down move by
  // one row whatever the sheet's width.
  const columns = () => {
    const node = cards.get(model.selected);
    const grid = node?.parentElement;
    if (!grid) return 1;
    const tops = [...grid.children].map((child) => child.offsetTop);
    return Math.max(1, tops.filter((top) => top === tops[0]).length);
  };
  const move = (delta) => {
    const id = stepId(shownIds, model.selected, delta);
    if (id) setModel(select(model, id), { scroll: true });
  };
  const inSheet = (target) => sheet.contains(target);
  // Capture on window: it runs before the Settings sheet's document-level
  // Escape and Tab handling, which would otherwise close Settings under us.
  function onKey(event) {
    if (!current) return;
    const target = event.target;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (search.value && target === search) {
        search.value = "";
        renderList();
        return;
      }
      close("cancel");
      return;
    }
    if (event.key === "Tab") {
      event.stopPropagation();
      const focusable = [...sheet.querySelectorAll("input, button")]
        .filter((node) => !node.disabled && node.offsetParent !== null && !node.classList.contains("ts-card"));
      const at = focusable.indexOf(document.activeElement);
      const next = focusable[(at + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length];
      if (next) {
        event.preventDefault();
        next.focus();
      }
      return;
    }
    if (!inSheet(target) || target.type === "color") return;
    const onButton = target.tagName === "BUTTON" && !target.classList.contains("ts-card");
    if (event.key === "Enter" && !onButton) {
      event.preventDefault();
      event.stopPropagation();
      applyId();
      return;
    }
    const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns(), ArrowDown: columns() };
    if (event.key in steps && !(target === search && (event.key === "ArrowLeft" || event.key === "ArrowRight") && search.value)) {
      event.preventDefault();
      event.stopPropagation();
      move(steps[event.key]);
    } else if ((event.key === "Home" || event.key === "End") && target !== search) {
      event.preventDefault();
      setModel(select(model, event.key === "Home" ? shownIds[0] : shownIds.at(-1)), { scroll: true });
    }
  }
  window.addEventListener("keydown", onKey, true);

  // ---- the pointer ----
  let hoverTimer = 0;
  list.addEventListener("mouseover", (event) => {
    const node = event.target.closest?.(".ts-card");
    if (!node || node.dataset.id === model.previewed) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => setModel(hover(model, node.dataset.id)), HOVER_DELAY_MS);
  });
  list.addEventListener("mouseleave", () => {
    clearTimeout(hoverTimer);
    setModel(hover(model, null));
  });
  list.addEventListener("click", (event) => {
    const node = event.target.closest?.(".ts-card");
    if (!node) return;
    clearTimeout(hoverTimer);
    setModel(select(model, node.dataset.id));
    applyId(node.dataset.id);
    search.focus();
  });
  search.addEventListener("input", () => {
    renderList();
    if (!shownIds.includes(model.selected) && shownIds.length) setModel(select(model, shownIds[0]), { scroll: true });
  });
  for (const input of Object.values(colorInputs)) {
    input.addEventListener("input", () => setModel(editCustom(model, input.dataset.key, input.value)));
  }
  applyCustom.addEventListener("click", () => applyId(CUSTOM_THEME));
  cancel.addEventListener("click", () => close("cancel"));
  done.addEventListener("click", () => close("done"));
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) close("outside");
    // A press on a card or the sheet's background keeps the keyboard in the
    // search field, where the arrows and Enter work.
    else if (!event.target.closest?.("input, .ts-actions button, .ts-custom-apply")) event.preventDefault();
  });

  current = {
    focus: () => search.focus(),
    close,
    model: () => model,
  };
  renderList();
  watchRoots();
  cards.get(model.selected)?.scrollIntoView?.({ block: "center" });
  claimFocus(FOCUS_OWNER);
  search.focus();
  return current;
}
