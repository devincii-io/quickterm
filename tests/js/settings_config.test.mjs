// The rules the Settings screens state about a configured thing: what it
// actually runs, and what is wrong with it. These are pure functions on the
// draft config, so they are testable without a DOM, and they are the part that
// must not quietly disagree with the backend validation.

import test from "node:test";
import assert from "node:assert/strict";

import { commandPreview, snippetProblems } from "../../quickterm/frontend/js/panel_settings_snippets.js";
import {
  agentConflicts, commandLineText, defaultArgsFor, fitsCommandLine, joinCommandLine,
  kindForCommand, purposeFor, runLine, splitCommandLine, sshProblems, takesStartCommand,
} from "../../quickterm/frontend/js/profile_model.js";
import { matchesQuery } from "../../quickterm/frontend/js/panel_settings_kit.js";
import { agentModeOf } from "../../quickterm/frontend/js/agent_profile.js";
import { connectionProblems } from "../../quickterm/frontend/js/panel_connections.js";

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
  assert.equal(runLine({ cmd: "claude", claude_mode: "agents" }, "claude-code"), "claude agents");
  assert.equal(runLine({ cmd: "claude", agent_mode: "resume", claude_mode: "agents" }, "claude-code"), "claude --resume");
  assert.equal(runLine({ cmd: "" }, "codex"), "codex", "codex starts a new conversation by default");
  assert.equal(runLine({ cmd: "codex", agent_mode: "continue" }, "codex"), "codex resume --last");
  assert.equal(runLine({ cmd: "codex", agent_mode: "fork" }, "codex"), "codex fork");
  assert.equal(runLine({ cmd: "wsl.exe", wsl_distro: "Ubuntu" }, "wsl"), "wsl.exe -d Ubuntu --cd ~");
  assert.equal(
    runLine({ ssh_host: "box", ssh_user: "deploy", ssh_port: 2222 }, "ssh"),
    "plink -ssh -P 2222 deploy@box",
    "no client means PuTTY, as every profile before 4.0",
  );
  assert.equal(
    runLine({ ssh_host: "box", ssh_port: 2222, ssh_client: "openssh", ssh_proxy_jump: "jump" }, "ssh"),
    "ssh -p 2222 -J jump box",
  );
  assert.equal(runLine({ ssh_host: "box", ssh_port: 2222, ssh_client: "openssh" }, "sftp"), "sftp -P 2222 box");
  assert.equal(
    runLine({ cmd: "pwsh.exe", args: ["-NoLogo"], start_command: "uv run dev" }, "powershell-core"),
    "pwsh.exe -NoLogo · then uv run dev",
  );
  // Agents take no start command, so the line must not imply one runs.
  assert.equal(runLine({ cmd: "claude", start_command: "ignored" }, "claude-code"), "claude --continue");
});

test("the agent mode reads agent_mode, then the legacy claude_mode, then the type's default", () => {
  assert.equal(agentModeOf({ agent_mode: "fork" }, "codex"), "fork");
  assert.equal(agentModeOf({ claude_mode: "resume" }, "claude-code"), "resume");
  assert.equal(agentModeOf({}, "claude-code"), "continue");
  assert.equal(agentModeOf({}, "codex"), "new");
});

test("a profile reports the problem that would stop it from starting", () => {
  const ok = { name: "Dev", cmd: "pwsh.exe", terminal_type: "powershell-core", env: {} };
  assert.deepEqual(connectionProblems(ok, [ok]), []);
  assert.match(connectionProblems({ name: "", cmd: "x", terminal_type: "custom", env: {} }, [])[0], /Enter a name/);
  assert.match(connectionProblems({ name: "a", cmd: "", terminal_type: "custom", env: {} }, [])[0], /client executable/);
  assert.match(connectionProblems({ name: "a", cmd: "", terminal_type: "ssh", env: {} }, [])[0], /Enter a host/);
  const clash = { name: "dev", cmd: "x", env: {} };
  assert.match(connectionProblems(ok, [ok, clash])[0], /already used/);
  // The environment rule is the shared one, not a second copy of it.
  assert.match(
    connectionProblems({ name: "a", cmd: "x", terminal_type: "custom", env: { "A=B": "1" } }, [])[0],
    /environment variable name/i,
  );
});

test("ssh fields refuse what the server refuses", () => {
  assert.deepEqual(sshProblems({ ssh_host: "box", ssh_user: "me" }), []);
  assert.match(sshProblems({ ssh_host: "-oProxyCommand=x" })[0], /Host must not start with -/);
  assert.match(sshProblems({ ssh_host: "box", ssh_client: "openssh", ssh_user: "a b" })[0], /User must not contain spaces/);
  // PuTTY takes a saved-session name as host; 3.x profiles keep loading.
  assert.deepEqual(sshProblems({ ssh_host: "Prod Server", ssh_user: "John Smith" }), []);
  assert.equal(sshProblems({ ssh_host: "box", ssh_proxy_jump: "bastion" })[0], "ProxyJump needs the OpenSSH client");
  assert.deepEqual(sshProblems({ ssh_host: "box", ssh_client: "openssh", ssh_proxy_jump: "me@bastion:22,other" }), []);
  assert.match(sshProblems({ ssh_host: "box", ssh_client: "openssh", ssh_proxy_jump: "-J x" })[0], /ProxyJump must be/);
  assert.match(sshProblems({ ssh_host: "box", ssh_client: "openssh", ssh_key: "C:\\k\\id.PPK" })[0], /OpenSSH cannot read PuTTY \.ppk keys/);
  assert.deepEqual(sshProblems({ ssh_host: "box", ssh_client: "putty", ssh_key: "C:\\k\\id.ppk" }), []);
});

test("codex bypass cannot be combined with approval or sandbox", () => {
  assert.deepEqual(agentConflicts("codex", { bypass: "true" }), []);
  assert.deepEqual(agentConflicts("codex", { bypass: "true", sandbox: "read-only" }), ["bypass replaces approval and sandbox; clear them first"]);
  assert.equal(agentConflicts("codex", { bypass: "true", approve_for_me: "true" }).length, 1);
  assert.deepEqual(agentConflicts("claude-code", { bypass: "true", sandbox: "x" }), []);
});

test("every kind of profile has a purpose sentence, including unknown ones", () => {
  for (const kind of ["claude-code", "codex", "wsl", "ssh", "sftp", "custom", "powershell-core", "nushell"]) {
    assert.ok(purposeFor(kind).length > 40, kind);
  }
});

test("filtering searches every field", () => {
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

test("a typed command infers its kind from where the editor started, never from the last keystroke", () => {
  // A shell follows its command, to another shell or to custom.
  assert.equal(kindForCommand("powershell-core", "C"), "custom");
  assert.equal(kindForCommand("powershell-core", "C:\\Program Files\\PowerShell\\7\\pwsh.exe"), "powershell-core");
  assert.equal(kindForCommand("powershell-core", "nu"), "nushell");
  // A custom command becomes a shell only when the command names one.
  assert.equal(kindForCommand("custom", "bash"), "bash");
  assert.equal(kindForCommand("custom", "python"), "custom");
  // Agents are opt-in and remote kinds are a host, not a command.
  assert.equal(kindForCommand("custom", "claude"), "custom");
  assert.equal(kindForCommand("custom", "codex"), "custom");
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
  for (const kind of ["custom", "sftp", "claude-code", "codex"]) assert.equal(takesStartCommand(kind), false, kind);
  assert.deepEqual(defaultArgsFor("powershell-core"), ["-NoLogo"]);
  assert.deepEqual(defaultArgsFor("git-bash"), []);
  // The run line does not promise a start command a custom command never runs.
  assert.equal(runLine({ cmd: "python", args: ["app.py"], start_command: "x" }, "custom"), "python app.py");
});
