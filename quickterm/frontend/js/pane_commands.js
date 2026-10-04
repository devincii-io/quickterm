// What the keyboard, the palette and the pane header do to the focused pane:
// split, new terminal, zoom, rename, detach (retain, never kill), the
// confirmed kill, this view's share of the shell's kill-all, snippets, and
// handing the keyboard back. The returned object is spread into the app
// facade under these same names.

import { broadcastNotice, broadcastTargets } from "./broadcast.js";
import { terminalMayFocus } from "./focus.js";
import { displaySnippet, sessionAlreadyGone } from "./panel_shared.js";

export function createPaneCommands({
  api, state, layout,
  spawnSplitInto, spawnDefaultInto, forgetSession, ensureScratchWorkspace,
  scheduleWorkspaceSave, persistCurrentWorkspace, refreshStatusSoon, showError,
}) {
  const paneFor = (id) => layout.panes().find((pane) => pane.session?.id === id) || null;

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
    // The shell's sidebar kill, routed here because this view holds or owns
    // the terminal: its in-memory ownership drops the id before the next
    // autosave could write it back. A real failure is thrown unchanged
    // ({status, detail}) for the confirmation to show; a 404 means there is
    // nothing left to stop, so it falls through like a verified kill.
    killSessionById: async (id) => {
      try {
        await api.killSession(id);
      } catch (error) {
        if (!sessionAlreadyGone(error)) throw error;
      }
      forgetSession(id);
      const pane = paneFor(id);
      if (pane) layout.closePane(pane);
      scheduleWorkspaceSave();
      refreshStatusSoon();
      return true;
    },
    // The sidebar's Detach: retain first, then close the pane that shows it.
    // Never a kill. `forget` is the first half of moving the terminal to
    // another view: this workspace lets go of it and says so on disk at once,
    // so the backend drops its workspace tag before the other view attaches.
    detachSessionById: async (id, { forget = false } = {}) => {
      try {
        await api.retainSession(id);
      } catch (error) {
        if (!sessionAlreadyGone(error)) throw error;
      }
      const pane = paneFor(id);
      if (pane) layout.closePane(pane);
      if (forget) {
        forgetSession(id);
        await persistCurrentWorkspace();
      } else {
        scheduleWorkspaceSave();
      }
      refreshStatusSoon();
      return true;
    },
    // The shell's kill-all reaches every view with the ids the backend
    // verified as stopped. Each view closes its panes on them and drops them
    // from its in-memory ownership, so its next autosave cannot write them
    // back. A terminal the backend could not stop is not in the list and
    // stays where it is. Answers how many panes closed.
    dropKilledSessions: (ids) => {
      const killedIds = new Set(ids || []);
      if (!killedIds.size) return 0;
      // Forgotten before any pane closes, as in killSessionById, so a save
      // the close sets off already leaves them out.
      for (const sessionId of killedIds) forgetSession(sessionId);
      let closed = 0;
      for (const pane of [...layout.panes()]) {
        if (!pane.session || !killedIds.has(pane.session.id)) continue;
        layout.closePane(pane);
        closed += 1;
      }
      scheduleWorkspaceSave();
      refreshStatusSoon();
      return closed;
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
