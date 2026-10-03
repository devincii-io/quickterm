// The two things the window says outside a pane: the #app-error banner, which
// is the one visible failure path, and the sidebar's save dot.

const $ = (id) => document.getElementById(id);

// #sb-save is the save dot on the shell sidebar's active workspace group:
// data-state drives the colour, the title carries the words. It is the
// saving/saved lifecycle and nothing else, so it is the wrong place for
// anything the user has to act on. Only the active view's saves reach it;
// the shell itself saves nothing and writes it only on a view's behalf
// (`shared`).
export function setWorkspaceSaveState(text, state = "", shared = false) {
  if (typeof window !== "undefined" && window.parent !== window) {
    const host = window.parent.quicktermViews;
    if (host?.active === host?.viewFor(window)) return window.parent.quicktermChrome?.saveState(text, state);
    return;
  }
  if (!shared) return;
  const status = $("sb-save");
  if (!status) return;
  const key = state || text;
  status.title = text;
  if (key) status.dataset.state = key;
  else delete status.dataset.state;
}

// The single visible failure path: a dismissible banner above the status
// bar, drawn over the panel overlay so a Dashboard/Settings gesture that
// fails is still readable.
export function showError(text) {
  if (typeof window !== "undefined" && window.parent !== window && window.parent.quicktermChrome) {
    window.parent.quicktermChrome.showError(text);
    return;
  }
  const banner = $("app-error");
  const body = $("app-error-text");
  if (!banner || !body) return;
  body.textContent = text;
  banner.hidden = false;
  const live = $("live-status");
  if (live) live.textContent = text;
}

export function clearError() {
  if (typeof window !== "undefined" && window.parent !== window && window.parent.quicktermChrome) {
    window.parent.quicktermChrome.clearError();
    return;
  }
  const banner = $("app-error");
  if (banner) banner.hidden = true;
}
