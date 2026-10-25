// What the sidebar's "+" starts: the row picked last in its menu while the
// menu still has it, else the configured shell; and the administrator row.

import test from "node:test";
import assert from "node:assert/strict";

import { chosenRow, newTerminalMenu } from "../../quickterm/frontend/js/sidebar_model.js";

const shells = [
  { value: "powershell", label: "PowerShell", available: true },
  { value: "git-bash", label: "Git Bash", available: true },
];
const agents = [{ name: "claude-code", label: "Claude Code", terminal_type: "claude-code" }];

test("+ starts the configured shell until another row is picked", () => {
  const menu = newTerminalMenu({ inventory: { shells }, shell: "powershell", agents });
  assert.equal(chosenRow(menu, null).value, "powershell");
  assert.equal(chosenRow(menu, "shell:git-bash").label, "Git Bash");
  assert.equal(chosenRow(menu, "agent:claude-code").profile.name, "claude-code");
});

test("a remembered row the menu no longer has falls back to the configured shell", () => {
  const menu = newTerminalMenu({ inventory: { shells }, shell: "powershell", agents: [] });
  assert.equal(chosenRow(menu, "profile:gone").value, "powershell");
  assert.equal(chosenRow(menu, "agent:claude-code").value, "powershell");
  // Neither a separator nor a row from before 4.5 is ever a choice.
  assert.equal(chosenRow(menu, "settings").value, "powershell");
  assert.equal(chosenRow(menu, "separator:admin").value, "powershell");
  // A WSL or SSH workspace has no local shells: its own shell row answers.
  const remote = newTerminalMenu({ inventory: { shells }, agents, host: "prod" });
  assert.equal(chosenRow(remote, "shell:git-bash").kind, "remote-shell");
  assert.equal(chosenRow(remote, "agent:claude-code").kind, "agent");
});

test("the administrator row is the sidebar's, local only, last", () => {
  const plain = newTerminalMenu({ inventory: { shells }, shell: "powershell", agents });
  assert.equal(plain.some((row) => row.kind === "admin"), false, "the palette's rows carry none");
  const sidebar = newTerminalMenu({ inventory: { shells }, shell: "powershell", agents, admin: true });
  assert.deepEqual(sidebar.slice(-2).map((row) => row.kind), ["separator", "admin"]);
  const remote = newTerminalMenu({ inventory: { shells }, agents, host: "prod", admin: true });
  assert.equal(remote.some((row) => row.kind === "admin"), false);
  const wsl = newTerminalMenu({ inventory: { shells }, agents, host: "wsl:Ubuntu", admin: true });
  assert.equal(wsl.some((row) => row.kind === "admin"), false);
});
