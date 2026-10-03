// Settings > Window: the size a new window opens at, whether the last size
// and position come back, and the drop-down overlay the summon shortcut can
// toggle. Everything binds to `settingsDraft.window` and `settingsDraft.overlay`;
// an older backend sends neither, and they are only added to the draft once
// something here is changed.

import { make } from "./panel_shared.js";
import { configChoice, configNumber, configPurpose, configToggle } from "./panel_settings_kit.js";
import { renderSummonField } from "./panel_settings_shortcuts.js";

export const WINDOW_DEFAULTS = { width: 1280, height: 800, remember_bounds: true };
export const OVERLAY_DEFAULTS = {
  enabled: false, edge: "top", width_pct: 100, height_pct: 50,
  always_on_top: true, hide_on_blur: true, monitor: "cursor", animate: true,
};
export const WINDOW_LIMITS = { width: [760, 16384], height: [480, 16384] };
export const SIZE_PRESETS = [[1280, 800], [1440, 900], [1600, 1000], [1920, 1080]];

export function sizePreset(width, height) {
  const found = SIZE_PRESETS.find(([w, h]) => w === width && h === height);
  return found ? `${found[0]}x${found[1]}` : "custom";
}

export function clampSize(width, height) {
  const clamp = (value, [low, high]) => Math.max(low, Math.min(high, Math.round(Number(value) || low)));
  return { width: clamp(width, WINDOW_LIMITS.width), height: clamp(height, WINDOW_LIMITS.height) };
}

// The bridge answers in pywebview's logical units, the same ones config.json
// stores. A plain browser has no bridge, and outer size is the best guess.
export async function currentWindowSize(win = globalThis.window) {
  try {
    const bounds = await win?.pywebview?.api?.window_bounds?.();
    if (bounds?.width && bounds?.height) return clampSize(bounds.width, bounds.height);
  } catch (_) { /* fall back to the document's view of it */ }
  return clampSize(win?.outerWidth, win?.outerHeight);
}

export function renderWindowSettings(host) {
  const cfg = this.settingsDraft;
  const win = { ...WINDOW_DEFAULTS, ...(cfg.window || {}) };
  const overlay = { ...OVERLAY_DEFAULTS, ...(cfg.overlay || {}) };
  const setWindow = (key, value) => {
    win[key] = value;
    cfg.window = { ...win };
  };
  const setOverlay = (key, value) => {
    overlay[key] = value;
    cfg.overlay = { ...overlay };
  };

  host.append(this._sectionHeading("Window", "How big a new window is, and how the summon shortcut shows QuickTerm."));

  const size = make("div", "settings-group");
  size.append(make("h3", "settings-group-title", "Size"));
  const grid = make("div", "settings-grid two-column");
  const width = configNumber({
    value: win.width, min: WINDOW_LIMITS.width[0], max: WINDOW_LIMITS.width[1], label: "Width",
    onChange: (value) => { setWindow("width", value); preset.set(sizePreset(win.width, win.height)); },
  });
  const height = configNumber({
    value: win.height, min: WINDOW_LIMITS.height[0], max: WINDOW_LIMITS.height[1], label: "Height",
    onChange: (value) => { setWindow("height", value); preset.set(sizePreset(win.width, win.height)); },
  });
  const widthField = this._field("Width", width, "760 to 16384 pixels");
  const heightField = this._field("Height", height, "480 to 16384 pixels");
  const showCustom = (on) => {
    widthField.hidden = !on;
    heightField.hidden = !on;
  };
  const preset = configChoice({
    label: "Default window size",
    value: sizePreset(win.width, win.height),
    options: [
      ...SIZE_PRESETS.map(([w, h]) => ({ value: `${w}x${h}`, label: `${w} × ${h}` })),
      { value: "custom", label: "Custom" },
    ],
    onChange: (value) => {
      if (value === "custom") {
        showCustom(true);
        return;
      }
      const [w, h] = value.split("x").map(Number);
      setWindow("width", w);
      setWindow("height", h);
      width.value = String(w);
      height.value = String(h);
      showCustom(false);
    },
  });
  const useCurrent = this._button("Use this window's size", "secondary-button compact");
  useCurrent.title = "Take the size of the window Settings is open in";
  useCurrent.addEventListener("click", async () => {
    const measured = await currentWindowSize();
    setWindow("width", measured.width);
    setWindow("height", measured.height);
    width.value = String(measured.width);
    height.value = String(measured.height);
    const value = sizePreset(measured.width, measured.height);
    preset.set(value);
    showCustom(value === "custom");
  });
  const presetRow = make("span", "settings-inline");
  presetRow.append(preset.el, useCurrent);
  grid.append(this._field("Default window size", presetRow, "New windows open at this size.", { id: "window.size" }), widthField, heightField);
  showCustom(sizePreset(win.width, win.height) === "custom");
  size.append(grid);
  size.append(configToggle({
    id: "window.remember_bounds",
    label: "Remember the last size and position",
    checked: win.remember_bounds,
    onChange: (checked) => setWindow("remember_bounds", checked),
  }).el);
  host.append(size);

  const drop = make("div", "settings-group");
  drop.append(
    make("h3", "settings-group-title", "Overlay"),
    configPurpose("With overlay on, the summon shortcut drops QuickTerm down from the screen edge and hides it again, like a console in a game."),
    configToggle({
      id: "overlay.enabled",
      label: "Use the drop-down overlay",
      checked: overlay.enabled,
      onChange: (checked) => setOverlay("enabled", checked),
    }).el,
  );
  const overlayGrid = make("div", "settings-grid two-column");
  const edge = configChoice({
    label: "Overlay edge",
    value: overlay.edge,
    options: [{ value: "top", label: "Top" }, { value: "bottom", label: "Bottom" }],
    onChange: (value) => setOverlay("edge", value),
  });
  const monitor = configChoice({
    label: "Overlay monitor",
    value: overlay.monitor,
    options: [
      { value: "cursor", label: "The monitor under the cursor" },
      { value: "primary", label: "The primary monitor" },
    ],
    onChange: (value) => setOverlay("monitor", value),
  });
  overlayGrid.append(
    this._field("Edge", edge.el, "", { id: "overlay.edge" }),
    this._field("Monitor", monitor.el, "", { id: "overlay.monitor" }),
    this._field("Width", configNumber({
      value: overlay.width_pct, min: 30, max: 100, label: "Overlay width in percent",
      onChange: (value) => setOverlay("width_pct", value),
    }), "Percent of the screen, 30 to 100", { id: "overlay.width_pct" }),
    this._field("Height", configNumber({
      value: overlay.height_pct, min: 20, max: 100, label: "Overlay height in percent",
      onChange: (value) => setOverlay("height_pct", value),
    }), "Percent of the screen, 20 to 100", { id: "overlay.height_pct" }),
  );
  drop.append(overlayGrid);
  for (const [id, label] of [
    ["always_on_top", "Stay on top of other windows"],
    ["hide_on_blur", "Hide when focus moves to another program"],
    ["animate", "Slide in and out"],
  ]) {
    drop.append(configToggle({
      id: `overlay.${id}`,
      label,
      checked: overlay[id],
      onChange: (checked) => setOverlay(id, checked),
    }).el);
  }
  host.append(drop);

  const summon = make("div", "settings-group");
  summon.append(make("h3", "settings-group-title", "Summon shortcut"));
  summon.append(renderSummonField.call(this, "With overlay on, the shortcut drops QuickTerm down from the screen edge."));
  host.append(summon);
}
