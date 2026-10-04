import * as api from "./api.js";
import { icon } from "./icons.js";
import { panelMenu } from "./panel_settings_kit.js";
import { make } from "./panel_shared.js";
import {
  CUSTOM_THEME, CUSTOM_THEME_DEFAULTS, customColors, getTheme, resolveThemeId, themeGroups,
} from "./themes.js";

// What a swatch shows: the theme's accent, then the eight normal ANSI
// colours, all on the terminal background, so a row reads like a prompt.
const SWATCH_KEYS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

function paintSwatch(swatch, def) {
  swatch.textContent = "";
  swatch.style.setProperty("--swatch-bg", def.xterm.background);
  const accent = make("i", "theme-swatch-accent");
  accent.style.setProperty("--swatch", def.accent);
  swatch.append(accent);
  for (const key of SWATCH_KEYS) {
    const dot = make("i");
    dot.style.setProperty("--swatch", def.xterm[key]);
    swatch.append(dot);
  }
}

function themeSwatch(def) {
  const swatch = make("span", "theme-swatch");
  swatch.setAttribute("aria-hidden", "true");
  paintSwatch(swatch, def);
  return swatch;
}

// The theme chooser is a menu.js menu like every other chooser (AGENTS.md):
// Dark, Light and Custom sections, a swatch on every row, the current theme
// checked. Choosing previews at once; Save keeps it.
export function renderThemePicker(cfg) {
  const wrap = make("div", "theme-picker");
  wrap.append(
    make("h4", "theme-picker-title", "Color theme"),
    make("p", "field-hint", "Previews the workbench and every open terminal instantly. Press Save to keep it."),
  );
  cfg.custom_theme = customColors(cfg.custom_theme || {});
  // A saved id from an older release resolves through THEME_ALIASES; the
  // config keeps that id until the user picks another theme.
  const selectedId = () => (cfg.theme === CUSTOM_THEME ? CUSTOM_THEME : resolveThemeId(cfg.theme));
  const definition = (id) => getTheme(id, cfg.custom_theme);

  const button = make("button", "config-choice theme-choice");
  button.type = "button";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", "Color theme");
  const swatch = make("span", "theme-swatch");
  swatch.setAttribute("aria-hidden", "true");
  const name = make("span", "config-choice-label");
  const detail = make("small", "theme-choice-detail");
  const copy = make("span", "theme-choice-copy");
  copy.append(name, detail);
  button.append(swatch, copy, icon("chevron-down", 12));
  const paint = () => {
    const def = definition(selectedId());
    paintSwatch(swatch, def);
    name.textContent = def.label;
    detail.textContent = `${def.light ? "Light" : "Dark"} · ${def.note}`;
  };

  const editor = make("div", "custom-theme-editor");
  const choose = (id) => {
    cfg.theme = id;
    paint();
    editor.hidden = id !== CUSTOM_THEME;
    this._themePreviewDirty = true;
    this.app.previewTheme(id, cfg.custom_theme);
  };

  button.addEventListener("click", () => {
    const current = selectedId();
    const items = [];
    for (const [heading, ids] of [...themeGroups(), ["Custom", [CUSTOM_THEME]]]) {
      items.push({ heading });
      for (const id of ids) {
        const def = definition(id);
        items.push({
          label: def.label,
          detail: def.note,
          trailing: () => themeSwatch(def),
          selected: id === current,
          run: () => choose(id),
        });
      }
    }
    panelMenu({
      anchor: button,
      label: "Color theme",
      items,
      width: 380,
      onClose: (reason) => {
        if (reason === "run" || reason === "escape") button.focus();
      },
    });
  });

  for (const [key, fallback] of Object.entries(CUSTOM_THEME_DEFAULTS)) {
    const label = make("label", "custom-color-field");
    const input = make("input");
    input.type = "color";
    input.value = cfg.custom_theme[key] || fallback;
    label.append(input, make("span", "", key.replace(/^./, (char) => char.toUpperCase())));
    input.addEventListener("input", () => {
      cfg.custom_theme[key] = input.value.toUpperCase();
      if (cfg.theme === CUSTOM_THEME) {
        paint();
        this._themePreviewDirty = true;
        this.app.previewTheme(CUSTOM_THEME, cfg.custom_theme);
      }
    });
    editor.append(label);
  }
  editor.hidden = selectedId() !== CUSTOM_THEME;
  paint();
  wrap.append(button, editor);
  return wrap;
}

export function renderLogoPicker({ title, value, hint, onChange }) {
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
    // Uploaded assets may still be referenced by committed settings or history.
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
        status.textContent = "Ready to save.";
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
