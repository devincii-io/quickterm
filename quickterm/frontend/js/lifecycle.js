// How this document stops being a window: best-effort on pagehide (the
// document is already going, so every request is a keepalive fetch), and
// awaited when the parent window closes this document as a workspace view.

import { sessionAlreadyGone } from "./panel_shared.js";

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
      workspace.save(state.currentWorkspace, layout.serialize(), state.workspaceLogo,
        [...ownedSessionIds()], undefined, { keepalive: true })
        .catch(() => {}).finally(release);
    } else release();
    // The idle reaper has fresh activity data; pagehide must never kill scratch.
  }

  // window.quicktermView.close(): the parent window is closing this view. The
  // layout is saved and every owned terminal retained before the registry
  // entry goes, and a failure leaves the view open and autosaving again.
  async function closeView() {
    if (state.transitioning) return false;
    state.transitioning = true;
    cancelWorkspaceSave();
    cancelWorkspaceRetry();
    try {
      if (state.currentWorkspace) {
        await workspace.save(state.currentWorkspace, layout.serialize(), state.workspaceLogo,
          [...ownedSessionIds()], state.workspacePath);
      }
      for (const id of ownedSessionIds()) {
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
