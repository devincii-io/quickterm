// The Settings/Dashboard sheet: the type label the dashboard shows for a
// profile, and who gets Escape while a menu opened from the sheet is up.
import test from "node:test";
import assert from "node:assert/strict";

import { Panels, sheetKeyRoute, terminalTypeLabel } from "../../quickterm/frontend/js/panels.js";

const label = (profile) => Panels.prototype._terminalLabel.call({}, profile);

test("every launcher kind has its own label, not Custom command", () => {
  assert.equal(label({ cmd: "C:\\Program Files\\Git\\bin\\bash.exe" }), "Git Bash");
  assert.equal(label({ cmd: "nu" }), "Nushell");
  assert.equal(label({ cmd: "/bin/bash" }), "Bash");
  assert.equal(label({ cmd: "zsh" }), "Zsh");
  assert.equal(label({ cmd: "/usr/bin/fish" }), "Fish");
  assert.equal(label({ cmd: "x", terminal_type: "git-bash" }), "Git Bash");
  assert.equal(label({ cmd: "pwsh.exe" }), "PowerShell 7");
  assert.equal(label({ cmd: "htop" }), "Custom command");
  assert.equal(terminalTypeLabel("something-new"), "Custom command");
});

test("an open menu takes Escape and Tab from the sheet", () => {
  assert.equal(sheetKeyRoute("Escape", { menuOpen: true, inMenu: true }), "menu");
  assert.equal(sheetKeyRoute("Tab", { menuOpen: true, inMenu: true }), "menu");
  // Focus has left the menu: the sheet closes the menu, and only the menu.
  assert.equal(sheetKeyRoute("Escape", { menuOpen: true, inMenu: false }), "close-menu");
  assert.equal(sheetKeyRoute("Escape", { menuOpen: false, inMenu: false }), "sheet");
  assert.equal(sheetKeyRoute("Tab", { menuOpen: false, inMenu: false }), "sheet");
  assert.equal(sheetKeyRoute("a", { menuOpen: true, inMenu: false }), "none");
});
