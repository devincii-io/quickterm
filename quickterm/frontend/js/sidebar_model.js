// The sidebar's model, without a DOM: its modes and width, how sessions
// group and what state each row shows, the terminal choices for new panes,
// and the per-machine storage behind the mode, width and folded groups.
// launcher.js builds the DOM from it and re-exports its public names.

import { agentModeOf, modeArgs, modeLabel } from "./agent_profile.js";
import { formatBytes, formatUptime } from "./panel_shared.js";
import { isScratchWorkspace, workspaceLabel } from "./boot_context.js";

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

// Past this the terminal rows get a second line (the folder each shell is
// sitting in) instead of hiding it behind a tooltip. Dragging the sidebar wide
// should buy information, not whitespace.
export const SIDEBAR_WIDE_AT = 280;

export function isWideSidebar(width) {
  return Number(width) >= SIDEBAR_WIDE_AT;
}

// Terminals nobody claims land here. panel_dashboard.js names the same set with
// the same word, so the two views cannot describe one thing two ways.
export const UNASSIGNED_GROUP = "Unassigned";

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
export function sessionState(session, isAttached) {
  const activity = session?.activity || {};
  if (session?.attention) return { key: "attention", label: "needs you" };
  if (session?.alive === false) return { key: "finished", label: "finished" };
  if (isAttached) return { key: "open", label: "open" };
  if (session?.busy === true) return { key: "busy", label: "busy" };
  if ((activity.background_output_bytes || 0) > 0) return { key: "unread", label: "new output" };
  if ((session?.attachments || 0) > 0) return { key: "elsewhere", label: "open elsewhere" };
  return { key: "idle", label: "background" };
}

// The folder a row names: where the shell says it is now (OSC 7 / OSC 9;9),
// else where it started.
export function sessionFolder(session) {
  return session?.current_cwd || session?.cwd || "";
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
  } else if (unread > 0) {
    const age = activity.background_output_age_seconds;
    parts.push(Number.isFinite(age)
      ? `+${formatBytes(unread)} ${formatUptime(age)} ago`
      : `+${formatBytes(unread)}`);
  } else if (session?.busy === true) {
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
  const lines = [session?.name || session?.id, sessionSummary(session)];
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

export const COUNTED_STATES = ["attention", "finished", "open", "busy", "unread"];
export const KIND_ORDER = { workspace: 0, scratch: 1, unassigned: 2 };

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
export function sidebarGroups(sessions = [], { workspaces = [], views = [], attached = {}, owned = {} } = {}) {
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
      sessions: [],
      counts: { attention: 0, open: 0, busy: 0, unread: 0, finished: 0 },
    };
    groups.set(key, group);
    return group;
  };

  for (const name of saved.keys()) if (!isScratchWorkspace(name)) ensure(name);
  for (const name of viewOf.keys()) ensure(name);
  for (const session of sessions || []) {
    if (!isListedSession(session)) continue;
    const attachedIn = lookup(attached, session.id) || null;
    const owner = attachedIn || lookup(owned, session.id) || session.workspace || null;
    const group = ensure(owner);
    const state = sessionState(session, Boolean(attachedIn));
    group.sessions.push({ session, state, attachedIn, finished: session.alive === false });
    if (COUNTED_STATES.includes(state.key)) group.counts[state.key] += 1;
  }

  const rowName = (entry) => entry.session.name || entry.session.id || "";
  for (const group of groups.values()) {
    group.sessions.sort((a, b) => rowName(a).localeCompare(rowName(b), undefined, { numeric: true })
      || String(a.session.id).localeCompare(String(b.session.id), undefined, { numeric: true }));
  }
  return [...groups.values()].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || byText(a.label, b.label)
    || byText(a.key, b.key));
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
  const quiet = sessions.length - attention - finished - count("open") - count("unread") - count("busy");
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


export function shellLabel(profile) {
  const target = profile.ssh_host
    ? (profile.ssh_user ? `${profile.ssh_user}@${profile.ssh_host}` : profile.ssh_host)
    : "";
  const mode = modeLabel(agentModeOf(profile));
  const labels = {
    "claude-code": `Claude Code · ${mode}`,
    codex: `Codex · ${mode}`,
    "powershell-core": "PowerShell 7",
    "windows-powershell": "Windows PowerShell",
    "command-prompt": "Command Prompt",
    wsl: profile.wsl_distro ? `WSL · ${profile.wsl_distro}` : "WSL",
    ssh: target ? `SSH · ${target}` : "SSH",
    sftp: target ? `SFTP · ${target}` : "SFTP",
    custom: "Custom command",
  };
  return labels[profile.terminal_type] || profile.cmd || "Terminal";
}

export const SYSTEM_META = {
  "powershell-core": { args: ["-NoLogo"] },
  "windows-powershell": { args: ["-NoLogo"] },
  "command-prompt": { args: [] },
  wsl: { args: ["--cd", "~"] },
  bash: { args: ["-l"] },
  zsh: { args: ["-l"] },
  fish: { args: ["-l"] },
  "git-bash": { args: ["-l"] },
  nushell: { args: [] },
};

// Agents need no profile. When the inventory finds a CLI, its common modes
// exist out of the box, each just the CLI plus its mode arguments; the
// workspace folder is where they open, exactly like a shell.
export const AGENT_CHOICES = {
  "claude-code": {
    group: "Claude",
    prefix: "claude",
    modes: [
      ["continue", "Claude · continue", "Continue the latest conversation in this folder"],
      ["new", "Claude · new", "Start a new conversation in this folder"],
      ["resume", "Claude · resume", "Choose one of Claude's sessions in this folder"],
    ],
  },
  codex: {
    group: "Codex",
    prefix: "codex",
    modes: [
      ["new", "Codex · new conversation", "Start a new Codex conversation in this folder"],
      ["continue", "Codex · continue latest", "Continue the latest Codex conversation in this folder"],
      ["resume", "Codex · choose session", "Choose one of Codex's sessions"],
    ],
  },
};

// Every choice carries its own `key`, and the selection is compared by that
// key alone, so a choice object from an earlier model still selects the right
// row after the list is recomputed.
export function terminalChoices(options) {
  const choices = [];
  for (const profile of options.profiles || []) {
    choices.push({
      key: `profile:${profile.name}`,
      group: ["rdp", "vnc"].includes(profile.terminal_type) ? "Desktop windows" : "Saved terminals",
      kind: "profile",
      profile,
      label: profile.name,
      // A description is why this profile exists; shellLabel only restates the
      // command, which the name usually already implies. Profiles written
      // before descriptions existed have none, so the shell label stays the
      // fallback rather than leaving the row blank.
      detail: (profile.description || "").trim() || shellLabel(profile),
    });
  }
  if (options.configuredOnly) return choices.filter((choice) => !["rdp", "vnc"].includes(choice.profile.terminal_type));
  const types = options.inventory?.types || [];
  for (const type of types) {
    if (!type.executable || type.available === false || ["custom", "ssh", "sftp", ...Object.keys(AGENT_CHOICES)].includes(type.id)) continue;
    const meta = SYSTEM_META[type.id] || { args: [] };
    if (type.id === "wsl" && (options.inventory?.wsl_distributions || []).length) {
      for (const distro of options.inventory.wsl_distributions) {
        choices.push({
          key: `system:wsl:${distro}`,
          group: "System",
          kind: "system",
          id: type.id,
          cmd: type.executable,
          args: ["-d", distro],
          distro,
          label: `WSL · ${distro}`,
          detail: distro,
        });
      }
      continue;
    }
    choices.push({
      key: `system:${type.id}`,
      group: "System",
      kind: "system",
      id: type.id,
      cmd: type.executable,
      args: meta.args,
      label: type.label,
      detail: type.executable,
    });
  }
  for (const [id, agent] of Object.entries(AGENT_CHOICES)) {
    const found = types.find((type) => type.id === id && type.executable && type.available !== false);
    if (!found) continue;
    for (const [mode, label, detail] of agent.modes) {
      const prefix = agent.prefix;
      choices.push({
        key: prefix === "claude" ? `claude:${mode}` : `${prefix}:${mode}`,
        group: agent.group,
        kind: "system",
        id,
        cmd: found.executable,
        args: modeArgs(id, mode),
        mode,
        label,
        detail,
      });
    }
  }
  // A missing shell one step away (PowerShell 7 through winget, or its
  // download page). Choosing it installs once; it is never what "+" starts,
  // so it is not selected, cycled or remembered (`canLaunch`).
  for (const install of options.inventory?.installs || []) {
    choices.push({
      key: `install:${install.id}`,
      group: "Install",
      kind: "install",
      id: install.id,
      cmd: install.cmd || null,
      args: install.args || [],
      url: install.url || null,
      label: install.label,
      detail: install.cmd ? "install with winget" : "open the download page",
    });
  }
  return choices;
}

export function canLaunch(choice) {
  return Boolean(choice) && choice.kind !== "install";
}

export function choiceKey(choice) {
  return choice?.key || "";
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
