import * as api from "./api.js";
import {
  DASHBOARD_REFRESH_MS, TERMINAL_TYPES, environmentError, inferTerminalType, make,
} from "./panel_shared.js";
import { renderDashboard } from "./panel_dashboard.js";
import { renderGeneralSettings } from "./panel_settings_general.js";
import { renderThemePicker, renderLogoPicker } from "./panel_settings_appearance.js";
import { renderTerminalSettings } from "./panel_settings_terminals.js";
import { renderSnippetSettings } from "./panel_settings_snippets.js";
import { renderAboutSettings, renderVoiceSettings, renderAdvancedSettings } from "./panel_settings_about.js";
import { renderHelp } from "./panel_help.js";
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
    // QuickTerm is a terminal-first workbench: closing a full-screen panel must
    // make the focused pane immediately typeable again. Returning focus to a
    // sidebar trigger leaves the next paste/keystroke outside xterm and feels
    // like the terminal lost focus. Keep the trigger only as a no-pane
    // accessibility fallback.
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
    const { box, button, wasDisabled } = this._inlineConfirmation;
    this._inlineConfirmation = null;
    box.remove();
    if (button.isConnected) {
      button.disabled = wasDisabled;
      button.setAttribute("aria-expanded", "false");
      if (restoreButton) button.focus();
    }
  }

  _confirmNear(button, message, confirmLabel, action) {
    this._clearInlineConfirmation(false);
    // Measure before changing the trigger. The previous implementation hid it
    // first, making getBoundingClientRect() return a zero rectangle and placing
    // confirmations at the top-right of the window (usually outside the
    // scrolled dashboard view). Keep the sole destructive control visible and
    // disabled while its confirmation is open.
    const rect = button.getBoundingClientRect();
    const wasDisabled = button.disabled;
    button.disabled = true;
    button.setAttribute("aria-expanded", "true");
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
    const boxRect = box.getBoundingClientRect();
    const margin = 12;
    const gap = 6;
    const maxLeft = Math.max(margin, window.innerWidth - boxRect.width - margin);
    const left = Math.max(margin, Math.min(maxLeft, rect.right - boxRect.width));
    let top = rect.bottom + gap;
    if (top + boxRect.height > window.innerHeight - margin) top = rect.top - boxRect.height - gap;
    top = Math.max(margin, Math.min(window.innerHeight - boxRect.height - margin, top));
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    this._inlineConfirmation = { box, button, wasDisabled };

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
    return renderDashboard.call(this, refreshing);
  }
  _terminalLabel(profile) {
    const type = inferTerminalType(profile);
    if (type === "claude-code") {
      const mode = profile.claude_mode === "resume" ? "choose session"
        : profile.claude_mode === "agents" ? "agent manager"
          : profile.claude_mode === "new" ? "new conversation" : "continue latest";
      return `Claude Code · ${mode}`;
    }
    if (type === "wsl" && profile.wsl_distro) return `WSL · ${profile.wsl_distro}`;
    if ((type === "ssh" || type === "sftp") && profile.ssh_host) {
      const target = profile.ssh_user ? `${profile.ssh_user}@${profile.ssh_host}` : profile.ssh_host;
      return `${type.toUpperCase()} · ${target}`;
    }
    const fallback = TERMINAL_TYPES.find((item) => item.id === "custom");
    return (TERMINAL_TYPES.find((item) => item.id === type) || fallback).label;
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

  _settingsGeneral(host) { return renderGeneralSettings.call(this, host); }
  _themePicker(cfg) { return renderThemePicker.call(this, cfg); }
  _logoPicker(options) { return renderLogoPicker.call(this, options); }
  _settingsTerminals(host, rerender) { return renderTerminalSettings.call(this, host, rerender); }
  _settingsSnippets(host, rerender) { return renderSnippetSettings.call(this, host, rerender); }
  _settingsAbout(host) { return renderAboutSettings.call(this, host); }
  _settingsVoice(host) { return renderVoiceSettings.call(this, host); }
  _settingsAdvanced(host) { return renderAdvancedSettings.call(this, host); }
  _help() { return renderHelp.call(this); }
}
