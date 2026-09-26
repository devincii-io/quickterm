// The rules the Settings screens state about a configured thing: what it
// actually runs, and what is wrong with it. These are pure functions on the
// draft config, so they are testable without a DOM, and they are the part that
// must not quietly disagree with the backend validation in config.py.

import test from "node:test";
import assert from "node:assert/strict";

import { commandPreview, snippetProblems } from "../../quickterm/frontend/js/panel_settings_snippets.js";
import {
  commandLineText, defaultArgsFor, fitsCommandLine, joinCommandLine, kindForCommand, moreStartsOpen,
  profileProblems, purposeFor, runLine, splitCommandLine, takesStartCommand,
} from "../../quickterm/frontend/js/panel_settings_terminals.js";
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

test("a custom command line splits on spaces, groups on quotes and joins back the same", () => {
  assert.deepEqual(splitCommandLine("python -m http.server"), ["python", "-m", "http.server"]);
  assert.deepEqual(
    splitCommandLine("\"C:\\Program Files\\Tool\\t.exe\"  --name \"a b\" \"\""),
    ["C:\\Program Files\\Tool\\t.exe", "--name", "a b", ""],
  );
  assert.deepEqual(splitCommandLine("   "), []);
  for (const parts of [["python", "-m", "http.server"], ["C:\\Program Files\\x.exe", "a b", ""], ["tool"]]) {
    assert.deepEqual(splitCommandLine(joinCommandLine(parts)), parts);
  }
  assert.equal(commandLineText({ cmd: "", args: [] }), "");
  assert.equal(commandLineText({ cmd: "C:\\a b\\x.exe", args: ["-v"] }), "\"C:\\a b\\x.exe\" -v");
  // A quote inside a part has no spelling there, so such a profile keeps
  // its executable and arguments apart.
  assert.equal(fitsCommandLine(["x", "say \"hi\""]), false);
  assert.equal(fitsCommandLine(["x", "a b"]), true);
});

test("a typed command infers its kind from where the card started, never from the last keystroke", () => {
  // A shell card follows its command, to another shell or to custom.
  assert.equal(kindForCommand("powershell-core", "C"), "custom");
  assert.equal(kindForCommand("powershell-core", "C:\\Program Files\\PowerShell\\7\\pwsh.exe"), "powershell-core");
  assert.equal(kindForCommand("powershell-core", "nu"), "nushell");
  // A custom card becomes a shell only when the command names one.
  assert.equal(kindForCommand("custom", "bash"), "bash");
  assert.equal(kindForCommand("custom", "python"), "custom");
  // Claude Code is opt-in and remote kinds are a host, not a command.
  assert.equal(kindForCommand("custom", "claude"), "custom");
  assert.equal(kindForCommand("claude-code", "C:\\bin\\claude.exe"), "claude-code");
  assert.equal(kindForCommand("claude-code", "pwsh"), "powershell-core");
  assert.equal(kindForCommand("custom", "plink"), "custom");
  assert.equal(kindForCommand("wsl", "plink"), "custom");
  // bash drops the profile's arguments at launch, so bash with arguments
  // stays a custom command that keeps them.
  assert.equal(kindForCommand("custom", "bash", ["-c", "make"]), "custom");
});

test("the kinds that take a start command are the ones launch.py starts one in", () => {
  for (const kind of ["powershell-core", "windows-powershell", "command-prompt", "wsl", "bash", "git-bash", "nushell", "ssh"]) {
    assert.equal(takesStartCommand(kind), true, kind);
  }
  for (const kind of ["custom", "sftp", "claude-code"]) assert.equal(takesStartCommand(kind), false, kind);
  assert.deepEqual(defaultArgsFor("powershell-core"), ["-NoLogo"]);
  assert.deepEqual(defaultArgsFor("git-bash"), []);
  // The run line does not promise a start command a custom command never runs.
  assert.equal(runLine({ cmd: "python", args: ["app.py"], start_command: "x" }, "custom"), "python app.py");
});

test("More starts open for a problem or a type the command does not show", () => {
  const ok = { cmd: "C:\\Windows\\System32\\cmd.exe", args: [] };
  assert.equal(moreStartsOpen(ok, "command-prompt", []), false);
  assert.equal(moreStartsOpen(ok, "command-prompt", ["No name"]), true);
  assert.equal(moreStartsOpen({ cmd: "pwsh.exe", args: [] }, "custom"), true);
  assert.equal(moreStartsOpen({ cmd: "python.exe", args: [] }, "powershell-core"), true);
  assert.equal(moreStartsOpen({ cmd: "python.exe", args: ["x"] }, "custom"), false);
  // These say what they are in the main row and the run line.
  assert.equal(moreStartsOpen({ cmd: "C:\\bin\\claude.exe", args: [] }, "claude-code"), false);
  assert.equal(moreStartsOpen({ cmd: "", args: [] }, "ssh"), false);
});
