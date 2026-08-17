// Global keybindings, capture phase. QuickTerm follows Windows conventions
// for terminal text size, then claims only Alt combos that nothing running
// inside the terminal wants:
//   Ctrl++/-/0         grow / shrink / reset terminal text size
//   Alt+K              command palette
//   Alt+N              new default terminal
//   Alt+Z              zoom pane
//   Alt+D              detach pane; process keeps running
//   Alt+W              confirm kill terminal process tree and close pane
//   Alt+Arrows         move focus between panes
//   Alt+Shift+H        split side by side
//   Alt+Shift+V        split top and bottom
//   Alt+Shift+Right    split to the right
//   Alt+Shift+Down     split below
//   Alt+Shift+Left/Up  previous / next new-terminal profile
// Everything on plain Alt that shells and TUIs actually bind passes through:
// Alt+V (Claude Code image paste on Windows/WSL), Alt+P (Claude Code model
// switch), Alt+H (PSReadLine parameter help), Alt+0..9/Alt+- (readline digit
// arguments), Alt+B/F/. word motions — none of these are claimed here.
// Selection-aware Ctrl+C and native Ctrl+V are handled in pane.js. With no
// selection Ctrl+C still reaches the PTY as the terminal interrupt. The
// Ctrl+Shift+C/V aliases remain available too.

export function initKeys(actions) {
  window.addEventListener("keydown", (e) => {
    // Windows-style text zoom. Use both key and code because WebView2 reports
    // the shifted plus key differently across keyboard layouts. Claim only
    // these exact Ctrl gestures; Ctrl+Alt and Meta combinations stay untouched.
    // Never match a physical code whose produced character is not +/-/0:
    // "Slash" and "BracketRight" are the QWERTZ positions of -/+ (already
    // covered by the e.key tests) but are Ctrl+/ and Ctrl+] on ANSI layouts,
    // where readline undo and the vim tag jump must reach the shell.
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const key = e.key.toLowerCase();
      const reset = key === "0" || e.code === "Digit0" || e.code === "Numpad0";
      const smaller = key === "-" || key === "_" || e.code === "Minus"
        || e.code === "NumpadSubtract";
      const bigger = key === "+" || key === "=" || key === "*"
        || e.code === "Equal" || e.code === "NumpadAdd";
      if (reset || smaller || bigger) {
        e.preventDefault();
        e.stopPropagation();
        if (reset) actions.fontReset();
        else if (smaller) actions.fontSmaller();
        else actions.fontBigger();
        return;
      }
    }

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
        n: actions.newTerminal,
        z: actions.zoom,
        d: actions.closePane,
        w: actions.killSession,
      };
      if (plain[key]) done(plain[key]);
      return;
    }

    // Alt+Shift layer: splits and pane resizing.
    if (key === "h") return done(actions.splitH);
    if (key === "v") return done(actions.splitV);
    if (key === "arrowleft") return done(() => actions.cycleTerminal(-1));
    if (key === "arrowup") return done(() => actions.cycleTerminal(1));
    if (key === "arrowright") return done(actions.splitH);
    if (key === "arrowdown") return done(actions.splitV);

  }, true);
}
