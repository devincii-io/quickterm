// Launches handed to this window from outside: Explorer's "Open QuickTerm
// here" and the `quickterm new` / `quickterm open` command line. The long poll
// on GET /api/launches/next turns each queued item into a terminal or a
// workspace shown in this window. The backend has already checked every field.

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
// default terminal there (in scratch when no workspace is named).
export function launchKind(launch) {
  if (!launch || typeof launch !== "object") return null;
  if (launch.profile) return "profile";
  if (launch.cwd) return launch.workspace ? "terminal" : "folder";
  if (launch.workspace) return "workspace";
  return null;
}

export function createLaunchLoop({
  api, state, layout, openFolderInScratch, spawnInto, spawnDefaultInto, switchWorkspace,
  focusShownWorkspace, showError,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
}) {
  let launchLoopStopped = false;
  // A folder handoff that cannot be satisfied (max_sessions reached, no shell
  // configured) used to retry twice a second forever, which also meant no
  // later "Open QuickTerm here" was ever claimed again.
  const LAUNCH_MAX_ATTEMPTS = 5;
  const LAUNCH_MAX_WAITS = 100; // 10 s of "transitioning" before giving up

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

  async function waitForSettledWindow() {
    let waits = 0;
    while (state.transitioning && !launchLoopStopped && waits++ < LAUNCH_MAX_WAITS) await sleep(100);
    return !state.transitioning;
  }

  async function openFolder(cwd) {
    let opened = false;
    let attempts = 0;
    let waited = 0;
    while (!opened && !launchLoopStopped && attempts < LAUNCH_MAX_ATTEMPTS) {
      if (state.transitioning) {
        if (waited++ >= LAUNCH_MAX_WAITS) break;
        await sleep(100);
        continue;
      }
      attempts += 1;
      opened = await openFolderInScratch(cwd);
      if (!opened && attempts < LAUNCH_MAX_ATTEMPTS) await sleep(Math.min(500 * attempts, 4000));
    }
    if (!opened && !launchLoopStopped) {
      showError(`Could not open "${cwd}" in a terminal. The request was dropped.`);
    }
    return opened;
  }

  // Focus the workspace where it already is (this window, or a view tiled
  // beside it), else move this window there. A refused claim is explained by
  // switchWorkspace itself, in the error banner.
  async function showWorkspace(name) {
    if (focusShownWorkspace?.(name)) return true;
    if (state.currentWorkspace === name) {
      layout?.focused?.focusSoon?.();
      return true;
    }
    if (!(await waitForSettledWindow())) {
      showError(`Could not show "${name}": this window is still busy. The request was dropped.`);
      return false;
    }
    return Boolean(await switchWorkspace(name)) && state.currentWorkspace === name;
  }

  // A terminal in the named workspace (moving this window there first), or
  // in the current one when none is named.
  async function startTerminal(launch) {
    const target = launch.workspace || null;
    if (target && state.currentWorkspace !== target) {
      if (!(await showWorkspace(target))) return false;
      if (state.currentWorkspace !== target) {
        // Shown in a view tiled beside this one: that document owns its
        // layout, and nothing reaches into it from here.
        const what = launch.profile ? `"${launch.profile}"` : "a terminal";
        showError(`"${target}" is shown beside this workspace, so ${what} was not started there. Open it from that view.`);
        return false;
      }
    }
    if (!(await waitForSettledWindow())) {
      showError("Could not start the terminal: this window is still busy. The request was dropped.");
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

  async function handleLaunch(launch) {
    const kind = launchKind(launch);
    if (!kind) return false;
    if (kind !== "folder" && (!switchWorkspace || !spawnInto || !spawnDefaultInto || !layout)) {
      showError("This window cannot open command-line launches. The request was dropped.");
      return false;
    }
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
      await waitForSettledWindow();
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
