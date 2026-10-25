import test from "node:test";
import assert from "node:assert/strict";

import { defaultShellRow, newTerminalMenu } from "../../quickterm/frontend/js/launcher.js";
import { chosenRow } from "../../quickterm/frontend/js/sidebar_model.js";
import { agentProfile, agentProfiles, agentCommandLine } from "../../quickterm/frontend/js/agent_profile.js";
import { availableShells, shellTerminalType, shellValueLabel } from "../../quickterm/frontend/js/shell_choice.js";

const shells = [
  { value: "powershell", label: "PowerShell", available: true },
  { value: "cmd", label: "Command Prompt", available: true },
  { value: "git-bash", label: "Git Bash", available: true },
  { value: "wsl:Ubuntu", label: "WSL: Ubuntu", available: true },
];
const inventory = {
  types: [
    { id: "claude-code", label: "Claude Code", executable: "C:\\bin\\claude.exe", available: true },
    { id: "codex", label: "Codex CLI", executable: null, available: false },
  ],
  shells,
};

test("a local + menu is the shells, a separator, the agents, a separator, As administrator", () => {
  const agents = agentProfiles({ agents: {} }, inventory);
  const menu = newTerminalMenu({ inventory, shell: "cmd", agents, admin: true });
  assert.deepEqual(menu.map((row) => row.kind), [
    "shell", "shell", "shell", "shell", "separator", "agent", "separator", "admin",
  ]);
  assert.deepEqual(menu.filter((row) => row.kind === "shell").map((row) => row.label),
    ["PowerShell", "Command Prompt", "Git Bash", "WSL: Ubuntu"]);
  assert.deepEqual(menu.filter((row) => row.isDefault).map((row) => row.value), ["cmd"]);
  assert.equal(menu[5].label, "Claude Code", "Codex is not installed, so it is not offered");
  assert.equal(menu.some((row) => /settings|saved terminal|profile/i.test(row.label || "")), false);
  assert.equal(defaultShellRow(menu).value, "cmd");
});

test("a WSL or SSH workspace's + menu: the shell there, the agents, no local shells and no administrator", () => {
  const agents = [{ name: "claude-code", label: "Claude Code" }, { name: "codex", label: "Codex" }];
  for (const [host, label] of [["wsl:Ubuntu", "Shell in WSL: Ubuntu"], ["devbox", "Shell in devbox"], ["me@10.0.0.5", "Shell in me@10.0.0.5"]]) {
    const menu = newTerminalMenu({ inventory, shell: "cmd", agents, host, admin: true });
    assert.deepEqual(menu.map((row) => row.label || row.kind), [label, "separator", "Claude Code", "Codex"], host);
    assert.equal(defaultShellRow(menu).kind, "remote-shell");
    // A remembered local shell is not offered there: "+" starts the shell there.
    assert.equal(chosenRow(menu, "shell:git-bash").kind, "remote-shell");
    assert.equal(chosenRow(menu, "agent:codex").label, "Codex");
  }
});

test("a remembered row from before 4.5 (a saved terminal) falls back to the configured shell", () => {
  const menu = newTerminalMenu({ inventory, shell: "cmd", agents: [] });
  assert.equal(chosenRow(menu, "profile:prod").value, "cmd");
  assert.equal(chosenRow(menu, "settings").value, "cmd");
});

test("with nothing to launch but shells, no empty band sits between the separators", () => {
  const menu = newTerminalMenu({ inventory: { shells }, shell: "powershell", agents: [], admin: true });
  assert.deepEqual(menu.map((row) => row.kind), ["shell", "shell", "shell", "shell", "separator", "admin"]);
  assert.deepEqual(newTerminalMenu({ inventory: { shells }, shell: "powershell" }).map((row) => row.kind),
    ["shell", "shell", "shell", "shell"], "the admin instance ends with the shells");
});

test("an inventory cached by an older build still offers the configured shell", () => {
  const menu = newTerminalMenu({ inventory: { types: [] }, shell: "git-bash", agents: [] });
  assert.deepEqual(menu[0], { key: "shell:git-bash", kind: "shell", value: "git-bash", label: "Git Bash", isDefault: true });
  assert.deepEqual(availableShells({ shells: [{ value: "cmd", available: false }] }, "powershell").map((e) => e.value),
    ["powershell"]);
});

test("shell values name themselves and say how a pane behaves", () => {
  assert.equal(shellValueLabel("wsl:Debian"), "WSL: Debian");
  assert.equal(shellValueLabel("cmd"), "Command Prompt");
  assert.equal(shellTerminalType("wsl:Debian"), "wsl");
  assert.equal(shellTerminalType("wsl"), "wsl");
  assert.equal(shellTerminalType("cmd"), "command-prompt");
  assert.equal(shellTerminalType(""), "bash");
});

test("the agents are settings, launched under their kind's name", () => {
  const claude = agentProfile("claude-code", { agent_mode: "new", agent: { model: "haiku" } });
  assert.equal(claude.name, "claude-code");
  assert.equal(claude.label, "Claude Code");
  assert.equal(claude.terminal_type, "claude-code");
  assert.equal(claude.builtin, true);
  // An executable of its own counts as installed even when PATH has none.
  const codex = agentProfiles({ agents: { codex: { cmd: "D:\\tools\\codex.exe" } } }, inventory);
  assert.deepEqual(codex.map((profile) => profile.name), ["claude-code", "codex"]);
});

test("an agent's settings row shows the command line they start", () => {
  const options = [{ key: "model", flag: "--model" }, { key: "add_dirs", flag: "--add-dir" }, { key: "verbose", flag: "--verbose" }];
  assert.equal(agentCommandLine("claude-code", {}), "claude --continue");
  assert.equal(
    agentCommandLine("claude-code", {
      agent_mode: "new", agent: { model: "haiku", add_dirs: "C:\\a\nC:\\b b", verbose: "true" }, args: ["--debug"],
    }, options),
    'claude --model haiku --add-dir C:\\a --add-dir "C:\\b b" --verbose --debug',
  );
  assert.equal(agentCommandLine("codex", { cmd: "codex.exe", agent_mode: "continue" }), "codex.exe resume --last");
});

test("the Settings shell picker lists the installed shells and keeps a saved one it does not list", async () => {
  const { shellOptions } = await import("../../quickterm/frontend/js/panel_settings_general.js");
  assert.deepEqual(shellOptions({ shells }, "cmd").map((option) => option.value),
    ["powershell", "cmd", "git-bash", "wsl:Ubuntu"]);
  assert.deepEqual(shellOptions({ shells }, "wsl:Gone").at(-1), { value: "wsl:Gone", label: "WSL: Gone" });
});
