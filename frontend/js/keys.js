// Global keybindings, capture phase, exact combos only so the terminal
// keeps every other key: Ctrl+P palette, Alt+H/V split, Alt+Z zoom,
// Alt+W close pane, Alt+arrows focus move.

export function initKeys(actions) {
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      e.stopPropagation();
      actions.togglePalette();
      return;
    }
    if (actions.paletteOpen()) return; // palette input owns the keyboard
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const map = {
      h: actions.splitH,
      v: actions.splitV,
      z: actions.zoom,
      w: actions.closePane,
      arrowleft: () => actions.focusDir("left"),
      arrowright: () => actions.focusDir("right"),
      arrowup: () => actions.focusDir("up"),
      arrowdown: () => actions.focusDir("down"),
    };
    const fn = map[e.key.toLowerCase()];
    if (fn) {
      e.preventDefault();
      e.stopPropagation();
      fn();
    }
  }, true);
}
