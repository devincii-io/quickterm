// The launch long poll (Explorer's "Open QuickTerm here" and the quickterm
// command line). The pacing is tested with a fake api that answers at once,
// because an instant error answer used to loop with no delay at all. The
// shell runs the poll and opens or focuses views; each view starts a
// launched terminal in its own layout.
import test from "node:test";
import assert from "node:assert/strict";

import {
  LAUNCH_MAX_BACKOFF_MS, LAUNCH_MIN_POLL_MS, createLaunchLoop, createLaunchTarget, launchBackoff, launchKind,
} from "../../quickterm/frontend/js/launch_loop.js";

// The shell side: views are opened or focused by name, each with an app that
// starts a launched terminal in its own layout.
function harness({ answers = [], state = {}, shown = [], active = null, refuse = [], ...deps } = {}) {
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
  const open = new Map(shown.map((name) => [name, { name }]));
  const fullState = { windowIsPrimary: true, registryAvailable: true, ...state };
  loop = createLaunchLoop({
    api,
    state: fullState,
    openView: async (name, options = {}) => {
      if (name && open.has(name)) {
        calls.push(["focus", name]);
        return open.get(name);
      }
      calls.push(["open", name, ...(options.cwd ? [options.cwd] : [])]);
      if (refuse.includes(name)) return false;
      const view = { name: name || "scratch" };
      if (name) open.set(name, view);
      return view;
    },
    appFor: (view) => ({
      startLaunch: async (launch) => { calls.push(["startLaunch", view.name, launch]); return true; },
    }),
    activeView: () => (active ? open.get(active) || { name: active } : null),
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

test("only the primary window claims while the registry can say which one that is", async () => {
  const { loop, sleeps, polls } = harness({ state: { windowIsPrimary: false } });
  await loop.claimLaunchLoop();
  assert.equal(polls(), 0);
  assert.deepEqual(sleeps, Array(8).fill(1000));
  const lost = harness({ state: { windowIsPrimary: false, registryAvailable: false } });
  await lost.loop.claimLaunchLoop();
  assert.ok(lost.polls() > 0, "with no registry to ask, a lost handoff is worse than a double claim");
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

test("a folder alone opens a new scratch view whose terminal starts there", async () => {
  const { loop, calls } = harness({ shown: ["dev"], active: "dev" });
  assert.equal(await loop.handleLaunch({ cwd: "/p" }), true);
  assert.deepEqual(calls, [["open", null, "/p"]]);
});

test("a folder that cannot open is reported in straight quotes", async () => {
  const { loop, errors } = harness({ refuse: [null] });
  assert.equal(await loop.handleLaunch({ cwd: "/p" }), false);
  assert.deepEqual(errors, ['Could not open "/p" in a terminal. The request was dropped.']);
});

test("a workspace already shown is focused, not opened again", async () => {
  const { loop, calls } = harness({ shown: ["dev"] });
  assert.equal(await loop.handleLaunch({ workspace: "dev" }), true);
  assert.deepEqual(calls, [["focus", "dev"]]);
});

test("a workspace shown nowhere opens its own view", async () => {
  const { loop, calls } = harness({ shown: ["ops"], active: "ops" });
  assert.equal(await loop.handleLaunch({ workspace: "dev" }), true);
  assert.deepEqual(calls, [["open", "dev"]]);
});

test("a refused view starts nothing; the view manager explains the refusal", async () => {
  const { loop, calls, errors } = harness({ refuse: ["dev"] });
  assert.equal(await loop.handleLaunch({ workspace: "dev", profile: "pwsh" }), false);
  assert.deepEqual(calls, [["open", "dev"]]);
  assert.deepEqual(errors, []);
});

test("a profile without a workspace starts in the active view", async () => {
  const { loop, calls } = harness({ shown: ["dev"], active: "dev" });
  const launch = { profile: "pwsh", cwd: "/p" };
  assert.equal(await loop.handleLaunch(launch), true);
  assert.deepEqual(calls, [["startLaunch", "dev", launch]]);
});

test("a profile with no view open gets a new scratch view first", async () => {
  const { loop, calls } = harness();
  const launch = { profile: "pwsh" };
  assert.equal(await loop.handleLaunch(launch), true);
  assert.deepEqual(calls, [["open", null], ["startLaunch", "scratch", launch]]);
});

test("a profile for another workspace opens that view first and starts there", async () => {
  const { loop, calls } = harness({ shown: ["dev"], active: "dev" });
  const launch = { profile: "pwsh", workspace: "ops" };
  assert.equal(await loop.handleLaunch(launch), true);
  assert.deepEqual(calls, [["open", "ops"], ["startLaunch", "ops", launch]]);
});

test("a profile for a workspace already shown starts in that view, not the active one", async () => {
  const { loop, calls } = harness({ shown: ["dev", "ops"], active: "dev" });
  const launch = { profile: "pwsh", workspace: "ops" };
  assert.equal(await loop.handleLaunch(launch), true);
  assert.deepEqual(calls, [["focus", "ops"], ["startLaunch", "ops", launch]]);
});

test("a folder in a named workspace starts the default terminal in that view", async () => {
  const { loop, calls } = harness();
  const launch = { workspace: "ops", cwd: "/p" };
  assert.equal(await loop.handleLaunch(launch), true);
  assert.deepEqual(calls, [["open", "ops"], ["startLaunch", "ops", launch]]);
});

test("a view without the launch hook says so instead of starting a stray terminal", async () => {
  const { loop, errors } = harness({ shown: ["dev"], active: "dev", appFor: () => ({}) });
  assert.equal(await loop.handleLaunch({ profile: "pwsh" }), false);
  assert.match(errors[0], /cannot start command-line launches/);
});

// ---- the view side ----

function target({ state = {}, focused = { canReplace: true } } = {}) {
  const calls = [];
  const errors = [];
  const fullState = { transitioning: false, currentWorkspace: null, scratchRoot: "/tmp/scratch", ...state };
  const split = { canReplace: true, split: true };
  const layout = {
    focused,
    init: () => ({ canReplace: true, fresh: true }),
    splitPane: () => split,
    autoDir: () => "h",
    focusPane: (pane) => calls.push(["focusPane", pane]),
  };
  const { startLaunch } = createLaunchTarget({
    state: fullState,
    layout,
    spawnInto: async (pane, profile, cwd) => { calls.push(["spawnInto", profile, cwd, pane]); return { id: "s1" }; },
    spawnDefaultInto: async (pane, cwd) => { calls.push(["spawnDefaultInto", cwd, pane]); return { id: "s2" }; },
    showError: (message) => errors.push(message),
    sleep: async () => {},
  });
  return { startLaunch, calls, errors, split };
}

test("a launched profile starts in the given folder, else the workspace root, else the scratch root", async () => {
  const named = target({ state: { currentWorkspace: "dev" } });
  assert.equal(await named.startLaunch({ profile: "pwsh", cwd: "/p" }), true);
  assert.deepEqual(named.calls.at(-1).slice(0, 3), ["spawnInto", "pwsh", "/p"]);
  await named.startLaunch({ profile: "pwsh" });
  // null lets the backend resolve the workspace folder.
  assert.deepEqual(named.calls.at(-1).slice(0, 3), ["spawnInto", "pwsh", null]);
  const scratch = target();
  await scratch.startLaunch({ profile: "pwsh" });
  assert.deepEqual(scratch.calls.at(-1).slice(0, 3), ["spawnInto", "pwsh", "/tmp/scratch"]);
});

test("a launched folder starts the default terminal, beside a pane that cannot be replaced", async () => {
  const { startLaunch, calls, split } = target({ focused: { canReplace: false } });
  assert.equal(await startLaunch({ workspace: "ops", cwd: "/p" }), true);
  assert.deepEqual(calls.at(-1), ["spawnDefaultInto", "/p", split]);
});

test("a view still restoring gets a moment, then the launch is dropped with a word", async () => {
  const { startLaunch, calls, errors } = target({ state: { transitioning: true } });
  assert.equal(await startLaunch({ cwd: "/p" }), false);
  assert.deepEqual(calls, []);
  assert.match(errors[0], /still busy/);
});
