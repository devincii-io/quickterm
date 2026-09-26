// Terminal text size: the saved default every pane starts with, and the
// focused pane's own size that Ctrl+plus/minus/0 change.

const MIN_FONT = 9;
const MAX_FONT = 30;
export const DEFAULT_FONT = 14;
export const clampFont = (px) => Math.max(MIN_FONT, Math.min(MAX_FONT, Math.round(px || DEFAULT_FONT)));

export function createFontSize({ api, state, layout }) {
  let fontSize = clampFont(state.cfg.font_size);
  let fontSaveTimer = null;

  // Terminal text size: applied live to every pane, persisted to config so it
  // survives restarts and shows up in Settings. Saving is debounced so holding
  // the shortcut does not spam the backend.
  function persistFontSize() {
    clearTimeout(fontSaveTimer);
    fontSaveTimer = setTimeout(() => {
      api.getFullConfig().then((full) => {
        if (!full) return;
        full.font_size = fontSize;
        state.cfg.font_size = fontSize;
        return api.putConfig(full);
      }).catch(() => {});
    }, 700);
  }

  function setFontSize(px, persist = true) {
    const next = clampFont(px);
    if (next === fontSize && persist) return;
    fontSize = next;
    layout.setFontSize(fontSize);
    if (persist) persistFontSize();
  }

  // Ctrl+± changes the focused pane only and Ctrl+0 puts it back on the saved
  // default; Settings changes that default for every pane. Pane-first is the
  // least surprising: changing text size in one terminal should not reflow
  // every other running terminal.
  function scopedFontSize() {
    return layout.focused ? layout.focused.fontSize : fontSize;
  }

  function setScopedFontSize(px) {
    const next = clampFont(px);
    if (layout.focused) {
      layout.focused.setFontSize(next);
      layout.focused.flashNotice(`[font ${next}px]`);
      return;
    }
    setFontSize(next);
  }

  function resetScopedFontSize() {
    setScopedFontSize(fontSize);
  }

  return {
    setFontSize,
    fontSize: () => fontSize,
    scopedFontSize,
    setScopedFontSize,
    resetScopedFontSize,
  };
}
