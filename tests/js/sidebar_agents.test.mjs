// Agent state, the hover time, Alt+J and git worktrees in the sidebar's pure
// model (CONTRACTS 4.2), with fake /api/sessions and /api/git/info data.

import test from "node:test";
import assert from "node:assert/strict";

import {
  activitySeconds, agentLines, groupBranch, groupSummary, needsYou, nextNeedsYou, relativeTime,
  sessionState, sessionTooltip, sidebarGroups, subagentLabel, visibleGroups,
} from "../../quickterm/frontend/js/sidebar_model.js";

function session(id, extra = {}) {
  return {
    id,
    name: id,
    alive: true,
    attachments: 0,
    busy: false,
    profile: "claude",
    attention: null,
    agent: null,
    activity: { idle_seconds: 100, background_output_bytes: 0, background_output_age_seconds: null },
    ...extra,
  };
}

function agent(state, extra = {}) {
  return { kind: "claude", state, prompt: null, message: null, tool: null, subagents: [], age_seconds: 4, ...extra };
}

test("an agent's state shows on its dot, before being open here", () => {
  assert.equal(sessionState(session("a", { agent: agent("working") }), true).key, "busy");
  assert.equal(sessionState(session("a", { agent: agent("working") }), true).label, "working");
  assert.equal(sessionState(session("a", { agent: agent("waiting") }), true).key, "attention");
  assert.equal(sessionState(session("a", { agent: agent("done") }), true).key, "done");
  assert.equal(sessionState(session("a", { agent: agent("failed") }), false).key, "failed");
  // Idle, or no agent at all, keeps the terminal rules.
  assert.equal(sessionState(session("a", { agent: agent("idle") }), true).key, "open");
  assert.equal(sessionState(session("a"), false).key, "idle");
  assert.equal(sessionState(session("a", { agent: agent("bogus") }), true).key, "open");
  // An exited process outranks a stale agent state.
  assert.equal(sessionState(session("a", { alive: false, agent: agent("working") }), false).key, "finished");
});

test("the tooltip carries the prompt, the tool and the last message", () => {
  const lines = agentLines(agent("working", {
    prompt: "fix the tests", tool: "Bash", message: "Looking at it",
    subagents: [{ id: "s1", type: "Explore", description: null, age_seconds: 3 }],
  }));
  assert.deepEqual(lines, [
    "Claude: working", "asked: fix the tests", "running: Bash", "said: Looking at it", "1 subagent running",
  ]);
  assert.deepEqual(agentLines(null), []);
  const tooltip = sessionTooltip(session("a", { agent: agent("done", { message: "All green" }) }), "qt");
  assert.match(tooltip, /claude · done, not seen yet/);
  assert.match(tooltip, /said: All green/);
});

test("a subagent row names its description, else its type", () => {
  assert.equal(subagentLabel({ id: "1", type: "Explore", description: "map the api" }), "map the api");
  assert.equal(subagentLabel({ id: "1", type: "Explore", description: null }), "Explore");
  assert.equal(subagentLabel({ id: "1" }), "subagent");
});

test("done and failed are counted and summarised", () => {
  const [group] = sidebarGroups([
    session("a", { workspace: "qt", agent: agent("done") }),
    session("b", { workspace: "qt", agent: agent("failed") }),
    session("c", { workspace: "qt" }),
  ], { workspaces: ["qt"] });
  assert.equal(group.counts.done, 1);
  assert.equal(group.counts.failed, 1);
  assert.equal(groupSummary(group), "1 done · 1 failed · 1 background");
});

test("the hover time is relative and short", () => {
  assert.equal(relativeTime(0), "now");
  assert.equal(relativeTime(59), "now");
  assert.equal(relativeTime(300), "5m");
  assert.equal(relativeTime(7200), "2h");
  assert.equal(relativeTime(3 * 86400), "3d");
  assert.equal(relativeTime(null), "");
  assert.equal(activitySeconds(session("a", { busy: true })), 0);
  assert.equal(activitySeconds(session("a", { agent: agent("working") })), 0);
  assert.equal(activitySeconds(session("a")), 100);
  assert.equal(activitySeconds(session("a", { activity: {}, agent: agent("done", { age_seconds: 42 }) })), 42);
  assert.equal(activitySeconds({ id: "x" }), null);
});

test("Alt+J walks the terminals that need you in sidebar order and wraps", () => {
  const list = [
    session("a"),
    session("b", { agent: agent("waiting") }),
    session("c", { attention: { kind: "bell" } }),
    session("d", { agent: agent("working") }),
    session("e", { agent: agent("done") }),
  ];
  assert.ok(needsYou(list[1]) && needsYou(list[2]) && needsYou(list[4]));
  assert.ok(!needsYou(list[0]) && !needsYou(list[3]));
  assert.equal(nextNeedsYou(list, null).id, "b");
  assert.equal(nextNeedsYou(list, "a").id, "b");
  assert.equal(nextNeedsYou(list, "b").id, "c");
  assert.equal(nextNeedsYou(list, "c").id, "e");
  assert.equal(nextNeedsYou(list, "e").id, "b");
  // The one you are on is not a jump.
  assert.equal(nextNeedsYou([session("x", { agent: agent("waiting") })], "x"), null);
  assert.equal(nextNeedsYou([session("x")], null), null);
  assert.equal(nextNeedsYou([], null), null);
});

const main = { name: "qt", path: "C:\\src\\qt", pathExists: true, git: { branch: "main", head: null, worktree: false, main_path: null } };
const tree = (name, branch, folder) => ({
  name, path: `C:\\src\\${folder}`, pathExists: true,
  git: { branch, head: null, worktree: true, main_path: "c:/src/qt/" },
});

test("worktree workspaces hang under their main checkout, alphabetical inside", () => {
  const workspaces = [
    { name: "alpha", path: "C:\\src\\alpha", pathExists: true, git: null },
    tree("qt/zeta", "zeta", "qt-zeta"),
    main,
    tree("qt/beta", "feat/beta", "qt-beta"),
    { name: "web", path: "C:\\src\\web", pathExists: true, git: null },
  ];
  const groups = sidebarGroups([], { workspaces });
  assert.deepEqual(groups.map((group) => group.name), ["alpha", "qt", "qt/beta", "qt/zeta", "web"]);
  const beta = groups.find((group) => group.name === "qt/beta");
  assert.equal(beta.parent, "ws:qt");
  assert.equal(beta.shortLabel, "beta");
  assert.equal(groups.find((group) => group.name === "qt").parent, null);
});

test("a worktree whose main checkout is no workspace stays on its own", () => {
  const groups = sidebarGroups([], { workspaces: [tree("orphan", "x", "elsewhere")] });
  assert.equal(groups[0].parent, null);
});

test("a shown worktree keeps its main workspace drawn", () => {
  const all = sidebarGroups([session("a", { workspace: "qt/beta" })], {
    workspaces: [main, tree("qt/beta", "beta", "qt-beta"), { name: "other", path: null, pathExists: null }],
  });
  const { groups, hidden } = visibleGroups(all);
  assert.deepEqual(groups.map((group) => group.name), ["qt", "qt/beta"]);
  assert.equal(hidden, 1);
});

test("the head shows the branch unless it repeats the name", () => {
  assert.equal(groupBranch({ label: "qt", git: main.git }), "main");
  assert.equal(groupBranch({ label: "qt/feat-beta", shortLabel: "feat-beta", git: { branch: "feat/beta" } }), "");
  assert.equal(groupBranch({ label: "qt", git: { branch: null, head: "abc1234" } }), "@abc1234");
  assert.equal(groupBranch({ label: "qt", git: null }), "");
});
