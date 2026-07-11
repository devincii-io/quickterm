// Global keybindings, capture phase. The UI only ever claims combos that
// terminals do not use, following the Windows Terminal / VS Code convention
// of keeping UI chrome on the Ctrl+Shift / Alt+Shift layer:
//   Ctrl+Shift+P  command palette
//   Alt+Shift+H   split side by side
//   Alt+Shift+V   split top and bottom
//   Alt+Shift+Z   zoom pane
//   Alt+Shift+W   close pane
//   Alt+Arrows    move focus between panes
//   Ctrl+Shift++/-/0  grow / shrink / reset terminal text size
// Everything else (Ctrl+P, Alt+letter readline metas, Ctrl+C, ...) reaches
// the terminal untouched. Ctrl+Shift+C/V copy/paste is handled inside the
// terminal itself (pane.js) so it only applies when a terminal is focused.
// Note: Ctrl+W / Ctrl+Shift+W are browser-reserved and cannot be intercepted,
// which is why close-pane lives on Alt+Shift+W.

export function initKeys(actions) {
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      e.stopPropagation();
      actions.togglePalette();
      return;
    }
    if (actions.paletteOpen()) return; // palette/panel input owns the keyboard

    // Ctrl+Shift +/-/0 resizes the terminal text (browser zoom stays on Ctrl+/-).
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
      const font = {
        "+": actions.fontBigger, "=": actions.fontBigger,
        "-": actions.fontSmaller, _: actions.fontSmaller,
        "0": actions.fontReset, ")": actions.fontReset,
      };
      const handler = font[e.key];
      if (handler) {
        e.preventDefault();
        e.stopPropagation();
        handler();
        return;
      }
    }

    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const key = e.key.toLowerCase();
      const arrows = {
        arrowleft: () => actions.focusDir("left"),
        arrowright: () => actions.focusDir("right"),
        arrowup: () => actions.focusDir("up"),
        arrowdown: () => actions.focusDir("down"),
      };
      if (!e.shiftKey && arrows[key]) {
        e.preventDefault();
        e.stopPropagation();
        arrows[key]();
        return;
      }
      const shifted = {
        h: actions.splitH,
        v: actions.splitV,
        z: actions.zoom,
        w: actions.closePane,
      };
      if (e.shiftKey && shifted[key]) {
        e.preventDefault();
        e.stopPropagation();
        shifted[key]();
      }
    }
  }, true);
}
