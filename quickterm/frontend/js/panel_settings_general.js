import { make } from "./panel_shared.js";
import { configChoice, configPurpose } from "./panel_settings_kit.js";

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
  const defaultProfile = configChoice({
    label: "Default terminal",
    value: cfg.default_profile || "",
    options: [
      { value: "", label: "First saved local terminal" },
      ...(cfg.profiles || []).filter((profile) => !["rdp", "vnc"].includes(profile.terminal_type))
        .map((profile) => ({ value: profile.name, label: profile.name })),
    ],
    onChange: (value) => { cfg.default_profile = value; },
  });
  const fields = make("div", "settings-grid two-column");
  fields.append(
    this._field("Terminal font", font, "Use any monospace font installed on this computer.", { id: "font_family" }),
    this._field("Terminal text size", fontSize.el, "Also adjust anytime with Ctrl+plus / minus / 0.", { id: "font_size" }),
    this._field("Default terminal", defaultProfile.el, "Opened when QuickTerm starts.", { id: "default_profile" }),
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
  host.append(group, branding);
}
