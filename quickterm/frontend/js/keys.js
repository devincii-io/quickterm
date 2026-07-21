// Global keybindings, capture phase. QuickTerm claims only Alt combos that
// nothing running inside the terminal wants:
//   Alt+K              command palette
//   Alt+Z              zoom pane
//   Alt+W              detach pane
//   Alt+Shift+W        kill terminal process tree and close pane
//   Alt+Arrows         move focus between panes
//   Alt+Shift+H        split side by side
//   Alt+Shift+V        split top and bottom
//   Alt+Shift+Right    split to the right
//   Alt+Shift+Down     split below
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

    // Alt+Shift layer: splits, pane resizing, and font size. Font controls
    // prefer the produced character, with stable numpad and WebView fallbacks.
    if (key === "h") return done(actions.splitH);
    if (key === "v") return done(actions.splitV);
    if (key === "w") return done(actions.killSession);
    if (key === "arrowright") return done(actions.splitH);
    if (key === "arrowdown") return done(actions.splitV);

    // WebView2 differs across keyboard layouts here: the same minus gesture
    // has been observed as key "_", code "Minus", code "Slash", and
    // NumpadSubtract.  Alt+Shift is QuickTerm's reserved view namespace, so
    // accept both the produced character and the known physical-key reports.
    const reset = e.code === "Digit0" || e.code === "Numpad0";
    const smaller = key === "-" || key === "_" || e.code === "NumpadSubtract"
      || e.code === "Minus" || e.code === "Slash";
    const bigger = key === "+" || key === "*" || e.code === "NumpadAdd"
      || e.code === "Equal" || e.code === "BracketRight";
    if (reset) return done(actions.fontReset);
    if (smaller) return done(actions.fontSmaller);
    if (bigger) return done(actions.fontBigger);
  }, true);
}
