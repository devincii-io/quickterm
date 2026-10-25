// "copy resume command" (CONTRACTS 4.3, round 2): the line for the
// configured shell, the palette rows for running agents, and Shift+Enter on
// a "resume ... session" row.
import test from "node:test";
import assert from "node:assert/strict";

import { configuredShell, resumeCommand } from "../../quickterm/frontend/js/resume_command.js";
import { agentSessionRows, resumeCopyRows } from "../../quickterm/frontend/js/palette_items.js";

const ID = "3f2c1d7e-9a8b-4c6d-8e7f-0a1b2c3d4e5f";

test("each agent's own resume command, in its folder, for each shell", () => {
  const folder = "C:\\src\\it's here";
  assert.equal(resumeCommand({ kind: "claude", id: ID, folder, shell: "powershell" }),
    `Set-Location -LiteralPath 'C:\\src\\it''s here'; claude --resume ${ID}`);
  assert.equal(resumeCommand({ kind: "codex", id: ID, folder, shell: "cmd" }),
    `cd /d "C:\\src\\it's here" && codex resume ${ID}`);
  assert.equal(resumeCommand({ kind: "claude-code", id: ID, folder: "/home/me/a'b", shell: "git-bash" }),
    `cd '/home/me/a'\\''b' && claude --resume ${ID}`);
  assert.equal(resumeCommand({ kind: "codex", id: ID, folder: "/srv/app", shell: "" }),
    `cd '/srv/app' && codex resume ${ID}`);
  assert.equal(resumeCommand({ kind: "claude", id: ID }), `claude --resume ${ID}`);
});

test("nothing that is not an id reaches a command line", () => {
  assert.equal(resumeCommand({ kind: "claude", id: "x; rm -rf ~" }), null);
  assert.equal(resumeCommand({ kind: "claude", id: "" }), null);
  assert.equal(resumeCommand({ kind: "vim", id: ID }), null);
  // A folder cmd cannot quote, or one with a line break, is left out.
  assert.equal(resumeCommand({ kind: "claude", id: ID, folder: 'C:\\a"b', shell: "cmd" }), `claude --resume ${ID}`);
  assert.equal(resumeCommand({ kind: "claude", id: ID, folder: "C:\\a\nb" }), `claude --resume ${ID}`);
});

test("the shell is the one the + menu marks as the default", () => {
  const app = { newTerminalMenu: () => [{ kind: "shell", value: "cmd" }, { kind: "shell", value: "git-bash", isDefault: true }] };
  assert.equal(configuredShell(app), "git-bash");
  assert.equal(configuredShell({}), "powershell");
});

const terminal = (id, name, agent) => ({ session: { id, name, alive: true, agent }, workspace: "web", label: "web" });

test("a running agent with a known conversation gets a quiet copy row", () => {
  const copied = [];
  const app = {
    newTerminalMenu: () => [{ kind: "shell", value: "cmd", isDefault: true }],
    liveTerminals: () => [
      terminal("s1", "Fix the login form", { kind: "claude", conversation_id: ID, cwd: "C:\\src\\web" }),
      terminal("s2", "Codex", { kind: "codex", conversation_id: null }),
      terminal("s3", "pwsh", null),
    ],
  };
  const rows = resumeCopyRows(app, (text) => copied.push(text));
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.label, "copy resume command: Fix the login form");
  assert.equal(row.quiet, true);
  assert.equal(row.hint, `cd /d "C:\\src\\web" && claude --resume ${ID}`);
  row.run();
  assert.deepEqual(copied, [`cd /d "C:\\src\\web" && claude --resume ${ID}`]);
});

test("Shift+Enter on a resume row copies its command instead of starting it", () => {
  const copied = [];
  const resumed = [];
  const app = {
    newTerminalMenu: () => [{ kind: "shell", value: "powershell", isDefault: true }],
    resumeAgentSession: (profile, id) => resumed.push(id),
  };
  const profile = { name: "Claude Code", terminal_type: "claude-code", builtin: true };
  const [row] = agentSessionRows(profile, [{ id: ID, title: "Release notes", cwd: "C:\\src\\web" }], app,
    (text) => copied.push(text));
  assert.match(row.hint, /Shift\+Enter copies$/);
  row.secondary();
  assert.deepEqual(copied, [`Set-Location -LiteralPath 'C:\\src\\web'; claude --resume ${ID}`]);
  row.run();
  assert.deepEqual(resumed, [ID]);
  // Without a clipboard writer the row stays as it was.
  const [plain] = agentSessionRows(profile, [{ id: ID, title: "t" }], app);
  assert.equal(plain.secondary, undefined);
  assert.doesNotMatch(plain.hint, /Shift/);
});
