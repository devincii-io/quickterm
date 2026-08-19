// The rules the Settings screens state about a configured thing: what it
// actually runs, and what is wrong with it. These are pure functions on the
// draft config, so they are testable without a DOM, and they are the part that
// must not quietly disagree with the backend validation in config.py.

import test from "node:test";
import assert from "node:assert/strict";

import { commandPreview, snippetProblems } from "../../quickterm/frontend/js/panel_settings_snippets.js";
import { profileProblems, purposeFor, runLine } from "../../quickterm/frontend/js/panel_settings_terminals.js";
import { FILTER_THRESHOLD, matchesQuery } from "../../quickterm/frontend/js/panel_settings_kit.js";

test("a snippet preview hides the carriage return that runs it", () => {
  assert.equal(commandPreview("git status\r"), "git status");
  assert.equal(commandPreview(""), "no command yet");
  assert.equal(commandPreview("one\ntwo\nthree\r"), "one … (+2 more)");
});

test("a snippet reports its own missing name, command and duplicate", () => {
  const named = { name: "build", text: "npm run build\r" };
  const twin = { name: "BUILD", text: "make\r" };
  assert.deepEqual(snippetProblems(named, [named]), []);
  assert.match(snippetProblems(named, [named, twin])[0], /Names must be unique/);
  assert.match(snippetProblems({ name: "", text: "x\r" }, [])[0], /no name/);
  assert.match(snippetProblems({ name: "x", text: "\r" }, [])[0], /no command/);
});

test("a profile's run line reflects what was typed, per kind", () => {
  assert.equal(
    runLine({ cmd: "claude", claude_mode: "agents" }, "claude-code"),
    "claude agents",
  );
  assert.equal(
    runLine({ cmd: "wsl.exe", wsl_distro: "Ubuntu" }, "wsl"),
    "wsl.exe -d Ubuntu --cd ~",
  );
  assert.equal(
    runLine({ ssh_host: "box", ssh_user: "deploy", ssh_port: 2222 }, "ssh"),
    "plink -ssh -P 2222 deploy@box",
  );
  assert.equal(
    runLine({ cmd: "pwsh.exe", args: ["-NoLogo"], start_command: "uv run dev" }, "powershell-core"),
    "pwsh.exe -NoLogo · then uv run dev",
  );
  // Claude takes no start command, so the line must not imply one runs.
  assert.equal(runLine({ cmd: "claude", start_command: "ignored" }, "claude-code"), "claude --continue");
});

test("a profile reports the problem that would stop it from starting", () => {
  const ok = { name: "Dev", cmd: "pwsh.exe", env: {} };
  assert.deepEqual(profileProblems(ok, [ok], "powershell-core"), []);
  assert.match(profileProblems({ name: "", cmd: "x", env: {} }, [], "custom")[0], /no name/);
  assert.match(profileProblems({ name: "a", cmd: "", env: {} }, [], "custom")[0], /No executable/);
  assert.match(profileProblems({ name: "a", cmd: "", env: {} }, [], "ssh")[0], /No host/);
  const clash = { name: "dev", cmd: "x", env: {} };
  assert.match(profileProblems(ok, [ok, clash], "custom")[1] || profileProblems(ok, [ok, clash], "custom")[0], /unique/);
  // The environment rule is the shared one, not a second copy of it.
  assert.match(
    profileProblems({ name: "a", cmd: "x", env: { "A=B": "1" } }, [], "custom")[0],
    /environment variable name/i,
  );
});

test("every kind of profile has a purpose sentence, including unknown ones", () => {
  for (const kind of ["claude-code", "wsl", "ssh", "sftp", "custom", "powershell-core", "nushell"]) {
    assert.ok(purposeFor(kind).length > 40, kind);
  }
});

test("filtering searches every field and only appears for a list worth filtering", () => {
  assert.ok(FILTER_THRESHOLD >= 4);
  assert.ok(matchesQuery("", "anything"));
  assert.ok(matchesQuery("LOG", "tail logs", "Follow the app log"));
  assert.ok(matchesQuery("follow", "tail logs", "Follow the app log"));
  assert.ok(!matchesQuery("deploy", "tail logs", "Follow the app log"));
});
