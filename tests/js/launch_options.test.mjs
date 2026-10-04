import test from "node:test";
import assert from "node:assert/strict";

import {
  launchOptions, launchOptionsFromNode, launchOptionsToNode, repeatLaunchOptions,
} from "../../quickterm/frontend/js/launch_options.js";
import { claudeProfileForPane, createSpawner, defaultSystemSpec } from "../../quickterm/frontend/js/spawner.js";

const SESSION = "0199a6f2-1c2d-7e3f-8a9b-0c1d2e3f4a5b";

test("launch options round-trip through a saved pane node", () => {
  const options = { agentMode: "new", startCommand: "claude --continue", args: ["--x", "y"] };
  const node = launchOptionsToNode(options);
  assert.deepEqual(node, { agent_mode: "new", start_command: "claude --continue", args: ["--x", "y"] });
  assert.deepEqual(launchOptionsFromNode(JSON.parse(JSON.stringify(node))), options);
  const resumed = { agentMode: "fork", agentSession: SESSION };
  assert.deepEqual(launchOptionsToNode(resumed), { agent_mode: "fork", agent_session: SESSION });
  assert.deepEqual(launchOptionsFromNode(launchOptionsToNode(resumed)), resumed);
});

test("a layout saved before 4.0 reads claude_mode as the agent mode", () => {
  const legacy = { claude_mode: "new", args: ["--verbose"] };
  const options = launchOptionsFromNode(legacy);
  assert.deepEqual(options, { agentMode: "new", args: ["--verbose"] });
  // Saved again, it is written under the new name only.
  assert.deepEqual(launchOptionsToNode(options), { agent_mode: "new", args: ["--verbose"] });
  // The new key wins when a hand-edited node carries both.
  assert.deepEqual(launchOptionsFromNode({ agent_mode: "agents", claude_mode: "new" }), { agentMode: "agents" });
  // Callers that still pass claudeMode get the same shape.
  assert.deepEqual(launchOptions({ claudeMode: "resume" }), { agentMode: "resume" });
});

test("an agent session must be a session id", () => {
  assert.equal(launchOptions({ agentSession: "--dangerously-skip-permissions" }), null);
  assert.equal(launchOptions({ agentSession: 12 }), null);
  assert.deepEqual(launchOptions({ agentMode: "resume", agentSession: "not-a-uuid" }), { agentMode: "resume" });
  assert.deepEqual(launchOptionsFromNode({ agent_mode: "resume", agent_session: SESSION }),
    { agentMode: "resume", agentSession: SESSION });
});

test("nothing worth repeating is saved as nothing", () => {
  assert.equal(launchOptions({}), null);
  assert.equal(launchOptions({ agentMode: undefined, claudeMode: undefined }), null);
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
  assert.deepEqual(launchOptionsFromNode({ claude_mode: "resume", args: "x" }), { agentMode: "resume" });
  assert.equal(launchOptionsFromNode({ start_command: "x".repeat(8193) }), null);
});

test("a respawn repeats the pane's own launch unless told otherwise", () => {
  const pane = { profileName: "Claude", launchOptions: { agentMode: "new" } };
  assert.deepEqual(repeatLaunchOptions(pane, "Claude", undefined, "claude-code"), { agentMode: "new" });
  // An explicit launch wins, and {} is an explicit "none".
  assert.deepEqual(repeatLaunchOptions(pane, "Claude", {}, "claude-code"), {});
  assert.deepEqual(repeatLaunchOptions(pane, "Claude", { agentMode: "agents" }, "claude-code"),
    { agentMode: "agents" });
  assert.deepEqual(repeatLaunchOptions(pane, "Claude", { claudeMode: "agents" }, "claude-code"),
    { agentMode: "agents" });
  // Another profile does not inherit this pane's launch.
  assert.deepEqual(repeatLaunchOptions(pane, "Shell", undefined, "bash"), {});
  // A profile that is no longer an agent profile would 400 on agent_mode.
  assert.deepEqual(repeatLaunchOptions(pane, "Claude", undefined, "bash"), {});
});

test("non-agent types drop the agent fields and keep the rest", () => {
  const pane = {
    profileName: "Tool",
    launchOptions: { agentMode: "resume", agentSession: SESSION, startCommand: "make", args: ["-j"] },
  };
  assert.deepEqual(repeatLaunchOptions(pane, "Tool", undefined, "bash"), { startCommand: "make", args: ["-j"] });
  assert.deepEqual(repeatLaunchOptions(pane, "Tool", undefined, null), { startCommand: "make", args: ["-j"] });
  assert.deepEqual(repeatLaunchOptions(null, "Tool", { agentMode: "new", args: ["-x"] }, "custom"), { args: ["-x"] });
});

test("a mode the agent type lacks is dropped, and a session only travels with resume or fork", () => {
  const forked = { profileName: "Agent", launchOptions: { agentMode: "fork", agentSession: SESSION } };
  assert.deepEqual(repeatLaunchOptions(forked, "Agent", undefined, "codex"), { agentMode: "fork", agentSession: SESSION });
  // The profile became Claude, which cannot fork: its default mode with no session.
  assert.deepEqual(repeatLaunchOptions(forked, "Agent", undefined, "claude-code"), {});
  const resumed = { profileName: "Agent", launchOptions: { agentMode: "resume", agentSession: SESSION } };
  assert.deepEqual(repeatLaunchOptions(resumed, "Agent", undefined, "claude-code"),
    { agentMode: "resume", agentSession: SESSION });
  assert.deepEqual(repeatLaunchOptions(null, "Agent", { agentMode: "continue", agentSession: SESSION }, "codex"),
    { agentMode: "continue" });
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
  assert.deepEqual(pane.launchOptions, { agentMode: "new" });
  await spawner.restartSavedPane(pane);
  assert.equal(requests.at(-1).agent_mode, "new");
  assert.equal("claude_mode" in requests.at(-1), false);
  assert.equal(requests.at(-1).profile, "Claude");
  assert.equal(requests.at(-1).cwd, "C:\\work");
});

test("a new terminal in a replaceable pane starts in the profile's default mode", async () => {
  const profiles = [{ name: "Claude", terminal_type: "claude-code" }];
  const { spawner, requests, state } = spawnerHarness(profiles);
  state.cfg.default_profile = "Claude";
  const pane = fakePane({ profileName: "Claude", launchOptions: { agentMode: "new" } });
  await spawner.spawnDefaultInto(pane);
  assert.equal("agent_mode" in requests.at(-1), false);
  assert.equal(pane.launchOptions, null);
});

// A layout with one replaceable focused pane, so the run* helpers fill it.
function withLayout(harness) {
  const pane = fakePane({ canReplace: true });
  const splits = [];
  harness.spawner = createSpawner({
    api: { createSession: async (body) => { harness.requests.push(body); return { id: "s", cwd: "C:\\work" }; } },
    state: harness.state,
    layout: {
      focused: pane,
      init: () => pane,
      autoDir: () => "h",
      splitPane: (source, dir) => { const next = fakePane(); splits.push({ source, dir, next }); return next; },
      focusPane() {},
    },
    ownSession() {}, scheduleWorkspaceSave() {}, refreshStatusSoon() {}, showError() {},
  });
  return { ...harness, pane, splits };
}

test("Codex launches in its modes and resumes or forks a chosen session", async () => {
  const codex = { name: "Codex", terminal_type: "codex" };
  const { spawner, requests, pane } = withLayout(spawnerHarness([codex]));
  await spawner.runAgentMode(codex, "fork");
  assert.equal(requests.at(-1).agent_mode, "fork");
  assert.equal("agent_session" in requests.at(-1), false);
  await spawner.resumeAgentSession(codex, SESSION, { fork: true });
  assert.deepEqual([requests.at(-1).agent_mode, requests.at(-1).agent_session], ["fork", SESSION]);
  // Restart and workspace restore repeat the same session.
  assert.deepEqual(pane.launchOptions, { agentMode: "fork", agentSession: SESSION });
  await spawner.restartSavedPane(pane);
  assert.deepEqual([requests.at(-1).agent_mode, requests.at(-1).agent_session], ["fork", SESSION]);
});

test("Claude resumes a chosen session and never forks one", async () => {
  const claude = { name: "Claude", terminal_type: "claude-code" };
  const { spawner, requests } = withLayout(spawnerHarness([claude]));
  await spawner.resumeAgentSession(claude, SESSION, { fork: true });
  assert.deepEqual([requests.at(-1).agent_mode, requests.at(-1).agent_session], ["resume", SESSION]);
  assert.equal(spawner.runClaudeMode, spawner.runAgentMode);
  assert.equal(spawner.splitClaudeAgentView, spawner.splitAgentView);
});

test("a resume starts in the folder its conversation was listed for", async () => {
  const claude = { name: "Claude", terminal_type: "claude-code" };
  const harness = withLayout(spawnerHarness([claude]));
  harness.state.scratchRoot = "C:\\scratch";
  // A named workspace: no folder from here, the backend resolves it by name.
  assert.equal(harness.spawner.agentSessionFolder(), null);
  await harness.spawner.resumeAgentSession(claude, SESSION);
  assert.equal(harness.requests.at(-1).cwd, undefined);
  // Scratch, before and after adoption: its throwaway root.
  for (const name of [null, "scratch"]) {
    harness.state.currentWorkspace = name;
    assert.equal(harness.spawner.agentSessionFolder(), "C:\\scratch");
    await harness.spawner.resumeAgentSession(claude, SESSION);
    assert.equal(harness.requests.at(-1).cwd, "C:\\scratch");
  }
  // A scratch view opened on a folder lists and resumes there.
  harness.state.scratchCwd = "C:\\proj";
  assert.equal(harness.spawner.agentSessionFolder(), "C:\\proj");
  await harness.spawner.resumeAgentSession(claude, SESSION);
  assert.equal(harness.requests.at(-1).cwd, "C:\\proj");
  assert.equal(harness.requests.at(-1).agent_session, SESSION);
});

test("the agent view splits beside the focused pane, and ordinary splits do not open it", async () => {
  const codex = { name: "Codex", terminal_type: "codex", agent_mode: "agents" };
  const harness = withLayout(spawnerHarness([codex]));
  await harness.spawner.splitAgentView(codex);
  assert.equal(harness.splits.length, 1);
  assert.equal(harness.requests.at(-1).agent_mode, "agents");
  harness.state.selectedTerminal = { kind: "profile", profile: codex };
  await harness.spawner.spawnSplitInto(fakePane(), harness.pane);
  assert.equal(harness.requests.at(-1).agent_mode, "continue");
  assert.equal(harness.requests.at(-1).cwd, undefined);
});

test("a dead Codex pane is recovered through its own continue", async () => {
  const codex = { name: "Codex", terminal_type: "codex" };
  const { spawner, requests } = spawnerHarness([codex]);
  const pane = fakePane({ profileName: "Codex", cwd: "C:\\work" });
  assert.equal(claudeProfileForPane([codex], pane), codex);
  await spawner.resumeClaudePane(pane);
  assert.equal(requests.at(-1).agent_mode, "continue");
  await spawner.resumeClaudePane(pane, "resume");
  assert.equal(requests.at(-1).agent_mode, "resume");
});

test("Codex is never the default system shell", () => {
  const inventory = {
    types: [
      { id: "codex", executable: "codex.exe", label: "Codex CLI" },
      { id: "claude-code", executable: "claude.exe", label: "Claude Code" },
      { id: "command-prompt", executable: "cmd.exe", label: "Command Prompt" },
    ],
  };
  assert.equal(defaultSystemSpec(inventory).terminalType, "command-prompt");
  assert.equal(defaultSystemSpec(inventory, "codex").terminalType, "command-prompt");
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
  const pane = fakePane({ launchOptions: { agentMode: "new" } });
  await spawner.spawnSpecInto(pane, { cmd: "pwsh.exe", args: ["-NoLogo"], name: "PowerShell" });
  assert.equal(pane.launchOptions, null);
  await spawner.restartSavedPane(pane);
  assert.equal(requests.at(-1).cmd, "pwsh.exe");
  assert.deepEqual(requests.at(-1).args, ["-NoLogo"]);
});
