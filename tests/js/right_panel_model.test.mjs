// The right panel's pure model: tree order, change groups, the primary
// button, diff rows for both layouts, check groups and the agent prompts.
import test from "node:test";
import assert from "node:assert/strict";

import {
  CMD_PROMPT_MAX, createGitLedger, gitSteps,
  PROMPT_MAX, branchSummary, changeStops, checkGroups, checksFixPrompt, clampPanelWidth, cmdSafe,
  flattenTree, formatSize, groupFiles, headIsPushed, hookFixPrompt, mergeChoices, nextStop, parseDiff,
  prBadge, prEmptyLine, primaryAction, promptSafe, secondaryActions, sideBySide, sortEntries, splitPath,
} from "../../quickterm/frontend/js/right_panel_model.js";

import { joinPath } from "../../quickterm/frontend/js/right_panel.js";
import { findAll, lineAt } from "../../quickterm/frontend/js/file_view.js";
import { createDiffView } from "../../quickterm/frontend/js/diff_view.js";
import { createChangesTab } from "../../quickterm/frontend/js/rp_changes.js";
import { createFilesTab } from "../../quickterm/frontend/js/rp_files.js";
import { createPrTab } from "../../quickterm/frontend/js/rp_pr.js";

const entry = (name, dir = false, ignored = false) => ({ name, dir, ignored, git: null });

test("every right panel module loads without a DOM", () => {
  for (const factory of [createDiffView, createChangesTab, createFilesTab, createPrTab]) {
    assert.equal(typeof factory, "function");
  }
});

test("a workspace path joins with the folder's own separator", () => {
  assert.equal(joinPath("C:\\work\\app", "src/main.py"), "C:\\work\\app\\src\\main.py");
  assert.equal(joinPath("C:\\work\\app\\", ""), "C:\\work\\app");
  assert.equal(joinPath("/home/me/app", "src/main.py"), "/home/me/app/src/main.py");
  assert.equal(joinPath("\\\\server\\share\\app", "a b.txt"), "\\\\server\\share\\app\\a b.txt");
  assert.equal(joinPath(null, "x"), "x");
});

test("find counts matches case-insensitively and names their lines", () => {
  const text = "alpha\nBeta beta\ngamma\n";
  assert.deepEqual(findAll(text, "beta"), [6, 11]);
  assert.deepEqual(findAll(text, ""), []);
  assert.equal(lineAt(text, 0), 1);
  assert.equal(lineAt(text, 11), 2);
  assert.equal(lineAt(text, 16), 3);
});

test("folders come first, numbers sort as numbers, ignored entries go last", () => {
  const sorted = sortEntries([
    entry("b.txt"), entry("file10.txt"), entry("node_modules", true, true), entry("src", true),
    entry("file2.txt"), entry("A.md"), entry("debug.log", false, true), entry("docs", true),
  ]);
  assert.deepEqual(sorted.map((item) => item.name), [
    "docs", "src", "A.md", "b.txt", "file2.txt", "file10.txt", "node_modules", "debug.log",
  ]);
});

test("the tree flattens only open folders and marks the ones still loading", () => {
  const children = new Map([
    ["", [entry("z.txt"), entry("src", true), entry("lib", true)]],
    ["src", [entry("main.py"), entry("util", true)]],
  ]);
  const rows = flattenTree(children, new Set(["src", "src/util", "lib"]));
  assert.deepEqual(rows.map((row) => [row.path, row.depth, row.open, row.loading]), [
    ["lib", 0, true, true],
    ["src", 0, true, false],
    ["src/util", 1, true, true],
    ["src/main.py", 1, false, false],
    ["z.txt", 0, false, false],
  ]);
});

test("paths split into name and folder", () => {
  assert.deepEqual(splitPath("src/app/main.py"), { name: "main.py", dir: "src/app" });
  assert.deepEqual(splitPath("README.md"), { name: "README.md", dir: "" });
});

test("the panel width stays between the minimum and 60% of the window", () => {
  assert.equal(clampPanelWidth(100, 1600), 240);
  assert.equal(clampPanelWidth(5000, 1600), 960);
  assert.equal(clampPanelWidth(Number.NaN, 1600), 340);
  assert.equal(clampPanelWidth(300, 300), 240);
  assert.equal(formatSize(3 * 1024 * 1024 + 1), "3.0 MB");
});

const file = (path, group, status = "M") => ({ path, group, status, added: 1, removed: 0 });

test("files group into staged, changes with untracked last, and committed", () => {
  const groups = groupFiles([
    file("z.txt", "untracked", "?"), file("b.py", "changes"), file("a.py", "staged", "A"),
    file("a10.py", "changes"), file("a2.py", "changes"), file("lib/x.py", "committed"),
  ]);
  assert.deepEqual(groups.staged.map((item) => item.path), ["a.py"]);
  assert.deepEqual(groups.changes.map((item) => item.path), ["a2.py", "a10.py", "b.py", "z.txt"]);
  assert.deepEqual(groups.committed.map((item) => item.path), ["lib/x.py"]);
});

test("the primary button follows the state", () => {
  const base = { branch: "feature", upstream: "origin/feature", ahead: 0, behind: 0, files: [] };
  assert.deepEqual(primaryAction({ ...base, files: [file("a", "changes")] }), { id: "stage-all", label: "Stage all", enabled: true });
  assert.deepEqual(primaryAction({ ...base, files: [file("a", "untracked", "?")] }, "msg").id, "stage-all");
  const staged = { ...base, files: [file("a", "staged"), file("b", "changes")] };
  assert.equal(primaryAction(staged, "").enabled, false);
  assert.equal(primaryAction(staged, "").label, "Commit");
  assert.deepEqual(primaryAction(staged, "Fix the thing"), { id: "commit", label: "Commit", enabled: true });
  assert.deepEqual(primaryAction({ ...base, ahead: 2 }), { id: "push", label: "Push", enabled: true });
  assert.deepEqual(primaryAction({ ...base, upstream: null, ahead: 1 }), { id: "publish", label: "Publish branch", enabled: true });
  assert.deepEqual(primaryAction({ ...base, behind: 3 }), { id: "pull", label: "Pull", enabled: true });
  // Ahead and with changes: the changes come first.
  assert.equal(primaryAction({ ...base, ahead: 1, files: [file("a", "changes")] }).id, "stage-all");
  assert.equal(primaryAction(base).enabled, false);
  assert.equal(primaryAction(null).enabled, false);
});

test("the menu offers the other actions where they apply", () => {
  const changes = { branch: "f", upstream: "origin/f", ahead: 0, behind: 0, files: [file("a", "staged")] };
  const byId = Object.fromEntries(secondaryActions(changes, "msg").map((item) => [item.id, item.enabled]));
  assert.deepEqual(byId, { "commit-push": true, amend: true, pull: true, push: false });
  const unpublished = secondaryActions({ ...changes, upstream: null }, "");
  assert.deepEqual(unpublished.map((item) => item.id), ["commit-push", "amend", "pull", "publish"]);
  assert.equal(unpublished[0].enabled, false);
  assert.equal(headIsPushed(changes), true);
  assert.equal(headIsPushed({ ...changes, ahead: 1 }), false);
  assert.equal(headIsPushed({ ...changes, upstream: null }), false);
});

test("the head names the branch, its target, ahead, behind and added lines", () => {
  assert.deepEqual(branchSummary({ branch: "f", upstream: null, base: "origin/main", ahead: 1, behind: 0, branch_added: 220 }), {
    branch: "f", target: "origin/main", ahead: 1, behind: 0, added: 220,
  });
});

const DIFF = [
  "diff --git a/app.py b/app.py",
  "index 1111111..2222222 100644",
  "--- a/app.py",
  "+++ b/app.py",
  "@@ -1,4 +1,5 @@ def main():",
  " keep",
  "-old one",
  "-old two",
  "+new one",
  " middle",
  "+added",
  " end",
  "\\ No newline at end of file",
  "",
].join("\n");

test("a unified diff parses into numbered rows without the file header", () => {
  const rows = parseDiff(DIFF);
  assert.deepEqual(rows.map((row) => [row.kind, row.old, row.new, row.text]), [
    ["hunk", null, null, "@@ -1,4 +1,5 @@ def main():"],
    ["ctx", 1, 1, "keep"],
    ["del", 2, null, "old one"],
    ["del", 3, null, "old two"],
    ["add", null, 2, "new one"],
    ["ctx", 4, 3, "middle"],
    ["add", null, 4, "added"],
    ["ctx", 5, 5, "end"],
    ["meta", null, null, "\\ No newline at end of file"],
  ]);
  assert.deepEqual(parseDiff("diff --git a/x b/x\nnew file mode 100644\nBinary files /dev/null and b/x differ\n")
    .map((row) => row.text), ["new file mode 100644", "Binary files /dev/null and b/x differ"]);
});

test("side by side pairs deletions with the additions after them", () => {
  const pairs = sideBySide(parseDiff(DIFF));
  const show = (side) => (side ? `${side.kind}:${side.text}` : "-");
  assert.deepEqual(pairs.map((pair) => (pair.full ? `full:${pair.full.kind}` : `${show(pair.left)}|${show(pair.right)}`)), [
    "full:hunk",
    "ctx:keep|ctx:keep",
    "del:old one|add:new one",
    "del:old two|-",
    "ctx:middle|ctx:middle",
    "-|add:added",
    "ctx:end|ctx:end",
    "full:meta",
  ]);
});

test("change stops mark the start of each block and wrap", () => {
  const rows = parseDiff(DIFF);
  const stops = changeStops(rows);
  assert.deepEqual(stops, [2, 6]);
  assert.deepEqual(changeStops(sideBySide(rows)), [2, 5]);
  assert.equal(nextStop(stops, -1, 1), 2);
  assert.equal(nextStop(stops, 2, 1), 6);
  assert.equal(nextStop(stops, 6, 1), 2);
  assert.equal(nextStop(stops, 2, -1), 6);
  assert.equal(nextStop([], 0, 1), null);
});

test("checks group into failing, pending and passing", () => {
  const groups = checkGroups([
    { name: "lint", bucket: "pass" }, { name: "test", bucket: "fail" }, { name: "deploy", bucket: "pending" },
    { name: "docs", bucket: "skipping" }, { name: "e2e", bucket: "cancel" },
  ]);
  assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([key, list]) => [key, list.map((check) => check.name)])), {
    failing: ["e2e", "test"], pending: ["deploy"], passing: ["docs", "lint"],
  });
});

test("the badge, the merge choices and the empty line", () => {
  const pr = { number: 249, state: "OPEN", isDraft: false, mergeStateStatus: "CLEAN", merge_methods: ["squash", "rebase"] };
  assert.equal(prBadge(pr), "OPEN");
  assert.equal(prBadge({ ...pr, isDraft: true }), "DRAFT");
  assert.deepEqual(mergeChoices(pr).map((choice) => choice.method), ["squash", "rebase"]);
  assert.deepEqual(mergeChoices({ ...pr, isDraft: true }), []);
  assert.deepEqual(mergeChoices({ ...pr, mergeStateStatus: "DIRTY" }), []);
  assert.deepEqual(mergeChoices({ ...pr, state: "MERGED" }), []);
  assert.deepEqual(prEmptyLine({ gh: "unauthenticated", pr: null }), { text: "GitHub CLI is not signed in.", command: "gh auth login" });
  assert.equal(prEmptyLine({ gh: "ok", pr: null, reason: "no pull request for this branch" }).command, "gh pr create");
  assert.equal(prEmptyLine({ gh: "missing", pr: null }).text, "GitHub CLI is not installed.");
  assert.equal(prEmptyLine({ gh: "ok", pr }), null);
});

test("prompts carry what failed, the rules, and fit the launch limits", () => {
  const prompt = hookFixPrompt({ output: 'ruff: "E501" line too long', message: "Add the panel", staged: ["a.py", "b.py"] });
  assert.match(prompt, /Add the panel/);
  assert.match(prompt, /- a\.py\n- b\.py/);
  assert.match(prompt, /ruff: 'E501' line too long/);
  assert.match(prompt, /Do not bypass the hooks/);
  assert.ok(!prompt.includes('"'));

  const long = "x".repeat(40000) + "\nTHE ERROR";
  const checks = checksFixPrompt({
    pr: { number: 249, title: "Panel" },
    checks: [{ name: "test", workflow: "ci", link: "https://github.com/a/b/actions/runs/1", log: long },
      { name: "lint", log: long }],
  });
  assert.ok(checks.length <= PROMPT_MAX, checks.length);
  assert.match(checks, /pull request #249 \(Panel\)/);
  assert.equal((checks.match(/THE ERROR/g) || []).length, 2);
  assert.match(checks, /Do not push and do not merge/);

  assert.equal(promptSafe("--force this"), "force this");
  assert.equal(cmdSafe("a & b\nc > d %PATH% !x!"), "a   b / c   d  PATH   x");
});

test("a prompt for cmd.exe fits 7000 characters by trimming the logs, not the rules", () => {
  const long = "x".repeat(40000) + "\nTHE ERROR";
  const build = (max) => checksFixPrompt({ pr: { number: 1 }, checks: [{ name: "a", log: long }, { name: "b", log: long }] }, max);
  const small = cmdSafe(build(CMD_PROMPT_MAX));
  assert.ok(small.length <= CMD_PROMPT_MAX, small.length);
  assert.equal((small.match(/THE ERROR/g) || []).length, 2);
  assert.match(small, /Do not push and do not merge/);
  assert.ok(!small.includes("\n"));
  const hook = hookFixPrompt({ output: long, message: "m", staged: ["a"] }, CMD_PROMPT_MAX);
  assert.ok(hook.length <= CMD_PROMPT_MAX);
  assert.match(hook, /THE ERROR/);
  assert.match(hook, /Do not bypass the hooks/);
});

test("git results stay with the workspace they ran in", () => {
  const ledger = createGitLedger();
  assert.equal(ledger.start("A", "commit"), true);
  // A second press in A waits; B is free while A commits.
  assert.equal(ledger.start("A", "push"), false);
  assert.equal(ledger.busy("A"), "commit");
  assert.equal(ledger.busy("B"), null);
  assert.equal(ledger.start("B", "stage-all"), true);
  ledger.say("A", "hook failed", { output: "hook failed" });
  assert.equal(ledger.said("B"), null);
  assert.deepEqual(ledger.said("A"), { text: "hook failed", failure: { output: "hook failed" } });
  ledger.finish("A");
  assert.equal(ledger.busy("A"), null);
  assert.equal(ledger.busy("B"), "stage-all");
  // A new run clears what the last one said there, and only there.
  ledger.say("B", "staged");
  assert.equal(ledger.start("A", "commit"), true);
  assert.equal(ledger.said("A"), null);
  assert.equal(ledger.said("B").text, "staged");
  assert.equal(ledger.start(null, "commit"), false);
});

test("push or publish is decided from the state the press saw", () => {
  assert.deepEqual(gitSteps("commit-push", { upstream: true }), ["commit", "push"]);
  assert.deepEqual(gitSteps("commit-push", { upstream: false }), ["commit", "publish"]);
  assert.deepEqual(gitSteps("push", { upstream: false }), ["publish"]);
  assert.deepEqual(gitSteps("amend"), ["amend"]);
});

test("a detached HEAD is never offered publish", () => {
  const detached = { branch: null, upstream: null, ahead: 2, behind: 0, files: [] };
  assert.equal(primaryAction(detached).id, null);
  assert.equal(primaryAction(detached).enabled, false);
  assert.equal(secondaryActions(detached).find((item) => item.id === "publish").enabled, false);
});

test("a folder outside git says so in the PR tab", () => {
  assert.deepEqual(prEmptyLine({ gh: "ok", pr: null, reason: "not a git repository" }), {
    text: "Not a git repository.", command: null,
  });
});
