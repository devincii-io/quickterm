// The right panel without a DOM: tree order, the change groups, the primary
// button's state, diff rows for both layouts, check groups and the prompts
// "Fix with Claude" sends. right_panel.js, diff_view.js and file_view.js draw
// what these return.

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export const PANEL_WIDTH_DEFAULT = 340;
export const PANEL_WIDTH_MIN = 240;
export const PROMPT_MAX = 16000;
// The scratch view in the panel's routes (api/ws.py SCRATCH_NAME).
export const SCRATCH_PANEL_NAME = ".scratch";
// cmd.exe ends a command line at 8191 characters (agents.py
// CMD_PROMPT_MAX_CHARS); a prompt for the cmd shell or a .cmd agent fits this.
export const CMD_PROMPT_MAX = 7000;

// ---- files -----------------------------------------------------------------

// Folders first, then files, each in natural order; ignored entries after
// all the others, in the same order among themselves.
export function sortEntries(entries = []) {
  return [...entries].sort((a, b) => (
    Number(Boolean(a.ignored)) - Number(Boolean(b.ignored))
    || Number(!a.dir) - Number(!b.dir)
    || collator.compare(a.name, b.name)
  ));
}

// The visible rows of a lazy tree: `children` maps a folder path ("" for the
// top) to its listed entries, `expanded` holds the open folder paths.
export function flattenTree(children, expanded) {
  const rows = [];
  const walk = (dir, depth) => {
    for (const entry of sortEntries(children.get(dir) || [])) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      const open = entry.dir && expanded.has(path);
      rows.push({ path, depth, entry, open, loading: open && !children.has(path) });
      if (open) walk(path, depth + 1);
    }
  };
  walk("", 0);
  return rows;
}

export function splitPath(path) {
  const text = String(path || "");
  const at = text.lastIndexOf("/");
  return at < 0 ? { name: text, dir: "" } : { name: text.slice(at + 1), dir: text.slice(0, at) };
}

// ---- modes: the same three as the left sidebar ----

export const PANEL_MODES = Object.freeze(["full", "rail", "hidden"]);
export const PANEL_MODE_KEY = "quickterm.rightPanelMode";

// The stored mode, per machine; hidden when there is none or the storage
// cannot be read.
export function loadPanelMode(storage) {
  try {
    const value = storage?.getItem(PANEL_MODE_KEY);
    return PANEL_MODES.includes(value) ? value : "hidden";
  } catch (_) {
    return "hidden";
  }
}

export function savePanelMode(storage, mode) {
  if (!PANEL_MODES.includes(mode)) return;
  try { storage?.setItem(PANEL_MODE_KEY, mode); } catch (_) { /* per-machine nicety only */ }
}

// Alt+Shift+E and the left footer's toggle open and close: hidden or rail
// goes to full, full to hidden.
export function keyPanelMode(mode) {
  return mode === "full" ? "hidden" : "full";
}

// The footer chevron steps between full and rail, as the left one does.
export function chevronPanelMode(mode) {
  return mode === "full" ? "rail" : "full";
}

// Whether the left footer's "right panel" toggle shows as on.
export function panelShows(mode) {
  return mode === "full" || mode === "rail";
}

// The rail's state dots: Changes when the tree has changes, Pull request in
// the colour of its checks (failing wins over pending over passing).
export function railMarks(changes, pr) {
  const files = changes?.files || [];
  const changed = files.some((file) => file.group !== "committed");
  let checks = null;
  if (pr?.pr) {
    const groups = checkGroups(pr.checks || []);
    if (groups.failing.length) checks = "failing";
    else if (groups.pending.length) checks = "pending";
    else if (groups.passing.length) checks = "passing";
  }
  return { changes: changed, pr: checks };
}

// The width the panel may take: never less than the minimum, never so much
// that the terminals keep less than 40% of the window.
export function clampPanelWidth(width, viewport) {
  const max = Math.max(PANEL_WIDTH_MIN, Math.floor(viewport * 0.6));
  const value = Number.isFinite(width) ? Math.round(width) : PANEL_WIDTH_DEFAULT;
  return Math.min(max, Math.max(PANEL_WIDTH_MIN, value));
}

export function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- changes ---------------------------------------------------------------

export const GROUPS = [
  { id: "staged", title: "Staged" },
  { id: "changes", title: "Changes" },
  { id: "committed", title: "Committed on branch" },
];

// The three sections of the Changes tab. Untracked files belong to Changes,
// after the tracked ones.
export function groupFiles(files = []) {
  const byPath = (a, b) => collator.compare(a.path, b.path);
  const pick = (group) => files.filter((file) => file.group === group).sort(byPath);
  return {
    staged: pick("staged"),
    changes: [...pick("changes"), ...pick("untracked")],
    committed: pick("committed"),
  };
}

// The one primary button: what it says and does for this state. `message`
// is the commit message field's text.
export function primaryAction(changes, message = "") {
  if (!changes) return { id: null, label: "Commit", enabled: false };
  const groups = groupFiles(changes.files || []);
  const typed = String(message || "").trim().length > 0;
  if (groups.staged.length) {
    return typed
      ? { id: "commit", label: "Commit", enabled: true }
      : { id: "commit", label: "Commit", enabled: false, hint: "Type a commit message first" };
  }
  if (groups.changes.length) return { id: "stage-all", label: "Stage all", enabled: true };
  // A detached HEAD has nothing to publish.
  if (changes.ahead > 0 && changes.upstream) return { id: "push", label: "Push", enabled: true };
  if (changes.ahead > 0 && changes.branch) return { id: "publish", label: "Publish branch", enabled: true };
  if (changes.behind > 0 && changes.upstream) return { id: "pull", label: "Pull", enabled: true };
  return { id: null, label: "Commit", enabled: false, hint: "Nothing to commit" };
}

// The last commit is already on the upstream: amending it rewrites history
// someone else may have, so the panel asks first.
export function headIsPushed(changes) {
  return Boolean(changes?.upstream) && Number(changes?.ahead) === 0;
}

// The primary button's menu: the other actions, enabled where they apply.
export function secondaryActions(changes, message = "") {
  const groups = groupFiles(changes?.files || []);
  const typed = String(message || "").trim().length > 0;
  const upstream = Boolean(changes?.upstream);
  return [
    { id: "commit-push", label: "Commit and push", enabled: groups.staged.length > 0 && typed },
    { id: "amend", label: "Amend last commit", enabled: Boolean(changes?.branch) },
    { id: "pull", label: "Pull", enabled: upstream },
    upstream
      ? { id: "push", label: "Push", enabled: Number(changes?.ahead) > 0 }
      : { id: "publish", label: "Publish branch", enabled: Boolean(changes?.branch) },
  ];
}

// The git actions of the Changes tab per workspace: which one runs where,
// and what git said there. A result belongs to the workspace it ran in, so
// a switch mid-commit neither frees the other workspace's button nor shows
// its output in the wrong place.
export function createGitLedger() {
  const running = new Map();
  const said = new Map();
  return {
    // False when `workspace` is missing or already running something.
    start(workspace, action) {
      if (!workspace || running.has(workspace)) return false;
      running.set(workspace, action);
      said.delete(workspace);
      return true;
    },
    finish(workspace) { running.delete(workspace); },
    busy(workspace) { return running.get(workspace) || null; },
    say(workspace, text, failure = null) {
      if (text) said.set(workspace, { text, failure });
      else said.delete(workspace);
    },
    said(workspace) { return said.get(workspace) || null; },
  };
}

// The git route actions one button press runs, decided from the state the
// press saw: a push without an upstream publishes the branch.
export function gitSteps(action, { upstream = false } = {}) {
  const push = upstream ? "push" : "publish";
  if (action === "commit-push") return ["commit", push];
  if (action === "push") return [push];
  return [action];
}

// "→ origin/main ↑1 ↓0 +220", in parts the head can colour.
export function branchSummary(changes) {
  if (!changes) return null;
  return {
    branch: changes.branch || "detached HEAD",
    target: changes.upstream || changes.base || null,
    ahead: Number(changes.ahead) || 0,
    behind: Number(changes.behind) || 0,
    added: Number(changes.branch_added) || 0,
  };
}

// ---- diffs -----------------------------------------------------------------

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;
const HIDDEN_META = /^(diff --git |index |--- |\+\+\+ )/;

// A unified diff as rows: {kind: "meta" | "hunk" | "ctx" | "add" | "del",
// old, new, text}, with old and new line numbers where the row has them.
export function parseDiff(text) {
  const rows = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of String(text || "").split("\n")) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: "hunk", old: null, new: null, text: line });
      continue;
    }
    if (!inHunk) {
      if (line && !HIDDEN_META.test(line)) rows.push({ kind: "meta", old: null, new: null, text: line });
      continue;
    }
    if (line.startsWith("+")) rows.push({ kind: "add", old: null, new: newNo++, text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "del", old: oldNo++, new: null, text: line.slice(1) });
    else if (line.startsWith(" ")) rows.push({ kind: "ctx", old: oldNo++, new: newNo++, text: line.slice(1) });
    else if (line.startsWith("\\")) rows.push({ kind: "meta", old: null, new: null, text: line });
    else if (line.startsWith("diff --git ")) inHunk = false;
  }
  return rows;
}

// Side by side: context on both sides, a run of deletions next to the run of
// additions that follows it, hunk and meta rows across both.
export function sideBySide(rows) {
  const pairs = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (row.kind === "ctx") {
      pairs.push({ left: row, right: row });
      index++;
      continue;
    }
    if (row.kind !== "del" && row.kind !== "add") {
      pairs.push({ full: row });
      index++;
      continue;
    }
    const dels = [];
    const adds = [];
    while (rows[index]?.kind === "del") dels.push(rows[index++]);
    while (rows[index]?.kind === "add") adds.push(rows[index++]);
    for (let at = 0; at < Math.max(dels.length, adds.length); at++) {
      pairs.push({ left: dels[at] || null, right: adds[at] || null });
    }
  }
  return pairs;
}

const changed = (item) => {
  if (!item) return false;
  if (item.full) return false;
  if (item.left !== undefined) return item.left?.kind === "del" || item.right?.kind === "add";
  return item.kind === "add" || item.kind === "del";
};

// Indices where a block of changes starts: the prev/next arrows and n/p.
export function changeStops(items) {
  const stops = [];
  items.forEach((item, index) => {
    if (changed(item) && !changed(items[index - 1])) stops.push(index);
  });
  return stops;
}

// The stop after (delta 1) or before (delta -1) `current`, wrapping.
export function nextStop(stops, current, delta) {
  if (!stops.length) return null;
  if (delta > 0) return stops.find((stop) => stop > current) ?? stops[0];
  return [...stops].reverse().find((stop) => stop < current) ?? stops.at(-1);
}

// ---- pull request ----------------------------------------------------------

export function checkGroups(checks = []) {
  const groups = { failing: [], pending: [], passing: [] };
  for (const check of checks) {
    const bucket = String(check?.bucket || "").toLowerCase();
    if (bucket === "fail" || bucket === "cancel") groups.failing.push(check);
    else if (bucket === "pending") groups.pending.push(check);
    else groups.passing.push(check);
  }
  const byName = (a, b) => collator.compare(String(a.name || ""), String(b.name || ""));
  for (const list of Object.values(groups)) list.sort(byName);
  return groups;
}

export function prBadge(pr) {
  if (!pr) return null;
  if (pr.isDraft && pr.state === "OPEN") return "DRAFT";
  return String(pr.state || "").toUpperCase() || null;
}

// Merge is offered for an open, ready PR without conflicts, in the methods
// the repository allows.
export function mergeChoices(pr) {
  if (!pr || pr.state !== "OPEN" || pr.isDraft || pr.mergeStateStatus === "DIRTY") return [];
  const labels = { merge: "Merge commit", squash: "Squash and merge", rebase: "Rebase and merge" };
  return (pr.merge_methods || []).filter((method) => labels[method]).map((method) => ({ method, label: labels[method] }));
}

// One line for a PR tab with nothing to show, and the command that helps.
export function prEmptyLine(answer) {
  if (!answer) return null;
  if (answer.gh === "missing") return { text: "GitHub CLI is not installed.", command: "winget install GitHub.cli" };
  if (answer.gh === "unauthenticated") return { text: "GitHub CLI is not signed in.", command: "gh auth login" };
  if (!answer.pr) {
    if (answer.reason === "not a git repository") return { text: "Not a git repository.", command: null };
    if (answer.reason === "no GitHub remote named origin") return { text: "No GitHub remote named origin.", command: null };
    return { text: "No pull request for this branch.", command: "gh pr create" };
  }
  return null;
}

// ---- prompts for "Fix with Claude" -----------------------------------------

// Agent prompts may not hold a double quote or start with "-" (agents.py
// validate_prompt), and stay within `max`.
export function promptSafe(text, max = PROMPT_MAX) {
  let value = String(text || "").replaceAll("\0", "").replaceAll('"', "'").trim();
  while (value.startsWith("-")) value = value.slice(1).trimStart();
  return value.length > max ? value.slice(0, max) : value;
}

// The same prompt for cmd.exe, which reinterprets these characters and ends
// the command at a newline.
export function cmdSafe(text, max = CMD_PROMPT_MAX) {
  return promptSafe(String(text || "").replace(/\r?\n/g, " / ").replace(/[&|<>^%!]/g, " "), max);
}

// Keep the end of each log (that is where a failure prints) so the whole
// prompt fits `max`; the logs give way before anything else.
function fitTails(build, logs, max) {
  let budget = max;
  for (let round = 0; round < 8; round++) {
    const share = Math.max(100, Math.floor(budget / Math.max(1, logs.length)));
    const text = build(logs.map((log) => {
      const value = String(log || "");
      return value.length > share ? `…${value.slice(-share)}` : value;
    }));
    if (text.length <= max) return text;
    budget -= text.length - max + 200;
  }
  return build(logs.map(() => "(log left out: too long)"));
}

export function hookFixPrompt({ output = "", message = "", staged = [] } = {}, max = PROMPT_MAX) {
  const build = ([log]) => [
    "A git commit in this repository failed, most likely in a hook. Find and fix the cause.",
    "",
    "Commit message:",
    String(message || "").trim() || "(none)",
    "",
    "Staged files:",
    ...(staged.length ? staged.map((path) => `- ${path}`) : ["(none)"]),
    "",
    "Output of git:",
    log,
    "",
    "Do not bypass the hooks (no --no-verify, no skip variables). Do not commit and do not push: leave the changes for me to review.",
  ].join("\n");
  return promptSafe(fitTails(build, [output], max), max);
}

export function checksFixPrompt({ pr = null, checks = [] } = {}, max = PROMPT_MAX) {
  const head = pr?.number ? `pull request #${pr.number}${pr.title ? ` (${pr.title})` : ""}` : "this branch's pull request";
  const build = (logs) => [
    `These checks failed on ${head}. Find and fix the cause in this repository.`,
    "",
    ...checks.flatMap((check, index) => [
      `Check: ${check.name || "unnamed"}${check.workflow ? ` (${check.workflow})` : ""}`,
      ...(check.link ? [`Link: ${check.link}`] : []),
      "Log tail:",
      logs[index] || "(no log)",
      "",
    ]),
    "Do not push and do not merge: leave the changes for me to review.",
  ].join("\n");
  return promptSafe(fitTails(build, checks.map((check) => check.log || ""), max), max);
}
