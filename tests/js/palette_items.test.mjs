import test from "node:test";
import assert from "node:assert/strict";

import {
  agentRows, agentSessionRows, agentSessionTarget, configRows, fuzzyScore, killRows, parsePrefix, rowGroup, settingRows,
  terminalRows, workspaceRows,
} from "../../quickterm/frontend/js/palette_items.js";

const SESSION = "0199a6f2-1c2d-7e3f-8a9b-0c1d2e3f4a5b";

function recorder() {
  const calls = [];
  // Members a test assigns are real; any other member records its call.
  const app = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => { calls.push([key, ...args]); };
    },
  });
  return { calls, app };
}

test("a leading character narrows the palette to one kind", () => {
  assert.deepEqual(parsePrefix(">split"), { kind: "action", text: "split" });
  assert.deepEqual(parsePrefix("@ api"), { kind: "place", text: "api" });
  assert.deepEqual(parsePrefix("#font"), { kind: "setting", text: "font" });
  assert.deepEqual(parsePrefix("!deploy"), { kind: "snippet", text: "deploy" });
  // A prefix alone lists that kind.
  assert.deepEqual(parsePrefix("#"), { kind: "setting", text: "" });
  assert.deepEqual(parsePrefix("  @"), { kind: "place", text: "" });
  assert.deepEqual(parsePrefix("split right"), { kind: null, text: "split right" });
  assert.deepEqual(parsePrefix(""), { kind: null, text: "" });
  assert.deepEqual(parsePrefix(undefined), { kind: null, text: "" });
  // Only the first character is a prefix.
  assert.deepEqual(parsePrefix("a#b"), { kind: null, text: "a#b" });
});

test("rows fall into the prefix groups by kind unless they name one", () => {
  assert.equal(rowGroup({ kind: "workspace" }), "place");
  assert.equal(rowGroup({ kind: "session" }), "place");
  assert.equal(rowGroup({ kind: "setting" }), "setting");
  assert.equal(rowGroup({ kind: "config" }), "setting");
  assert.equal(rowGroup({ kind: "snippet" }), "snippet");
  assert.equal(rowGroup({ kind: "terminal" }), "action");
  assert.equal(rowGroup({ kind: "agent" }), "action");
  assert.equal(rowGroup({ kind: "terminal", group: "place" }), "place");
});

// The scorer as palette.js had it before it moved here, kept verbatim so a
// change to the ranking shows up as a failure rather than a reshuffled list.
function legacyFuzzyScore(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  let last = -2;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      streak = i === last + 1 ? streak + 1 : 1;
      score += 1 + streak * 2;
      if (i === 0 || t[i - 1] === " " || t[i - 1] === ":") score += 3;
      last = i;
      qi++;
    }
  }
  return qi === q.length ? score : -1;
}

test("fuzzy ranking is unchanged by the move", () => {
  const texts = [
    "split right", "split below", "s-p-l-i-t", "snippet: deploy", "open terminal: Git Bash",
    "kill session and close pane", "open workspace: api", "setting: Font size", "",
  ];
  const queries = ["", "s", "sr", "split", "SPLIT", "dep", "kill", "api", "zzz", "o:a"];
  for (const query of queries) {
    for (const text of texts) {
      assert.equal(fuzzyScore(query, text), legacyFuzzyScore(query, text), `${query} / ${text}`);
    }
  }
  assert.ok(fuzzyScore("split", "split right") > fuzzyScore("split", "s-p-l-i-t"));
  assert.equal(fuzzyScore("xyz", "split right"), -1);
});

test("workspace rows open saved workspaces and close open views, with no free-text prompt", () => {
  const { calls, app } = recorder();
  app.openWorkspaces = () => [{ workspace: "api", label: "api", active: true }, "scratch-view-abc12345"];
  const details = new Map([
    ["api", { path: "C:\\src\\api" }],
    ["web", { path: "C:\\src\\web", path_exists: false }],
  ]);
  const rows = workspaceRows(app, ["api", "web", "scratch"], details);
  const labels = rows.map((row) => row.label);
  assert.deepEqual(labels.filter((label) => label.startsWith("open workspace: ")),
    ["open workspace: api", "open workspace: web"]);
  assert.ok(labels.includes("close workspace view: api"));
  assert.ok(labels.some((label) => label.startsWith("close workspace view: ") && label !== "close workspace view: api"));
  assert.ok(labels.includes("new scratch view"));
  assert.ok(!labels.some((label) => label.includes("load workspace")));
  assert.equal(rows.find((row) => row.label === "open workspace: api").hint, "open · C:\\src\\api");
  assert.equal(rows.find((row) => row.label === "open workspace: web").hint, "C:\\src\\web (missing)");
  for (const row of rows) assert.equal(rowGroup(row), "place");
  rows.find((row) => row.label === "open workspace: web").run();
  rows.find((row) => row.label === "close workspace view: api").run();
  rows.find((row) => row.label === "new scratch view").run();
  assert.deepEqual(calls, [["openWorkspace", "web"], ["closeWorkspaceView", "api"], ["newScratchView"]]);
});

test("workspace rows survive an app that has none of the new members", () => {
  const rows = workspaceRows({}, ["api"]);
  assert.deepEqual(rows.map((row) => row.label), ["open workspace: api", "new scratch view"]);
  for (const row of rows) assert.doesNotThrow(() => row.run());
  assert.deepEqual(workspaceRows(null).map((row) => row.label), ["new scratch view"]);
});

test("terminal rows reach every listed terminal and say where it is and how it is", () => {
  const { calls, app } = recorder();
  const build = { id: "s1", name: "build", alive: true, busy: true };
  const agent = { id: "s2", name: "claude", alive: true, attention: { kind: "bell" } };
  const done = { id: "s3", alive: false };
  app.liveTerminals = () => [
    { session: build, workspace: "api", label: "api", attachedIn: null },
    { session: agent, workspace: "web", label: "web", attachedIn: "web" },
    { session: done, workspace: null, label: null, attachedIn: null },
    { session: null },
  ];
  const rows = terminalRows(app);
  assert.deepEqual(rows.map((row) => row.label), ["go to terminal: build", "go to terminal: claude", "go to terminal: s3"]);
  assert.deepEqual(rows.map((row) => row.hint), ["api · busy", "web · needs you", "Unassigned · finished"]);
  for (const row of rows) assert.equal(rowGroup(row), "place");
  rows[1].run();
  assert.deepEqual(calls, [["activateTerminal", agent]]);
  assert.deepEqual(terminalRows({}), []);
});

test("settings rows are found by their keywords and open the setting", () => {
  const { calls, app } = recorder();
  app.settingEntries = () => [
    { id: "font_size", label: "Font size", tab: "general", hint: "Terminal text size", keywords: "zoom px" },
    { id: "broken" },
  ];
  const rows = settingRows(app);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "setting: Font size");
  assert.ok(fuzzyScore("zoom", rows[0].search) > 0);
  rows[0].run();
  assert.deepEqual(calls, [["openSetting", "font_size"]]);
});

test("config rows edit a terminal or a snippet by name", () => {
  const { calls, app } = recorder();
  app.profiles = [{ name: "Git Bash", terminal_type: "git-bash" }];
  app.snippets = [{ name: "deploy", text: "make deploy\r" }];
  const rows = configRows(app);
  assert.deepEqual(rows.map((row) => row.label), ["edit terminal: Git Bash", "edit snippet: deploy"]);
  for (const row of rows) { assert.equal(rowGroup(row), "setting"); row.run(); }
  assert.deepEqual(calls, [["editTerminalConfig", "Git Bash"], ["editSnippet", "deploy"]]);
});

test("agent rows offer every mode of the type and lead with the profile's own", () => {
  const { calls, app } = recorder();
  app.workspacePath = () => "C:\\src\\api";
  const codex = { name: "Codex", terminal_type: "codex" };
  const rows = agentRows(codex, app);
  assert.deepEqual(rows.map((row) => row.label), [
    "Codex new conversation: Codex", "Codex continue latest: Codex", "Codex choose session: Codex",
    "Codex fork a session: Codex", "Codex agent manager: Codex", "split agent view: Codex",
  ]);
  assert.equal(rows[0].hint, "C:\\src\\api");
  rows[3].run();
  rows[5].run();
  assert.deepEqual(calls, [["runAgentMode", codex, "fork"], ["splitAgentView", codex]]);

  const claude = { name: "Assistant", terminal_type: "claude-code", claude_mode: "agents" };
  const claudeRows = agentRows(claude, app).map((row) => row.label);
  assert.equal(claudeRows[0], "Claude agent manager: Assistant");
  assert.ok(!claudeRows.some((label) => label.includes("fork")));
  assert.deepEqual(agentRows({ name: "Shell", terminal_type: "bash" }, app), []);
});

test("agent rows fall back to the Claude-named aliases", () => {
  const calls = [];
  const app = { runClaudeMode: (...args) => calls.push(["run", ...args]), splitClaudeAgentView: (p) => calls.push(["split", p]) };
  const claude = { name: "C", terminal_type: "claude-code" };
  const rows = agentRows(claude, app);
  rows[0].run();
  rows.at(-1).run();
  assert.deepEqual(calls, [["run", claude, "continue"], ["split", claude]]);
});

test("resume rows name the agent and the conversation", () => {
  const { calls, app } = recorder();
  const claude = { name: "Claude", terminal_type: "claude-code" };
  const rows = agentSessionRows(claude, [
    { id: SESSION, title: "Fix the reaper", updated_at: "2026-10-03T21:14:09Z", cwd: "C:\\src" },
    { id: "", title: "no id" },
  ], app);
  assert.deepEqual(rows.map((row) => row.label), ["resume Claude session: Fix the reaper"]);
  assert.equal(rows[0].hint, "Claude · 2026-10-03 21:14");
  rows[0].run();
  assert.deepEqual(calls, [["resumeAgentSession", claude, SESSION]]);
  assert.deepEqual(agentSessionRows({ name: "x", terminal_type: "bash" }, [{ id: SESSION }], app), []);
});

test("resume rows list a named workspace by name and a scratch view by its folder", () => {
  // A named workspace: the backend resolves the folder by name.
  assert.deepEqual(agentSessionTarget({
    currentWorkspace: () => "api", agentSessionFolder: () => null, scratchRoot: () => "C:\\scratch",
  }), { workspace: "api" });
  // A scratch view, adopted or not yet: the folder its resumes start in.
  for (const name of ["scratch-view-0123456789ab", "scratch", null]) {
    assert.deepEqual(agentSessionTarget({
      currentWorkspace: () => name, agentSessionFolder: () => "C:\\proj", scratchRoot: () => "C:\\scratch",
    }), { cwd: "C:\\proj" }, String(name));
  }
  // No view open (the shell's facade): the scratch root a new view starts in.
  assert.deepEqual(agentSessionTarget({ currentWorkspace: () => null, scratchRoot: () => "C:\\scratch" }),
    { cwd: "C:\\scratch" });
  // No folder at all: nothing to ask for.
  assert.equal(agentSessionTarget({ currentWorkspace: () => null, scratchRoot: () => null }), null);
  assert.equal(agentSessionTarget(null), null);
});

test("kill rows list only running terminals and carry the entry, not a kill", () => {
  const live = { session: { id: "s1", name: "build", alive: true }, workspace: "api", label: "api" };
  const app = {
    liveTerminals: () => [live, { session: { id: "s2", alive: false } }],
  };
  const rows = killRows(app);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "kill build…");
  assert.equal(rows[0].terminal, live);
  assert.equal(rows[0].run, undefined);
  assert.deepEqual(killRows({}), []);
});
