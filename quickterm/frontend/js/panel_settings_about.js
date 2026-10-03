import * as api from "./api.js";
import { icon } from "./icons.js";
import { folderPickerControl, make } from "./panel_shared.js";
import { configChoice, configPurpose, configToggle } from "./panel_settings_kit.js";
import { shortcutInput } from "./shortcut_input.js";
export function renderAboutSettings(host) {
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
        "A local terminal workspace: split panes, named workspaces, "
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
    card.dataset.setting = "updates";
    card.append(
      make("h4", "", "Updates"),
      configPurpose("Checking asks GitHub for the latest release and compares it with the version you are running. Installing downloads that release's installer, verifies its SHA-256, and runs it; QuickTerm closes while it does."),
    );
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

    host.append(card);
    host.append(renderSettingsHistory.call(this));
  }

// "theme, profiles" from the server; an empty summary means that version and
// the one after it hold the same values (DPAPI makes their files differ).
export function historySummary(entry) {
  return entry?.summary ? `changes ${entry.summary}` : "no difference";
}

export function historyTime(savedAt) {
  const when = new Date(savedAt);
  if (Number.isNaN(when.getTime())) return String(savedAt || "");
  return when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// The last versions a save replaced, with a Restore action each. Restoring
// goes through the same server path as Save (validation, live apply, and the
// version it replaces joins this list), then reloads the open draft, because
// the draft still holds the settings from before.
function renderSettingsHistory() {
  const section = make("section", "about-update settings-history");
  section.dataset.setting = "config_history";
  section.append(
    make("h4", "", "Settings history"),
    configPurpose("Every save keeps the version it replaced, the last 20 of them, on this device. Restoring one saves it again, so the settings it replaces are kept here too."),
  );
  const list = make("div", "settings-history-list");
  const status = make("p", "about-update-status", "Loading…");
  section.append(status, list);

  api.getConfigHistory().then((entries) => {
    list.textContent = "";
    if (!entries?.length) {
      status.textContent = "Nothing yet. The first save that changes something starts the history.";
      return;
    }
    status.hidden = true;
    for (const entry of entries) {
      const row = make("div", "settings-history-row");
      const time = historyTime(entry.saved_at);
      const summary = historySummary(entry);
      row.append(make("span", "settings-history-time", time), make("span", "settings-history-summary", summary));
      const restore = this._button("Restore", "secondary-button compact");
      restore.title = `Restore the settings saved ${time} (${summary})`;
      restore.addEventListener("click", () => {
        this._confirmNear(restore, `Restore the settings saved ${time}? Unsaved edits here are discarded.`, "Restore", async () => {
          await api.restoreConfigVersion(entry.id);
          await this.app.onConfigSaved();
          this._themePreviewDirty = false;
          if (this.open === "settings") {
            this.bodyEl.textContent = "";
            this._settings();
          }
        });
      });
      row.append(restore);
      list.append(row);
    }
  }).catch(() => {
    status.textContent = "The settings history could not be read.";
  });
  return section;
}


const SCROLLBACK_SIZES = [64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
const IDLE_TIMEOUTS = [["0", "Never"], ["300", "5 minutes"], ["900", "15 minutes"], ["1800", "30 minutes"], ["3600", "1 hour"]];
const VOICE_DEFAULTS = { enabled: true, model_size: "small", hotkey: "ctrl+alt+v", language: null };

export function renderAdvancedSettings(host) {
    const cfg = this.settingsDraft;
    host.append(this._sectionHeading("Advanced", "The local server, terminal memory and cleanup, and updates."));

    const server = make("div", "settings-group");
    server.append(make("h3", "settings-group-title", "Server"), configPurpose("Only reachable from this computer. Both apply after a restart."));
    const serverFields = make("div", "settings-grid two-column");
    const bind = configChoice({
      label: "Loopback address",
      value: cfg.host || "127.0.0.1",
      options: ["127.0.0.1", "localhost", "::1"].map((value) => ({ value, label: value })),
      onChange: (value) => { cfg.host = value; },
    });
    const port = this._textInput(cfg.port, "8620");
    port.type = "number";
    port.setAttribute("aria-label", "Local server port");
    port.addEventListener("input", () => { cfg.port = Number(port.value) || 8620; });
    serverFields.append(
      this._field("Loopback address", bind.el, "Applies after restart.", { id: "host" }),
      this._field("Local server port", port, "Applies after restart.", { id: "port" }),
    );
    server.append(serverFields);

    const sessions = make("div", "settings-group");
    sessions.append(make("h3", "settings-group-title", "Terminals"));
    const sessionFields = make("div", "settings-grid two-column");
    const scrollback = configChoice({
      label: "In-memory scrollback",
      value: String(cfg.scrollback_bytes),
      options: SCROLLBACK_SIZES.map((kb) => ({ value: String(kb * 1024), label: kb < 1024 ? `${kb} KB` : `${kb / 1024} MB` })),
      onChange: (value) => { cfg.scrollback_bytes = Number(value); },
    });
    const idleTimeout = configChoice({
      label: "Clean unused shells",
      value: String(cfg.idle_timeout_s ?? 300),
      options: IDLE_TIMEOUTS.map(([value, label]) => ({ value, label })),
      onChange: (value) => { cfg.idle_timeout_s = Number(value); },
    });
    const maxSessions = this._textInput(cfg.max_sessions ?? 0, "0");
    maxSessions.type = "number";
    maxSessions.min = "0";
    maxSessions.max = "100";
    maxSessions.step = "1";
    maxSessions.setAttribute("aria-label", "Live terminal limit");
    maxSessions.addEventListener("input", () => {
      cfg.max_sessions = Math.max(0, Math.min(100, Number(maxSessions.value) || 0));
    });
    // The partial settings save applies this root live. Empty means the default.
    const scratch = this._textInput(cfg.scratch_dir || "", "Default: a QuickTerm folder in the system temp folder");
    scratch.setAttribute("aria-label", "Scratch folder");
    scratch.addEventListener("input", () => { cfg.scratch_dir = scratch.value.trim(); });
    const scratchField = folderPickerControl(scratch, { label: "Choose the scratch folder" });
    sessionFields.append(
      this._field("In-memory scrollback", scrollback.el, "Per live terminal. Never written to disk; released when the terminal is removed.", { id: "scrollback_bytes" }),
      this._field("Clean unused shells", idleTimeout.el, "Only untouched, detached shells are ended after this time; used and busy terminals are kept.", { id: "idle_timeout_s" }),
      this._field("Live terminal limit", maxSessions, "0 means unlimited. At the limit, new terminals are blocked; existing terminals are never stopped.", { id: "max_sessions" }),
      this._field("Scratch folder", scratchField, "Where scratch terminals start. Leave empty for a QuickTerm folder in the system temp folder. QuickTerm never deletes anything in it.", { id: "scratch_dir" }),
    );
    sessions.append(sessionFields);

    const updates = make("div", "settings-group");
    updates.append(make("h3", "settings-group-title", "Updates"), configToggle({
      id: "update_check",
      label: "Tell me when a new version is available",
      checked: cfg.update_check !== false,
      onChange: (checked) => { cfg.update_check = checked; },
    }).el);

    host.append(server, sessions, updates, renderVoice.call(this));
  }

// Voice capture is parked until it has a real capture overlay; the backend
// hotkey wiring is disabled in app.py for the same reason. Its preferences
// stay editable so a saved config keeps round-tripping.
function renderVoice() {
    const cfg = this.settingsDraft;
    const voice = { ...VOICE_DEFAULTS, ...(cfg.voice || {}) };
    const set = (key, value) => {
      voice[key] = value;
      cfg.voice = { ...voice };
    };
    const group = make("div", "settings-group");
    group.dataset.setting = "voice";
    group.append(make("h3", "settings-group-title", "Voice input"), configPurpose("Voice capture is currently unavailable."));
    group.append(configToggle({ label: "Voice enabled", checked: voice.enabled, onChange: (checked) => set("enabled", checked) }).el);
    const fields = make("div", "settings-grid two-column");
    const model = configChoice({
      label: "Whisper model",
      value: voice.model_size,
      options: ["tiny", "base", "small", "medium", "large-v3"].map((value) => ({ value, label: value })),
      onChange: (value) => set("model_size", value),
    });
    const language = this._textInput(voice.language || "", "Auto-detect");
    language.setAttribute("aria-label", "Language code");
    language.addEventListener("input", () => set("language", language.value || null));
    const hotkey = shortcutInput({ value: voice.hotkey, label: "Voice shortcut", onChange: (binding) => set("hotkey", binding || "") });
    fields.append(
      this._field("Model", model.el),
      this._field("Language code", language),
      this._field("Voice shortcut", hotkey.el),
    );
    group.append(fields);
    return group;
  }
