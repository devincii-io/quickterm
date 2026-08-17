import * as api from "./api.js";
import { icon } from "./icons.js";
import {
  CUSTOM_THEME, CUSTOM_THEME_DEFAULTS, DEFAULT_THEME, TERMINAL_THEMES,
  customColors, getTheme,
} from "./themes.js";
import {
  THEME_CATALOG_GROUPS, make,
} from "./panel_shared.js";
export function renderThemePicker(cfg) {
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
    // Superseded uploads were never reclaimed: every replaced logo stayed in
    // %APPDATA%/quickterm/assets forever (up to 1 MB each) and api.deleteAsset
    // had no callers at all. Best effort — the config change is what matters.
    const discard = (assetId) => {
      if (assetId) api.deleteAsset(assetId).catch(() => {});
    };
    remove.addEventListener("click", async () => {
      const previous = value;
      await onChange(null);
      value = null;
      discard(previous);
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
        const previous = value;
        await onChange(uploaded.id);
        value = uploaded.id;
        if (previous !== uploaded.id) discard(previous);
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
