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
//   Alt+Shift+S        sidebar: full, rail, hidden
//   Alt+Shift+E        open the focused terminal's folder in Explorer
//   Alt+Shift+C        open the focused terminal's folder in VS Code
// Everything on plain Alt that shells and TUIs actually bind passes through:
// Alt+V (Claude Code image paste on Windows/WSL), Alt+P (Claude Code model
// switch), Alt+H (PSReadLine parameter help), Alt+0..9/Alt+- (readline digit
// arguments), Alt+B/F/. word motions. None of these are claimed here.
// Selection-aware Ctrl+C and native Ctrl+V are handled in pane.js. With no
// selection Ctrl+C still reaches the PTY as the terminal interrupt. The
// Ctrl+Shift+C/V aliases remain available too.

import { focusOwners } from "./focus.js";

// The one list of in-app keys. Help and the Settings Shortcuts tab render
// from it, and `bindings` (in the hotkey grammar of shortcut_input.js) is what
// initKeys claims, so a global shortcut on one of them can be warned about.
// Rows with no bindings are handled by the pane, not by this layer.
const arrows = (prefix) => ["left", "right", "up", "down"].map((key) => `${prefix}+${key}`);
export const SHORTCUTS = [
  { id: "palette", keys: "Alt+K", label: "Open the command palette", group: "Panels", bindings: ["alt+k"] },
  { id: "dashboard", keys: "Alt+G", label: "Dashboard", group: "Panels", bindings: ["alt+g"] },
  { id: "settings", keys: "Alt+S", label: "Settings", group: "Panels", bindings: ["alt+s"] },
  { id: "help", keys: "Alt+I", label: "Quick guide", group: "Panels", bindings: ["alt+i"] },
  { id: "new-terminal", keys: "Alt+N", label: "New default terminal", group: "Terminals", bindings: ["alt+n"] },
  { id: "zoom", keys: "Alt+Z", label: "Zoom the focused pane; again shows all panes", group: "Terminals", bindings: ["alt+z"] },
  { id: "detach", keys: "Alt+D", label: "Detach the pane; the process keeps running", group: "Terminals", bindings: ["alt+d"] },
  { id: "kill", keys: "Alt+W", label: "Arm the kill bar; Alt+W or Enter again kills, Escape cancels", group: "Terminals", bindings: ["alt+w"] },
  { id: "focus", keys: "Alt+Arrows", label: "Move between panes", group: "Panes", bindings: arrows("alt") },
  { id: "split-right", keys: "Alt+Shift+→ or Alt+Shift+H", label: "Split the selected terminal to the right", group: "Panes", bindings: ["alt+shift+right", "alt+shift+h"] },
  { id: "split-down", keys: "Alt+Shift+↓ or Alt+Shift+V", label: "Split the selected terminal below", group: "Panes", bindings: ["alt+shift+down", "alt+shift+v"] },
  { id: "cycle-terminal", keys: "Alt+Shift+← / ↑", label: "Previous / next new-terminal choice", group: "Panes", bindings: ["alt+shift+left", "alt+shift+up"] },
  { id: "sidebar", keys: "Alt+Shift+S", label: "Sidebar: full, rail, hidden", group: "Window", bindings: ["alt+shift+s"] },
  { id: "explorer", keys: "Alt+Shift+E", label: "Open the focused terminal's folder in Explorer", group: "Window", bindings: ["alt+shift+e"] },
  { id: "editor", keys: "Alt+Shift+C", label: "Open the focused terminal's folder in VS Code", group: "Window", bindings: ["alt+shift+c"] },
  { id: "font-bigger", keys: "Ctrl++", label: "Bigger terminal text", group: "Text", bindings: ["ctrl+equal", "ctrl+shift+equal"] },
  { id: "font-smaller", keys: "Ctrl+-", label: "Smaller terminal text", group: "Text", bindings: ["ctrl+minus"] },
  { id: "font-reset", keys: "Ctrl+0", label: "Reset terminal text size", group: "Text", bindings: ["ctrl+0"] },
  { id: "copy", keys: "Ctrl+C", label: "Copy the selection; without one it interrupts", group: "Text", bindings: [] },
  { id: "paste", keys: "Ctrl+V", label: "Paste into the terminal", group: "Text", bindings: [] },
];

// Plain Alt keys that shells and agents bind (AGENTS.md). initKeys never
// claims them, and a global shortcut on one takes it from every terminal.
export const PASS_THROUGH_ALT = ["v", "p", "h", "b", "f", "minus", ..."0123456789"];

export function initKeys(actions) {
  window.addEventListener("keydown", (e) => {
    // A shortcut field is recording (shortcut_input.js). Its own capture
    // listener is registered after this one, so this layer has to step aside
    // or Alt+S would close Settings instead of being recorded.
    if (focusOwners().includes("shortcut")) return;
    // Windows-style text zoom. Use both key and code because WebView2 reports
    // the shifted plus key differently across keyboard layouts. Claim only
    // these exact Ctrl gestures; Ctrl+Alt and Meta combinations stay untouched.
    // Never match a physical code whose produced character is not +/-/0:
    // "Slash" and "BracketRight" are the QWERTZ positions of -/+ (already
    // covered by the e.key tests) but are Ctrl+/ and Ctrl+] on ANSI layouts,
    // where readline undo and the vim tag jump must reach the shell.
    // The same holds for the US positions: Ctrl+Shift+- is "_" on the Minus
    // key, which is readline's undo, and Ctrl+Shift+8 is "*". So a code only
    // stands in when the layout did not say which character it produced; the
    // two numpad operators always produce + and -, so they need no guard.
    // Numpad0 is guarded too: with NumLock off it is Insert, and Ctrl+Insert
    // is copy.
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const key = e.key.toLowerCase();
      const unnamed = !e.key || e.key === "Unidentified";
      // AZERTY types "a" with a grave accent on the 0 key unshifted (0 needs
      // Shift there); Ctrl+0 on that key was the reset before and no shell
      // binds Ctrl+that letter.
      const reset = key === "0"
        || (unnamed && (e.code === "Digit0" || e.code === "Numpad0"))
        || (e.code === "Digit0" && !e.shiftKey && key === "à");
      const smaller = key === "-" || e.code === "NumpadSubtract"
        || (unnamed && e.code === "Minus");
      // "=" counts only on the key whose shifted character is "+" (US and
      // AZERTY); on QWERTZ it is Shift+0.
      const bigger = key === "+" || (key === "=" && e.code === "Equal")
        || e.code === "NumpadAdd" || (unnamed && e.code === "Equal");
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

    // Alt+K toggles the palette even while it is already open. The panel keys
    // sit here for the same reason: a shortcut that opens a panel but cannot
    // close it again is not a toggle, and the user would have to reach for the
    // mouse to undo their own keystroke.
    if (!e.shiftKey && key === "k") return done(actions.togglePalette);
    if (!e.shiftKey && key === "g") return done(actions.toggleDashboard);
    if (!e.shiftKey && key === "s") return done(actions.toggleSettings);
    if (!e.shiftKey && key === "i") return done(actions.toggleHelp);
    // A kill confirmation that takes Alt+W completes on it (the sidebar's,
    // like a pane's kill bar); it is checked before the overlay stand-down.
    if (!e.shiftKey && key === "w" && actions.acceptKill?.()) return done(() => {});
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

    // Alt+Shift layer: splits, the terminal choice, and the sidebar.
    if (key === "h") return done(actions.splitH);
    if (key === "v") return done(actions.splitV);
    // Alt+Shift+S cycles the sidebar: full, rail, hidden. Plain Alt+B is
    // readline's backward-word and Ctrl+B the tmux prefix, so neither is
    // ours to take.
    if (key === "s") return done(actions.toggleSidebar);
    // The focused terminal's folder, in Explorer or VS Code. Plain Alt+C is
    // readline's capitalize-word, so both live on the Shift layer with the
    // splits; Alt+Shift+E pairs with Win+E, which is Explorer too.
    if (key === "e") return done(actions.openExplorer);
    if (key === "c") return done(actions.openEditor);
    if (key === "arrowleft") return done(() => actions.cycleTerminal(-1));
    if (key === "arrowup") return done(() => actions.cycleTerminal(1));
    if (key === "arrowright") return done(actions.splitH);
    if (key === "arrowdown") return done(actions.splitV);

  }, true);
}
