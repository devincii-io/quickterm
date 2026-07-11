import * as api from "./api.js";
import { icon } from "./icons.js";
import {
  CUSTOM_THEME,
  CUSTOM_THEME_DEFAULTS,
  DEFAULT_THEME,
  TERMINAL_THEMES,
  customColors,
  getTheme,
} from "./themes.js";

const DASHBOARD_REFRESH_MS = 5000;

const TERMINAL_TYPES = [
  { id: "powershell-core", label: "PowerShell 7", executable: "pwsh.exe" },
  { id: "windows-powershell", label: "Windows PowerShell", executable: "powershell.exe" },
  { id: "command-prompt", label: "Command Prompt", executable: "cmd.exe" },
  { id: "wsl", label: "Windows Subsystem for Linux", executable: "wsl.exe" },
  { id: "custom", label: "Custom command", executable: "" },
];

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function inferTerminalType(profile) {
  if (profile.terminal_type) return profile.terminal_type;
  const cmd = (profile.cmd || "").toLowerCase().split(/[\\/]/).pop();
  if (cmd === "pwsh" || cmd === "pwsh.exe") return "powershell-core";
  if (cmd === "powershell" || cmd === "powershell.exe") return "windows-powershell";
  if (cmd === "cmd" || cmd === "cmd.exe") return "command-prompt";
  if (cmd === "wsl" || cmd === "wsl.exe") return "wsl";
  return "custom";
}

function countPanes(layout) {
  if (!layout) return 0;
  if (layout.type !== "split") return 1;
  return (layout.children || []).reduce((sum, child) => sum + countPanes(child), 0);
}

// Snippets store the exact keystrokes sent to the shell, including the trailing
// carriage return that runs the command. The editor hides that CR and re-adds
// it on change, so a one-line snippet "just runs" when picked from the palette.
function displaySnippet(text) {
  return String(text || "").replace(/\r\n?/g, "\n").replace(/\n$/, "");
}
function runnableSnippet(text) {
  const body = String(text || "").replace(/\r\n?/g, "\n");
  return body ? `${body}\r` : "";
}

export class Panels {
  constructor(app) {
    this.app = app;
    this.open = null;
    this.settingsDraft = null;
    this.settingsTab = "general";

    const overlay = make("div", "panel-overlay");
    overlay.hidden = true;
    overlay.innerHTML =
      '<section class="panel" role="dialog" aria-modal="true">' +
      '<header class="panel-head"><div><span class="panel-eyebrow">QuickTerm</span>' +
      '<h1 class="panel-title"></h1><p class="panel-subtitle"></p></div>' +
      '<button class="panel-close" type="button"><span>Close</span><kbd>Esc</kbd></button></header>' +
      '<div class="panel-body"></div></section>';
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.panelEl = overlay.querySelector(".panel");
    this.titleEl = overlay.querySelector(".panel-title");
    this.subtitleEl = overlay.querySelector(".panel-subtitle");
    this.bodyEl = overlay.querySelector(".panel-body");

    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) this.close();
    });
    overlay.querySelector(".panel-close").addEventListener("click", () => this.close());
    document.addEventListener("keydown", (event) => {
      if (this.open && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
    }, true);
  }

  close() {
    // If the user previewed a theme in Settings without saving, put the
    // committed theme back so closing = cancel.
    const revert = this._themePreviewDirty ? this.app.appliedTheme() : null;
    this._themePreviewDirty = false;
    this.open = null;
    this.overlay.hidden = true;
    this._stopDashboardRefresh();
    if (revert) this.app.previewTheme(revert.theme, revert.custom_theme);
    this.app.refocusTerm();
  }

  toggle(name) {
    if (this.open === name) this.close();
    else this.show(name);
  }

  show(name) {
    const refreshing = this.open === name;
    this.open = name;
    this.overlay.hidden = false;
    this.panelEl.dataset.view = name;
    if (name !== "dashboard") this._stopDashboardRefresh();
    const titles = {
      dashboard: ["Your workspaces", "Pick up where you left off, or start something new."],
      settings: ["Settings", "Make QuickTerm feel right for the way you work."],
      help: ["Quick guide", "Everything you need, without a manual."],
    };
    [this.titleEl.textContent, this.subtitleEl.textContent] = titles[name] || titles.help;
    if (name === "dashboard") {
      this._dashboard(refreshing);
      this._startDashboardRefresh();
    } else if (name === "settings") {
      this.bodyEl.textContent = "";
      this._settings();
    } else {
      this.bodyEl.textContent = "";
      this._help();
    }
  }

  // Live data on the dashboard (session list, pane counts) keeps itself
  // fresh; refreshes render in place without flashing or moving the scroll.
  _startDashboardRefresh() {
    this._stopDashboardRefresh();
    this._dashTimer = setInterval(() => {
      if (this.open === "dashboard" && !this._dashLoading) this._dashboard(true);
    }, DASHBOARD_REFRESH_MS);
  }

  _stopDashboardRefresh() {
    clearInterval(this._dashTimer);
    this._dashTimer = null;
  }

  // Collapse an element smoothly before a list refresh removes it.
  _leave(el) {
    el.style.height = `${el.offsetHeight}px`;
    void el.offsetHeight; // commit the fixed height before transitioning
    el.classList.add("leaving");
    return new Promise((resolve) => setTimeout(resolve, 260));
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

  _field(label, control, hint) {
    const field = make("label", "settings-field");
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

  _select(options, value) {
    const select = make("select", "ui-select");
    for (const item of options) {
      const option = make("option", "", item.label);
      option.value = item.value;
      option.selected = item.value === value;
      option.disabled = Boolean(item.disabled);
      select.append(option);
    }
    return select;
  }

  _layoutPreview(layout) {
    const build = (node) => {
      if (!node || node.type !== "split") {
        const pane = make("span", "workspace-preview-pane");
        const profile = make("i", "", node && node.profile ? node.profile : "terminal");
        pane.append(profile);
        return pane;
      }
      const split = make("span", `workspace-preview-split ${node.dir === "v" ? "vertical" : "horizontal"}`);
      const ratio = Math.max(20, Math.min(80, Math.round((node.ratio || 0.5) * 100)));
      const children = node.children || [];
      const first = build(children[0]);
      const second = build(children[1]);
      first.style.flex = `${ratio} 1 0`;
      second.style.flex = `${100 - ratio} 1 0`;
      split.append(first, second);
      return split;
    };
    const preview = make("div", "workspace-preview");
    preview.append(build(layout));
    return preview;
  }

  async _dashboard(refreshing = false) {
    this._dashLoading = true;
    if (!refreshing) {
      this.bodyEl.textContent = "";
      this.bodyEl.append(make("div", "panel-loading", "Collecting your workspace…"));
    }
    const scrollTop = refreshing ? this.bodyEl.scrollTop : 0;
    let workspaces;
    let sessions;
    try {
      const [names, sessionList] = await Promise.all([
        api.listWorkspaces().catch(() => []),
        api.getSessions().catch(() => []),
      ]);
      sessions = sessionList;
      workspaces = await Promise.all(names.map(async (name) => ({
        name,
        data: await api.getWorkspace(name).catch(() => null),
      })));
    } finally {
      this._dashLoading = false;
    }
    if (this.open !== "dashboard") return;
    this.bodyEl.textContent = "";
    if (refreshing) this.bodyEl.classList.add("no-entrance");
    else this.bodyEl.classList.remove("no-entrance");

    const hero = make("div", "dashboard-hero");
    const heroCopy = make("div", "hero-copy");
    heroCopy.append(
      make("span", "hero-kicker", "Ready when you are"),
      make("h2", "hero-title", "A calmer place for every command."),
      make("p", "hero-text", "Keep different projects in their own layout and return to them in one click."),
    );
    const stats = make("div", "dashboard-stats");
    const alive = sessions.filter((session) => session.alive);
    for (const [value, label] of [[workspaces.length, "workspaces"], [alive.length, "live sessions"], [this.app.profiles.length, "terminal profiles"]]) {
      const stat = make("div", "dashboard-stat");
      stat.append(make("strong", "", String(value).padStart(2, "0")), make("span", "", label));
      stats.append(stat);
    }
    hero.append(heroCopy, stats);
    this.bodyEl.append(hero);

    const workspaceSection = make("section", "dashboard-section");
    const wsHeading = this._sectionHeading("Workspaces", "Saved arrangements of terminals, folders and tools.");
    const saveForm = make("div", "save-workspace-form");
    const saveInput = this._textInput("", "Name this workspace");
    const saveButton = this._button("Save current", "primary-button");
    const save = async () => {
      const name = saveInput.value.trim();
      if (!name) {
        saveInput.focus();
        return;
      }
      saveButton.disabled = true;
      await this.app.saveWorkspace(name);
      if (this.open === "dashboard") this._dashboard(true);
    };
    saveButton.addEventListener("click", save);
    saveInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") save();
    });
    saveForm.append(saveInput, saveButton);
    wsHeading.append(saveForm);
    workspaceSection.append(wsHeading);

    const cards = make("div", "workspace-grid");
    if (!workspaces.length) {
      const empty = make("div", "workspace-empty-card");
      empty.append(make("span", "empty-orbit"), make("h3", "", "Your first workspace starts here"), make("p", "", "Arrange your terminals, give the layout a name, then save it above."));
      cards.append(empty);
    }
    for (const [index, workspace] of workspaces.entries()) {
      const layout = workspace.data && workspace.data.layout;
      const card = make("article", "workspace-card");
      const isCurrent = this.app.currentWorkspace && this.app.currentWorkspace() === workspace.name;
      if (isCurrent) card.classList.add("current");
      card.style.setProperty("--card-index", index);
      const top = make("div", "workspace-card-top");
      const badge = make("span", "workspace-badge", isCurrent ? "Open now" : `${countPanes(layout)} pane${countPanes(layout) === 1 ? "" : "s"}`);
      if (workspace.data && workspace.data.logo) {
        const logo = make("img", "workspace-card-logo");
        logo.src = api.assetUrl(workspace.data.logo);
        logo.alt = "";
        top.append(logo);
      }
      const menu = this._button("", "text-button danger-text");
      menu.append(icon("trash", 13), make("span", "", "Delete"));
      menu.addEventListener("click", async (event) => {
        event.stopPropagation();
        menu.disabled = true;
        const gone = this._leave(card);
        if (this.app.deleteWorkspace) await this.app.deleteWorkspace(workspace.name);
        else await api.deleteWorkspace(workspace.name).catch(() => {});
        await gone;
        if (this.open === "dashboard") this._dashboard(true);
      });
      top.append(badge, menu);
      const preview = this._layoutPreview(layout);
      const footer = make("div", "workspace-card-footer");
      const name = make("div");
      name.append(make("h3", "", workspace.name), make("p", "", "Saved workspace"));
      const load = this._button("Open workspace", "card-open-button");
      load.addEventListener("click", () => {
        this.close();
        this.app.loadWorkspace(workspace.name);
      });
      footer.append(name, load);
      card.append(top, preview, footer);
      card.addEventListener("dblclick", () => load.click());
      cards.append(card);
    }
    workspaceSection.append(cards);
    this.bodyEl.append(workspaceSection);

    const lower = make("div", "dashboard-lower");
    const profiles = make("section", "dashboard-list-card");
    profiles.append(this._sectionHeading("Quick launch", "Your terminal profiles"));
    const profileList = make("div", "quick-profile-list");
    if (!this.app.profiles.length) profileList.append(make("p", "quiet-empty", "No personal terminals yet. Create one in Settings — system shells are always available in the launcher."));
    for (const profile of this.app.profiles.slice(0, 6)) {
      const row = make("button", "quick-profile");
      row.type = "button";
      const mark = make("span", "profile-mark", (profile.name || "> ").slice(0, 2).toUpperCase());
      const copy = make("span", "quick-profile-copy");
      copy.append(make("strong", "", profile.name), make("small", "", this._terminalLabel(profile)));
      const arrow = make("span", "profile-arrow");
      arrow.append(icon("arrow-up-right", 13));
      row.append(mark, copy, arrow);
      row.addEventListener("click", () => {
        this.close();
        this.app.runProfile(profile);
      });
      profileList.append(row);
    }
    profiles.append(profileList);

    const live = make("section", "dashboard-list-card");
    live.append(this._sectionHeading("Live now", "Sessions stay running when detached"));
    const liveList = make("div", "live-session-list");
    if (!alive.length) liveList.append(make("p", "quiet-empty", "No detached sessions. A fresh start."));
    const attached = new Set(this.app.attachedSessionIds());
    for (const session of alive.slice(0, 6)) {
      const row = make("div", "live-session-row");
      const status = make("span", "live-dot");
      const copy = make("span", "live-session-copy");
      copy.append(make("strong", "", session.name || session.id), make("small", "", `${session.profile || "Terminal"} · ${session.cols}×${session.rows}`));
      row.append(status, copy);
      if (attached.has(session.id)) row.append(make("span", "attached-label", "Attached"));
      else {
        const attach = this._button("Attach", "text-button");
        attach.addEventListener("click", () => {
          this.close();
          this.app.attachSession(session);
        });
        row.append(attach);
      }
      const kill = this._button("", "icon-button danger-text");
      kill.append(icon("power", 13));
      kill.title = "End session";
      kill.addEventListener("click", async () => {
        kill.disabled = true;
        const gone = this._leave(row);
        await api.killSession(session.id).catch(() => {});
        await gone;
        if (this.open === "dashboard") this._dashboard(true);
      });
      row.append(kill);
      liveList.append(row);
    }
    live.append(liveList);
    lower.append(profiles, live);
    this.bodyEl.append(lower);
    this.bodyEl.scrollTop = scrollTop;
  }

  _terminalLabel(profile) {
    const type = inferTerminalType(profile);
    if (type === "wsl" && profile.wsl_distro) return `WSL · ${profile.wsl_distro}`;
    return (TERMINAL_TYPES.find((item) => item.id === type) || TERMINAL_TYPES[4]).label;
  }

  async _settings() {
    this._themePreviewDirty = false;
    this.bodyEl.append(make("div", "panel-loading", "Loading your preferences…"));
    const [cfg, inventory] = await Promise.all([
      api.getFullConfig().catch(() => null),
      api.getTerminalOptions().catch(() => ({ types: TERMINAL_TYPES, wsl_distributions: [] })),
    ]);
    if (this.open !== "settings") return;
    this.bodyEl.textContent = "";
    if (!cfg) {
      this.bodyEl.append(make("div", "settings-error", "Settings could not be loaded. Is QuickTerm still running?"));
      return;
    }
    this.settingsDraft = JSON.parse(JSON.stringify(cfg));
    this.terminalInventory = inventory;
    for (const profile of this.settingsDraft.profiles) profile.terminal_type = inferTerminalType(profile);

    const shell = make("div", "settings-shell");
    const nav = make("nav", "settings-tabs");
    const content = make("div", "settings-content");
    const tabs = [
      ["general", "General", "Appearance and behavior"],
      ["terminals", "Terminals", "Profiles, WSL and commands"],
      ["snippets", "Snippets", "Palette commands"],
      ["voice", "Voice", "Local dictation"],
      ["advanced", "Advanced", "Raw configuration"],
    ];
    const render = () => {
      for (const button of nav.querySelectorAll("button")) button.classList.toggle("active", button.dataset.tab === this.settingsTab);
      content.textContent = "";
      if (this.settingsTab === "general") this._settingsGeneral(content);
      else if (this.settingsTab === "terminals") this._settingsTerminals(content, render);
      else if (this.settingsTab === "snippets") this._settingsSnippets(content, render);
      else if (this.settingsTab === "voice") this._settingsVoice(content);
      else this._settingsAdvanced(content);
    };
    for (const [id, title, note] of tabs) {
      const button = make("button", "settings-tab");
      button.type = "button";
      button.dataset.tab = id;
      button.append(make("strong", "", title), make("small", "", note));
      button.addEventListener("click", () => {
        this.settingsTab = id;
        render();
      });
      nav.append(button);
    }
    const main = make("div", "settings-main");
    main.append(nav, content);

    const footer = make("footer", "settings-footer");
    const message = make("span", "settings-message", "Changes are saved to this device.");
    const cancel = this._button("Cancel", "secondary-button");
    cancel.addEventListener("click", () => this.close());
    const save = this._button("Save changes", "primary-button");
    save.addEventListener("click", async () => {
      const textarea = content.querySelector(".settings-json");
      if (textarea) {
        try {
          this.settingsDraft = JSON.parse(textarea.value);
        } catch (_) {
          message.textContent = "Fix the JSON before saving.";
          message.classList.add("error");
          textarea.focus();
          return;
        }
      }
      const profiles = this.settingsDraft.profiles || [];
      if (profiles.some((profile) => !(profile.name || "").trim())) {
        message.textContent = "Every terminal profile needs a name.";
        message.classList.add("error");
        return;
      }
      const names = profiles.map((profile) => profile.name.trim().toLowerCase());
      if (new Set(names).size !== names.length) {
        message.textContent = "Terminal profile names must be unique.";
        message.classList.add("error");
        return;
      }
      save.disabled = true;
      message.classList.remove("error");
      message.textContent = "Saving…";
      try {
        await api.putConfig(this.settingsDraft);
        await this.app.onConfigSaved();
        this._themePreviewDirty = false; // committed — nothing to revert on close
        message.textContent = "Saved. New terminals will use these settings.";
      } catch (error) {
        message.textContent = `Could not save (${error.status || "connection error"}).`;
        message.classList.add("error");
      } finally {
        save.disabled = false;
      }
    });
    footer.append(message, make("span", "footer-spacer"), cancel, save);
    shell.append(main, footer);
    this.bodyEl.append(shell);
    render();
  }

  _settingsGeneral(host) {
    const cfg = this.settingsDraft;
    host.append(this._sectionHeading("General", "A few comfortable defaults. Changes to the server port apply after restart."));
    const group = make("div", "settings-group");
    group.append(make("h3", "settings-group-title", "Appearance"));
    const font = this._textInput(cfg.font_family, "JetBrains Mono");
    font.addEventListener("input", () => { cfg.font_family = font.value; });
    const fontSize = this._select(
      Array.from({ length: 13 }, (_, index) => {
        const px = index + 10;
        return { value: String(px), label: `${px} px` };
      }),
      String(cfg.font_size || 14),
    );
    fontSize.addEventListener("change", () => { cfg.font_size = Number(fontSize.value); });
    const profileOptions = [
      { value: "", label: "System default shell" },
      ...(cfg.profiles || []).map((profile) => ({ value: profile.name, label: profile.name })),
    ];
    const defaultProfile = this._select(profileOptions, cfg.default_profile || "");
    defaultProfile.addEventListener("change", () => { cfg.default_profile = defaultProfile.value; });
    const fields = make("div", "settings-grid two-column");
    fields.append(
      this._field("Terminal font", font, "Use any monospace font installed on this computer."),
      this._field("Terminal text size", fontSize, "Also adjust anytime with Alt+plus / minus."),
      this._field("Default terminal", defaultProfile, "Opened when QuickTerm starts."),
    );
    group.append(fields);
    group.append(this._themePicker(cfg));

    const branding = make("div", "settings-group");
    branding.append(make("h3", "settings-group-title", "Branding"));
    branding.append(this._logoPicker({
      title: "App logo",
      value: cfg.logo,
      hint: "Shown whenever a workspace does not have its own logo.",
      onChange: async (assetId) => { cfg.logo = assetId; },
    }));
    const workspaceName = this.app.currentWorkspace && this.app.currentWorkspace();
    if (workspaceName) {
      branding.append(this._logoPicker({
        title: `${workspaceName} logo`,
        value: this.app.workspaceLogo ? this.app.workspaceLogo() : null,
        hint: "Overrides the app logo only while this workspace is open.",
        onChange: async (assetId) => { await this.app.setWorkspaceLogo(assetId); },
      }));
    } else {
      branding.append(make("p", "branding-scratch-note", "Open or save a named workspace to give it a separate logo."));
    }

    const behavior = make("div", "settings-group");
    behavior.append(make("h3", "settings-group-title", "Application"));
    const hotkey = this._textInput(cfg.summon_hotkey, "ctrl+alt+grave");
    hotkey.addEventListener("input", () => { cfg.summon_hotkey = hotkey.value; });
    const port = this._textInput(cfg.port, "8620");
    port.type = "number";
    port.addEventListener("input", () => { cfg.port = Number(port.value) || 8620; });
    const scrollback = this._select([
      { value: String(256 * 1024), label: "256 KB" },
      { value: String(512 * 1024), label: "512 KB" },
      { value: String(1024 * 1024), label: "1 MB" },
      { value: String(2 * 1024 * 1024), label: "2 MB" },
    ], String(cfg.scrollback_bytes));
    scrollback.addEventListener("change", () => { cfg.scrollback_bytes = Number(scrollback.value); });
    const idleTimeout = this._select([
      { value: "0", label: "Never" },
      { value: "300", label: "5 minutes" },
      { value: "900", label: "15 minutes" },
      { value: "1800", label: "30 minutes" },
      { value: "3600", label: "1 hour" },
    ], String(cfg.idle_timeout_s ?? 300));
    idleTimeout.addEventListener("change", () => { cfg.idle_timeout_s = Number(idleTimeout.value); });
    const appFields = make("div", "settings-grid two-column");
    appFields.append(
      this._field("Summon shortcut", hotkey, "Show or hide QuickTerm globally."),
      this._field("Local server port", port, "Only available on this computer."),
      this._field("Session scrollback", scrollback, "History retained for each live session."),
      this._field("Reap detached sessions", idleTimeout, "Silent sessions outside named workspaces are ended after this time."),
    );
    behavior.append(appFields);
    host.append(group, branding, behavior);
  }

  _themePicker(cfg) {
    const wrap = make("div", "theme-picker");
    wrap.append(make("h4", "theme-picker-title", "App theme"), make("p", "field-hint", "Recolors the whole app and every open terminal the instant you pick one. Press Save to keep it."));
    const grid = make("div", "theme-grid");
    const current = () => cfg.theme || DEFAULT_THEME;
    const entries = [
      ...Object.entries(TERMINAL_THEMES),
      [CUSTOM_THEME, getTheme(CUSTOM_THEME, cfg.custom_theme)],
    ];
    const cards = new Map();
    const editor = make("div", "custom-theme-editor");
    const renderStrip = (card, def) => {
      const strip = card.querySelector(".theme-strip");
      strip.style.background = def.xterm.background;
      strip.querySelector(".theme-strip-prompt").style.color = def.xterm.foreground;
      const dots = strip.querySelectorAll(".theme-strip-dot");
      ["red", "yellow", "green", "cyan", "blue", "magenta"].forEach((key, index) => {
        dots[index].style.background = def.xterm[key];
      });
    };
    for (const [id, def] of entries) {
      const card = make("button", "theme-card");
      card.type = "button";
      card.dataset.theme = id;
      card.classList.toggle("active", current() === id);
      const strip = make("span", "theme-strip");
      const prompt = make("i", "theme-strip-prompt", "~ $");
      strip.append(prompt);
      for (const key of ["red", "yellow", "green", "cyan", "blue", "magenta"]) {
        const dot = make("i", "theme-strip-dot");
        strip.append(dot);
      }
      card.append(strip, make("strong", "", def.label), make("small", "", def.note));
      renderStrip(card, def);
      card.addEventListener("click", () => {
        cfg.theme = id;
        for (const other of grid.children) other.classList.toggle("active", other === card);
        editor.hidden = id !== CUSTOM_THEME;
        this._themePreviewDirty = true;
        this.app.previewTheme(id, cfg.custom_theme);
      });
      grid.append(card);
      cards.set(id, card);
    }
    cfg.custom_theme = customColors(cfg.custom_theme || {});
    for (const [key, fallback] of Object.entries(CUSTOM_THEME_DEFAULTS)) {
      const label = make("label", "custom-color-field");
      const input = make("input");
      input.type = "color";
      input.value = cfg.custom_theme[key] || fallback;
      label.append(input, make("span", "", key.replace(/^./, (char) => char.toUpperCase())));
      input.addEventListener("input", () => {
        cfg.custom_theme[key] = input.value.toUpperCase();
        renderStrip(cards.get(CUSTOM_THEME), getTheme(CUSTOM_THEME, cfg.custom_theme));
        if (cfg.theme === CUSTOM_THEME) {
          this._themePreviewDirty = true;
          this.app.previewTheme(CUSTOM_THEME, cfg.custom_theme);
        }
      });
      editor.append(label);
    }
    editor.hidden = current() !== CUSTOM_THEME;
    wrap.append(grid, editor);
    return wrap;
  }

  _logoPicker({ title, value, hint, onChange }) {
    const row = make("div", "logo-picker");
    const preview = make("div", "logo-preview");
    const image = make("img");
    const fallback = make("span", "logo-preview-fallback", "QT");
    const render = (assetId) => {
      preview.textContent = "";
      if (assetId) {
        image.src = api.assetUrl(assetId);
        preview.append(image);
      } else {
        preview.append(fallback);
      }
    };
    render(value);
    const copy = make("div", "logo-picker-copy");
    copy.append(make("strong", "", title), make("small", "", hint));
    const status = make("span", "logo-picker-status", "Square PNG/WebP or simple SVG recommended · max 1 MB");
    copy.append(status);
    const file = make("input");
    file.type = "file";
    file.accept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon";
    file.hidden = true;
    const choose = this._button("Choose image", "secondary-button compact");
    choose.addEventListener("click", () => file.click());
    const remove = this._button("Reset", "text-button");
    remove.disabled = !value;
    remove.addEventListener("click", async () => {
      await onChange(null);
      value = null;
      remove.disabled = true;
      render(null);
      status.textContent = "Using the built-in QuickTerm mark.";
    });
    file.addEventListener("change", async () => {
      const selected = file.files && file.files[0];
      if (!selected) return;
      if (selected.size > 1024 * 1024) {
        status.textContent = "That image is larger than 1 MB.";
        status.classList.add("error");
        return;
      }
      choose.disabled = true;
      status.classList.remove("error");
      status.textContent = "Uploading…";
      try {
        const uploaded = await api.uploadAsset(selected);
        await onChange(uploaded.id);
        value = uploaded.id;
        remove.disabled = false;
        render(value);
        status.textContent = "Ready. Save settings to apply the global logo.";
      } catch (error) {
        status.textContent = `Upload failed (${error.status || "connection error"}).`;
        status.classList.add("error");
      } finally {
        choose.disabled = false;
        file.value = "";
      }
    });
    const actions = make("div", "logo-picker-actions");
    actions.append(choose, remove, file);
    row.append(preview, copy, actions);
    return row;
  }

  _settingsTerminals(host, rerender) {
    const cfg = this.settingsDraft;
    const heading = this._sectionHeading("Terminal profiles", "Your own terminals: a shell plus folder, command and shortcut. System shells are always available in the launcher without any setup.");
    const add = this._button("", "primary-button compact");
    add.append(icon("plus", 13), make("span", "", "Add terminal"));
    add.addEventListener("click", () => {
      let n = 1;
      const names = new Set(cfg.profiles.map((profile) => profile.name));
      while (names.has(`Terminal ${n}`)) n += 1;
      const available = (this.terminalInventory.types || []).find((type) => type.executable && type.available !== false);
      const base = available || { id: "custom", executable: "" };
      const args = base.id === "powershell-core" || base.id === "windows-powershell" ? ["-NoLogo"] : [];
      cfg.profiles.push({ name: `Terminal ${n}`, cmd: base.executable || "", args, cwd: null, env: {}, keybinding: null, autostart: false, terminal_type: base.id, wsl_distro: null, start_command: null });
      rerender();
      host.lastElementChild?.scrollIntoView({ block: "nearest" });
    });
    heading.append(add);
    host.append(heading);
    if (!cfg.profiles.length) {
      const empty = make("div", "profiles-empty");
      empty.append(make("p", "", "No personal terminals yet. The launcher already offers every shell installed on this computer — add a profile when you want a preset folder, start command or global shortcut."));
      host.append(empty);
    }

    const inventoryTypes = (this.terminalInventory.types || TERMINAL_TYPES).map((type) => ({
      value: type.id,
      label: `${type.label}${type.available === false ? " — not found" : ""}`,
    }));
    const distros = this.terminalInventory.wsl_distributions || [];
    for (const [index, profile] of cfg.profiles.entries()) {
      const card = make("article", "terminal-profile-card");
      const cardHead = make("div", "terminal-card-head");
      const identity = make("div", "terminal-identity");
      identity.append(make("span", "profile-mark large", (profile.name || "> ").slice(0, 2).toUpperCase()), make("div", "", undefined));
      identity.lastElementChild.append(make("h3", "", profile.name || "Untitled terminal"), make("p", "", this._terminalLabel(profile)));
      const remove = this._button("", "text-button danger-text");
      remove.append(icon("trash", 13), make("span", "", "Remove"));
      remove.addEventListener("click", () => {
        cfg.profiles.splice(index, 1);
        if (cfg.default_profile === profile.name) cfg.default_profile = cfg.profiles[0]?.name || "";
        rerender();
      });
      cardHead.append(identity, remove);
      card.append(cardHead);

      const fields = make("div", "settings-grid two-column");
      const name = this._textInput(profile.name, "My terminal");
      name.addEventListener("input", () => {
        if (cfg.default_profile === profile.name) cfg.default_profile = name.value;
        profile.name = name.value;
        identity.querySelector("h3").textContent = name.value || "Untitled terminal";
      });
      const type = this._select(inventoryTypes, inferTerminalType(profile));
      type.addEventListener("change", () => {
        profile.terminal_type = type.value;
        const known = TERMINAL_TYPES.find((item) => item.id === type.value);
        if (known && known.executable) profile.cmd = known.executable;
        if (type.value === "powershell-core" || type.value === "windows-powershell") profile.args = ["-NoLogo"];
        else profile.args = [];
        rerender();
      });
      fields.append(this._field("Profile name", name), this._field("Terminal type", type));

      if (inferTerminalType(profile) === "wsl") {
        const distroOptions = [{ value: "", label: distros.length ? "Default WSL distribution" : "No distributions detected" }, ...distros.map((distro) => ({ value: distro, label: distro }))];
        const distro = this._select(distroOptions, profile.wsl_distro || "");
        distro.addEventListener("change", () => { profile.wsl_distro = distro.value || null; });
        fields.append(this._field("Linux distribution", distro, distros.length ? "Detected from WSL on this computer." : "Install a distribution with wsl --install."));
      }
      if (inferTerminalType(profile) === "custom") {
        const command = this._textInput(profile.cmd, "executable.exe");
        command.addEventListener("input", () => { profile.cmd = command.value; });
        const args = this._textInput((profile.args || []).join(" "), "--optional arguments");
        args.addEventListener("input", () => { profile.args = args.value.trim() ? args.value.trim().split(/\s+/) : []; });
        fields.append(this._field("Executable", command), this._field("Arguments", args, "Arguments containing spaces can be edited precisely in Advanced."));
      }
      const cwd = this._textInput(profile.cwd, inferTerminalType(profile) === "wsl" ? "~ or /home/you/project" : "C:\\Users\\you\\project");
      cwd.addEventListener("input", () => { profile.cwd = cwd.value || null; });
      fields.append(this._field("Starting folder", cwd, inferTerminalType(profile) === "wsl" ? "Use a Linux path for WSL." : "Leave empty to use the current folder."));
      if (inferTerminalType(profile) !== "custom") {
        const start = this._textInput(profile.start_command, "Optional, e.g. uv run dev");
        start.addEventListener("input", () => { profile.start_command = start.value || null; });
        fields.append(this._field("Start command", start, "Runs inside the shell and keeps it open."));
      }
      const shortcut = this._textInput(profile.keybinding, "Optional, e.g. ctrl+alt+1");
      shortcut.addEventListener("input", () => { profile.keybinding = shortcut.value || null; });
      fields.append(this._field("Global shortcut", shortcut, "Applied after restarting QuickTerm."));
      card.append(fields);

      const toggle = make("label", "toggle-row");
      const checkbox = make("input");
      checkbox.type = "checkbox";
      checkbox.checked = Boolean(profile.autostart);
      checkbox.addEventListener("change", () => { profile.autostart = checkbox.checked; });
      toggle.append(checkbox, make("span", "toggle-control"), make("span", "toggle-copy", "Open automatically with a restored workspace"));
      card.append(toggle);
      host.append(card);
    }
  }

  _settingsSnippets(host, rerender) {
    const cfg = this.settingsDraft;
    cfg.snippets ||= [];
    const heading = this._sectionHeading("Snippets", "Reusable commands, one keystroke away in the command palette (Alt+P).");
    const add = this._button("", "primary-button compact");
    add.append(icon("plus", 13), make("span", "", "Add snippet"));
    add.addEventListener("click", () => {
      let n = 1;
      const names = new Set(cfg.snippets.map((snippet) => snippet.name));
      while (names.has(`Snippet ${n}`)) n += 1;
      cfg.snippets.push({ name: `Snippet ${n}`, text: "" });
      rerender();
      host.lastElementChild?.scrollIntoView({ block: "nearest" });
    });
    heading.append(add);
    host.append(heading);
    if (!cfg.snippets.length) {
      const empty = make("div", "profiles-empty");
      empty.append(make("p", "", "No snippets yet. Add one to keep a command you type often ready to run from the palette."));
      host.append(empty);
    }
    for (const [index, snippet] of cfg.snippets.entries()) {
      const card = make("article", "snippet-card");
      const cardHead = make("div", "snippet-card-head");
      const name = this._textInput(snippet.name, "Snippet name");
      name.addEventListener("input", () => { snippet.name = name.value; });
      const remove = this._button("", "text-button danger-text");
      remove.append(icon("trash", 13), make("span", "", "Remove"));
      remove.addEventListener("click", () => {
        cfg.snippets.splice(index, 1);
        rerender();
      });
      cardHead.append(name, remove);
      const command = make("textarea", "ui-input snippet-text");
      command.rows = 2;
      command.spellcheck = false;
      command.placeholder = "git status";
      command.value = displaySnippet(snippet.text);
      command.addEventListener("keydown", (event) => event.stopPropagation());
      command.addEventListener("input", () => { snippet.text = runnableSnippet(command.value); });
      card.append(cardHead, this._field("Command", command, "Runs in the focused terminal; a trailing Enter is added for you."));
      host.append(card);
    }
  }

  _settingsVoice(host) {
    const cfg = this.settingsDraft;
    cfg.voice ||= { enabled: true, model_size: "small", hotkey: "ctrl+alt+v", language: null };
    host.append(this._sectionHeading("Voice input", "Private, local speech-to-text for your focused terminal."));
    const callout = make("div", "voice-callout");
    callout.append(make("span", "voice-wave", "|||||"), make("div", "", undefined));
    callout.lastElementChild.append(make("h3", "", "Push to talk, then keep typing"), make("p", "", "Audio is transcribed locally with Whisper. Nothing is sent to a cloud service."));
    host.append(callout);
    const group = make("div", "settings-group");
    const enabled = make("label", "toggle-row standalone");
    const enabledInput = make("input");
    enabledInput.type = "checkbox";
    enabledInput.checked = Boolean(cfg.voice.enabled);
    enabledInput.addEventListener("change", () => { cfg.voice.enabled = enabledInput.checked; });
    enabled.append(enabledInput, make("span", "toggle-control"), make("span", "toggle-copy", "Enable voice input"));
    group.append(enabled);
    const model = this._select(["tiny", "base", "small", "medium", "large-v3"].map((value) => ({ value, label: value })), cfg.voice.model_size);
    model.addEventListener("change", () => { cfg.voice.model_size = model.value; });
    const hotkey = this._textInput(cfg.voice.hotkey, "ctrl+alt+v");
    hotkey.addEventListener("input", () => { cfg.voice.hotkey = hotkey.value; });
    const language = this._select([{ value: "", label: "Auto-detect" }, { value: "en", label: "English" }, { value: "de", label: "German" }], cfg.voice.language || "");
    language.addEventListener("change", () => { cfg.voice.language = language.value || null; });
    const fields = make("div", "settings-grid two-column");
    fields.append(this._field("Whisper model", model, "Larger models are more accurate and use more memory."), this._field("Push-to-talk shortcut", hotkey), this._field("Spoken language", language));
    group.append(fields);
    host.append(group);
  }

  _settingsAdvanced(host) {
    host.append(this._sectionHeading("Advanced configuration", "The complete local configuration. Invalid JSON cannot be saved."));
    const notice = make("div", "advanced-notice", "Use this for environment variables, precise argument arrays and settings not shown elsewhere.");
    const textarea = make("textarea", "settings-json");
    textarea.spellcheck = false;
    textarea.value = JSON.stringify(this.settingsDraft, null, 2);
    textarea.addEventListener("keydown", (event) => event.stopPropagation());
    host.append(notice, textarea);
  }

  _help() {
    const intro = make("div", "help-intro");
    intro.append(make("h2", "", "QuickTerm stays out of your way."), make("p", "", "Terminals continue running in the background. Close a pane to detach it, then reattach from the dashboard whenever you need it."));
    this.bodyEl.append(intro);
    const grid = make("div", "help-grid");
    const shortcuts = [
      ["Alt P", "Open command palette"], ["Alt H", "Split side by side"],
      ["Alt V", "Split top and bottom"], ["Alt arrows", "Move between panes"],
      ["Alt Z", "Focus one pane"], ["Alt W", "Detach current pane"],
      ["Alt +", "Bigger terminal text"], ["Alt -", "Smaller terminal text"],
      ["Alt 0", "Reset terminal text size"],
      ["Ctrl Shift C", "Copy selection in terminal"], ["Ctrl Shift V", "Paste into terminal"],
    ];
    const keyCard = make("section", "help-card");
    keyCard.append(make("h3", "", "Keyboard shortcuts"));
    for (const [key, label] of shortcuts) {
      const row = make("div", "shortcut-row");
      row.append(make("kbd", "", key), make("span", "", label));
      keyCard.append(row);
    }
    const conceptCard = make("section", "help-card");
    conceptCard.append(make("h3", "", "A few useful ideas"));
    for (const [title, copy] of [
      ["Your keys stay yours", "QuickTerm only claims a handful of Alt combos. Ctrl+C, Ctrl+P, the Alt+B/F word motions and every other key reach the shell untouched."],
      ["Profiles", "Reusable terminal types, folders and start commands."],
      ["Workspaces", "Named arrangements that restore your split layout."],
      ["Live sessions", "Background terminals you can detach and return to."],
      ["Snippets", "Small reusable commands available in the palette."],
    ]) {
      const item = make("div", "concept-row");
      item.append(make("strong", "", title), make("p", "", copy));
      conceptCard.append(item);
    }
    grid.append(keyCard, conceptCard);
    this.bodyEl.append(grid);
  }
}
