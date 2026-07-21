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

const THEME_CATALOG_GROUPS = [
  ["Dark", ["graphite", "one-dark", "dracula", "tokyo-night", "github-dark", "solarized-dark", "material-ocean", "night-owl", "cobalt2"]],
  ["Soft", ["catppuccin-mocha", "catppuccin-macchiato", "nord", "everforest", "rose-pine", "ayu-mirage"]],
  ["Warm", ["gruvbox-dark", "kanagawa", "monokai", "horizon"]],
  ["Light", ["rose-pine-dawn", "github-light", "solarized-light"]],
  ["Custom", [CUSTOM_THEME]],
];

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

function envToLines(env) {
  return Object.entries(env || {}).map(([key, value]) => `${key}=${value}`).join("\n");
}

function parseEnvLines(text) {
  const env = {};
  for (const raw of (text || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key) env[key] = line.slice(eq + 1);
  }
  return env;
}

function environmentError(env) {
  const seen = new Set();
  for (const [key, value] of Object.entries(env || {})) {
    if (!key || key.includes("=") || /[\x00-\x1f]/.test(key)) return `Invalid environment variable name: ${key || "(empty)"}.`;
    if (typeof value !== "string" || value.includes("\0")) return `Invalid value for environment variable ${key}.`;
    const folded = key.toLocaleLowerCase();
    if (seen.has(folded)) return `Environment variable names must be unique ignoring case: ${key}.`;
    seen.add(folded);
  }
  return "";
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

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "Unavailable";
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 100 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
}

function layoutSessionIds(node, out = new Set()) {
  if (!node) return out;
  if (node.type === "split") {
    for (const child of node.children || []) layoutSessionIds(child, out);
  } else if (node.session_id) {
    out.add(node.session_id);
  }
  return out;
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

    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) this.close();
    });
    overlay.querySelector(".panel-close").addEventListener("click", () => this.close());
    document.addEventListener("keydown", (event) => {
      if (this.open && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      } else if (this.open && event.key === "Tab") {
        const focusable = [...this.panelEl.querySelectorAll(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
    }, true);
  }

  close() {
    // If the user previewed a theme in Settings without saving, put the
    // committed theme back so closing = cancel.
    const revert = this._themePreviewDirty ? this.app.appliedTheme() : null;
    this._themePreviewDirty = false;
    this.open = null;
    this._clearInlineConfirmation();
    this.overlay.hidden = true;
    this._stopDashboardRefresh();
    if (revert) this.app.previewTheme(revert.theme, revert.custom_theme);
    if (this.returnFocus && this.returnFocus.isConnected) this.returnFocus.focus();
    else this.app.refocusTerm();
  }

  toggle(name) {
    if (this.open === name) this.close();
    else this.show(name);
  }

  show(name) {
    const refreshing = this.open === name;
    if (!refreshing) this.returnFocus = document.activeElement;
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
    if (!refreshing) requestAnimationFrame(() => this.closeButton.focus());
  }

  // Live data on the dashboard (session list, pane counts) keeps itself
  // fresh; refreshes render in place without flashing or moving the scroll.
  _startDashboardRefresh() {
    this._stopDashboardRefresh();
    this._dashTimer = setInterval(() => {
      // Rebuilding the dashboard steals focus from action buttons just as
      // surely as from inputs. Pause while focus is anywhere in its body;
      // header/close-button focus does not block background refreshes.
      const interacting = this.bodyEl.contains(document.activeElement);
      if (this.open === "dashboard" && !this._dashLoading
          && !interacting && !this._inlineConfirmation) this._dashboard(true);
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

  _clearInlineConfirmation(restoreButton = true) {
    if (!this._inlineConfirmation) return;
    const { box, button } = this._inlineConfirmation;
    this._inlineConfirmation = null;
    box.remove();
    if (restoreButton && button.isConnected) {
      button.hidden = false;
      button.focus();
    }
  }

  _confirmNear(button, message, confirmLabel, action) {
    this._clearInlineConfirmation(false);
    button.hidden = true;
    const box = make("div", "inline-confirmation");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Confirm destructive action");
    const copy = make("span", "inline-confirmation-copy", message);
    const actions = make("span", "inline-confirmation-actions");
    const confirm = this._button(confirmLabel, "secondary-button danger-text compact");
    const cancel = this._button("Cancel", "text-button compact");
    actions.append(confirm, cancel);
    box.append(copy, actions);
    document.body.append(box);
    const rect = button.getBoundingClientRect();
    box.style.top = `${Math.min(window.innerHeight - 90, rect.bottom + 6)}px`;
    box.style.right = `${Math.max(12, window.innerWidth - rect.right)}px`;
    this._inlineConfirmation = { box, button };

    const run = async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      try {
        await action();
        this._clearInlineConfirmation(false);
      } catch (error) {
        copy.textContent = error?.detail || "Action failed. Try again.";
        confirm.textContent = "Retry";
        confirm.disabled = false;
        cancel.disabled = false;
        confirm.focus();
      }
    };
    confirm.addEventListener("click", run);
    cancel.addEventListener("click", () => this._clearInlineConfirmation());
    box.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this._clearInlineConfirmation();
      }
    });
    requestAnimationFrame(() => confirm.focus());
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
      make("span", "hero-kicker", "Workspace overview"),
      make("h2", "hero-title", this.app.currentWorkspace() || "Scratch"),
      make("p", "hero-text", "Open layouts, reattach background terminals, or clean up sessions from one place."),
    );
    const stats = make("div", "dashboard-stats");
    const liveSessions = sessions.filter((session) => session.alive);
    const measuredMemory = liveSessions.reduce((sum, session) =>
      sum + (session.usage?.available ? session.usage.working_set_bytes || 0 : 0), 0);
    for (const [value, label] of [[workspaces.length, "workspaces"], [liveSessions.length, "live terminals"], [formatBytes(measuredMemory), "host RAM"]]) {
      const stat = make("div", "dashboard-stat");
      stat.append(make("strong", "", String(value).padStart(2, "0")), make("span", "", label));
      stats.append(stat);
    }
    hero.append(heroCopy, stats);
    this.bodyEl.append(hero);

    const usageSection = make("section", "dashboard-section usage-section");
    const usageHeading = this._sectionHeading(
      "Terminal usage",
      "Live host process-tree working set and sampled CPU. Figures are local estimates, not billing or enforcement data.",
    );
    if (liveSessions.length) {
      const killAll = this._button("Kill all terminals…", "secondary-button danger-text");
      killAll.addEventListener("click", () => {
        const count = liveSessions.length;
        const warning = `Stop ${count} live terminal${count === 1 ? "" : "s"} across all QuickTerm windows? Their panes in this window will close and unsaved shell work will be lost.`;
        this._confirmNear(killAll, warning, "Kill all", async () => {
          await this.app.killAllSessions();
          if (this.open === "dashboard") this._dashboard(true);
        });
      });
      usageHeading.append(killAll);
    }
    usageSection.append(usageHeading);
    const usageTable = make("div", "usage-table");
    if (!liveSessions.length) {
      usageTable.append(make("p", "detached-empty", "No live terminals to measure."));
    }
    for (const session of liveSessions) {
      const usage = session.usage || {};
      const row = make("div", "usage-row");
      const identity = make("div", "usage-identity");
      const scope = usage.scope === "host-process-tree-partial-wsl"
        ? "host side only · WSL workload excluded"
        : `${session.attachments > 0 ? "open" : "background"} · ${session.profile || "terminal"}`;
      identity.append(make("strong", "", session.name || session.id), make("small", "", scope));
      const values = make("div", "usage-values");
      const cpu = usage.cpu_percent == null ? "Sampling…" : `${usage.cpu_percent.toFixed(1)}%`;
      const metrics = [
        [usage.available ? formatBytes(usage.working_set_bytes) : "Unavailable", "RAM"],
        [usage.available ? cpu : "Unavailable", "CPU"],
        [String(usage.process_count || 0), "processes"],
        [formatUptime(usage.uptime_seconds), "uptime"],
      ];
      for (const [value, label] of metrics) {
        const cell = make("span", "usage-value");
        cell.append(make("strong", "", value), make("small", "", label));
        values.append(cell);
      }
      row.append(identity, values);
      usageTable.append(row);
    }
    usageSection.append(usageTable);
    this.bodyEl.append(usageSection);

    const workspaceSection = make("section", "dashboard-section");
    const wsHeading = this._sectionHeading("Workspaces", "Saved arrangements of terminals, folders and tools.");
    const saveForm = make("div", "save-workspace-form");
    const saveInput = this._textInput("", "Name this workspace");
    const saveButton = this._button("Save current", "primary-button");
    const saveNote = make("p", "save-workspace-note");
    let confirmOverwrite = null; // name armed for a second "really overwrite" click
    const existing = new Set(workspaces.map((workspace) => workspace.name));
    const save = async () => {
      const name = saveInput.value.trim();
      const problem = this.app.validateWorkspaceName ? this.app.validateWorkspaceName(name) : (name ? null : "Give the workspace a name.");
      if (problem) {
        saveNote.textContent = problem;
        saveInput.focus();
        return;
      }
      // Overwriting a different existing workspace loses its layout — ask once.
      const current = this.app.currentWorkspace && this.app.currentWorkspace();
      if (existing.has(name) && name !== current && confirmOverwrite !== name) {
        confirmOverwrite = name;
        saveButton.textContent = "Overwrite?";
        saveNote.textContent = `“${name}” already exists — save again to replace it.`;
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
    saveInput.addEventListener("input", () => {
      confirmOverwrite = null;
      saveButton.textContent = "Save current";
      saveNote.textContent = "";
    });
    saveForm.append(saveInput, saveButton);
    wsHeading.append(saveForm, saveNote);
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
      menu.addEventListener("click", (event) => {
        event.stopPropagation();
        this._confirmNear(menu, `Delete workspace “${workspace.name}” and stop its detached sessions?`, "Delete", async () => {
          const deleted = this.app.deleteWorkspace
            ? await this.app.deleteWorkspace(workspace.name)
            : await api.deleteWorkspace(workspace.name).then(() => true).catch(() => false);
          if (!deleted) throw new Error("Workspace could not be deleted.");
          await this._leave(card);
          if (this.open === "dashboard") this._dashboard(true);
        });
      });
      top.append(badge, menu);
      const preview = this._layoutPreview(layout);
      const footer = make("div", "workspace-card-footer");
      const name = make("div");
      name.append(make("h3", "", workspace.name), make("p", "", workspace.name === "scratch" ? "Disposable · gone when the app quits" : "Saved workspace"));
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

    const sessionSection = make("section", "dashboard-section detached-section");
    const timeoutSeconds = this.app.idleTimeoutSeconds ?? 300;
    const timeoutCopy = timeoutSeconds <= 0
      ? "Untouched background shells are never expired automatically."
      : `Untouched background shells expire after ${Math.max(1, Math.round(timeoutSeconds / 60))} quiet minutes; used or busy sessions are kept.`;
    sessionSection.append(this._sectionHeading(
      "Detached sessions",
      timeoutCopy,
    ));
    const sessionGroups = make("div", "detached-groups");
    const currentName = (this.app.currentWorkspace && this.app.currentWorkspace()) || "scratch";
    const attachedHere = new Set(this.app.attachedSessionIds ? this.app.attachedSessionIds() : []);
    const liveById = new Map(sessions.filter((session) => session.alive).map((session) => [session.id, session]));
    const claimed = new Set();
    const groups = [];
    for (const workspace of workspaces) {
      if (!workspace.data) continue;
      const layoutIds = layoutSessionIds(workspace.data.layout);
      const owned = new Set(workspace.data.session_ids || []);
      for (const sid of layoutIds) owned.add(sid);
      if (workspace.name === currentName && this.app.ownedSessionIds) {
        for (const sid of this.app.ownedSessionIds()) owned.add(sid);
      }
      for (const sid of owned) claimed.add(sid);
      const detached = [...owned]
        .filter((sid) => !layoutIds.has(sid) && !attachedHere.has(sid))
        .map((sid) => liveById.get(sid))
        .filter((session) => session && !(session.attachments > 0));
      if (detached.length) groups.push({ name: workspace.name, sessions: detached });
    }
    if (!workspaces.some((workspace) => workspace.name === currentName) && this.app.ownedSessionIds) {
      const owned = new Set(this.app.ownedSessionIds());
      for (const sid of owned) claimed.add(sid);
      const detached = [...owned]
        .filter((sid) => !attachedHere.has(sid))
        .map((sid) => liveById.get(sid))
        .filter((session) => session && !(session.attachments > 0));
      if (detached.length) groups.push({ name: currentName, sessions: detached });
    }
    const unassigned = sessions.filter((session) =>
      session.alive && !(session.attachments > 0) && !claimed.has(session.id));
    if (unassigned.length) groups.push({ name: "Unassigned", sessions: unassigned });

    const sessionRow = (session, workspaceName, isCurrent) => {
      const row = make("div", "detached-session-row");
      const copy = make("div", "detached-session-copy");
      copy.append(
        make("strong", "", session.name || session.id),
        make("small", "", `${session.profile || "terminal"} · ${session.id}`),
      );
      const actions = make("div", "detached-session-actions");
      const attach = this._button(isCurrent ? "Attach" : "Move here & attach", "secondary-button compact");
      attach.addEventListener("click", async () => {
        this.close();
        if (isCurrent) this.app.attachSession(session);
        else await this.app.moveSessionHere(session, workspaceName === "Unassigned" ? null : workspaceName);
      });
      const kill = this._button("Kill", "text-button danger-text");
      kill.addEventListener("click", () => {
        this._confirmNear(kill, `Stop terminal “${session.name || session.id}”?`, "Kill", async () => {
          const stopped = await this.app.killWorkspaceSession(session, workspaceName === "Unassigned" ? null : workspaceName);
          if (!stopped) throw new Error("Terminal could not be stopped.");
          if (this.open === "dashboard") this._dashboard(true);
        });
      });
      actions.append(attach, kill);
      row.append(copy, actions);
      return row;
    };

    const currentGroup = groups.find((group) => group.name === currentName);
    if (currentGroup) {
      const group = make("section", "detached-group current");
      group.append(make("h3", "", currentName === "scratch" ? "Scratch" : currentName));
      for (const session of currentGroup.sessions) group.append(sessionRow(session, currentName, true));
      sessionGroups.append(group);
    }
    const otherGroups = groups.filter((group) => group !== currentGroup);
    if (otherGroups.length) {
      const other = make("details", "other-workspace-sessions");
      const count = otherGroups.reduce((sum, group) => sum + group.sessions.length, 0);
      other.append(make("summary", "", `Other workspaces · ${count} — explicit move required`));
      for (const item of otherGroups) {
        const group = make("section", "detached-group");
        group.append(make("h3", "", item.name));
        for (const session of item.sessions) group.append(sessionRow(session, item.name, false));
        other.append(group);
      }
      sessionGroups.append(other);
    }
    if (!groups.length) {
      sessionGroups.append(make("p", "detached-empty", "Nothing is detached. Alt+W puts a used terminal here without stopping it."));
    }
    sessionSection.append(sessionGroups);
    this.bodyEl.append(sessionSection);

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

    lower.append(profiles);
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
      // Voice is parked until it has a real capture overlay; the backend
      // hotkey wiring is disabled in app.py for the same reason.
      ["advanced", "Advanced", "Raw configuration"],
      ["about", "About", "Version, updates and links"],
    ];
    const render = () => {
      for (const button of nav.querySelectorAll("button")) button.classList.toggle("active", button.dataset.tab === this.settingsTab);
      content.textContent = "";
      if (this.settingsTab === "general") this._settingsGeneral(content);
      else if (this.settingsTab === "terminals") this._settingsTerminals(content, render);
      else if (this.settingsTab === "snippets") this._settingsSnippets(content, render);
      else if (this.settingsTab === "about") this._settingsAbout(content);
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
      const badEnvironment = profiles
        .map((profile) => environmentError(profile.env))
        .find(Boolean);
      if (badEnvironment) {
        message.textContent = badEnvironment;
        message.classList.add("error");
        return;
      }
      const snippets = this.settingsDraft.snippets || [];
      if (snippets.some((snippet) => !(snippet.name || "").trim() || !(snippet.text || "").trim())) {
        message.textContent = "Every snippet needs a name and command.";
        message.classList.add("error");
        return;
      }
      const snippetNames = snippets.map((snippet) => snippet.name.trim().toLowerCase());
      if (new Set(snippetNames).size !== snippetNames.length) {
        message.textContent = "Snippet names must be unique.";
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
        message.textContent = error.detail || `Could not save (${error.status || "connection error"}).`;
        message.title = message.textContent;
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
      Array.from({ length: 22 }, (_, index) => {
        const px = index + 9;
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
      this._field("Terminal text size", fontSize, "Also adjust anytime with Alt+Shift+plus / minus."),
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
    const maxSessions = this._textInput(cfg.max_sessions ?? 0, "0");
    maxSessions.type = "number";
    maxSessions.min = "0";
    maxSessions.max = "100";
    maxSessions.step = "1";
    maxSessions.addEventListener("input", () => {
      cfg.max_sessions = Math.max(0, Math.min(100, Number(maxSessions.value) || 0));
    });
    const appFields = make("div", "settings-grid two-column");
    appFields.append(
      this._field("Summon shortcut", hotkey, "Show or hide QuickTerm globally."),
      this._field("Local server port", port, "Only available on this computer."),
      this._field("Session scrollback", scrollback, "History retained for each live session."),
      this._field("Clean unused shells", idleTimeout, "Only untouched, detached shells are ended after this time; used and busy terminals are kept."),
      this._field("Live terminal limit", maxSessions, "0 means unlimited. At the limit, new terminals are blocked; existing terminals are never stopped."),
    );
    behavior.append(appFields);
    host.append(group, branding, behavior);
  }

  _themePicker(cfg) {
    const wrap = make("div", "theme-picker");
    wrap.append(make("h4", "theme-picker-title", "Color theme"), make("p", "field-hint", "Previews the workbench and every open terminal instantly. Press Save to keep it."));
    const featuredGrid = make("div", "theme-grid theme-grid-featured");
    const catalog = make("details", "theme-catalog");
    const catalogBody = make("div", "theme-catalog-body");
    const current = () => cfg.theme || DEFAULT_THEME;
    const entries = [
      ...Object.entries(TERMINAL_THEMES),
      [CUSTOM_THEME, getTheme(CUSTOM_THEME, cfg.custom_theme)],
    ];
    const selectedThemeId = entries.some(([id]) => id === current()) ? current() : DEFAULT_THEME;
    const featuredIds = ["graphite", "github-dark", "one-dark", "rose-pine-dawn"];
    if (!featuredIds.includes(selectedThemeId)) featuredIds[featuredIds.length - 1] = selectedThemeId;
    const featured = new Set(featuredIds);
    const catalogCount = entries.filter(([id]) => !featured.has(id)).length;
    const catalogTargets = new Map();
    const availableIds = new Set(entries.map(([id]) => id));
    for (const [label, ids] of THEME_CATALOG_GROUPS) {
      const visibleIds = ids.filter((id) => availableIds.has(id) && !featured.has(id));
      if (!visibleIds.length) continue;
      const section = make("section", "theme-category");
      const grid = make("div", "theme-grid theme-grid-catalog");
      section.append(make("h5", "theme-category-title", label), grid);
      catalogBody.append(section);
      for (const id of visibleIds) catalogTargets.set(id, grid);
    }
    const ungroupedIds = entries
      .map(([id]) => id)
      .filter((id) => !featured.has(id) && !catalogTargets.has(id));
    if (ungroupedIds.length) {
      const section = make("section", "theme-category");
      const grid = make("div", "theme-grid theme-grid-catalog");
      section.append(make("h5", "theme-category-title", "Other"), grid);
      catalogBody.append(section);
      for (const id of ungroupedIds) catalogTargets.set(id, grid);
    }
    catalog.append(make("summary", "theme-catalog-trigger", `Theme catalog · ${catalogCount} more`), catalogBody);
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
      card.classList.toggle("active", selectedThemeId === id);
      card.setAttribute("aria-pressed", String(selectedThemeId === id));
      const strip = make("span", "theme-strip");
      strip.setAttribute("aria-hidden", "true");
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
        for (const other of cards.values()) {
          const active = other === card;
          other.classList.toggle("active", active);
          other.setAttribute("aria-pressed", String(active));
        }
        editor.hidden = id !== CUSTOM_THEME;
        this._themePreviewDirty = true;
        this.app.previewTheme(id, cfg.custom_theme);
      });
      (featured.has(id) ? featuredGrid : catalogTargets.get(id) || catalogBody).append(card);
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
    editor.hidden = selectedThemeId !== CUSTOM_THEME;
    wrap.append(featuredGrid, catalog, editor);
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
      fields.append(this._field("Starting folder", cwd, inferTerminalType(profile) === "wsl" ? "Use a Linux path for WSL." : "Leave empty to start in your Desktop folder."));
      if (inferTerminalType(profile) !== "custom") {
        const start = this._textInput(profile.start_command, "Optional, e.g. uv run dev");
        start.addEventListener("input", () => { profile.start_command = start.value || null; });
        fields.append(this._field("Start command", start, "Runs inside the shell and keeps it open."));
      }
      const shortcut = this._textInput(profile.keybinding, "Optional, e.g. ctrl+alt+1");
      shortcut.addEventListener("input", () => { profile.keybinding = shortcut.value || null; });
      fields.append(this._field("Global shortcut", shortcut, "Applied after restarting QuickTerm."));
      card.append(fields);

      const envArea = make("textarea", "ui-input env-input");
      envArea.value = envToLines(profile.env);
      envArea.placeholder = "API_TOKEN=...\nNODE_ENV=development";
      envArea.spellcheck = false;
      envArea.rows = 3;
      envArea.addEventListener("keydown", (event) => event.stopPropagation());
      envArea.addEventListener("input", () => { profile.env = parseEnvLines(envArea.value); });
      card.append(this._field(
        "Environment variables",
        envArea,
        "One KEY=value per line, inherited by every process in this terminal. Values are encrypted on disk with your Windows account.",
      ));

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
    const heading = this._sectionHeading("Snippets", "Reusable commands, one keystroke away in the command palette (Alt+K).");
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

  _settingsAbout(host) {
    const cfg = this.settingsDraft;
    const version = this.app.version || "";

    const hero = make("section", "about-hero");
    const identity = make("div", "about-identity");
    identity.append(
      make("h3", "about-name", "QuickTerm"),
      make("span", "about-version", version ? `Version ${version}` : ""),
    );
    hero.append(
      identity,
      make("p", "about-tagline",
        "A calm, local terminal workspace — split panes, named workspaces, "
        + "persistent sessions and quick-launch profiles. Everything stays on this computer."),
      make("p", "about-credit", "Made by Devin Isaac Worbis · Released under the MIT license"),
    );
    host.append(hero);

    const links = make("section", "about-links");
    for (const [label, url] of [
      ["Repository", "https://github.com/devincii-io/quickterm"],
      ["Report an issue", "https://github.com/devincii-io/quickterm/issues"],
      ["Releases & changelog", "https://github.com/devincii-io/quickterm/releases"],
      ["MIT license", "https://github.com/devincii-io/quickterm/blob/main/LICENSE"],
    ]) {
      const link = make("a", "about-link");
      link.href = url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.append(make("span", "", label), icon("arrow-up-right", 13));
      links.append(link);
    }
    host.append(links);

    const card = make("section", "about-update");
    card.append(make("h4", "", "Updates"));
    const status = make("p", "about-update-status", "New versions are fetched from GitHub releases.");
    const row = make("div", "about-update-row");
    const check = this._button("Check for updates", "secondary-button compact");
    const install = this._button("", "primary-button compact");
    install.hidden = true;
    row.append(check, install);
    card.append(status, row);

    check.addEventListener("click", async () => {
      check.disabled = true;
      status.textContent = "Checking…";
      install.hidden = true;
      try {
        const result = await api.checkUpdate(true);
        if (result.update_available) {
          status.textContent = `QuickTerm v${result.latest} is available (you have v${result.current}).`;
          if (result.installable) {
            install.textContent = `Install v${result.latest}`;
            install.hidden = false;
          }
        } else {
          status.textContent = `You are up to date (v${result.current}).`;
        }
      } catch (error) {
        status.textContent = "Could not reach GitHub. Check your connection and try again.";
      } finally {
        check.disabled = false;
      }
    });
    install.addEventListener("click", async () => {
      install.disabled = true;
      const wanted = install.textContent;
      install.textContent = "Downloading…";
      try {
        await api.installUpdate();
        status.textContent = "Installer started - QuickTerm will close and update itself.";
        install.textContent = wanted;
        install.hidden = true;
      } catch (error) {
        status.textContent = "The download failed. You can update manually from the releases page.";
        install.textContent = wanted;
        install.disabled = false;
      }
    });

    const toggle = make("label", "toggle-row standalone");
    const checkbox = make("input");
    checkbox.type = "checkbox";
    checkbox.checked = cfg.update_check !== false;
    checkbox.addEventListener("change", () => { cfg.update_check = checkbox.checked; });
    toggle.append(checkbox, make("span", "toggle-control"), make("span", "toggle-copy", "Tell me when a new version is available"));
    card.append(toggle);
    host.append(card);
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
    intro.append(make("h2", "", "Your terminals stay organized."), make("p", "", "Alt+W detaches a used terminal without stopping it. It remains inside the current workspace — including Scratch — and appears on the dashboard with Attach and Kill controls."));
    this.bodyEl.append(intro);
    const grid = make("div", "help-grid");
    const shortcuts = [
      ["Alt K", "Open command palette"], ["Alt Shift →", "Split to the right"],
      ["Alt Shift ↓", "Split below"], ["Alt arrows", "Move between panes"],
      ["Alt Z", "Focus one pane"], ["Alt W", "Detach current pane"],
      ["Alt Shift W", "Kill terminal and close pane"],
      ["Alt Shift +", "Bigger terminal text"], ["Alt Shift -", "Smaller terminal text"],
      ["Alt Shift 0", "Reset terminal text size"],
      ["Ctrl Shift C", "Copy selection in terminal"], ["Ctrl Shift V", "Paste into terminal"],
      ["Right click", "Copy the current selection"],
      ["Ctrl click", "Open a link or file path printed in the terminal"],
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
      ["Your keys stay yours", "QuickTerm only claims cold Alt combos. Ctrl+C, Ctrl+P, Alt+V (Claude Code image paste), Alt+P (model switch), the Alt+B/F word motions and every other key reach the shell untouched."],
      ["Profiles", "Reusable terminal types, folders and start commands."],
      ["Workspaces", "Named arrangements that restore your split layout."],
      ["Sessions live in workspaces", "Detached sessions stay with their workspace and do not expire. The palette only shows the current workspace; moving a session from another workspace requires the explicit menu."],
      ["Scratch is temporary", "Scratch keeps its detached sessions for this run, but the whole Scratch workspace is deleted when QuickTerm quits."],
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
