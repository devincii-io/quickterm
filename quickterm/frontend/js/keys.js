// Global keybindings, capture phase. QuickTerm follows Windows conventions
// for terminal text size, then claims only Alt combos that nothing running
// inside the terminal wants:
//   Ctrl++/-/0         grow / shrink / reset terminal text size
//   Alt+K              command palette
//   Alt+N              new default terminal
//   Alt+Z              zoom pane
//   Alt+D              detach pane; process keeps running
//   Alt+W              confirm kill terminal process tree and close pane
//   Alt+J              jump to the next terminal that needs you, cycling
//                      (no readline, PSReadLine, zsh, fish or agent CLI
//                      default binds plain Alt+J)
//   Alt+Arrows         move focus between panes
//   Alt+Shift+H        split side by side
//   Alt+Shift+V        split top and bottom
//   Alt+Shift+Right    split to the right
//   Alt+Shift+Down     split below
//   Alt+Shift+Left/Up  open the new-terminal menu
//   Alt+Shift+S        sidebar: full, rail, hidden
//   Alt+Shift+E        right panel: files, changes, pull request
//   Alt+Shift+C        open the focused terminal's folder in VS Code
//   Ctrl+Shift+1..9    show the nth workspace in the sidebar (by `code`, so
//                      the shifted symbol of the layout does not matter)
//   Alt+PgDn / PgUp    next / previous open workspace
//   Ctrl+Tab           recent terminals: Tab / Shift+Tab move while Ctrl is
//                      held, releasing Ctrl shows the chosen one
// Ctrl+Shift+F (find in the terminal) is the pane's own, in pane.js.
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
  { id: "dashboard", keys: "Alt+G", label: "Workspace board", group: "Panels", bindings: ["alt+g"] },
  { id: "settings", keys: "Alt+S", label: "Settings", group: "Panels", bindings: ["alt+s"] },
  { id: "help", keys: "Alt+I", label: "Quick guide", group: "Panels", bindings: ["alt+i"] },
  { id: "new-terminal", keys: "Alt+N", label: "New default terminal", group: "Terminals", bindings: ["alt+n"] },
  { id: "zoom", keys: "Alt+Z", label: "Zoom the focused pane; again shows all panes", group: "Terminals", bindings: ["alt+z"] },
  { id: "detach", keys: "Alt+D", label: "Detach the pane; the process keeps running", group: "Terminals", bindings: ["alt+d"] },
  { id: "kill", keys: "Alt+W", label: "Arm the kill bar; Alt+W or Enter again kills, Escape cancels", group: "Terminals", bindings: ["alt+w"] },
  { id: "needs-you", keys: "Alt+J", label: "Jump to the next terminal that needs you: waiting, ringing, or a finished agent turn", group: "Terminals", bindings: ["alt+j"] },
  { id: "recent", keys: "Ctrl+Tab", label: "Recent terminals: hold Ctrl, Tab or Shift+Tab moves, releasing Ctrl shows it; a tap flips between the last two", group: "Terminals", bindings: ["ctrl+tab", "ctrl+shift+tab"] },
  { id: "find", keys: "Ctrl+Shift+F", label: "Find in the terminal: Enter next, Shift+Enter previous, Alt+C case, Alt+R regex", group: "Terminals", bindings: [] },
  { id: "focus", keys: "Alt+Arrows", label: "Move between panes", group: "Panes", bindings: arrows("alt") },
  { id: "split-right", keys: "Alt+Shift+→ or Alt+Shift+H", label: "Split the selected terminal to the right", group: "Panes", bindings: ["alt+shift+right", "alt+shift+h"] },
  { id: "split-down", keys: "Alt+Shift+↓ or Alt+Shift+V", label: "Split the selected terminal below", group: "Panes", bindings: ["alt+shift+down", "alt+shift+v"] },
  { id: "cycle-terminal", keys: "Alt+Shift+← / ↑", label: "Open the new-terminal menu (what + starts)", group: "Panes", bindings: ["alt+shift+left", "alt+shift+up"] },
  { id: "sidebar", keys: "Alt+Shift+S", label: "Sidebar: full, rail, hidden", group: "Window", bindings: ["alt+shift+s"] },
  { id: "workspace-n", keys: "Ctrl+Shift+1…9", label: "Show the first to ninth workspace in the sidebar", group: "Window", bindings: [..."123456789"].map((digit) => `ctrl+shift+${digit}`) },
  { id: "workspace-cycle", keys: "Alt+PgDn / Alt+PgUp", label: "Next / previous open workspace", group: "Window", bindings: ["alt+pagedown", "alt+pageup"] },
  { id: "right-panel", keys: "Alt+Shift+E", label: "Right panel: files, changes, pull request", group: "Window", bindings: ["alt+shift+e"] },
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

// The workspace keys and the recent-terminals list belong to the window, not
// to one workspace view. The shell passes them to initKeys; a view document
// that does not reaches them through the shell (`quicktermChrome.windowKeys`).
function windowAction(actions, name) {
  if (typeof actions[name] === "function") return actions[name];
  try {
    const host = typeof window !== "undefined" && window.parent && window.parent !== window ? window.parent : null;
    const action = host?.quicktermChrome?.windowKeys?.[name];
    return typeof action === "function" ? action : null;
  } catch (_) {
    return null;
  }
}

// Ctrl+Shift+1..9 by physical key: the layout's shifted symbol ("!", "\"",
// "§") says nothing about which digit was meant. 0 if it is not one.
// Not Alt+Shift: on US layouts those are readline's M-! M-@ M-$ completion
// bindings. Not Ctrl+Alt: that is AltGr, which types { [ ] } on QWERTZ.
// Ctrl+Shift+digit costs little: on US layouts Ctrl+Shift+2 is Ctrl+@
// (NUL, readline's set-mark), which Ctrl+Space sends as well. Where the
// layout makes the key a plus sign (Swiss German Ctrl+Shift+1), it stays
// the text zoom: zooming was there first.
export function workspaceDigit(e) {
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return 0;
  if (e.key === "+") return 0;
  const match = /^Digit([1-9])$/.exec(e.code || "");
  return match ? Number(match[1]) : 0;
}

export function initKeys(actions) {
  // Releasing Ctrl ends the Ctrl+Tab list. The list moves the keyboard into
  // the shell document, but the release may still land in the view it came
  // from, so every document forwards it.
  window.addEventListener("keyup", (e) => {
    if (e.key === "Control") windowAction(actions, "ctrlReleased")?.();
  }, true);
  window.addEventListener("keydown", (e) => {
    // A shortcut field is recording (shortcut_input.js). Its own capture
    // listener is registered after this one, so this layer has to step aside
    // or Alt+S would close Settings instead of being recorded.
    if (focusOwners().includes("shortcut")) return;
    // Ctrl+Tab and Ctrl+Shift+Tab: the recent terminals. A tab character
    // typed with Ctrl means nothing to a shell, so nothing is taken from it.
    if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "Tab" || e.code === "Tab")) {
      const step = windowAction(actions, "recentTerminals");
      if (step && step(e.shiftKey ? -1 : 1) !== false) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
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
      // The nth workspace in the sidebar; it belongs to the window, like
      // Alt+PgUp/PgDn, and stands down while the palette has the keyboard.
      const digit = workspaceDigit(e);
      if (digit) {
        if (actions.paletteOpen()) return;
        const show = windowAction(actions, "showWorkspace");
        if (show) {
          e.preventDefault();
          e.stopPropagation();
          show(digit);
        }
        return;
      }
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
    // The right panel and its file view hold the keyboard while in use, and
    // the key that opened the panel must also close it from there. It belongs
    // to the window, like the workspace keys. Explorer stays in the palette
    // and on the sidebar's folder button.
    if (e.shiftKey && key === "e") {
      const toggle = windowAction(actions, "toggleRightPanel");
      if (toggle) done(toggle);
      return;
    }
    if (actions.paletteOpen()) return; // palette/panel input owns the keyboard

    // The next and previous open workspace. No shell or agent binds
    // Alt+PgUp/PgDn; plain Alt+digit stays readline's digit argument.
    const cycle = !e.shiftKey && (key === "pagedown" ? 1 : key === "pageup" ? -1 : 0);
    if (cycle) {
      const action = windowAction(actions, "cycleWorkspace");
      if (action) done(() => action(cycle));
      return;
    }

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
        // Reaches the terminal when no jump is wired in this document.
        j: actions.nextNeedsYou,
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
    // The focused terminal's folder in VS Code. Plain Alt+C is readline's
    // capitalize-word, so it lives on the Shift layer with the splits.
    if (key === "c") return done(actions.openEditor);
    if (key === "arrowleft") return done(() => actions.cycleTerminal(-1));
    if (key === "arrowup") return done(() => actions.cycleTerminal(1));
    if (key === "arrowright") return done(actions.splitH);
    if (key === "arrowdown") return done(actions.splitV);

  }, true);
}
