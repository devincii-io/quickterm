// Launches handed to this window from outside: Explorer's "Open QuickTerm
// here" and the `quickterm new` / `quickterm open` command line. The shell
// runs the long poll on GET /api/launches/next and turns each queued item into
// a view opened or focused in this window, or a terminal started in one. The
// backend has already checked every field.

import { SCRATCH_WS } from "./boot_context.js";

// A poll that comes back at once must not come back again at once. An error
// answer (a page loaded without the token gets 403 on every call) used to
// loop with no delay at all when the api resolved instead of throwing, and
// even the catch only waited a second. Errors back off to half a minute; an
// empty answer that arrived early waits out the rest of a second.
export const LAUNCH_MIN_POLL_MS = 1000;
export const LAUNCH_MAX_BACKOFF_MS = 30000;

export function launchBackoff(failures) {
  const exponent = Math.max(0, failures - 1);
  return Math.min(LAUNCH_MIN_POLL_MS * 2 ** exponent, LAUNCH_MAX_BACKOFF_MS);
}

// What a launch asks for: `workspace` alone shows that workspace, a
// `profile` starts that profile, anything else with a folder starts the
// default terminal there (in a new scratch view when no workspace is named).
export function launchKind(launch) {
  if (!launch || typeof launch !== "object") return null;
  if (launch.profile) return "profile";
  if (launch.cwd) return launch.workspace ? "terminal" : "folder";
  if (launch.workspace) return "workspace";
  return null;
}

// The view half: start one launched terminal in this view's layout, in the
// focused pane when it can be replaced, else beside it. A view still busy
// restoring gets a few seconds before the launch is dropped.
export function createLaunchTarget({
  state, layout, spawnInto, spawnDefaultInto, showError,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const LAUNCH_MAX_WAITS = 100; // 10 s of "transitioning" before giving up

  async function startLaunch(launch) {
    let waits = 0;
    while (state.transitioning && waits++ < LAUNCH_MAX_WAITS) await sleep(100);
    if (state.transitioning) {
      showError("Could not start the terminal: this view is still busy. The request was dropped.");
      return false;
    }
    let pane = layout.focused || layout.init();
    if (!pane.canReplace) pane = layout.splitPane(pane, layout.autoDir(pane));
    if (!pane) return false;
    layout.focusPane(pane);
    if (!launch.profile) return Boolean(await spawnDefaultInto(pane, launch.cwd));
    // Without a folder a profile starts where every profile does: the
    // workspace root, which the backend resolves; scratch has its own.
    const onScratch = !state.currentWorkspace || state.currentWorkspace === SCRATCH_WS;
    const cwd = launch.cwd || (onScratch ? state.scratchRoot || null : null);
    return Boolean(await spawnInto(pane, launch.profile, cwd));
  }

  return { startLaunch };
}

// The shell half. `openView(name, {cwd})` focuses the view that shows `name`
// or opens one (null opens a scratch view) and resolves with it once its
// document is up, or false; `appFor(view)` is that document's app and
// `activeView()` the view the keyboard is in.
export function createLaunchLoop({
  api, state, openView, appFor, activeView, showError,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
}) {
  let launchLoopStopped = false;

  // One claim. `error` is set when the backend could not be asked or said
  // no; `launch` is null when nothing was queued.
  async function claimOnce() {
    try {
      const launch = await api.claimLaunch();
      if (launch !== null && launch !== undefined && typeof launch !== "object") {
        return { error: new Error("unexpected launch answer") };
      }
      return { launch: launch || null };
    } catch (error) {
      return { error };
    }
  }

  // A folder alone opens a new scratch view whose first terminal starts there.
  async function openFolder(cwd) {
    const opened = Boolean(await openView(null, { cwd }));
    if (!opened && !launchLoopStopped) {
      showError(`Could not open "${cwd}" in a terminal. The request was dropped.`);
    }
    return opened;
  }

  // The view that shows the workspace, focused, or a new one for it. A
  // refused claim is explained by the view manager, in the error banner.
  async function showWorkspace(name) {
    return Boolean(await openView(name));
  }

  // A terminal in the named workspace's view (opened first when needed), or
  // in the active view when none is named, or in a new scratch view when no
  // view is open.
  async function startTerminal(launch) {
    const view = launch.workspace
      ? await openView(launch.workspace)
      : activeView() || await openView(null);
    const app = view ? appFor(view) : null;
    if (!app?.startLaunch) {
      if (view) showError("That view cannot start command-line launches. The request was dropped.");
      return false;
    }
    return Boolean(await app.startLaunch(launch));
  }

  async function handleLaunch(launch) {
    const kind = launchKind(launch);
    if (!kind) return false;
    try {
      if (kind === "folder") return await openFolder(launch.cwd);
      if (kind === "workspace") return await showWorkspace(launch.workspace);
      return await startTerminal(launch);
    } catch (error) {
      showError(`Could not open the launch: ${error?.detail || error?.message || error}`);
      return false;
    }
  }

  async function claimLaunchLoop() {
    let failures = 0;
    while (!launchLoopStopped) {
      // One launch, one window. The queue behind GET /api/launches/next hands
      // each launch to a single waiter, so with several windows waiting the
      // folder used to land in whichever one happened to poll first. The
      // registry already names the window this is meant for: `primary` is the
      // same window the summon hotkey raises and the one whose native title
      // hotkeys.py matches, and it is re-promoted when that window closes.
      // A window with no registry to ask still claims, because a lost folder
      // handoff is worse than an unlikely double claim.
      if (!state.windowIsPrimary && state.registryAvailable) {
        await sleep(1000);
        continue;
      }
      const started = now();
      const { launch, error } = await claimOnce();
      if (launchLoopStopped) break;
      if (error) {
        failures += 1;
        await sleep(launchBackoff(failures));
        continue;
      }
      failures = 0;
      if (!launch) {
        const early = LAUNCH_MIN_POLL_MS - (now() - started);
        if (early > 0) await sleep(early);
        continue;
      }
      await handleLaunch(launch);
    }
  }

  function stopLaunchLoop() {
    launchLoopStopped = true;
  }

  return { claimLaunchLoop, stopLaunchLoop, handleLaunch };
}
