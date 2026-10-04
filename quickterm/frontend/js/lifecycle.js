// How this document stops being a window: best-effort on pagehide (the
// document is already going, so every request is a keepalive fetch), and
// awaited when the parent window closes this document as a workspace view.

import { sessionAlreadyGone } from "./panel_shared.js";
import { isScratchWorkspace } from "./boot_context.js";
import { withoutSessionLeaf } from "./layout_sessions.js";

export function createLifecycle({
  api, workspace, state, layout, ownedSessionIds,
  stopWindowHeartbeat, stopLaunchLoop, cancelWorkspaceSave, cancelWorkspaceRetry, scheduleWorkspaceSave,
}) {
  function persistOnExit() {
    if (state.exiting) return;
    state.exiting = true;
    stopLaunchLoop();
    stopWindowHeartbeat();
    // keepalive, for the same reason the layout PUT below needs it: the
    // document is going away and a normal fetch is cancelled with it, so the
    // release would never leave and this window's workspace would stay claimed
    // until the registry expired the heartbeat. That is the difference between
    // the other window opening it now and the user waiting out a timeout.
    const release = () => {
      if (!state.windowId) return;
      return fetch(`/api/windows/${encodeURIComponent(state.windowId)}`, {
        method: "DELETE",
        headers: { ...api.authHeaders() },
        keepalive: true,
      }).catch(() => {});
    };
    if (state.currentWorkspace && layout.root && !state.transitioning) {
      // Use the same queue as autosave: a queued older snapshot must never
      // arrive after this one. Unload remains best-effort; explicit view close
      // awaits the save while its document is still alive.
      workspace.save(state.currentWorkspace, layout.serialize(), isScratchWorkspace(state.currentWorkspace) ? state.workspaceLogo : undefined,
        [...ownedSessionIds()], undefined, { keepalive: true })
        .catch(() => {});
    }
    // Now, not after the save: once the document is torn down a pending
    // promise never settles, and a release chained to it never left. The
    // claim then outlived a reload for the whole registry TTL.
    release();
    // The idle reaper has fresh activity data; pagehide must never kill scratch.
  }

  // A scratch view keeps what holds work when it closes: a terminal that is
  // busy, typed into (by the backend's `touched` or this view's own
  // `userWrote`), or unknown. Every new scratch view starts an idle shell;
  // retaining those pinned them forever (the reaper never takes a retained
  // session) and kept QuickTerm resident in the tray after the last window.
  async function scratchKeepIds(owned) {
    const sessions = await api.getSessions({ metrics: false }).catch(() => null);
    if (!sessions) return new Set(owned);
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const typed = new Set((layout.panes?.() || [])
      .filter((pane) => pane.userWrote && pane.session?.id).map((pane) => pane.session.id));
    return new Set(owned.filter((id) => {
      const session = byId.get(id);
      return !session || session.busy !== false || session.touched || session.retained || typed.has(id);
    }));
  }

  // window.quicktermView.close(): the parent window is closing this view. The
  // layout is saved and its terminals retained before the registry entry goes
  // (a scratch view only those holding work; the idle rest leave its file
  // too, so the idle reaper can collect them), and a failure leaves the view
  // open and autosaving again. Nothing is killed here.
  async function closeView() {
    if (state.transitioning) return false;
    state.transitioning = true;
    cancelWorkspaceSave();
    cancelWorkspaceRetry();
    try {
      const scratch = isScratchWorkspace(state.currentWorkspace);
      let keep = [...ownedSessionIds()];
      if (state.currentWorkspace) {
        let tree = layout.serialize();
        if (scratch) {
          const kept = await scratchKeepIds(keep);
          for (const id of keep) if (!kept.has(id)) tree = withoutSessionLeaf(tree, id).layout;
          keep = keep.filter((id) => kept.has(id));
        }
        await workspace.save(state.currentWorkspace, tree, scratch ? state.workspaceLogo : undefined, keep);
      }
      for (const id of keep) {
        await api.retainSession(id).catch((error) => { if (!sessionAlreadyGone(error)) throw error; });
      }
      if (state.windowId) await api.unregisterWindow(state.windowId);
      state.exiting = true;
      stopWindowHeartbeat();
      stopLaunchLoop();
      return true;
    } catch (error) {
      state.transitioning = false;
      scheduleWorkspaceSave();
      throw error;
    }
  }

  return { persistOnExit, closeView };
}
