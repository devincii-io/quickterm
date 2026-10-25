import test from "node:test";
import assert from "node:assert/strict";

import {
  launchOptions, launchOptionsFromNode, launchOptionsToNode, repeatLaunchOptions,
} from "../../quickterm/frontend/js/launch_options.js";
import {
  claudeProfileForPane, createSpawner, legacyAgentSpec, serializableSpec,
} from "../../quickterm/frontend/js/spawner.js";

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
  const state = { cfg: { shell: "powershell" }, profiles, currentWorkspace: "proj", terminalInventory: null };
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
  const profiles = [{ name: "claude-code", terminal_type: "claude-code" }];
  const { spawner, requests } = spawnerHarness(profiles);
  const pane = fakePane();
  await spawner.spawnInto(pane, "claude-code", null, { claudeMode: "new" });
  assert.deepEqual(pane.launchOptions, { agentMode: "new" });
  await spawner.restartSavedPane(pane);
  assert.equal(requests.at(-1).agent_mode, "new");
  assert.equal("claude_mode" in requests.at(-1), false);
  assert.equal(requests.at(-1).profile, "claude-code");
  assert.equal(requests.at(-1).cwd, "C:\\work");
});

test("a new terminal with no profile is the configured shell, whatever the pane held", async () => {
  const profiles = [{ name: "claude-code", terminal_type: "claude-code" }];
  const { spawner, requests, state } = spawnerHarness(profiles);
  state.cfg.shell = "wsl:Ubuntu";
  const pane = fakePane({ profileName: "Claude", launchOptions: { agentMode: "new" } });
  await spawner.spawnDefaultInto(pane, "C:\\here");
  assert.deepEqual(requests.at(-1), { cwd: "C:\\here", workspace: "proj" });
  assert.equal(pane.launchOptions, null);
  assert.equal(pane.profileName, null);
  assert.equal(pane.launchSpec, null, "the backend resolves the configured shell on every start");
  assert.equal(pane.terminalType, "wsl");
  await spawner.restartSavedPane(pane);
  assert.equal("shell" in requests.at(-1), false);
});

test("a shell from the + menu is remembered by its value", async () => {
  const { spawner, requests } = spawnerHarness([]);
  const pane = fakePane();
  await spawner.spawnShellInto(pane, null, "git-bash");
  assert.equal(requests.at(-1).shell, "git-bash");
  assert.deepEqual(pane.launchSpec, { shell: "git-bash", name: "Git Bash", terminal_type: "git-bash" });
  await spawner.restartSavedPane(pane);
  assert.equal(requests.at(-1).shell, "git-bash");
  assert.equal("cmd" in requests.at(-1), false);
  assert.deepEqual(serializableSpec({ shell: "cmd", cwd: "C:\\w" }),
    { shell: "cmd", name: "Command Prompt", cwd: "C:\\w", terminal_type: "command-prompt" });
});

test("Claude Code and Codex start from their settings under their kind's name", async () => {
  const { spawner, requests, state } = spawnerHarness([]);
  state.cfg.agents = { "claude-code": { agent_mode: "new" }, codex: {} };
  assert.equal(spawner.profileTerminalType("claude-code"), "claude-code");
  assert.equal(spawner.profileByName("codex").label, "Codex");
  const pane = fakePane();
  await spawner.spawnInto(pane, "codex", null, { agentMode: "continue" });
  assert.equal(requests.at(-1).profile, "codex");
  assert.equal(requests.at(-1).agent_mode, "continue");
  assert.equal(pane.terminalType, "codex");
});

test("a dead pane of a migrated agent profile still offers continue and choose session", async () => {
  const { spawner, requests } = spawnerHarness([{ name: "Box", terminal_type: "ssh" }]);
  const migrated = fakePane({ profileName: "Claude New", cwd: "C:\\work" });
  const agent = claudeProfileForPane(spawner.allProfiles(), migrated);
  assert.equal(agent?.name, "claude-code", "the gone profile's name names the agent");
  assert.equal(claudeProfileForPane([{ name: "Box", terminal_type: "ssh" }], migrated), null,
    "saved profiles alone know nothing about it");
  await spawner.resumeClaudePane(migrated, "resume");
  assert.deepEqual([requests.at(-1).profile, requests.at(-1).agent_mode], ["claude-code", "resume"]);
  // A 4.3 agent pane is found by its own profile, a renamed one by its type.
  assert.equal(claudeProfileForPane(spawner.allProfiles(), fakePane({ profileName: "codex" }))?.name, "codex");
  const typed = fakePane({ profileName: "Reviewer", terminalType: "codex" });
  assert.equal(claudeProfileForPane(spawner.allProfiles(), typed)?.name, "codex");
  assert.equal(claudeProfileForPane(spawner.allProfiles(), fakePane({ profileName: "Box" })), null);
});

test("a pane saved with a profile that is gone opens the shell instead", async () => {
  const { spawner, requests } = spawnerHarness([]);
  const notices = [];
  const pane = fakePane({ flashNotice: (text) => notices.push(text) });
  await spawner.spawnInto(pane, "Windows PowerShell", null);
  assert.equal("profile" in requests.at(-1), false);
  assert.match(notices[0], /"Windows PowerShell" no longer exists/);
});

test("a 4.2 built-in agent pane comes back through the agent settings", async () => {
  assert.deepEqual(legacyAgentSpec({ cmd: "claude.exe", args: ["--continue"], terminal_type: "claude-code" }),
    { kind: "claude-code", mode: "continue" });
  assert.deepEqual(legacyAgentSpec({ cmd: "codex.exe", args: ["resume", "--last"], terminal_type: "codex" }),
    { kind: "codex", mode: "continue" });
  assert.equal(legacyAgentSpec({ cmd: "pwsh.exe", args: [] }), null);
  const { spawner, requests } = spawnerHarness([]);
  await spawner.spawnSpecInto(fakePane(), { cmd: "claude.exe", args: [], terminal_type: "claude-code" });
  assert.deepEqual([requests.at(-1).profile, requests.at(-1).agent_mode], ["claude-code", "new"]);
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
  const codex = { name: "codex", terminal_type: "codex" };
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
  const claude = { name: "claude-code", terminal_type: "claude-code" };
  const { spawner, requests } = withLayout(spawnerHarness([claude]));
  await spawner.resumeAgentSession(claude, SESSION, { fork: true });
  assert.deepEqual([requests.at(-1).agent_mode, requests.at(-1).agent_session], ["resume", SESSION]);
  assert.equal(spawner.runClaudeMode, spawner.runAgentMode);
  assert.equal(spawner.splitClaudeAgentView, spawner.splitAgentView);
});

test("a resume starts in the folder its conversation was listed for", async () => {
  const claude = { name: "claude-code", terminal_type: "claude-code" };
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
  const codex = { name: "codex", terminal_type: "codex", agent_mode: "agents" };
  const harness = withLayout(spawnerHarness([codex]));
  await harness.spawner.splitAgentView(codex);
  assert.equal(harness.splits.length, 1);
  assert.equal(harness.requests.at(-1).agent_mode, "agents");
  await harness.spawner.spawnSplitInto(fakePane(), harness.pane);
  assert.equal("agent_mode" in harness.requests.at(-1), false);
  assert.equal("profile" in harness.requests.at(-1), false, "a split starts the shell");
});

test("a dead Codex pane is recovered through its own continue", async () => {
  const codex = { name: "codex", terminal_type: "codex" };
  const { spawner, requests } = spawnerHarness([codex]);
  const pane = fakePane({ profileName: "codex", cwd: "C:\\work" });
  assert.equal(claudeProfileForPane([codex], pane), codex);
  await spawner.resumeClaudePane(pane);
  assert.equal(requests.at(-1).agent_mode, "continue");
  await spawner.resumeClaudePane(pane, "resume");
  assert.equal(requests.at(-1).agent_mode, "resume");
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
