// A workspace's setup (CONTRACTS 4.5 wave 2): the environment editor's
// rules, the "Start with" list, the request each item becomes, when a view
// runs the list, and the new-workspace dialog's toggles.
import test from "node:test";
import assert from "node:assert/strict";

import {
  ENV_MAX, STARTUP_MAX, addStartupItem, canAddStartup, cleanStartupItem, envFromRows, envNameProblem,
  envProblems, envRows, envValueProblem, envValueType, moveStartupItem, newEnvRow, newStartupItem,
  removeStartupItem, setStartupKind, startupDecision, startupItems, startupProblems, startupRequest,
} from "../../quickterm/frontend/js/workspace_setup.js";
import {
  DEFAULT_START_WITH, createLocationWorkspace, startWithItems, toggleStartWith,
} from "../../quickterm/frontend/js/new_workspace.js";
import { createStartupRunner } from "../../quickterm/frontend/js/startup_runner.js";

test("variable names follow the contract's rule; QuickTerm's own are refused", () => {
  for (const name of ["API_KEY", "_x", "a1"]) assert.equal(envNameProblem(name), null, name);
  assert.match(envNameProblem(""), /name/);
  assert.match(envNameProblem("1ABC"), /Letters, digits/);
  assert.match(envNameProblem("MY-VAR"), /Letters, digits/);
  assert.match(envNameProblem("QUICKTERM_PORT"), /QuickTerm's own/);
  assert.match(envNameProblem("quickterm_x"), /QuickTerm's own/);
  assert.match(envNameProblem("WSLENV"), /set by QuickTerm/);
  assert.equal(envValueProblem("x".repeat(8192)), null);
  assert.match(envValueProblem("x".repeat(8193)), /8 KB/);
  // Bytes, not characters: 3000 three-byte characters are over the limit.
  assert.match(envValueProblem("€".repeat(3000)), /8 KB/);
  assert.match(envValueProblem("a\0b"), /NUL/);
});

test("the editor reports per row, catches a name set twice and ignores an untouched row", () => {
  const rows = envRows({ TOKEN: "s3cret", Path2: "x" });
  assert.deepEqual(rows.map((row) => [row.name, row.value]), [["TOKEN", "s3cret"], ["Path2", "x"]]);
  assert.notEqual(rows[0].key, rows[1].key);
  rows.push(newEnvRow());
  assert.equal(envProblems(rows).ok, true, "a blank row is not a problem");
  assert.deepEqual(envFromRows(rows), { TOKEN: "s3cret", Path2: "x" });

  const twice = { ...newEnvRow(), name: "token", value: "y" };
  const bad = { ...newEnvRow(), name: "QUICKTERM_X", value: "" };
  const problems = envProblems([...rows, twice, bad]);
  assert.equal(problems.ok, false);
  assert.match(problems.byKey.get(twice.key).name, /token is set twice/);
  assert.match(problems.byKey.get(bad.key).name, /QuickTerm's own/);
  assert.equal(problems.byKey.has(rows[0].key), false);

  const many = Array.from({ length: ENV_MAX + 1 }, (_, index) => ({ ...newEnvRow(), name: `V${index}`, value: "1" }));
  assert.match(envProblems(many).list, /At most 64/);
  // A value with a name typed but nothing else is still saved (empty value).
  assert.deepEqual(envFromRows([{ key: "k", name: " A ", value: "" }]), { A: "" });
});

test("a value is masked until its field has the keyboard", () => {
  assert.equal(envValueType(false), "password");
  assert.equal(envValueType(true), "text");
});

test("the start list adds up to eight, removes and moves one step, held at the ends", () => {
  let items = [];
  items = addStartupItem(items, "shell");
  items = addStartupItem(items, "claude-code");
  items = addStartupItem(items, "codex");
  assert.deepEqual(items.map((item) => item.kind), ["shell", "claude-code", "codex"]);
  assert.deepEqual(moveStartupItem(items, 2, -1).map((item) => item.kind), ["shell", "codex", "claude-code"]);
  assert.deepEqual(moveStartupItem(items, 0, -1).map((item) => item.kind), ["shell", "claude-code", "codex"]);
  assert.deepEqual(moveStartupItem(items, 2, 1).map((item) => item.kind), ["shell", "claude-code", "codex"]);
  assert.deepEqual(removeStartupItem(items, 1).map((item) => item.kind), ["shell", "codex"]);
  assert.equal(items.length, 3, "the edits return new lists");
  for (let index = 0; index < 10; index += 1) items = addStartupItem(items, "shell");
  assert.equal(items.length, STARTUP_MAX);
  assert.equal(canAddStartup(items), false);
  assert.equal(new Set(items.map((item) => item.key)).size, STARTUP_MAX, "every item keeps its own key");
  assert.equal(newStartupItem("telnet").kind, "shell");
});

test("changing an item's type drops what belonged to the old type", () => {
  const item = { ...newStartupItem("shell"), name: "dev", command: "npm run dev", env: { PORT: "3000" } };
  setStartupKind(item, "claude-code");
  assert.equal(item.kind, "claude-code");
  assert.equal(item.command, null);
  assert.equal(item.name, "dev");
  assert.deepEqual(item.env, { PORT: "3000" });
  item.agent_mode = "new";
  item.agent = { model: "opus" };
  setStartupKind(item, "codex");
  assert.equal(item.agent_mode, null);
  assert.equal(item.agent, null);
});

test("an item is stored with every key, and only what its type takes", () => {
  const shell = {
    ...newStartupItem("shell"), name: "  dev ", shell: "git-bash", command: " npm run dev ", agent_mode: "new", agent: { x: "1" },
  };
  assert.deepEqual(cleanStartupItem(shell), {
    kind: "shell", name: "dev", shell: "git-bash", command: "npm run dev", agent_mode: null, agent: null, env: null,
  });
  const claude = {
    ...newStartupItem("claude-code"), command: "nope", agent_mode: "fork", agent: { model: "opus", effort: "" },
    env: { A: "1" }, claude_mode: "new",
  };
  assert.deepEqual(cleanStartupItem(claude), {
    kind: "claude-code", name: null, shell: null, command: null, agent_mode: null, agent: { model: "opus" }, env: { A: "1" },
  }, "fork is a Codex mode; empty options and the legacy key are dropped");
  assert.equal(cleanStartupItem({ ...newStartupItem("codex"), agent_mode: "fork" }).agent_mode, "fork");
});

test("the stored list reads back as editor items, junk dropped, at most eight", () => {
  const items = startupItems([
    { kind: "shell", name: "dev", command: "npm run dev", env: { PORT: "1" } },
    { kind: "claude-code", agent_mode: "new", agent: { model: "opus" } },
    { kind: "telnet" },
    null,
    ...Array.from({ length: 10 }, () => ({ kind: "codex" })),
  ]);
  assert.equal(items.length, STARTUP_MAX);
  assert.deepEqual(cleanStartupItem(items[0]), {
    kind: "shell", name: "dev", shell: null, command: "npm run dev", agent_mode: null, agent: null, env: { PORT: "1" },
  });
  assert.equal(items[1].agent_mode, "new");
  assert.deepEqual(startupItems(null), []);
});

test("inline problems for a start item", () => {
  const ok = { ...newStartupItem("shell"), command: "npm run dev" };
  const lines = { ...newStartupItem("shell"), command: "a\nb" };
  const env = { ...newStartupItem("codex"), env: { QUICKTERM_X: "1" } };
  const problems = startupProblems([ok, lines, env]);
  assert.equal(problems.ok, false);
  assert.equal(problems.byKey.has(ok.key), false);
  assert.match(problems.byKey.get(lines.key).command, /one line/);
  assert.match(problems.byKey.get(env.key).env, /QuickTerm's own/);
});

test("an item becomes the POST /api/sessions body that starts it", () => {
  assert.deepEqual(startupRequest({ ...newStartupItem("shell"), name: "dev", command: "npm run dev", env: { PORT: "3000" } },
    { workspace: "web" }), { workspace: "web", name: "dev", command: "npm run dev", env: { PORT: "3000" } });
  assert.deepEqual(startupRequest(newStartupItem("shell"), { workspace: "web" }), { workspace: "web" },
    "a plain shell is a request without a profile");
  assert.deepEqual(startupRequest({ ...newStartupItem("claude-code"), agent_mode: "new", agent: { model: "opus" } },
    { workspace: "web" }), { profile: "claude-code", workspace: "web", agent_mode: "new", agent: { model: "opus" } });
  assert.deepEqual(startupRequest({ kind: "codex", command: "ignored" }, { cwd: "C:\\tmp" }), { profile: "codex", cwd: "C:\\tmp" });
  assert.deepEqual(startupRequest({ kind: "shell", shell: "wsl:Ubuntu", command: "ls" }, { workspace: "web" }),
    { workspace: "web", shell: "wsl:Ubuntu", command: "ls" });
  assert.deepEqual(startupRequest({ kind: "codex", shell: "cmd" }, {}), { profile: "codex" }, "a shell belongs to a shell item");
});

test("a view runs the list only when nothing it names still runs and it has one", () => {
  const alive = (ids) => (id) => ids.includes(id);
  assert.equal(startupDecision({ layout: null, session_ids: [] }, alive([])), "startup", "a new workspace");
  const layout = {
    type: "split", dir: "h", ratio: 0.5,
    children: [{ type: "pane", session_id: "a" }, { type: "pane", session_id: "b" }],
  };
  const startup = [{ kind: "shell" }];
  assert.equal(startupDecision({ layout, session_ids: ["a", "b"], startup }, alive([])), "startup", "every terminal is gone");
  assert.equal(startupDecision({ layout, session_ids: ["a", "b"] }, alive([])), "restore",
    "no list: the dead layout comes back with its Restart and Resume offers");
  assert.equal(startupDecision({ layout, session_ids: [] }, alive(["b"])), "restore");
  assert.equal(startupDecision({ layout, session_ids: ["c"], startup }, alive(["c"])), "restore", "a detached one it owns");
  assert.equal(startupDecision(null, alive(["a"])), "startup");
});

test("the dialog's Start with: Shell by default, any combination, in a fixed order", () => {
  assert.deepEqual(DEFAULT_START_WITH, ["shell"]);
  assert.deepEqual(startWithItems(), [
    { kind: "shell", name: null, shell: null, command: null, agent_mode: null, agent: null, env: null },
  ]);
  let chosen = toggleStartWith(DEFAULT_START_WITH, "codex");
  chosen = toggleStartWith(chosen, "claude-code");
  assert.deepEqual(chosen, ["shell", "claude-code", "codex"]);
  assert.deepEqual(startWithItems(chosen).map((item) => item.kind), ["shell", "claude-code", "codex"]);
  chosen = toggleStartWith(chosen, "shell");
  assert.deepEqual(startWithItems(chosen).map((item) => item.kind), ["claude-code", "codex"]);
  assert.deepEqual(startWithItems([]), [], "nothing chosen opens one plain shell");
  assert.deepEqual(toggleStartWith(["shell"], "telnet"), ["shell"]);
});

test("creating a workspace saves its Start with list with it", async () => {
  const calls = [];
  const api = {
    listWorkspaces: async () => [],
    putLocationWorkspace: async (...args) => { calls.push(args); },
  };
  const startup = startWithItems(["shell", "codex"]);
  await createLocationWorkspace({ api, host: null, path: "C:\\src\\web", name: "web", folders: new Map(), startup });
  assert.deepEqual(calls, [["web", null, "C:\\src\\web", startup]]);
});

function fakePane(name) {
  return {
    name, canReplace: true, spawning: false, notices: [],
    beginSpawn() { this.spawning = true; return true; },
    endSpawn() { this.spawning = false; },
    setLaunchCwd(cwd) { this.cwd = cwd; },
    attach(info) { this.session = info; },
    showNotice(text) { this.notices.push(text); },
  };
}

function runnerWith({ fail = new Set(), room = 99 } = {}) {
  const requests = [];
  const errors = [];
  const panes = [];
  let splits = 0;
  const layout = {
    focused: null,
    init() { const pane = fakePane("p0"); panes.push(pane); this.focused = pane; return pane; },
    autoDir: () => "h",
    splitPane(from) {
      if (splits >= room) return null;
      splits += 1;
      const pane = fakePane(`p${panes.length}`);
      pane.from = from.name;
      panes.push(pane);
      return pane;
    },
    focusPane(pane) { this.focused = pane; },
  };
  const runner = createStartupRunner({
    api: {
      createSession: async (body) => {
        requests.push(body);
        if (fail.has(requests.length - 1)) throw { detail: "codex not found" };
        return { id: `s${requests.length}`, cwd: "C:\\src\\web" };
      },
      getWorkspace: async () => ({ startup: [{ kind: "shell" }, { kind: "codex", agent_mode: "new" }] }),
    },
    state: { cfg: { shell: "powershell" }, currentWorkspace: "web" },
    layout,
    ownSession: () => {},
    spawnWorkspaceTag: () => "web",
    contextCwd: () => null,
    spawnDefaultInto: async (pane) => { requests.push({ plain: pane.name }); return { id: "plain" }; },
    scheduleWorkspaceSave: () => {},
    refreshStatusSoon: () => {},
    showError: (text) => errors.push(text),
  });
  return { runner, requests, errors, panes, layout };
}

test("startup puts each item in its own pane, each splitting the last", async () => {
  const { runner, requests, panes } = runnerWith();
  const first = fakePane("first");
  const items = startupItems([{ kind: "shell", command: "npm run dev" }, { kind: "claude-code", agent_mode: "new" }, { kind: "codex" }]);
  assert.equal(await runner.runStartup(items, { first }), true);
  assert.deepEqual(requests, [
    { workspace: "web", command: "npm run dev" },
    { profile: "claude-code", workspace: "web", agent_mode: "new" },
    { profile: "codex", workspace: "web" },
  ]);
  assert.equal(first.session.id, "s1");
  assert.deepEqual(panes.map((pane) => pane.from), ["first", "p0"], "dwindle: each new pane halves the last");
  assert.equal(panes[0].profileName, "claude-code");
  assert.deepEqual(panes[0].launchOptions, { agentMode: "new" });
  assert.equal(first.profileName, null);
  assert.deepEqual(first.launchSpec, { command: "npm run dev", name: "Shell" },
    "a restored layout restarts the shell with its command");
  assert.equal(panes[0].launchSpec, null);
  assert.equal(typeof first.restartWith, "function", "a restart in this session repeats the whole item");
});

test("a shell item with its own shell restarts in it, its variables kept out of the layout", async () => {
  const { runner, requests } = runnerWith();
  const first = fakePane("first");
  await runner.runStartup(startupItems([{ kind: "shell", shell: "git-bash", command: "make", env: { TOKEN: "s" } }]), { first });
  assert.deepEqual(requests, [{ workspace: "web", shell: "git-bash", command: "make", env: { TOKEN: "s" } }]);
  assert.equal(first.terminalType, "git-bash");
  assert.deepEqual(first.launchSpec, { shell: "git-bash", name: "Git Bash", command: "make", terminal_type: "git-bash" });
  assert.equal(JSON.stringify(first.launchSpec).includes("TOKEN"), false);
});

test("no items means one plain shell; a failed item says why in its pane", async () => {
  const plain = runnerWith();
  const first = fakePane("first");
  assert.equal(await plain.runner.runStartup([], { first }), true);
  assert.deepEqual(plain.requests, [{ plain: "first" }]);

  const failing = runnerWith({ fail: new Set([1]) });
  const pane = fakePane("first");
  await failing.runner.runStartup(startupItems([{ kind: "shell" }, { kind: "codex" }]), { first: pane });
  assert.deepEqual(failing.panes[0].notices, ["[codex not found]"]);
});

test("Run setup starts the saved list next to what is open and says when there is no room", async () => {
  const { runner, requests, errors, panes, layout } = runnerWith({ room: 1 });
  const open = fakePane("open");
  open.canReplace = false;
  layout.focused = open;
  assert.equal(await runner.runSetup(), true);
  assert.deepEqual(panes.map((pane) => pane.from), ["open"]);
  assert.deepEqual(requests, [{ workspace: "web" }]);
  assert.match(errors[0], /No room for 1 more setup terminal\./);
});

test("a plain shell's pane type follows the workspace location", async () => {
  const { plainShellType } = await import("../../quickterm/frontend/js/spawner.js");
  assert.equal(plainShellType("wsl:Ubuntu", "powershell"), "wsl", "WSL panes map dropped Windows paths");
  assert.equal(plainShellType("me@box", "powershell"), "ssh", "remote panes refuse local paths");
  assert.equal(plainShellType(null, "git-bash"), "git-bash");
  assert.equal(plainShellType(null, "wsl:Debian"), "wsl");
});
