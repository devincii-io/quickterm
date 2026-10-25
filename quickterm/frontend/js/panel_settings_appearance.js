import * as api from "./api.js";
import { make } from "./panel_shared.js";
import { openThemeSwitcher, themeMiniature } from "./theme_switcher.js";
import { CUSTOM_THEME, customColors, getTheme, resolveThemeId } from "./themes.js";

// Settings > General shows the current theme as a miniature with its name and
// opens the switcher sheet, which saves on its own: a theme is tried and
// applied there, with the whole window as the preview. Each save there is
// written into this sheet's draft and baseline too, so Save here neither
// repeats it nor reports it as changed in another window.
export function renderThemePicker(cfg) {
  const wrap = make("div", "theme-picker");
  wrap.append(
    make("h4", "theme-picker-title", "Color theme"),
    make("p", "field-hint", "Opens the theme switcher: try themes on the whole window, apply one, and keep the sheet open."),
  );
  // A saved id from an older release resolves through THEME_ALIASES; the
  // config keeps that id until the user picks another theme.
  const selectedId = () => (cfg.theme === CUSTOM_THEME ? CUSTOM_THEME : resolveThemeId(cfg.theme));

  const button = make("button", "theme-row");
  button.type = "button";
  button.setAttribute("aria-haspopup", "dialog");
  const copy = make("span", "theme-row-copy");
  const name = make("strong");
  const detail = make("small");
  copy.append(name, detail);
  const action = make("span", "theme-row-action", "Change…");
  const paint = () => {
    const custom = customColors(cfg.custom_theme || {});
    const def = getTheme(selectedId(), custom);
    button.textContent = "";
    button.append(themeMiniature(selectedId(), custom), copy, action);
    name.textContent = def.label;
    detail.textContent = `${def.light ? "Light" : "Dark"} · ${def.note}`;
    button.setAttribute("aria-label", `Color theme: ${def.label}. Change`);
  };
  button.addEventListener("click", () => {
    openThemeSwitcher(this.app, {
      returnFocus: button,
      onApplied: (theme, custom) => {
        for (const draft of [cfg, this.settingsBaseline].filter(Boolean)) {
          draft.theme = theme;
          draft.custom_theme = structuredClone(custom);
        }
        if (button.isConnected) paint();
      },
    });
  });
  paint();
  wrap.append(button);
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
