// Global keybindings, capture phase. QuickTerm keeps its whole UI on a single
// modifier — Alt — so every shortcut is just two keys:
//   Alt+P        command palette
//   Alt+H        split side by side
//   Alt+V        split top and bottom
//   Alt+Z        zoom pane
//   Alt+W        close pane
//   Alt+Arrows   move focus between panes
//   Alt++/-/0    grow / shrink / reset terminal text size
// These particular Alt combos are not bound by PowerShell/PSReadLine or bash
// readline, and they are caught here (capture phase) before the terminal, so
// only the combos above are claimed. Everything else — Ctrl+C, Ctrl+P, the
// Alt+B/F/D word motions, ... — reaches the shell untouched. Copy and paste
// stay on Ctrl+Shift+C/V (handled in pane.js) because Ctrl+C is the terminal's
// interrupt and must never be reused for the UI.

export function initKeys(actions) {
  window.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return; // Alt-only layer
    const key = e.key.toLowerCase();

    // Alt+P toggles the palette even while it is already open.
    if (!e.shiftKey && key === "p") {
      e.preventDefault();
      e.stopPropagation();
      actions.togglePalette();
      return;
    }
    if (actions.paletteOpen()) return; // palette/panel input owns the keyboard

    const arrows = {
      arrowleft: () => actions.focusDir("left"),
      arrowright: () => actions.focusDir("right"),
      arrowup: () => actions.focusDir("up"),
      arrowdown: () => actions.focusDir("down"),
    };
    const commands = {
      h: actions.splitH,
      v: actions.splitV,
      z: actions.zoom,
      w: actions.closePane,
      "+": actions.fontBigger, "=": actions.fontBigger,
      "-": actions.fontSmaller, _: actions.fontSmaller,
      "0": actions.fontReset, ")": actions.fontReset,
    };
    const handler = (!e.shiftKey && arrows[key]) || commands[key];
    if (handler) {
      e.preventDefault();
      e.stopPropagation();
      handler();
    }
  }, true);
}
