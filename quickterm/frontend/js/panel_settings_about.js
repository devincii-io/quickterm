import * as api from "./api.js";
import { icon } from "./icons.js";
import { make } from "./panel_shared.js";
export function renderAboutSettings(host) {
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


export function renderVoiceSettings(host) {
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


export function renderAdvancedSettings(host) {
    host.append(this._sectionHeading("Advanced configuration", "The complete local configuration. Invalid JSON cannot be saved."));
    const notice = make("div", "advanced-notice", "Use this for environment variables, precise argument arrays and settings not shown elsewhere.");
    const textarea = make("textarea", "settings-json");
    textarea.spellcheck = false;
    textarea.value = JSON.stringify(this.settingsDraft, null, 2);
    textarea.addEventListener("keydown", (event) => event.stopPropagation());
    host.append(notice, textarea);
  }
