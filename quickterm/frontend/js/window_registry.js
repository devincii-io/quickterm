// This window in the backend's window registry: its id, the one workspace it
// may own, the heartbeat that keeps that claim alive, and opening another
// window. The claim, heartbeat and primary flags live on the shared state
// because the launch loop, the autosave and the sidebar all read them.

import { rememberWindowId, rememberedWindowId } from "./boot_context.js";
import {
  claimOutcome, claimRefusalMessage, conflictHolder, describeHolder, newWindowUrl,
  normalizeWindows, workspaceHolder,
} from "./windows.js";

// Well inside whatever the registry uses to expire a silent window: a missed
// beat must never look like a crashed window, because expiry is what hands this
// window's workspace to someone else.
const WINDOW_HEARTBEAT_MS = 5000;

export function createWindowRegistry({
  api, state, identity, showError, cancelWorkspaceSave, buildLauncher, refreshStatusSoon,
}) {
  let windowHeartbeatTimer = null;

  // ---- this window in the registry ---------------------------------------
  //
  // The invariant: two windows must never own the same workspace, because both
  // of them autosave the whole layout on every pane change and the loser's
  // panes disappear without a trace. Every path that changes what this window
  // owns goes through claimWorkspaceFor().

  // The id in the launch URL wins: app.py's viewer bookkeeping forgets a window
  // by exactly that id when its native shell closes, so registering under any
  // other one would leave the workspace claimed until the heartbeat expired.
  // The remembered id is the fallback for a plain browser tab, where a reload
  // otherwise looks like a second window fighting its own claim.
  //
  // No workspace key: registering is also how a reloaded page says hello, and
  // an omitted key preserves the claim it already holds instead of dropping it
  // for the moment it takes to ask for it back.
  async function acquireWindowId() {
    try {
      const info = await api.registerWindow({
        id: identity.id || rememberedWindowId(),
        primary: identity.primary,
      });
      state.windowId = info && info.id ? String(info.id) : null;
      state.registryAvailable = Boolean(state.windowId);
      if (info && "primary" in info) state.windowIsPrimary = Boolean(info.primary);
      if (state.windowId) rememberWindowId(state.windowId);
    } catch (_) {
      // An older backend without the registry, one still starting up, or the
      // window cap. The app is fully usable without it; only the guarantee is
      // missing, and pretending otherwise would be the worse failure.
      state.windowId = null;
      state.registryAvailable = false;
    }
    return state.windowId;
  }

  async function listWindowsSafe() {
    try {
      const list = normalizeWindows(await api.listWindows());
      state.registryAvailable = true;
      return list;
    } catch (_) {
      state.registryAvailable = false;
      return [];
    }
  }

  // Returns null when this window may own `name` (and now does), or the message
  // to show when it may not. `name` null means scratch, which is nobody's:
  // an unadopted scratch layout has no file to overwrite.
  //
  // A registry that cannot answer degrades to "carry on": blocking the user out
  // of their own workspace because a route 404'd is a worse failure than the
  // one being prevented. It never degrades to pretending the claim worked,
  // which is why claimedWorkspace stays null on that path.
  async function claimWorkspaceFor(name) {
    if (!state.windowId) {
      state.claimedWorkspace = null;
      return null;
    }
    try {
      if (!name) {
        await api.releaseWindowWorkspace(state.windowId);
        state.claimedWorkspace = null;
        return null;
      }
      await api.claimWindowWorkspace(state.windowId, name);
      state.claimedWorkspace = name;
      return null;
    } catch (error) {
      state.claimedWorkspace = null;
      if (claimOutcome(error) === "unavailable") {
        state.registryAvailable = false;
        return null;
      }
      // Refused. The 409 body names the window that holds it, so "taken" is
      // actionable; the registry listing is only the fallback.
      const holder = conflictHolder(error)
        || workspaceHolder(await listWindowsSafe(), state.windowId, name);
      return claimRefusalMessage(name, holder);
    }
  }

  // The registry expires a window that stops answering; that is how a crashed
  // or force-killed window lets go of its workspace. It answers a beat from an
  // expired window with 404 rather than reviving it silently, and that 404 is
  // the one heartbeat failure that matters: this window is autosaving a
  // workspace it no longer owns.
  function startWindowHeartbeat() {
    if (!state.windowId || windowHeartbeatTimer) return;
    windowHeartbeatTimer = setInterval(() => {
      api.heartbeatWindow(state.windowId).then(
        (info) => {
          state.registryAvailable = true;
          if (info && "primary" in info) state.windowIsPrimary = Boolean(info.primary);
        },
        (error) => { if (error?.status === 404) recoverWindowRegistration(); },
      );
    }, WINDOW_HEARTBEAT_MS);
  }

  // Say hello again and ask for the same workspace back. If it has been taken
  // in the meantime this window must stop owning it, and it lets go the same
  // way deleting the current workspace already does: the layout and every
  // terminal in it stay exactly as they are and carry on as an unnamed scratch
  // layout. Nothing is killed, nothing is saved over.
  async function recoverWindowRegistration() {
    const wanted = state.currentWorkspace;
    let refused = null;
    try {
      const info = await api.registerWindow({
        id: state.windowId,
        workspace: wanted || null,
        primary: identity.primary,
      });
      if (info && info.id) {
        state.windowId = String(info.id);
        rememberWindowId(state.windowId);
        if ("primary" in info) state.windowIsPrimary = Boolean(info.primary);
      }
      state.claimedWorkspace = wanted || null;
      state.registryAvailable = true;
      return;
    } catch (error) {
      state.claimedWorkspace = null;
      if (claimOutcome(error) !== "refused") {
        state.registryAvailable = false;
        return;
      }
      refused = `"${wanted}" was taken over by ${describeHolder(conflictHolder(error))} `
        + "while this window was unreachable. Nothing here was closed: your terminals "
        + "keep running and this layout carries on as an unnamed scratch layout.";
    }
    cancelWorkspaceSave();
    for (const sid of state.workspaceSessionIds) state.scratchSessionIds.add(sid);
    state.workspaceSessionIds = new Set();
    state.currentWorkspace = null;
    showError(refused);
    buildLauncher();
    refreshStatusSoon();
  }

  // Opening a window is the desktop shell's job: it owns the native window and
  // knows the launch URL, token fragment included. The backend route is for a
  // viewer that is not the shell but is talking to a backend that has one. A
  // plain browser window is the last resort, so the button is never dead.
  async function openNewWindow(name) {
    const target = name || null;
    const bridge = globalThis.pywebview?.api?.open_window;
    if (typeof bridge === "function") {
      // The bridge never rejects: a refusal is ordinary, so it answers
      // {opened:false, error}. Only "unavailable" means "there is no shell
      // here, ask someone else"; every other error is this window's answer.
      const result = await bridge(target || "", "").catch(() => null);
      if (result && result.opened) return true;
      if (result && result.error === "workspace_claimed") {
        // The bridge answers with the owner's id; the listing turns it into
        // something the user can point at.
        const holder = (await listWindowsSafe()).find((entry) => entry.id === result.owner) || null;
        showError(claimRefusalMessageForOpen(target, holder));
        return false;
      }
      if (result && result.error && result.error !== "unavailable") {
        showError(result.detail || "Could not open a second window.");
        return false;
      }
    }
    try {
      const result = await api.requestWindow({ workspace: target });
      if (result && result.opened) return true;
    } catch (error) {
      if (claimOutcome(error) === "refused") {
        showError(claimRefusalMessageForOpen(target, conflictHolder(error)));
        return false;
      }
      // Anything else means no shell answered, which is exactly what a plain
      // browser looks like. Fall through rather than leave a dead button.
    }
    const opened = window.open(
      newWindowUrl(location.pathname, target, api.token()),
      "_blank",
      "noopener",
    );
    if (!opened) {
      showError("Could not open a second window. Your browser blocked the pop-up.");
      return false;
    }
    return true;
  }

  // Same refusal, different consequence: nothing was switched here, the second
  // window simply did not open.
  function claimRefusalMessageForOpen(name, holder) {
    return `"${name}" is already open in ${describeHolder(holder)}, `
      + "so no second window was opened. Two windows on one workspace overwrite "
      + "each other's saved layout.";
  }

  // Leaving for good (pagehide or an explicit view close). The timer is not
  // cleared back to null, so nothing can start a second heartbeat afterwards.
  function stopWindowHeartbeat() {
    clearInterval(windowHeartbeatTimer);
  }

  return {
    acquireWindowId,
    listWindowsSafe,
    claimWorkspaceFor,
    startWindowHeartbeat,
    stopWindowHeartbeat,
    recoverWindowRegistration,
    openNewWindow,
  };
}
