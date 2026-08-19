// One place decides who owns the keyboard.
//
// A pane re-asserts terminal focus asynchronously: `Pane.focusSoon()` calls
// `term.focus()` immediately, again on the next frame, and again on a zero
// timeout, because an attach/replay/split can move focus out from under it.
// That is right while the terminal is the only thing on screen and wrong the
// moment an overlay opens, since every one of those deferred calls lands
// *after* the overlay has focused its own input.
//
// It is exactly why Alt+K did not focus the palette: `togglePalette` closes any
// open panel first, panel close calls `refocusTerm()`, that schedules three
// terminal focus calls, and the palette then focuses its input synchronously —
// so the rAF and the timeout stole it straight back a frame later.
//
// Overlays claim ownership while they are open. The terminal's deferred focus
// asks first and stands down. Claims are counted per owner name, so nested or
// repeated opens (a folder browser over the dashboard) release cleanly.

const owners = new Map();

export function claimFocus(owner) {
  owners.set(owner, (owners.get(owner) || 0) + 1);
}

export function releaseFocus(owner) {
  const held = owners.get(owner) || 0;
  if (held <= 1) owners.delete(owner);
  else owners.set(owner, held - 1);
}

// True when nothing on top of the workspace wants the keyboard.
export function terminalMayFocus() {
  return owners.size === 0;
}

export function focusOwners() {
  return [...owners.keys()];
}

// Test seam: overlays are torn down between cases, the module is not.
export function resetFocusOwners() {
  owners.clear();
}
