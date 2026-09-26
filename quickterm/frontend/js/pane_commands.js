// What the keyboard, the palette and the pane header do to the focused pane:
// split, new terminal, zoom, rename, detach (retain, never kill), the
// confirmed kill, kill-all, snippets, and handing the keyboard back. The
// returned object is spread into the app facade under these same names.

import { broadcastNotice, broadcastTargets } from "./broadcast.js";
import { terminalMayFocus } from "./focus.js";
import { displaySnippet, sessionAlreadyGone } from "./panel_shared.js";

export function createPaneCommands({
  api, state, layout,
  spawnSplitInto, spawnDefaultInto, forgetSession, ensureScratchWorkspace,
  removeSessionsFromSavedWorkspaces, scheduleWorkspaceSave, refreshStatusSoon, showError,
}) {
  return {
    splitH: () => {
      const source = layout.focused;
      const pane = layout.splitFocused("h");
      if (pane) spawnSplitInto(pane, source);
    },
    splitV: () => {
      const source = layout.focused;
      const pane = layout.splitFocused("v");
      if (pane) spawnSplitInto(pane, source);
    },
    newTerminal: () => {
      let pane = layout.focused || layout.init();
      if (!pane.canReplace) pane = layout.splitPane(pane, layout.autoDir(pane));
      if (pane) spawnDefaultInto(pane);
    },
    // Renaming from the sidebar row; a pane showing the terminal takes the
    // new name too, and the workspace autosaves it like a header rename.
    renameSession: async (sessionId, name) => {
      let info = null;
      try {
        info = await api.renameSession(sessionId, name);
      } catch (error) {
        showError(error.detail || "rename failed");
        return;
      }
      const pane = layout.panes().find((item) => item.session?.id === sessionId);
      if (pane) pane.setTitle(name, info);
      refreshStatusSoon();
    },
    cycleTerminal: (delta) => {
      const choice = state.launcherView?.cycleTerminal(delta);
      if (choice) layout.focused?.flashNotice(`[new terminal: ${choice.label}]`);
      return choice;
    },
    zoom: () => layout.toggleZoom(),
    isZoomed: () => layout.zoomed,
    // Broadcast input to every live pane of this document; the layout owns
    // the switch and turns it off on its own when a workspace is restored.
    // Said once, with the count, because the accent outline alone does not
    // say how far a keystroke goes.
    toggleBroadcast: () => {
      const on = layout.setBroadcast(!layout.broadcasting);
      const pane = layout.focused;
      if (pane) {
        const others = on ? broadcastTargets(layout.panes(), pane).length : 0;
        pane.flashNotice(broadcastNotice(on, others), on ? 4000 : 2000);
      }
      return on;
    },
    isBroadcasting: () => layout.broadcasting,
    // D/Alt+D is a true detach: retain the process first, then remove only its
    // viewer. It must never share the kill semantics of X/Alt+W.
    closePane: async () => {
      const pane = layout.focused;
      if (!pane) return;
      const session = pane.session;
      if (session) {
        let forgotten = false;
        try {
          await api.retainSession(session.id);
        } catch (error) {
          // Nothing to retain once the backend has dropped the session, and
          // closing the view is then the whole job. Any other failure means the
          // terminal may still be alive, so the pane stays visible.
          if (!sessionAlreadyGone(error)) {
            pane.flashNotice("[could not retain terminal, pane left open]");
            return;
          }
          forgotten = true;
          forgetSession(session.id);
        }
        if (!forgotten && !state.currentWorkspace) {
          const adopted = await ensureScratchWorkspace().catch(() => false);
          // Another window may already own Scratch. Retain still guarantees
          // this process lives; exclude it from this viewer's exit cleanup.
          if (!adopted) state.scratchSessionIds.delete(session.id);
        }
      }
      layout.closePane(pane);
      scheduleWorkspaceSave();
      refreshStatusSoon();
    },
    // `keyboard` marks Alt+W and the palette: the bar then opens with Kill
    // focused and a second Alt+W completes it, so a terminal can be killed
    // without reaching for the mouse. The header button keeps Cancel first.
    killFocusedSession: async ({ keyboard = false } = {}) => {
      const pane = layout.focused;
      if (!pane) return;
      if (keyboard && pane.confirmationLabel() === "Kill") {
        pane.acceptConfirmation();
        return;
      }
      if (!pane.session) {
        pane.flashNotice("[no terminal to kill · Alt+D closes the pane]");
        return;
      }
      pane.confirmAction(`Stop "${pane.displayName()}" and close this pane?`, async () => {
        const sessionId = pane.session.id;
        try {
          await api.killSession(sessionId);
        } catch (error) {
          // Rethrowing a real failure keeps it on the confirmation bar. A
          // forgotten session must fall through and close, or the pane can
          // never be removed at all.
          if (!sessionAlreadyGone(error)) throw error;
        }
        forgetSession(sessionId);
        layout.closePane(pane);
        scheduleWorkspaceSave();
        refreshStatusSoon();
      }, "Kill", { focusConfirm: keyboard });
    },
    killAllSessions: async () => {
      const result = await api.killAllSessions();
      const killedIds = new Set(result?.killed_ids || []);
      for (const pane of [...layout.panes()]) {
        if (!pane.session || !killedIds.has(pane.session.id)) continue;
        forgetSession(pane.session.id);
        layout.closePane(pane);
      }
      for (const sessionId of killedIds) forgetSession(sessionId);
      await removeSessionsFromSavedWorkspaces(killedIds);
      scheduleWorkspaceSave();
      refreshStatusSoon();
      const failed = result?.failed_ids || [];
      if (failed.length) {
        showError(`${failed.length} terminal${failed.length === 1 ? "" : "s"} could not be stopped and ${failed.length === 1 ? "is" : "are"} still running.`);
      }
      return { killed: result?.killed || 0, failed: failed.length };
    },
    focusedPaneName: () => layout.focused?.displayName() || null,
    // Snippets type straight into the focused terminal. Say where they went,
    // say when they went nowhere, and confirm anything multi-line first. One
    // Enter in the palette should never run three commands unannounced.
    sendSnippet: (snippet) => {
      const pane = layout.focused;
      if (!pane) {
        showError("Focus a terminal first. Snippets are typed into the focused pane.");
        return;
      }
      const body = displaySnippet(snippet.text);
      const send = () => {
        if (pane.sendText(snippet.text)) pane.flashNotice(`[sent: ${snippet.name}]`);
        else showError(`"${snippet.name}" was not sent. That pane has no live terminal.`);
      };
      const lines = body ? body.split("\n").length : 0;
      if (lines > 1) {
        pane.confirmAction(
          `Run "${snippet.name}" (${lines} lines) in ${pane.displayName()}?`,
          async () => send(),
          "Run",
        );
        return;
      }
      send();
    },
    refocusTerm: () => {
      if (!layout.focused) return false;
      // Report success even while an overlay holds the keyboard: the caller
      // only wants to know whether there *is* a pane to hand back to, and
      // saying "no" would send it to the fallback branch and park focus on a
      // sidebar button instead. focus.js decides when the pane actually takes
      // it; the class is set either way so the pane still reads as focused.
      layout.focused.setFocused(true);
      return true;
    },
    focusHeldByOverlay: () => !terminalMayFocus(),
  };
}
