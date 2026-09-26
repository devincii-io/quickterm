// Explorer's "Open QuickTerm here": the long poll on GET /api/launches/next
// that turns each queued folder into a terminal in this window's scratch.

export function createLaunchLoop({ api, state, openFolderInScratch, showError }) {
  let launchLoopStopped = false;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A folder handoff that cannot be satisfied (max_sessions reached, no shell
  // configured) used to retry twice a second forever, which also meant no
  // later "Open QuickTerm here" was ever claimed again.
  const LAUNCH_MAX_ATTEMPTS = 5;
  const LAUNCH_MAX_WAITS = 100; // 10 s of "transitioning" before giving up

  async function claimLaunchLoop() {
    while (!launchLoopStopped) {
      try {
        // One folder, one window. The queue behind GET /api/launches/next hands
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
        let waits = 0;
        while (state.transitioning && !launchLoopStopped && waits++ < LAUNCH_MAX_WAITS) await sleep(100);
        const launch = await api.claimLaunch();
        if (launch?.cwd) {
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
            opened = await openFolderInScratch(launch.cwd);
            if (!opened && attempts < LAUNCH_MAX_ATTEMPTS) await sleep(Math.min(500 * attempts, 4000));
          }
          if (!opened && !launchLoopStopped) {
            showError(`Could not open “${launch.cwd}” in a terminal. The request was dropped.`);
          }
        }
      } catch (_) {
        await sleep(1000);
      }
    }
  }

  function stopLaunchLoop() {
    launchLoopStopped = true;
  }

  return { claimLaunchLoop, stopLaunchLoop };
}
