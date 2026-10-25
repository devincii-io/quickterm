// The sidebar's model, without a DOM: its modes and width, how sessions
// group and what state each row shows, the terminal choices for new panes,
// and the per-machine storage behind the mode, width and folded groups.
// launcher.js builds the DOM from it and re-exports its public names.

import { DEFAULT_SHELL, availableShells } from "./shell_choice.js";
import { formatBytes, formatUptime } from "./panel_shared.js";
import { isScratchWorkspace, workspaceLabel } from "./boot_context.js";
import { locationLabel } from "./locations.js";

export const SIDEBAR_MODES = ["full", "rail", "hidden"];
export const SIDEBAR_MODE_KEY = "quickterm.sidebarMode";
export const LEGACY_COLLAPSED_KEY = "quickterm.sidebarCollapsed";
export const SIDEBAR_WIDTH_KEY = "quickterm.sidebarWidth";
export const SIDEBAR_GROUPS_KEY = "quickterm.sidebarClosedGroups";

export function nextSidebarMode(mode) {
  const index = SIDEBAR_MODES.indexOf(mode);
  return SIDEBAR_MODES[(index + 1) % SIDEBAR_MODES.length];
}

// Bounds for the full sidebar only; the rail is a fixed width in CSS. Below
// 150px a terminal name is three letters and a dot; past 40% of the window the
// terminal stops being the point of the app.
export const SIDEBAR_WIDTH_DEFAULT = 200;
export const SIDEBAR_WIDTH_MIN = 150;
export const SIDEBAR_WIDTH_MAX = 400;

// Pure on purpose: the clamp is the part worth testing, and a test should not
// need a DOM to reach it. `viewport` is the window width; a non-positive or
// unknown viewport falls back to the absolute cap.
export function maxSidebarWidth(viewport) {
  const room = Number(viewport) > 0 ? Math.round(Number(viewport) * 0.4) : SIDEBAR_WIDTH_MAX;
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, room));
}

export function clampSidebarWidth(width, viewport) {
  // parseFloat, not Number: a blank or absent stored value must read as "no
  // opinion" and fall back to the default, where Number would call it zero and
  // pin the sidebar to its minimum.
  const wanted = Math.round(Number.parseFloat(width));
  if (!Number.isFinite(wanted)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(maxSidebarWidth(viewport), Math.max(SIDEBAR_WIDTH_MIN, wanted));
}

// Past this a terminal row names the folder its shell is sitting in, after the
// name, instead of hiding it behind a tooltip. Dragging the sidebar wide
// should buy information, not whitespace.
export const SIDEBAR_WIDE_AT = 280;

export function isWideSidebar(width) {
  return Number(width) >= SIDEBAR_WIDE_AT;
}

// Terminals nobody claims land here. panel_dashboard.js names the same set with
// the same word, so the two views cannot describe one thing two ways.
export const UNASSIGNED_GROUP = "Unassigned";

// The sidebar footer's glyphs, keyed by the label the shell passes in
// `chrome`, so a new footer entry is one map line away from its own glyph
// instead of silently falling back to the terminal one.
export const NAV_ICONS = Object.freeze({
  "workspace board": "dashboard", settings: "settings", help: "help",
  commands: "terminal", "new window": "new-window", "right panel": "panel-right",
});

// What one terminal is doing, in one word.
//
// `busy` comes from one process-table snapshot even on the sidebar's cheap
// poll (`metrics: false` skips only usage sampling). Older backends answered
// null there, which means "not measured" and must never be printed as "idle",
// so only an explicit `true` claims busy and the quiet figure below comes from
// `activity.idle_seconds`.
//
// `attention` outranks everything, being open here included: a pane you are
// not looking at can ring, and the focused one never keeps it long, because
// the shell tells the server it was seen.
//
// `attachments` counts subscribers on the backend, not panes in this window,
// so a terminal open in another QuickTerm window says so rather than looking
// abandoned. That matters before moving it.
//
// An agent's hook state (`session.agent`, CONTRACTS 4.2) comes before being
// open here: a Claude that is working, done or failed says so on its dot
// whether or not a pane shows it. Waiting is the needs-you look. An idle
// agent, or none, keeps the plain terminal rules.
// A process-tree "busy" for a terminal whose agent reports its own state is
// noise: Claude and Codex always have child processes, so an idle agent would
// read as busy forever. The hook state decides for them.
export function processBusy(session) {
  return session?.busy === true && !session?.agent;
}

export function sessionState(session, isAttached) {
  const activity = session?.activity || {};
  const agent = agentState(session);
  if (session?.attention || agent === "waiting") return { key: "attention", label: "needs you" };
  if (session?.alive === false) return { key: "finished", label: "finished" };
  if (agent === "working") return { key: "busy", label: "working" };
  if (agent === "done" || agent === "failed") return { key: agent, label: agent };
  if (isAttached) return { key: "open", label: "open" };
  if (processBusy(session)) return { key: "busy", label: "busy" };
  if ((activity.background_output_bytes || 0) > 0) return { key: "unread", label: "new output" };
  if ((session?.attachments || 0) > 0) return { key: "elsewhere", label: "open elsewhere" };
  return { key: "idle", label: "background" };
}

export const AGENT_STATES = ["working", "waiting", "done", "failed", "idle"];
const AGENT_NAMES = { claude: "Claude", codex: "Codex" };
const AGENT_STATE_TEXT = {
  working: "working", waiting: "waiting for you", done: "done, not seen yet", failed: "failed", idle: "idle",
};

export function agentState(session) {
  const state = session?.agent?.state;
  return AGENT_STATES.includes(state) ? state : null;
}

// Waiting, ringing, or a finished turn nobody has looked at. The backend's
// mark_seen turns done and failed into idle, so done here means unseen.
export function needsYou(session) {
  if (!session) return false;
  if (session.attention) return true;
  return ["waiting", "done", "failed"].includes(agentState(session));
}

// The terminal Alt+J goes to: the next one after `currentId` in the
// sidebar's own order that needs you, wrapping around. null when none does
// (or only the current one).
export function nextNeedsYou(sessions = [], currentId = null) {
  const list = (sessions || []).filter((session) => session?.id);
  const start = list.findIndex((session) => session.id === currentId);
  for (let step = 1; step <= list.length; step++) {
    const session = list[(start + step) % list.length];
    if (session.id !== currentId && needsYou(session)) return session;
  }
  return null;
}

// The tooltip lines an agent adds: what it was asked, what it runs now, what
// it last said.
export function agentLines(agent) {
  if (!agent || !AGENT_STATES.includes(agent.state)) return [];
  const lines = [`${AGENT_NAMES[agent.kind] || "agent"}: ${AGENT_STATE_TEXT[agent.state]}`];
  if (agent.prompt) lines.push(`asked: ${agent.prompt}`);
  if (agent.tool) lines.push(`running: ${agent.tool}`);
  if (agent.message) lines.push(`said: ${agent.message}`);
  const count = runningSubagents(agent).length;
  if (count) lines.push(`${count} subagent${count === 1 ? "" : "s"} running`);
  return lines;
}

export function runningSubagents(agent) {
  return Array.isArray(agent?.subagents) ? agent.subagents.filter((sub) => sub?.id) : [];
}

// A subagent's child row says what it is doing in one line: the description
// the parent gave it, else its type.
export function subagentLabel(sub) {
  return String(sub?.description || sub?.type || "subagent");
}

// Seconds since a terminal last did anything, for the row's hover time.
// Busy and working are now. null when the payload does not say.
export function activitySeconds(session) {
  if (processBusy(session) || agentState(session) === "working") return 0;
  for (const value of [session?.activity?.idle_seconds, session?.agent?.age_seconds]) {
    const seconds = Number(value);
    if (value != null && Number.isFinite(seconds)) return Math.max(0, seconds);
  }
  return null;
}

export function relativeTime(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return "";
  const whole = Math.max(0, Math.floor(Number(seconds)));
  if (whole < 60) return "now";
  if (whole < 3600) return `${Math.floor(whole / 60)}m`;
  if (whole < 86400) return `${Math.floor(whole / 3600)}h`;
  return `${Math.floor(whole / 86400)}d`;
}

// The folder a row names: where the shell says it is now (OSC 7 / OSC 9;9),
// else where it started.
export function sessionFolder(session) {
  return session?.current_cwd || session?.cwd || "";
}

// The text after a row's name. The folder is the fact that tells one
// project's shell from another's, but under its workspace it shows only where
// it differs from the workspace's own folder: a terminal that `cd`'d away says
// so, one at home says nothing the head does not already say. Scratch has no
// saved folder, so its home is wherever the terminal started. The flat list
// names the workspace, and the folder only when it is not the same word.
export function rowWhere(item, group) {
  const session = item?.session || {};
  const folder = folderName(sessionFolder(session));
  const same = (other) => String(other || "").toLowerCase() === folder.toLowerCase();
  if (group?.kind === "flat") return [item.owner, same(item.owner) ? "" : folder].filter(Boolean).join(" · ");
  const home = folderName(group?.kind === "scratch" ? session.cwd : group?.path);
  return same(home) || same(group?.label) ? "" : folder;
}

// What a terminal asked for, in words, for the tooltip and the dashboard.
export function attentionText(attention) {
  if (!attention) return "";
  if (attention.text) return attention.text;
  if (attention.kind === "bell") return "rang the bell";
  if (attention.kind === "exit") return "finished";
  return "sent a notification";
}

export function exitText(session) {
  return Number.isInteger(session?.exit_code) ? `exited with code ${session.exit_code}` : "exited";
}

// An exited terminal stays listed only while the backend holds it for the
// user: unread final output (the 24 h retention) or an unanswered attention.
// Anything else that has exited is on its way out of the registry.
export function isListedSession(session) {
  if (!session) return false;
  if (session.alive) return true;
  return Boolean(session.attention) || (session.activity?.background_output_bytes || 0) > 0;
}

// The line under the name, in the order someone scans it: what kind of terminal
// this is, then why it wants attention, then how long since anything happened.
// Memory only joins when a metrics-carrying payload actually measured it.
export function sessionSummary(session) {
  const activity = session?.activity || {};
  const unread = activity.background_output_bytes || 0;
  const parts = [session?.profile || "terminal"];
  if (session?.attention) {
    const age = session.attention.age_seconds;
    parts.push(Number.isFinite(age) ? `needs you ${formatUptime(age)} ago` : "needs you");
  } else if (session?.alive === false) {
    parts.push(exitText(session));
  } else if (agentState(session) && agentState(session) !== "idle") {
    parts.push(AGENT_STATE_TEXT[agentState(session)]);
  } else if (unread > 0) {
    const age = activity.background_output_age_seconds;
    parts.push(Number.isFinite(age)
      ? `+${formatBytes(unread)} ${formatUptime(age)} ago`
      : `+${formatBytes(unread)}`);
  } else if (processBusy(session)) {
    parts.push("working");
  } else {
    parts.push(`quiet ${formatUptime(activity.idle_seconds || 0)}`);
  }
  const usage = session?.usage;
  if (usage?.available) parts.push(formatBytes(usage.working_set_bytes || 0));
  return parts.join(" · ");
}

// Everything the row cannot show, for the tooltip. The id is here rather than
// on the row because it is what you paste into a bug report and never what you
// scan a list by.
export function sessionTooltip(session, groupName) {
  const usage = session?.usage;
  const lines = [session?.name || session?.id, sessionSummary(session), ...agentLines(session?.agent)];
  if (session?.attention) lines.push(`needs you: ${attentionText(session.attention)}`);
  if (session?.alive === false) lines.push(`finished, ${exitText(session)}; click to read its output`);
  lines.push(`workspace: ${groupName}`);
  const here = session?.current_cwd;
  if (here && session?.cwd && here !== session.cwd) {
    lines.push(`in ${here}`, `started in ${session.cwd}`);
  } else if (sessionFolder(session)) {
    lines.push(sessionFolder(session));
  }
  if ((session?.attachments || 0) > 0) lines.push(`${session.attachments} viewer${session.attachments === 1 ? "" : "s"} attached`);
  if (usage?.available) {
    lines.push(`${formatBytes(usage.working_set_bytes || 0)} · ${(usage.cpu_percent ?? 0).toFixed(1)}% CPU · ${usage.process_count || 0} processes`);
    lines.push(`up ${formatUptime(usage.uptime_seconds)}`);
  }
  lines.push(session?.id || "");
  return lines.filter(Boolean).join("\n");
}

export const COUNTED_STATES = ["attention", "finished", "open", "busy", "unread", "done", "failed"];
const emptyCounts = () => ({ attention: 0, open: 0, busy: 0, unread: 0, finished: 0, done: 0, failed: 0 });
export const KIND_ORDER = { flat: 0, workspace: 0, scratch: 1, unassigned: 2 };

export function lookup(map, id) {
  if (!map) return undefined;
  if (map instanceof Map) return map.get(id);
  return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined;
}

export function byText(a, b) {
  return String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true })
    || (a < b ? -1 : a > b ? 1 : 0);
}

// One flat list of groups: every saved workspace (empty ones too, so any of
// them is one click from open), the scratch views this window shows or that
// still own a terminal, then the terminals nobody owns. The order is the name
// and nothing else. A terminal that needs you gets a chip and a halo; it never
// moves a row or a group, because a list that reorders itself under the
// pointer turns a click on one terminal into a click on another.
//
// The owner rule is the dashboard's rule plus what this window knows first: a
// view that has a pane on the session, then an in-memory claim not yet
// autosaved, then the backend's `workspace` field (mirrored from every saved
// workspace's session_ids on each workspace PUT).
//
// `view` (the sidebar's view menu) may hide finished terminals, sort by
// recent activity instead, or drop the grouping for one flat list. Hiding
// empty workspaces is visibleGroups()'s job, so this list stays complete.
export function sidebarGroups(sessions = [], { workspaces = [], views = [], attached = {}, owned = {}, view } = {}) {
  const options = { ...SIDEBAR_VIEW_DEFAULTS, ...(view || {}) };
  const viewOf = new Map();
  for (const view of views || []) if (view?.workspace) viewOf.set(view.workspace, view);
  const saved = new Map();
  for (const entry of workspaces || []) {
    const info = typeof entry === "string" ? { name: entry } : entry;
    if (info?.name) saved.set(info.name, info);
  }
  const groups = new Map();

  const ensure = (name) => {
    const key = name ? `ws:${name}` : "unassigned";
    let group = groups.get(key);
    if (group) return group;
    const view = name ? viewOf.get(name) : undefined;
    const kind = !name ? "unassigned" : isScratchWorkspace(name) ? "scratch" : "workspace";
    const info = name ? saved.get(name) : undefined;
    group = {
      key,
      name: name || null,
      label: kind === "unassigned" ? UNASSIGNED_GROUP
        : kind === "scratch" ? (view?.label || workspaceLabel(name)) : name,
      kind,
      open: Boolean(view),
      active: Boolean(view?.active),
      color: view?.color || null,
      path: info?.path ?? null,
      pathExists: info?.pathExists ?? null,
      git: info?.git ?? null,
      host: info?.host ?? null,
      startup: info?.startup ?? [],
      sessions: [],
      counts: emptyCounts(),
    };
    groups.set(key, group);
    return group;
  };

  for (const name of saved.keys()) if (!isScratchWorkspace(name)) ensure(name);
  for (const name of viewOf.keys()) ensure(name);
  const flat = options.group === "none";
  // GET /api/sessions lists terminals in the order they were started, so the
  // index is their age: the tie-break between two rows of one name.
  for (const [started, session] of (sessions || []).entries()) {
    if (!isListedSession(session)) continue;
    // A finished terminal that still asks for you stays: hiding it would hide
    // the question.
    if (!options.finished && session.alive === false && !session.attention) continue;
    const attachedIn = lookup(attached, session.id) || null;
    const owner = attachedIn || lookup(owned, session.id) || session.workspace || null;
    const ownerGroup = ensure(owner);
    const group = flat ? ensureFlat(groups) : ownerGroup;
    const state = sessionState(session, Boolean(attachedIn));
    group.sessions.push({ session, state, attachedIn, finished: session.alive === false, owner: ownerGroup.label, started });
    if (COUNTED_STATES.includes(state.key)) group.counts[state.key] += 1;
  }

  const rowName = (entry) => entry.session.name || entry.session.id || "";
  const byName = (a, b) => rowName(a).localeCompare(rowName(b), undefined, { numeric: true })
    || a.started - b.started;
  const recent = options.sort === "activity";
  for (const group of groups.values()) {
    group.sessions.sort(byName);
    // Two terminals of one name in one group ("PowerShell", "PowerShell")
    // are told apart by a number in the order they were started, so a new
    // one is always the next number, and the activity sort never moves it.
    const seen = new Map();
    for (const entry of group.sessions) {
      const name = entry.session.name;
      if (!name) continue;
      const count = (seen.get(name) || 0) + 1;
      seen.set(name, count);
      entry.label = count > 1 ? `${name} ${count}` : name;
    }
    if (recent) group.sessions.sort((a, b) => idleOf(a.session) - idleOf(b.session) || byName(a, b));
  }
  const ordered = [...groups.values()].filter((group) => !flat || group.kind === "flat");
  return ordered.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || (recent ? groupIdle(a) - groupIdle(b) : 0)
    || byText(a.label, b.label)
    || byText(a.key, b.key));
}

// The branch a workspace head shows, muted: a detached HEAD by its short sha.
// Empty when it would only repeat the name.
export function groupBranch(group) {
  const git = group?.git;
  const branch = git?.branch || (git?.head ? `@${git.head}` : "");
  const plain = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!branch || plain(branch) === plain(group.label)) return "";
  return branch;
}

// A workspace whose folder is a linked worktree says so after its branch and
// names the main checkout in the tooltip. QuickTerm creates no worktrees; it
// only shows what the folder is.
export function worktreeNote(git) {
  if (!git?.worktree) return null;
  return { word: "worktree", title: git.main_path ? `worktree of ${git.main_path}` : "a git worktree" };
}

// Seconds since a terminal last did anything. Busy and ringing terminals are
// happening now; a finished one sorts after every live one.
function idleOf(session) {
  if (session?.attention || processBusy(session) || agentState(session) === "working") return 0;
  if (session?.alive === false) return Number.MAX_SAFE_INTEGER;
  const seconds = Number(session?.activity?.idle_seconds);
  return Number.isFinite(seconds) ? seconds : Number.MAX_SAFE_INTEGER - 1;
}

function groupIdle(group) {
  return group.sessions.length ? idleOf(group.sessions[0].session) : Number.MAX_SAFE_INTEGER;
}

function ensureFlat(groups) {
  let group = groups.get("flat");
  if (!group) {
    group = {
      key: "flat", name: null, label: "Terminals", kind: "flat", open: false, active: false,
      color: null, path: null, pathExists: null, git: null, host: null, sessions: [],
      counts: emptyCounts(),
    };
    groups.set("flat", group);
  }
  return group;
}

// What the sidebar draws. A workspace with no terminal is one more row to scan
// past on every glance, so unless the view menu asks for empty ones it shows
// only workspaces that hold a terminal or are open in this window. `hidden`
// counts the rest for the "show them" line under the list.
export function visibleGroups(groups = [], view) {
  const options = { ...SIDEBAR_VIEW_DEFAULTS, ...(view || {}) };
  if (options.empty) return { groups, hidden: 0 };
  const keep = new Set(groups.filter((group) => group.sessions.length > 0 || group.open || group.active).map((group) => group.key));
  const shown = groups.filter((group) => keep.has(group.key));
  return { groups: shown, hidden: groups.length - shown.length };
}

// The sidebar's view menu, per window like its mode and width.
export const SIDEBAR_VIEW_KEY = "quickterm.sidebarView";
export const SIDEBAR_VIEW_DEFAULTS = Object.freeze({ empty: false, finished: true, group: "workspace", sort: "name" });

export function normalizeView(value) {
  const view = value && typeof value === "object" ? value : {};
  return {
    empty: view.empty === true,
    finished: view.finished !== false,
    group: view.group === "none" ? "none" : "workspace",
    sort: view.sort === "activity" ? "activity" : "name",
  };
}

export function isDefaultView(view) {
  const normal = normalizeView(view);
  return Object.entries(SIDEBAR_VIEW_DEFAULTS).every(([key, value]) => normal[key] === value);
}

export function loadView() {
  try {
    return normalizeView(JSON.parse(localStorage.getItem(SIDEBAR_VIEW_KEY) || "{}"));
  } catch {
    return normalizeView({});
  }
}

export function saveView(view) {
  try { localStorage.setItem(SIDEBAR_VIEW_KEY, JSON.stringify(normalizeView(view))); } catch { /* private mode */ }
}

// The group's one-line summary. A collapsed group has to keep saying what is
// inside it, or folding one away hides exactly what this section exists to
// show. The count itself lives in the pill beside the name.
export function groupSummary(group) {
  const sessions = group.sessions || [];
  if (!sessions.length) return "nothing running";
  const counts = group.counts || group;
  const count = (key) => counts[key] || 0;
  const parts = [];
  const attention = count("attention");
  const finished = count("finished");
  if (attention) parts.push(`${attention} need${attention === 1 ? "s" : ""} you`);
  if (count("open")) parts.push(`${count("open")} open`);
  if (count("unread")) parts.push(`${count("unread")} new output`);
  if (count("busy")) parts.push(`${count("busy")} busy`);
  if (count("done")) parts.push(`${count("done")} done`);
  if (count("failed")) parts.push(`${count("failed")} failed`);
  const quiet = sessions.length - attention - finished - count("open") - count("unread") - count("busy")
    - count("done") - count("failed");
  if (quiet > 0) parts.push(`${quiet} background`);
  if (finished) parts.push(`${finished} finished`);
  return parts.join(" · ");
}

// The workspace folder is the one fact about a workspace worth a permanent
// slot in the chrome; the full path stays in the tooltip.
export function folderName(path) {
  if (!path) return "";
  const parts = String(path).split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || String(path);
}


// The "+" menu (CONTRACTS 4.5), as rows the launcher turns into menu.js
// items: every available shell with the configured one marked, then Claude
// Code and Codex when installed, then "As administrator". Separators sit
// between the parts; a part with nothing in it leaves no empty band.
// A workspace in WSL or on an SSH host (`host`) has no local shells and no
// administrator: its first row is the login shell there.
export function newTerminalMenu({
  inventory = null, shell = DEFAULT_SHELL, agents = [], host = null, admin = false,
} = {}) {
  const current = shell ?? DEFAULT_SHELL;
  const rows = host
    ? [{ key: "remote-shell", kind: "remote-shell", label: `Shell in ${locationLabel(host)}`, isDefault: true }]
    : availableShells(inventory, current).map((entry) => ({
      key: `shell:${entry.value}`,
      kind: "shell",
      value: entry.value,
      label: entry.label,
      isDefault: entry.value === current,
    }));
  const launchers = (agents || []).map((profile) => ({
    key: `agent:${profile.name}`, kind: "agent", profile, label: profile.label || profile.name,
  }));
  if (launchers.length) rows.push({ key: "separator:launchers", kind: "separator" }, ...launchers);
  // The sidebar's menu (`admin`) also starts the chosen row elevated; the
  // admin instance itself, WSL and an SSH host cannot.
  if (admin && !host) rows.push({ key: "separator:admin", kind: "separator" }, { key: "admin", kind: "admin", label: "As administrator…" });
  return rows;
}

// The configured shell, the "+" button's choice until another row is picked.
export function defaultShellRow(menu) {
  const shellLike = (row) => row.kind === "shell" || row.kind === "remote-shell";
  return (menu || []).find((row) => shellLike(row) && row.isDefault)
    || (menu || []).find(shellLike) || null;
}

// The rows a new terminal can be started from (no separators, no admin).
const LAUNCHABLE = new Set(["shell", "remote-shell", "agent"]);

// What "+" and Alt+N start: the row picked last in the "+" menu, while the
// menu still has it (a WSL or SSH workspace has no local shells, a saved
// terminal from before 4.5 is gone), else the configured shell.
export function chosenRow(menu, key) {
  const picked = key ? (menu || []).find((row) => row.key === key && LAUNCHABLE.has(row.kind)) : null;
  return picked || defaultShellRow(menu);
}

// Remembered per machine, like the sidebar mode: the menu's key of the row.
export const TERMINAL_CHOICE_KEY = "quickterm.newTerminalChoice";

export function loadTerminalChoice() {
  try { return localStorage.getItem(TERMINAL_CHOICE_KEY) || null; } catch (_) { return null; }
}

export function saveTerminalChoice(key) {
  try {
    if (key) localStorage.setItem(TERMINAL_CHOICE_KEY, key);
    else localStorage.removeItem(TERMINAL_CHOICE_KEY);
  } catch (_) { /* optional */ }
}

export function loadMode() {
  try {
    const stored = sessionStorage.getItem(SIDEBAR_MODE_KEY) || localStorage.getItem(SIDEBAR_MODE_KEY);
    if (SIDEBAR_MODES.includes(stored)) return stored;
    // Sidebars collapsed before modes existed stay collapsed.
    return localStorage.getItem(LEGACY_COLLAPSED_KEY) === "1" ? "rail" : "full";
  } catch (_) { return "full"; }
}

export function saveMode(mode) {
  try { sessionStorage.setItem(SIDEBAR_MODE_KEY, mode); } catch (_) { /* optional */ }
  try { localStorage.setItem(SIDEBAR_MODE_KEY, mode); } catch (_) { /* optional */ }
}

export function loadWidth() {
  try {
    const raw = sessionStorage.getItem(SIDEBAR_WIDTH_KEY) || localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw === null) return SIDEBAR_WIDTH_DEFAULT;
    return clampSidebarWidth(parseInt(raw, 10), window.innerWidth);
  } catch (_) { return SIDEBAR_WIDTH_DEFAULT; }
}

export function saveWidth(width) {
  try { sessionStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)); } catch (_) { /* optional */ }
  try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)); } catch (_) { /* optional */ }
}

// Folded groups are stored by workspace name (Unassigned by its label), not by
// position: workspaces come and go and the fold has to stay with its group.
export function loadClosedGroups() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(SIDEBAR_GROUPS_KEY) || "[]");
    return new Set(Array.isArray(raw) ? raw.filter((name) => typeof name === "string") : []);
  } catch (_) { return new Set(); }
}

export function saveClosedGroups(names) {
  try { sessionStorage.setItem(SIDEBAR_GROUPS_KEY, JSON.stringify([...names])); } catch (_) { /* optional */ }
}

export function foldId(group) {
  return group.name || UNASSIGNED_GROUP;
}
