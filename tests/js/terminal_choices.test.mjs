import test from "node:test";
import assert from "node:assert/strict";

import { canLaunch, terminalChoices } from "../../quickterm/frontend/js/launcher.js";

const inventory = {
  types: [
    { id: "windows-powershell", label: "Windows PowerShell", executable: "powershell.exe", available: true },
    { id: "powershell-core", label: "PowerShell 7", executable: null, available: false },
  ],
  wsl_distributions: [],
  installs: [
    {
      id: "powershell-core",
      label: "PowerShell 7",
      cmd: "C:\\apps\\winget.exe",
      args: ["install", "--id", "Microsoft.PowerShell", "--exact", "--source", "winget"],
      url: null,
    },
  ],
};

test("a missing shell with an install offer is a menu row of its own, last", () => {
  const choices = terminalChoices({ profiles: [], inventory });
  assert.deepEqual(choices.map((choice) => choice.key), [
    "system:windows-powershell",
    "install:powershell-core",
  ]);
  const install = choices.at(-1);
  assert.equal(install.group, "Install");
  assert.equal(install.detail, "install with winget");
  assert.deepEqual(install.args, inventory.installs[0].args);
});

test("an install row is never what a new terminal starts", () => {
  const [shell, install] = terminalChoices({ profiles: [], inventory });
  assert.equal(canLaunch(shell), true);
  assert.equal(canLaunch(install), false);
  assert.equal(canLaunch(null), false);
});

test("without winget the row opens the download page", () => {
  const offer = { ...inventory.installs[0], cmd: null, args: [], url: "https://example.invalid/pwsh" };
  const [, install] = terminalChoices({ profiles: [], inventory: { ...inventory, installs: [offer] } });
  assert.equal(install.detail, "open the download page");
  assert.equal(install.url, offer.url);
});

test("an inventory from before installs existed has no install rows", () => {
  const { installs: _gone, ...older } = inventory;
  assert.equal(terminalChoices({ profiles: [], inventory: older }).some((c) => !canLaunch(c)), false);
});

test("an agent profile names its mode, agent_mode first and claude_mode as the fallback", () => {
  const detail = (profile) => terminalChoices({ profiles: [{ name: "p", cmd: "", ...profile }] })[0].detail;
  assert.equal(detail({ terminal_type: "claude-code" }), "Claude Code · continue latest");
  assert.equal(detail({ terminal_type: "claude-code", claude_mode: "resume" }), "Claude Code · choose session");
  assert.equal(detail({ terminal_type: "claude-code", claude_mode: "agents" }), "Claude Code · agent manager");
  // Saved by 4.0, which writes both: agent_mode wins.
  assert.equal(detail({ terminal_type: "claude-code", agent_mode: "new", claude_mode: "resume" }), "Claude Code · new conversation");
  assert.equal(detail({ terminal_type: "codex" }), "Codex · new conversation");
  assert.equal(detail({ terminal_type: "codex", agent_mode: "continue" }), "Codex · continue latest");
  assert.equal(detail({ terminal_type: "codex", agent_mode: "fork" }), "Codex · fork a session");
  assert.equal(detail({ terminal_type: "codex", agent_mode: "agents" }), "Codex · agent manager");
  // A description still beats the generated label.
  assert.equal(detail({ terminal_type: "codex", description: "reviews" }), "reviews");
});

test("ssh and sftp read as the target for either client", () => {
  const detail = (profile) => terminalChoices({ profiles: [{ name: "p", cmd: "", ...profile }] })[0].detail;
  assert.equal(detail({ terminal_type: "ssh", ssh_host: "box", ssh_user: "me" }), "SSH · me@box");
  assert.equal(detail({ terminal_type: "ssh", ssh_host: "box", ssh_client: "openssh" }), "SSH · box");
  assert.equal(detail({ terminal_type: "sftp", ssh_host: "box" }), "SFTP · box");
  assert.equal(detail({ terminal_type: "ssh" }), "SSH");
  assert.equal(detail({ terminal_type: "sftp" }), "SFTP");
});

test("an installed Codex CLI is offered like Claude, never as a plain shell", () => {
  const found = {
    types: [
      { id: "codex", label: "Codex CLI", executable: "C:\\bin\\codex.exe", available: true },
      { id: "claude-code", label: "Claude Code", executable: "claude", available: true },
    ],
  };
  const choices = terminalChoices({ profiles: [], inventory: found });
  assert.equal(choices.some((choice) => choice.key === "system:codex"), false);
  const codex = choices.filter((choice) => choice.id === "codex");
  assert.deepEqual(codex.map((choice) => choice.key), ["codex:new", "codex:continue", "codex:resume"]);
  assert.deepEqual(codex.map((choice) => choice.label),
    ["Codex · new conversation", "Codex · continue latest", "Codex · choose session"]);
  assert.deepEqual(codex[1].args, ["resume", "--last"]);
  assert.equal(codex[0].cmd, "C:\\bin\\codex.exe");
  assert.equal(codex[0].mode, "new");
  assert.deepEqual(choices.filter((choice) => choice.id === "claude-code").map((choice) => choice.key),
    ["claude:continue", "claude:new", "claude:resume"]);
  const missing = { types: [{ id: "codex", label: "Codex CLI", executable: null, available: false }] };
  assert.deepEqual(terminalChoices({ profiles: [], inventory: missing }), []);
});

test("the configured launcher exposes only saved terminal configurations", () => {
  const local = { name: "Console", cmd: "cmd.exe", terminal_type: "command-prompt" };
  const desktop = { name: "Desktop", cmd: "", terminal_type: "rdp", connection: { host: "server" } };
  const inventory = { types: [{ id: "claude-code", executable: "claude", available: true }, { id: "wsl", executable: "wsl.exe", available: true }] };
  assert.deepEqual(terminalChoices({ configuredOnly: true, profiles: [], inventory }), []);
  assert.deepEqual(terminalChoices({ configuredOnly: true, profiles: [local, desktop], inventory }).map((item) => item.label), ["Console"]);
});
