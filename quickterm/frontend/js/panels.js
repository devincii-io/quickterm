import { closeConfirm, confirmIsOpen, confirmNear } from "./confirm_popover.js";
import * as api from "./api.js";
import { DASHBOARD_REFRESH_MS, TERMINAL_TYPES, make } from "./panel_shared.js";
import { renderDashboard } from "./panel_dashboard.js";
import { renderWorkspaceSettings } from "./panel_workspace.js";
import { claimFocus, releaseFocus } from "./focus.js";
import { closeMenu, menuIsOpen } from "./menu.js";
import { renderGeneralSettings } from "./panel_settings_general.js";
import { renderThemePicker, renderLogoPicker } from "./panel_settings_appearance.js";
import { renderWindowSettings } from "./panel_settings_window.js";
import { renderShortcutSettings } from "./panel_settings_shortcuts.js";
import { renderSnippetSettings } from "./panel_settings_snippets.js";
import { renderAboutSettings, renderAdvancedSettings } from "./panel_settings_about.js";
import { settingsSearchResults } from "./panel_settings_kit.js";
import { renderHelp } from "./panel_help.js";
import { renderAgentSettings } from "./panel_settings_agents.js";
import { renderSetup } from "./setup.js";
import { settingsPatch, settingsProblems } from "./global_settings.js";
import { snapshotItems } from "./config_list.js";
import { captureActive } from "./shortcut_input.js";
import { SETTINGS_INDEX, SETTINGS_TABS, searchSettings, settingsTabId } from "./settings_index.js";

// Who gets Escape or Tab while the sheet is open, in order: a shortcut field
// that is recording, a menu opened from the sheet, a destructive
// confirmation, a search or filter box with text in it, and only then the
// sheet itself. The sheet listens in the capture phase on document, before
// any of those see the key, so it has to step aside for them by name.
export function sheetKeyRoute(key, { menuOpen, inMenu, capturing = false, confirming = false, searchActive = false }) {
  if (key !== "Escape" && key !== "Tab") return "none";
  if (capturing) return "none";
  if (menuOpen) return inMenu ? "menu" : "close-menu";
  if (key === "Escape" && confirming) return "confirm";
  if (key === "Escape" && searchActive) return "search";
  return "sheet";
}

const editable = (node) => Boolean(node?.closest?.("input, textarea, [contenteditable='true']"));
const filterBox = (node) => (node?.matches?.(".config-filter-input") && node.value ? node : null);

export class Panels {
  constructor(app) {
    this.app = app;
    this.open = null;
    this.settingsDraft = null;
    this.settingsTab = "general";

    const overlay = make("div", "panel-overlay");
    overlay.hidden = true;
    overlay.innerHTML =
      '<section class="panel" role="dialog" aria-modal="true" aria-labelledby="panel-title">' +
      '<header class="panel-head"><div><span class="panel-eyebrow">QuickTerm</span>' +
      '<h1 id="panel-title" class="panel-title"></h1><p class="panel-subtitle"></p></div>' +
      '<button class="panel-close" type="button"><span>Close</span><kbd>Esc</kbd></button></header>' +
      '<div class="panel-body"></div></section>';
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.panelEl = overlay.querySelector(".panel");
    this.titleEl = overlay.querySelector(".panel-title");
    this.subtitleEl = overlay.querySelector(".panel-subtitle");
    this.bodyEl = overlay.querySelector(".panel-body");
    this.closeButton = overlay.querySelector(".panel-close");
    // Controls a view puts beside its title (the board's search).
    this.headTools = make("div", "panel-head-tools");
    this.closeButton.before(this.headTools);

    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) this.close();
    });
    overlay.querySelector(".panel-close").addEventListener("click", () => this.close());
    document.addEventListener("keydown", (event) => this._sheetKey(event), true);
  }

  _sheetKey(event) {
    if (!this.open) return;
    const settings = this.open === "settings" ? this._settingsView : null;
    if (settings && event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      this._saveSettings();
      return;
    }
    if (settings && event.key === "/" && !event.ctrlKey && !event.altKey && !event.metaKey && !editable(event.target)) {
      event.preventDefault();
      settings.search.focus();
      return;
    }
    const filter = filterBox(event.target);
    const route = sheetKeyRoute(event.key, {
      menuOpen: menuIsOpen(),
      inMenu: Boolean(event.target?.closest?.(".qt-menu")),
      capturing: captureActive(),
      confirming: confirmIsOpen(),
      searchActive: Boolean(filter || settings?.search.value),
    });
    if (route === "none" || route === "menu") return;
    // Escape inside the box is the box's own: it refuses to close while its
    // action runs, so a failure can still show its detail and Retry.
    if (route === "confirm" && event.target?.closest?.(".confirm-popover")) return;
    if (event.key === "Tab" && route === "sheet") {
      this._trapTab(event);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (route === "close-menu") closeMenu("escape");
    else if (route === "confirm") closeConfirm("escape");
    else if (route === "search" && filter) {
      filter.value = "";
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (route === "search") settings.clearSearch();
    else this.close();
  }

  _trapTab(event) {
    const focusable = [...this.panelEl.querySelectorAll(
      'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((node) => !node.hidden && node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  close() {
    // If the user previewed a theme in Settings without saving, put the
    // committed theme back so closing = cancel.
    const revert = this._themePreviewDirty ? this.app.appliedTheme() : null;
    this._themePreviewDirty = false;
    if (this.open) releaseFocus("panel");
    this.open = null;
    this._settingsView = null;
    this._configList = null;
    // The sheet is going away, so its box goes too, even mid-action.
    closeConfirm("close", { force: true });
    this.overlay.hidden = true;
    this._stopDashboardRefresh();
    if (revert) this.app.previewTheme(revert.theme, revert.custom_theme);
    // QuickTerm is a terminal-first workbench: closing a panel must make the
    // focused pane immediately typeable again. The trigger is only the
    // no-pane accessibility fallback.
    if (!this.app.refocusTerm()
        && this.returnFocus && this.returnFocus.isConnected) this.returnFocus.focus();
  }

  toggle(name) {
    if (this.open === name) this.close();
    else this.show(name);
  }

  show(name) {
    const refreshing = this.open === name;
    if (!refreshing) this.returnFocus = document.activeElement;
    // A panel opened over a focused pane owns the keyboard until it closes;
    // see focus.js for why the pane's own re-focus cannot be trusted to stop.
    if (!this.open) claimFocus("panel");
    this.open = name;
    this.overlay.hidden = false;
    this.panelEl.dataset.view = name;
    if (name !== "dashboard") {
      this._stopDashboardRefresh();
      this.headTools.replaceChildren();
    }
    if (name !== "settings") this._settingsView = null;
    const titles = {
      dashboard: ["Workspace board", ""],
      workspace: ["Workspace settings", this._workspaceName || ""],
      settings: ["Settings", "Make QuickTerm feel right for the way you work."],
      help: ["Quick guide", "Everything you need, without a manual."],
      setup: ["Set up QuickTerm", "Windows, workspaces and terminals"],
    };
    [this.titleEl.textContent, this.subtitleEl.textContent] = titles[name] || titles.help;
    if (name === "dashboard") {
      this._dashboard();
      this._startDashboardRefresh();
    } else if (name === "workspace") {
      renderWorkspaceSettings.call(this, this._workspaceName);
    } else if (name === "settings") {
      this.bodyEl.textContent = "";
      this._settings();
    } else if (name === "setup") {
      this.bodyEl.textContent = "";
      renderSetup.call(this, this.bodyEl);
    } else {
      this.bodyEl.textContent = "";
      this._help();
    }
    // showSetting may already have revealed and focused a field by the next
    // frame; Close is only the landing spot when nothing in the sheet has it.
    if (!refreshing) {
      requestAnimationFrame(() => {
        if (!this.panelEl.contains(document.activeElement)) this.closeButton.focus();
      });
    }
  }

  // The board keeps itself fresh. A refresh patches the existing DOM in place
  // (see render.js), so it never replaces the card under the pointer or the
  // search box under the caret.
  _startDashboardRefresh() {
    this._stopDashboardRefresh();
    this._dashTimer = setInterval(() => {
      // A hidden window must not keep issuing 3+N requests every 5 s.
      if (document.hidden) return;
      if (this.open !== "dashboard" || this._dashLoading) return;
      this._dashboard();
    }, DASHBOARD_REFRESH_MS);
  }

  _stopDashboardRefresh() {
    clearInterval(this._dashTimer);
    this._dashTimer = null;
  }

  _sectionHeading(title, subtitle) {
    const heading = make("div", "section-heading");
    const copy = make("div");
    copy.append(make("h2", "section-title", title));
    if (subtitle) copy.append(make("p", "section-subtitle", subtitle));
    heading.append(copy);
    return heading;
  }

  _button(label, className = "secondary-button") {
    const button = make("button", className, label);
    button.type = "button";
    return button;
  }

  // One confirmation box for the whole app: confirm_popover.js measures the
  // trigger before disabling it, clamps the box to the viewport, follows the
  // trigger while the body scrolls and claims the keyboard in focus.js.
  // `keyboard`: the keyboard asked for this (Delete on a row), so the
  // destructive button takes the focus and Enter completes it. A pointer
  // gets Cancel first (AGENTS.md).
  // confirm_popover.js tracks the one open box; the sheet asks it.
  _confirmNear(button, message, confirmLabel, action, { keyboard = false } = {}) {
    return confirmNear(button, {
      message, confirmLabel, action, keyboard, owner: "confirm",
      onClose: (reason) => {
        if ((reason === "cancel" || reason === "escape") && button.isConnected) button.focus();
      },
    });
  }

  // `id` stamps data-setting, which settings search reveals and focuses.
  _field(label, control, hint, { id = "", keywords = "" } = {}) {
    const field = make("label", "settings-field");
    if (id) field.dataset.setting = id;
    if (keywords) field.dataset.keywords = keywords;
    field.append(make("span", "field-label", label), control);
    if (hint) field.append(make("span", "field-hint", hint));
    return field;
  }

  _textInput(value = "", placeholder = "") {
    const input = make("input", "ui-input");
    input.value = value == null ? "" : value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.addEventListener("keydown", (event) => event.stopPropagation());
    return input;
  }

  // Every render is a patch of the same DOM, and the first one builds it.
  async _dashboard() {
    return renderDashboard.call(this);
  }

  async _settings() {
    this._themePreviewDirty = false;
    let ready;
    this._settingsReady = new Promise((resolve) => { ready = resolve; });
    this.bodyEl.append(make("div", "panel-loading", "Loading your preferences…"));
    const [cfg, inventory] = await Promise.all([
      api.getFullConfig().catch(() => null),
      api.getTerminalOptions().catch(() => ({ types: TERMINAL_TYPES, wsl_distributions: [] })),
    ]);
    if (this.open !== "settings") { ready(); return; }
    this.bodyEl.textContent = "";
    if (!cfg) {
      this.bodyEl.append(make("div", "settings-error", "Settings could not be loaded. Is QuickTerm still running?"));
      ready();
      return;
    }
    this.settingsDraft = JSON.parse(JSON.stringify(cfg));
    this.settingsBaseline = structuredClone(cfg);
    this.terminalInventory = inventory;
    // Read once per opening of the sheet; Settings never waits for it.
    this.agentCatalogLoad = null;
    this._snapshot();

    const shell = make("div", "settings-shell");
    const nav = make("nav", "settings-tabs");
    const content = make("div", "settings-content");
    const searchBox = make("div", "settings-search-box");
    const search = make("input", "ui-input settings-search");
    search.type = "search";
    search.placeholder = "Search settings";
    search.spellcheck = false;
    search.setAttribute("aria-label", "Search settings");
    search.title = "Search settings (/)";
    searchBox.append(search, make("kbd", "settings-search-key", "/"));
    nav.append(searchBox);
    let results = [];
    let resultButtons = [];
    let shownResults = [];

    const render = () => {
      this.settingsTab = settingsTabId(this.settingsTab);
      for (const button of nav.querySelectorAll(".settings-tab")) {
        const current = button.dataset.tab === this.settingsTab;
        button.classList.toggle("active", current);
        if (current) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      }
      content.textContent = "";
      this._configList = null;
      const query = search.value.trim();
      if (query) {
        results = searchSettings(query, this.settingsDraft);
        const list = settingsSearchResults({ results, tabs: SETTINGS_TABS, query, onPick: pick, onLeave: () => search.focus() });
        resultButtons = list.buttons;
        shownResults = list.shown || results;
        content.append(list.el);
        return;
      }
      const tab = this.settingsTab;
      if (tab === "general") renderGeneralSettings.call(this, content);
      else if (tab === "window") renderWindowSettings.call(this, content);
      else if (tab === "shortcuts") renderShortcutSettings.call(this, content);
      else if (tab === "agents") renderAgentSettings.call(this, content);
      else if (tab === "snippets") renderSnippetSettings.call(this, content);
      else if (tab === "about") renderAboutSettings.call(this, content);
      else renderAdvancedSettings.call(this, content);
    };
    const go = (tab) => {
      search.value = "";
      this.settingsTab = tab;
      render();
    };
    const pick = (result) => {
      if (result.kind === "snippet") this.configFocus = { kind: result.kind, name: result.name };
      go(result.tab);
      if (result.kind === "setting") this._revealSetting(result.id);
    };
    search.addEventListener("input", render);
    search.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && shownResults.length) {
        event.preventDefault();
        pick(shownResults[0]);
      } else if (event.key === "ArrowDown" && resultButtons.length) {
        event.preventDefault();
        resultButtons[0].focus();
      }
    });

    for (const [id, title, note] of SETTINGS_TABS) {
      const button = make("button", "settings-tab");
      button.type = "button";
      button.dataset.tab = id;
      button.append(make("strong", "", title), make("small", "", note));
      button.addEventListener("click", () => go(id));
      nav.append(button);
    }
    const main = make("div", "settings-main");
    main.append(nav, content);

    const footer = make("footer", "settings-footer");
    const message = make("span", "settings-message", "Changes are saved to this device.");
    const cancel = this._button("Cancel", "secondary-button");
    cancel.addEventListener("click", () => this.close());
    const save = this._button("Save changes", "primary-button");
    save.title = "Save changes (Ctrl+S)";
    save.addEventListener("click", () => this._saveSettings());
    footer.append(message, make("span", "footer-spacer"), cancel, save);
    shell.append(main, footer);
    this.bodyEl.append(shell);
    this._settingsView = {
      render, go, content, search, message, save,
      clearSearch: () => {
        search.value = "";
        render();
        search.focus();
      },
    };
    render();
    ready();
  }

  // What "unsaved" is measured against: every snippet as it was when
  // Settings opened or last saved.
  _snapshot() {
    this.savedSnapshots = new WeakMap();
    snapshotItems(this.savedSnapshots, this.settingsDraft?.snippets);
  }

  // The one way Settings persists: the footer Save, Ctrl+S in the sheet, and
  // the Save button beside a snippet editor all land here.
  async _saveSettings() {
    const view = this._settingsView;
    if (!view || this._saving) return;
    const { message, save } = view;
    const fail = (text) => {
      message.textContent = text;
      message.title = text;
      message.classList.add("error");
    };
    const problem = settingsProblems(this.settingsDraft, { baseline: this.settingsBaseline });
    if (problem) { fail(problem); return; }
    this._saving = true;
    save.disabled = true;
    message.classList.remove("error");
    message.textContent = "Saving…";
    try {
      const fresh = await api.getFullConfig();
      const patch = settingsPatch(this.settingsDraft, this.settingsBaseline, fresh);
      await api.putConfig(patch);
      // Keys this save did not touch take what another window saved. Arrays
      // that did not change keep their objects, so the open editor stays.
      let outside = false;
      for (const [key, value] of Object.entries(fresh)) {
        if (key in patch || JSON.stringify(value) === JSON.stringify(this.settingsDraft[key])) continue;
        this.settingsDraft[key] = value;
        outside = true;
      }
      this.settingsBaseline = structuredClone(this.settingsDraft);
      this._snapshot();
      await this.app.onConfigSaved();
      this._themePreviewDirty = false; // committed, so nothing to revert on close
      // Windows can refuse a binding another program holds; the save stands,
      // but the shortcut does nothing, so the footer says which one.
      const hotkeyError = this.app.hotkeyError?.() || "";
      message.textContent = hotkeyError ? `Saved, but ${hotkeyError}.` : "Saved. New terminals use these settings.";
      message.title = hotkeyError;
      message.classList.toggle("error", Boolean(hotkeyError));
      if (this._settingsView !== view) return;
      // The summon field reads hotkeyError when it is drawn.
      if (outside || ["shortcuts", "window"].includes(this.settingsTab)) view.render();
      else this._configList?.refresh();
    } catch (error) {
      fail(error.detail || error.message || `Could not save (${error.status || "connection error"}).`);
    } finally {
      this._saving = false;
      save.disabled = false;
    }
  }

  async _openSettingsTab(tab) {
    tab = settingsTabId(tab);
    this.settingsTab = tab;
    if (this.open !== "settings") this.show("settings");
    else if (this._settingsView) this._settingsView.go(tab);
    await this._settingsReady;
  }

  _revealSetting(id) {
    const content = this._settingsView?.content;
    const node = [...(content?.querySelectorAll("[data-setting]") || [])].find((item) => item.dataset.setting === id);
    if (!node) return false;
    node.scrollIntoView?.({ block: "center" });
    const control = node.matches("input, button, textarea") ? node
      : node.querySelector("input, textarea, button:not([disabled]), [tabindex]:not([tabindex='-1'])");
    control?.focus({ preventScroll: true });
    node.classList.remove("setting-flash");
    void node.offsetWidth; // restart the animation for a second reveal
    node.classList.add("setting-flash");
    setTimeout(() => node.classList.remove("setting-flash"), 1600);
    return true;
  }

  /** Open Settings on the tab holding `id` and reveal that field. */
  async showSetting(id) {
    const text = String(id || "");
    if (text.startsWith("terminal:")) return this.showConfig("terminal", text.slice(9));
    if (text.startsWith("snippet:")) return this.showConfig("snippet", text.slice(8));
    const entry = SETTINGS_INDEX.find((item) => item.id === text);
    await this._openSettingsTab(entry?.tab || "general");
    return entry ? this._revealSetting(text) : false;
  }

  /** Open Snippets with `name` selected (null opens Add). Saved terminals
   *  are gone since 4.5; "terminal" lands on the agent settings. */
  async showConfig(kind, name = null) {
    if (kind !== "snippet") return this._openSettingsTab("agents");
    this.configFocus = { kind: "snippet", name: name || null };
    await this._openSettingsTab("snippets");
  }

  /** Open the settings of workspace `name`: folder, logo, layout. */
  showWorkspace(name) {
    if (!name) return;
    this._workspaceName = name;
    this.show("workspace");
  }

  /** Every settings field for the palette's "setting:" rows. */
  settingEntries() {
    return SETTINGS_INDEX.map(({ id, label, tab, hint, keywords }) => ({ id, label, tab, hint, keywords }));
  }

  _themePicker(cfg) { return renderThemePicker.call(this, cfg); }
  _logoPicker(options) { return renderLogoPicker.call(this, options); }
  _help() { return renderHelp.call(this); }
}
