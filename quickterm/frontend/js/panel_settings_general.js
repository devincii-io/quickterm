import { make } from "./panel_shared.js";
import { configChoice, configPurpose, configToggle } from "./panel_settings_kit.js";
import { DEFAULT_SHELL, availableShells, shellValueLabel } from "./shell_choice.js";

export const NOTIFY_OPTIONS = Object.freeze([
  Object.freeze({ value: "off", label: "Off", detail: "The sidebar still shows it" }),
  Object.freeze({ value: "flash", label: "Flash", detail: "Flash the taskbar button" }),
  Object.freeze({ value: "notify", label: "Notify", detail: "Flash and show a Windows notification" }),
]);

export const KEEP_AWAKE_OPTIONS = Object.freeze([
  Object.freeze({ value: "agents", label: "While agents work", detail: "The screen may still turn off" }),
  Object.freeze({ value: "always", label: "Always", detail: "While QuickTerm runs" }),
  Object.freeze({ value: "off", label: "Never", detail: "Windows decides as usual" }),
]);

// The saved choices, with the defaults for a config written before they existed.
export function notificationSettings(cfg) {
  const saved = cfg?.notifications || {};
  return {
    needs_you: NOTIFY_OPTIONS.some((option) => option.value === saved.needs_you) ? saved.needs_you : "notify",
    finished: NOTIFY_OPTIONS.some((option) => option.value === saved.finished) ? saved.finished : "flash",
    sound: saved.sound === true,
  };
}

// The installed shells, plus the configured one when the inventory does not
// list it (a WSL distribution since removed, or "wsl" for the default one), so
// the picker always shows what is saved.
export function shellOptions(inventory, current) {
  const options = availableShells(inventory, current);
  if (!options.some((option) => option.value === current)) {
    options.push({ value: current, label: shellValueLabel(current) });
  }
  return options;
}

export function renderGeneralSettings(host) {
  const cfg = this.settingsDraft;
  host.append(this._sectionHeading("General", "How terminals look, and which one opens first."));
  const group = make("div", "settings-group");
  group.append(
    make("h3", "settings-group-title", "Appearance"),
    configPurpose("Every change previews immediately and applies to panes that are already open."),
  );
  const font = this._textInput(cfg.font_family, "JetBrains Mono");
  font.setAttribute("aria-label", "Terminal font");
  font.addEventListener("input", () => { cfg.font_family = font.value; });
  const fontSize = configChoice({
    label: "Terminal text size",
    value: String(cfg.font_size || 14),
    options: Array.from({ length: 22 }, (_, index) => {
      const px = index + 9;
      return { value: String(px), label: `${px} px` };
    }),
    onChange: (value) => { cfg.font_size = Number(value); },
  });
  const shell = configChoice({
    label: "Shell",
    value: cfg.shell ?? DEFAULT_SHELL,
    options: shellOptions(this.terminalInventory, cfg.shell ?? DEFAULT_SHELL),
    onChange: (value) => { cfg.shell = value; },
  });
  const fields = make("div", "settings-grid two-column");
  fields.append(
    this._field("Terminal font", font, "Use any monospace font installed on this computer.", { id: "font_family" }),
    this._field("Terminal text size", fontSize.el, "Also adjust anytime with Ctrl+plus / minus / 0.", { id: "font_size" }),
    this._field("Shell", shell.el, "What + and Alt+N start. Claude Code and Codex run inside it.", { id: "shell" }),
  );
  group.append(fields);
  const theme = this._themePicker(cfg);
  theme.dataset.setting = "theme";
  group.append(theme);

  const branding = make("div", "settings-group");
  branding.append(
    make("h3", "settings-group-title", "Branding"),
    configPurpose("The mark shown top-left. A workspace can carry its own, so you can tell one project's window from another at a glance."),
  );
  const logo = this._logoPicker({
    title: "App logo",
    value: cfg.logo,
    hint: "Shown whenever a workspace does not have its own logo.",
    onChange: async (assetId) => { cfg.logo = assetId; },
  });
  logo.dataset.setting = "logo";
  branding.append(logo);
  host.append(group, branding, renderAgentAttention.call(this, cfg));
}

// Settings > General > Notifications and Keep awake: what QuickTerm does
// about an agent while you look elsewhere.
function renderAgentAttention(cfg) {
  const box = make("div", "settings-group");
  box.append(
    make("h3", "settings-group-title", "Notifications and sleep"),
    configPurpose("Notifications come only while QuickTerm is not in front; otherwise the sidebar says it."),
  );
  const write = (key, value) => {
    cfg.notifications = { ...notificationSettings(cfg), [key]: value };
  };
  const current = notificationSettings(cfg);
  const needsYou = configChoice({
    label: "When an agent needs you",
    value: current.needs_you,
    options: NOTIFY_OPTIONS,
    onChange: (value) => write("needs_you", value),
  });
  const finished = configChoice({
    label: "When an agent finishes",
    value: current.finished,
    options: NOTIFY_OPTIONS,
    onChange: (value) => write("finished", value),
  });
  const keepAwake = configChoice({
    label: "Keep awake",
    value: KEEP_AWAKE_OPTIONS.some((option) => option.value === cfg.keep_awake) ? cfg.keep_awake : "agents",
    options: KEEP_AWAKE_OPTIONS,
    onChange: (value) => { cfg.keep_awake = value; },
  });
  const fields = make("div", "settings-grid two-column");
  fields.append(
    this._field("When an agent needs you", needsYou.el, "A question or a permission it waits for.",
      { id: "notifications.needs_you" }),
    this._field("When an agent finishes", finished.el, "A finished turn.", { id: "notifications.finished" }),
    this._field("Keep awake", keepAwake.el, "Holds off sleep; the screen may still turn off.", { id: "keep_awake" }),
  );
  const sound = configToggle({
    label: "Play the notification sound",
    checked: current.sound,
    id: "notifications.sound",
    onChange: (checked) => write("sound", checked),
  });
  box.append(fields, sound.el);
  return box;
}
