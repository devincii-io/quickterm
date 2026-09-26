// Keeping this window in step with the config: re-reading it after Settings
// saves, previewing a theme without saving it, reporting a background launch
// failure, and replacing the cached shell inventory once a fresh scan lands.

import { embedded, saveInventoryCache } from "./boot_context.js";
import { applyChromeTheme, getTheme } from "./themes.js";

const $ = (id) => document.getElementById(id);

export function createConfigSync({ api, state, app, layout, setFontSize, buildLauncher, showError }) {
  // Autostart and global-hotkey launches run in the backend with no pane to
  // report into, so app.py keeps the latest failure on the config as
  // `launch_error`. It is shown once when it first appears and again only
  // when it changes, and only by the primary top-level window: every
  // workspace view and every second window reads the same config.
  // A banner already up (a refused workspace claim at boot) keeps its text.
  let shownLaunchError = null;
  function reportLaunchError(value) {
    const text = typeof value === "string" && value.trim() ? value : null;
    if (text && text !== shownLaunchError && !embedded && state.windowIsPrimary) {
      const banner = $("app-error");
      const current = banner && !banner.hidden ? $("app-error-text")?.textContent : "";
      showError(current ? `${current} ${text}` : text);
    }
    shownLaunchError = text;
  }

  // A global hotkey launches while this window is in the background, and its
  // failure only lands on the config. Look again when the user comes back to
  // the window instead of polling the whole config every few seconds.
  let launchErrorCheckedAt = 0;
  function checkLaunchError() {
    if (embedded || !state.windowIsPrimary || Date.now() - launchErrorCheckedAt < 5000) return;
    launchErrorCheckedAt = Date.now();
    api.getConfig().then((fresh) => reportLaunchError(fresh && fresh.launch_error)).catch(() => {});
  }

  async function onConfigSaved() {
    const [fresh, freshInventory] = await Promise.all([
      api.getConfig().catch(() => null),
      api.getTerminalOptions().catch(() => state.terminalInventory),
    ]);
    if (!fresh) return;
    state.cfg = fresh;
    reportLaunchError(fresh.launch_error);
    state.scratchRoot = fresh.scratch_dir || state.scratchRoot;
    state.profiles = fresh.profiles || [];
    state.snippets = fresh.snippets || [];
    state.terminalInventory = saveInventoryCache(freshInventory);
    app.profiles = state.profiles;
    app.snippets = state.snippets;
    app.idleTimeoutSeconds = fresh.idle_timeout_s ?? 300;
    applyChromeTheme(fresh.theme, fresh.custom_theme);
    layout.setTheme(getTheme(fresh.theme, fresh.custom_theme).xterm);
    layout.setFontFamily(fresh.font_family || "JetBrains Mono");
    setFontSize(fresh.font_size, false);
    buildLauncher();
  }

  // Live theme preview: apply the chrome and every terminal's colors instantly
  // (Settings calls this the moment you click a theme) without persisting.
  // Reverting is just re-applying the committed config theme, which is what
  // appliedTheme() reports.
  function previewTheme(themeId, custom) {
    applyChromeTheme(themeId, custom || {});
    layout.setTheme(getTheme(themeId, custom || {}).xterm);
  }

  function appliedTheme() {
    return { theme: state.cfg.theme, custom_theme: state.cfg.custom_theme || {} };
  }

  // Boot drew the sidebar from the inventory cached in localStorage; once the
  // first terminal is up, a fresh scan replaces it if anything changed.
  function refreshCachedInventory() {
    setTimeout(() => {
      api.getTerminalOptions().then((fresh) => {
        if (JSON.stringify(fresh) === JSON.stringify(state.terminalInventory)) return;
        state.terminalInventory = saveInventoryCache(fresh);
        buildLauncher();
      }).catch(() => {});
    }, 1500);
  }

  return {
    reportLaunchError,
    checkLaunchError,
    onConfigSaved,
    previewTheme,
    appliedTheme,
    refreshCachedInventory,
  };
}
