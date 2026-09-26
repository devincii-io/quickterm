// What the palette does with a terminal's output and lifetime beyond the
// pane commands: restart an exited terminal in place, search every
// terminal's scrollback and bring a hit into view, save a terminal's output
// to a file and open the last one saved. The returned object is spread into
// the app facade under these same names.

import { codeUnitOffset } from "./buffer_search.js";

export function createTerminalActions({ api, layout, attachSession, restartSavedPane, showError }) {
  let lastSaved = null;

  async function call(method, path) {
    const res = await fetch(path, { method, headers: { ...api.authHeaders() } });
    let payload = null;
    try { payload = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok) {
      const error = new Error(`${method} ${path} -> ${res.status}`);
      error.status = res.status;
      if (payload && payload.detail) error.detail = String(payload.detail);
      throw error;
    }
    return payload;
  }

  // Same launch as before (restartSavedPane repeats the pane's own profile,
  // launch spec, folder and launch options), never the terminal currently
  // selected in the sidebar.
  function restartTerminal(pane = layout.focused) {
    if (!pane) return Promise.resolve(null);
    if (!pane.canRestart) {
      pane.flashNotice("[this terminal is still running · nothing to restart]");
      return Promise.resolve(null);
    }
    pane.keepScreenOnNextAttach();
    return restartSavedPane(pane);
  }

  function searchTerminals(query) {
    return call("GET", `/api/search?q=${encodeURIComponent(query)}`);
  }

  function paneShowing(sessionId) {
    return layout.panes().find((pane) => pane.session?.id === sessionId) || null;
  }

  // A hit in a pane of this layout is focused and scrolled to. Anything else
  // is attached here the way the palette's "attach here" rows do it, which
  // keeps its rules: a terminal owned by another workspace is refused with a
  // pointer to "move here & attach", an exited one is not reopened.
  async function revealSearchResult(result, query) {
    const match = {
      text: result.text,
      start: result.start,
      length: [...String(query || "")].length,
      line: result.line,
    };
    let pane = paneShowing(result.session_id);
    if (!pane) {
      const sessions = await api.getSessions({ metrics: false }).catch(() => null);
      const info = sessions?.find((item) => item.id === result.session_id);
      if (!info) {
        showError(`"${result.name}" is gone, and its output went with it.`);
        return false;
      }
      if (!info.alive) {
        showError(`"${result.name}" has exited and is not open here, so there is nothing to scroll to.`);
        return false;
      }
      if (info.attachments > 0) {
        showError(`"${result.name}" is open in another window or view. Go there to see the line.`);
        return false;
      }
      if (!attachSession(info)) return false;
      pane = paneShowing(info.id);
      if (!pane) return false;
    }
    layout.focusPane(pane);
    return pane.revealWhenReady(match);
  }

  async function saveTerminalOutput() {
    const pane = layout.focused;
    if (!pane?.session) {
      if (pane) pane.flashNotice("[no terminal output to save in this pane]");
      else showError("Focus a terminal first. Its output is what gets saved.");
      return null;
    }
    try {
      const saved = await call("POST", `/api/sessions/${encodeURIComponent(pane.session.id)}/export`);
      lastSaved = saved.path;
      pane.flashNotice(`[saved to ${saved.path}]`, 6000);
      return saved.path;
    } catch (error) {
      pane.flashNotice(error.status === 404
        ? "[this terminal's output is gone, nothing was saved]"
        : `[${error.detail || "could not save the output"}]`, 6000);
      return null;
    }
  }

  function openLastSavedOutput() {
    if (!lastSaved) return Promise.resolve(false);
    return api.openTarget(lastSaved).then(
      () => true,
      (error) => {
        showError(error?.detail || `Could not open ${lastSaved}.`);
        return false;
      },
    );
  }

  return {
    restartTerminal,
    canRestartFocused: () => Boolean(layout.focused?.canRestart),
    searchTerminals,
    revealSearchResult,
    saveTerminalOutput,
    openLastSavedOutput,
    lastSavedOutput: () => lastSaved,
  };
}

// The part of a result row the user reads: the line, trimmed, with the match
// kept in view when the line is long (a palette row shows about 64
// characters before the hint). Pure, tested under node.
export function resultLabel(result, width = 64) {
  const text = String(result.text || "");
  const at = codeUnitOffset(text, result.start || 0);
  if (text.length <= width) return text.trim();
  const begin = Math.max(0, Math.min(at - Math.floor(width / 3), text.length - width));
  const cut = text.slice(begin, begin + width).trim();
  return `${begin > 0 ? "…" : ""}${cut}${begin + width < text.length ? "…" : ""}`;
}
