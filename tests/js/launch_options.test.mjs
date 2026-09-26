import test from "node:test";
import assert from "node:assert/strict";

import {
  launchOptions, launchOptionsFromNode, launchOptionsToNode, repeatLaunchOptions,
} from "../../quickterm/frontend/js/launch_options.js";
import { createSpawner } from "../../quickterm/frontend/js/spawner.js";

test("launch options round-trip through a saved pane node", () => {
  const options = { claudeMode: "new", startCommand: "claude --continue", args: ["--x", "y"] };
  const node = launchOptionsToNode(options);
  assert.deepEqual(node, { claude_mode: "new", start_command: "claude --continue", args: ["--x", "y"] });
  assert.deepEqual(launchOptionsFromNode(JSON.parse(JSON.stringify(node))), options);
});

test("nothing worth repeating is saved as nothing", () => {
  assert.equal(launchOptions({}), null);
  assert.equal(launchOptions({ claudeMode: undefined }), null);
  assert.equal(launchOptionsToNode(null), null);
});

test("old layouts and hand-edited junk load as no options", () => {
  assert.equal(launchOptionsFromNode(undefined), null);
  assert.equal(launchOptionsFromNode("new"), null);
  assert.equal(launchOptionsFromNode([]), null);
  assert.deepEqual(
    launchOptionsFromNode({ claude_mode: "delete-everything", start_command: 5, args: ["ok", 3] }),
    null,
  );
  assert.deepEqual(launchOptionsFromNode({ claude_mode: "resume", args: "x" }), { claudeMode: "resume" });
  assert.equal(launchOptionsFromNode({ start_command: "x".repeat(8193) }), null);
});

test("a respawn repeats the pane's own launch unless told otherwise", () => {
  const pane = { profileName: "Claude", launchOptions: { claudeMode: "new" } };
  assert.deepEqual(repeatLaunchOptions(pane, "Claude", undefined, "claude-code"), { claudeMode: "new" });
  // An explicit launch wins, and {} is an explicit "none".
  assert.deepEqual(repeatLaunchOptions(pane, "Claude", {}, "claude-code"), {});
  assert.deepEqual(repeatLaunchOptions(pane, "Claude", { claudeMode: "agents" }, "claude-code"),
    { claudeMode: "agents" });
  // Another profile does not inherit this pane's launch.
  assert.deepEqual(repeatLaunchOptions(pane, "Shell", undefined, "bash"), {});
  // A profile that is no longer a Claude profile would 400 on claude_mode.
  assert.deepEqual(repeatLaunchOptions(pane, "Claude", undefined, "bash"), {});
});

function spawnerHarness(profiles) {
  const requests = [];
  let next = 0;
  const api = {
    createSession: async (body) => {
      requests.push(body);
      next += 1;
      return { id: `s${next}`, cwd: "C:\\work" };
    },
  };
  const state = { cfg: {}, profiles, currentWorkspace: "proj", selectedTerminal: null, terminalInventory: null };
  const spawner = createSpawner({
    api, state, layout: {}, ownSession() {}, scheduleWorkspaceSave() {}, refreshStatusSoon() {}, showError() {},
  });
  return { spawner, requests, state };
}

function fakePane(overrides = {}) {
  return {
    profileName: null, launchSpec: null, launchOptions: null, cwd: null, spawnPending: false,
    beginSpawn() { return true; }, endSpawn() {}, showNotice() {},
    setLaunchCwd(cwd) { this.cwd = cwd; }, attach(info) { this.session = info; },
    ...overrides,
  };
}

test("a Claude pane started as a new conversation restarts as one", async () => {
  const profiles = [{ name: "Claude", terminal_type: "claude-code" }];
  const { spawner, requests } = spawnerHarness(profiles);
  const pane = fakePane();
  await spawner.spawnInto(pane, "Claude", null, { claudeMode: "new" });
  assert.deepEqual(pane.launchOptions, { claudeMode: "new" });
  await spawner.restartSavedPane(pane);
  assert.equal(requests.at(-1).claude_mode, "new");
  assert.equal(requests.at(-1).profile, "Claude");
  assert.equal(requests.at(-1).cwd, "C:\\work");
});

test("a new terminal in a replaceable pane starts in the profile's default mode", async () => {
  const profiles = [{ name: "Claude", terminal_type: "claude-code" }];
  const { spawner, requests, state } = spawnerHarness(profiles);
  state.cfg.default_profile = "Claude";
  const pane = fakePane({ profileName: "Claude", launchOptions: { claudeMode: "new" } });
  await spawner.spawnDefaultInto(pane);
  assert.equal("claude_mode" in requests.at(-1), false);
  assert.equal(pane.launchOptions, null);
});

test("a restored pane node repeats its saved start command", async () => {
  const profiles = [{ name: "Shell", terminal_type: "bash", cmd: "bash" }];
  const { spawner, requests } = spawnerHarness(profiles);
  const pane = fakePane({ profileName: "Shell", launchOptions: launchOptionsFromNode({ start_command: "claude --continue" }) });
  // workspace_switch.js restores with spawnInto(pane, profile, cwd): no options.
  await spawner.spawnInto(pane, pane.profileName, null);
  assert.equal(requests.at(-1).start_command, "claude --continue");
});

test("a system terminal restarts from its launch spec and carries no profile options", async () => {
  const { spawner, requests } = spawnerHarness([]);
  const pane = fakePane({ launchOptions: { claudeMode: "new" } });
  await spawner.spawnSpecInto(pane, { cmd: "pwsh.exe", args: ["-NoLogo"], name: "PowerShell" });
  assert.equal(pane.launchOptions, null);
  await spawner.restartSavedPane(pane);
  assert.equal(requests.at(-1).cmd, "pwsh.exe");
  assert.deepEqual(requests.at(-1).args, ["-NoLogo"]);
});
