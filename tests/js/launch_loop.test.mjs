// The launch long poll (Explorer's "Open QuickTerm here" and the quickterm
// command line). The pacing is tested with a fake api that answers at once,
// because an instant error answer used to loop with no delay at all.
import test from "node:test";
import assert from "node:assert/strict";

import {
  LAUNCH_MAX_BACKOFF_MS, LAUNCH_MIN_POLL_MS, createLaunchLoop, launchBackoff, launchKind,
} from "../../quickterm/frontend/js/launch_loop.js";

function harness({ answers = [], state = {}, ...deps } = {}) {
  const sleeps = [];
  const errors = [];
  const calls = [];
  let loop = null;
  let polls = 0;
  const api = {
    async claimLaunch() {
      polls += 1;
      const next = answers.length ? answers.shift() : null;
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const pane = { canReplace: true };
  const layout = {
    focused: pane,
    init: () => pane,
    splitPane: () => pane,
    autoDir: () => "right",
    focusPane: (each) => calls.push(["focusPane", each]),
  };
  const fullState = {
    windowIsPrimary: true,
    registryAvailable: true,
    transitioning: false,
    currentWorkspace: null,
    scratchRoot: "/tmp/scratch",
    ...state,
  };
  loop = createLaunchLoop({
    api,
    state: fullState,
    layout,
    openFolderInScratch: async (cwd) => { calls.push(["openFolderInScratch", cwd]); return true; },
    spawnInto: async (_pane, profile, cwd) => { calls.push(["spawnInto", profile, cwd]); return { id: "s1" }; },
    spawnDefaultInto: async (_pane, cwd) => { calls.push(["spawnDefaultInto", cwd]); return { id: "s2" }; },
    switchWorkspace: async (name) => {
      calls.push(["switchWorkspace", name]);
      fullState.currentWorkspace = name;
      return true;
    },
    focusShownWorkspace: () => false,
    showError: (message) => errors.push(message),
    // Every poll answers "instantly": the clock never moves.
    now: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length >= 8) loop.stopLaunchLoop();
    },
    ...deps,
  });
  return { loop, sleeps, errors, calls, state: fullState, polls: () => polls };
}

test("an instant error answer backs off and never re-polls at once", async () => {
  const failing = Array.from({ length: 10 }, () => Object.assign(new Error("403"), { status: 403 }));
  const { loop, sleeps, polls } = harness({ answers: failing });
  await loop.claimLaunchLoop();
  assert.deepEqual(sleeps, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  // One poll per wait: nothing slipped through between the sleeps.
  assert.equal(polls(), 8);
});

test("an answer that is not a launch counts as an error, not as nothing queued", async () => {
  const { loop, sleeps } = harness({ answers: ["forbidden: bad token", "<html>", 42] });
  await loop.claimLaunchLoop();
  assert.deepEqual(sleeps.slice(0, 3), [1000, 2000, 4000]);
});

test("a success resets the backoff", async () => {
  const boom = () => new Error("500");
  const { loop, sleeps } = harness({ answers: [boom(), boom(), boom(), null, boom()] });
  await loop.claimLaunchLoop();
  assert.deepEqual(sleeps.slice(0, 5), [1000, 2000, 4000, LAUNCH_MIN_POLL_MS, 1000]);
});

test("an empty answer that came back early waits out the rest of a second", async () => {
  let clock = 0;
  const { loop, sleeps } = harness({
    answers: [null, null],
    now: () => { clock += 150; return clock; },
  });
  await loop.claimLaunchLoop();
  // Started at 150, answered at 300: 850 ms left of the second.
  assert.equal(sleeps[0], 850);
  assert.equal(sleeps[1], 850);
});

test("backoff is capped", () => {
  assert.equal(launchBackoff(1), 1000);
  assert.equal(launchBackoff(3), 4000);
  assert.equal(launchBackoff(40), LAUNCH_MAX_BACKOFF_MS);
});

test("each launch shape has one meaning", () => {
  assert.equal(launchKind({ cwd: "/p" }), "folder");
  assert.equal(launchKind({ workspace: "dev" }), "workspace");
  assert.equal(launchKind({ workspace: "dev", cwd: "/p" }), "terminal");
  assert.equal(launchKind({ profile: "pwsh" }), "profile");
  assert.equal(launchKind({ profile: "pwsh", workspace: "dev", cwd: "/p" }), "profile");
  assert.equal(launchKind({}), null);
  assert.equal(launchKind(null), null);
});

test("a folder alone opens in scratch as before", async () => {
  const { loop, calls } = harness();
  assert.equal(await loop.handleLaunch({ cwd: "/p" }), true);
  assert.deepEqual(calls, [["openFolderInScratch", "/p"]]);
});

test("a folder that cannot open is reported in straight quotes", async () => {
  const { loop, errors } = harness({ openFolderInScratch: async () => false });
  assert.equal(await loop.handleLaunch({ cwd: "/p" }), false);
  assert.deepEqual(errors, ['Could not open "/p" in a terminal. The request was dropped.']);
});

test("a workspace already shown is focused, not switched to", async () => {
  const focused = [];
  const { loop, calls } = harness({ focusShownWorkspace: (name) => { focused.push(name); return true; } });
  assert.equal(await loop.handleLaunch({ workspace: "dev" }), true);
  assert.deepEqual(focused, ["dev"]);
  assert.deepEqual(calls, []);
});

test("a workspace shown nowhere is switched to through the claim rules", async () => {
  const { loop, calls } = harness();
  assert.equal(await loop.handleLaunch({ workspace: "dev" }), true);
  assert.deepEqual(calls, [["switchWorkspace", "dev"]]);
});

test("a refused switch starts nothing; switchWorkspace explains the refusal", async () => {
  const { loop, calls } = harness({
    switchWorkspace: async (name) => { calls.push(["switchWorkspace", name]); return false; },
  });
  assert.equal(await loop.handleLaunch({ workspace: "dev", profile: "pwsh" }), false);
  assert.deepEqual(calls, [["switchWorkspace", "dev"]]);
});

test("a profile starts in the given folder in the current workspace", async () => {
  const { loop, calls } = harness({ state: { currentWorkspace: "dev" } });
  assert.equal(await loop.handleLaunch({ profile: "pwsh", cwd: "/p" }), true);
  assert.deepEqual(calls.filter(([what]) => what !== "focusPane"), [["spawnInto", "pwsh", "/p"]]);
});

test("a profile without a folder starts in the workspace root", async () => {
  const named = harness({ state: { currentWorkspace: "dev" } });
  await named.loop.handleLaunch({ profile: "pwsh" });
  // null lets the backend resolve the workspace folder.
  assert.deepEqual(named.calls.at(-1), ["spawnInto", "pwsh", null]);
  const scratch = harness();
  await scratch.loop.handleLaunch({ profile: "pwsh" });
  assert.deepEqual(scratch.calls.at(-1), ["spawnInto", "pwsh", "/tmp/scratch"]);
});

test("a profile for another workspace moves this window there first", async () => {
  const { loop, calls } = harness({ state: { currentWorkspace: "dev" } });
  assert.equal(await loop.handleLaunch({ profile: "pwsh", workspace: "ops" }), true);
  const steps = calls.filter(([what]) => what !== "focusPane");
  assert.deepEqual(steps, [["switchWorkspace", "ops"], ["spawnInto", "pwsh", null]]);
});

test("a folder in a named workspace starts the default terminal there", async () => {
  const { loop, calls } = harness();
  assert.equal(await loop.handleLaunch({ workspace: "ops", cwd: "/p" }), true);
  const steps = calls.filter(([what]) => what !== "focusPane");
  assert.deepEqual(steps, [["switchWorkspace", "ops"], ["spawnDefaultInto", "/p"]]);
});

test("a workspace tiled beside this one gets focus and an explanation, not a stray terminal", async () => {
  const { loop, calls, errors } = harness({ focusShownWorkspace: () => true });
  assert.equal(await loop.handleLaunch({ profile: "pwsh", workspace: "ops" }), false);
  assert.deepEqual(calls, []);
  assert.match(errors[0], /^"ops" is shown beside this workspace/);
});

test("a window composed without the command-line hooks still opens folders", async () => {
  const errors = [];
  const opened = [];
  const loop = createLaunchLoop({
    api: {},
    state: { transitioning: false },
    openFolderInScratch: async (cwd) => { opened.push(cwd); return true; },
    showError: (message) => errors.push(message),
  });
  assert.equal(await loop.handleLaunch({ cwd: "/p" }), true);
  assert.equal(await loop.handleLaunch({ workspace: "dev" }), false);
  assert.deepEqual(opened, ["/p"]);
  assert.equal(errors.length, 1);
});
