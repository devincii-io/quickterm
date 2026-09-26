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
