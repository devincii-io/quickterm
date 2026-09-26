// The two things the window says outside a pane: the #app-error banner, which
// is the one visible failure path, and the sidebar's save dot.

const $ = (id) => document.getElementById(id);

// #sb-save owns the saving/saved lifecycle only. It is a 9 px span that
// collapses when empty and disappears under the panel overlay, so it is the
// wrong place for anything the user has to act on.
// #sb-save is the save dot on the sidebar's workspace row: data-state drives
// the colour, the title carries the words. It is the saving/saved lifecycle
// and nothing else.
export function setWorkspaceSaveState(text, state = "") {
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
  const banner = $("app-error");
  const body = $("app-error-text");
  if (!banner || !body) return;
  body.textContent = text;
  banner.hidden = false;
  const live = $("live-status");
  if (live) live.textContent = text;
}

export function clearError() {
  const banner = $("app-error");
  if (banner) banner.hidden = true;
}
