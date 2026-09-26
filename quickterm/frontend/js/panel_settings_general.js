import { folderPickerControl, make } from "./panel_shared.js";
import { configPurpose } from "./panel_settings_kit.js";
export function renderGeneralSettings(host) {
    const cfg = this.settingsDraft;
    host.append(this._sectionHeading("General", "A few comfortable defaults. Changes to the server port apply after restart."));
    const group = make("div", "settings-group");
    group.append(
      make("h3", "settings-group-title", "Appearance"),
      configPurpose("How terminal text and the app around it look. Every change previews immediately and applies to panes that are already open."),
    );
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
    // A detected shell is a default of its own (stored as its id, "git-bash"),
    // so opening Git Bash by default needs no profile.
    const shells = (this.terminalInventory?.types || []).filter((type) => type.executable
      && type.available !== false && !["custom", "claude-code", "ssh", "sftp"].includes(type.id));
    const profileOptions = [
      { value: "", label: "System default shell" },
      ...shells.map((type) => ({ value: type.id, label: type.label })),
      ...(cfg.profiles || []).map((profile) => ({ value: profile.name, label: profile.name })),
    ];
    const defaultProfile = this._select(profileOptions, cfg.default_profile || "");
    defaultProfile.addEventListener("change", () => { cfg.default_profile = defaultProfile.value; });
    const fields = make("div", "settings-grid two-column");
    fields.append(
      this._field("Terminal font", font, "Use any monospace font installed on this computer."),
      this._field("Terminal text size", fontSize, "Also adjust anytime with Ctrl+plus / minus / 0."),
      this._field("Default terminal", defaultProfile, "Opened when QuickTerm starts."),
    );
    group.append(fields);
    group.append(this._themePicker(cfg));

    const branding = make("div", "settings-group");
    branding.append(
      make("h3", "settings-group-title", "Branding"),
      configPurpose("The mark shown top-left. A workspace can carry its own, so you can tell one project's window from another at a glance."),
    );
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
    behavior.append(
      make("h3", "settings-group-title", "Application"),
      configPurpose("How QuickTerm itself runs: the shortcut that summons it, the local port it serves on, how much it keeps in memory, and where scratch terminals start. The port and the summon shortcut apply after a restart."),
    );
    const hotkey = this._textInput(cfg.summon_hotkey, "ctrl+alt+grave");
    hotkey.addEventListener("input", () => { cfg.summon_hotkey = hotkey.value; });
    const port = this._textInput(cfg.port, "8620");
    port.type = "number";
    port.addEventListener("input", () => { cfg.port = Number(port.value) || 8620; });
    const scrollback = this._select([
      { value: String(64 * 1024), label: "64 KB" },
      { value: String(128 * 1024), label: "128 KB" },
      { value: String(256 * 1024), label: "256 KB" },
      { value: String(512 * 1024), label: "512 KB" },
      { value: String(1024 * 1024), label: "1 MB" },
      { value: String(2 * 1024 * 1024), label: "2 MB" },
      { value: String(4 * 1024 * 1024), label: "4 MB" },
      { value: String(8 * 1024 * 1024), label: "8 MB" },
      { value: String(16 * 1024 * 1024), label: "16 MB" },
      { value: String(32 * 1024 * 1024), label: "32 MB" },
      { value: String(64 * 1024 * 1024), label: "64 MB" },
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
    // Settings PUTs the whole draft, so writing the field into it is all a
    // save needs; the server applies the folder live and main.js re-reads the
    // resolved root in onConfigSaved. Empty means the built-in default.
    const scratch = this._textInput(cfg.scratch_dir || "", "Default: a QuickTerm folder in the system temp folder");
    scratch.addEventListener("input", () => { cfg.scratch_dir = scratch.value.trim(); });
    const scratchField = folderPickerControl(scratch, { label: "Choose the scratch folder" });
    // summon_hotkey and port are deliberately excluded from the live-update
    // whitelist in server.py, and Windows can refuse a shortcut another program
    // already owns, so say both here instead of letting "Saved." imply it worked.
    const hotkeyHint = this.app.hotkeyError && this.app.hotkeyError()
      ? `Could not be registered: ${this.app.hotkeyError()}. Applies after restart.`
      : "Show or hide QuickTerm globally. Applies after restart.";
    const appFields = make("div", "settings-grid two-column");
    appFields.append(
      this._field("Summon shortcut", hotkey, hotkeyHint),
      this._field("Local server port", port, "Only available on this computer. Applies after restart."),
      this._field("In-memory scrollback", scrollback, "Per live session. Never written to disk; released when the terminal is removed."),
      this._field("Clean unused shells", idleTimeout, "Only untouched, detached shells are ended after this time; used and busy terminals are kept."),
      this._field("Live terminal limit", maxSessions, "0 means unlimited. At the limit, new terminals are blocked; existing terminals are never stopped."),
      this._field("Scratch folder", scratchField, "Where scratch terminals start. Leave empty for a QuickTerm folder in the system temp folder. QuickTerm never deletes anything in it."),
    );
    behavior.append(appFields);
    host.append(group, branding, behavior);
  }
