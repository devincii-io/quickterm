// Global keybindings, capture phase. QuickTerm claims only Alt combos that
// nothing running inside the terminal wants:
//   Alt+K              command palette
//   Alt+Z              zoom pane
//   Alt+W              close pane
//   Alt+Arrows         move focus between panes
//   Alt+Shift+H        split side by side
//   Alt+Shift+V        split top and bottom
//   Alt+Shift++/-/0    grow / shrink / reset terminal text size
// Everything on plain Alt that shells and TUIs actually bind passes through:
// Alt+V (Claude Code image paste on Windows/WSL), Alt+P (Claude Code model
// switch), Alt+H (PSReadLine parameter help), Alt+0..9/Alt+- (readline digit
// arguments), Alt+B/F/D/. word motions — none of these are claimed here.
// Copy and paste stay on Ctrl+Shift+C/V (handled in pane.js) because Ctrl+C
// is the terminal's interrupt and must never be reused for the UI.

export function initKeys(actions) {
  window.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return; // Alt-only layer

    const key = e.key.toLowerCase();
    const done = (handler) => {
      e.preventDefault();
      e.stopPropagation();
      handler();
    };

    // Alt+K toggles the palette even while it is already open.
    if (!e.shiftKey && key === "k") return done(actions.togglePalette);
    if (actions.paletteOpen()) return; // palette/panel input owns the keyboard

    if (!e.shiftKey) {
      const plain = {
        arrowleft: () => actions.focusDir("left"),
        arrowright: () => actions.focusDir("right"),
        arrowup: () => actions.focusDir("up"),
        arrowdown: () => actions.focusDir("down"),
        z: actions.zoom,
        w: actions.closePane,
      };
      if (plain[key]) done(plain[key]);
      return;
    }

    // Alt+Shift layer: splits and font size. Letters match by e.key; the
    // font keys match by physical key (e.code) so Shift'ed punctuation works
    // on any keyboard layout (German Shift+'+' is '*', etc.).
    if (key === "h") return done(actions.splitH);
    if (key === "v") return done(actions.splitV);
    if (e.code === "Digit0" || e.code === "Numpad0") return done(actions.fontReset);
    if (e.code === "Minus" || e.code === "NumpadSubtract") return done(actions.fontSmaller);
    if (e.code === "Equal" || e.code === "BracketRight" || e.code === "NumpadAdd") return done(actions.fontBigger);
  }, true);
}
