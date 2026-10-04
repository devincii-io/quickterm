import { icon } from "./icons.js";
import { toggleMenu } from "./menu.js";
import { formatBytes, formatUptime } from "./panel_shared.js";
import { connectionLabel, connectionTarget } from "./panel_connections.js";
import { isScratchWorkspace, workspaceLabel } from "./boot_context.js";
import { itemFor, markEditing, patchList, setAttrs, setClass, setText } from "./render.js";
import { claimFocus, releaseFocus } from "./focus.js";
import { confirmNear } from "./confirm_popover.js";

// The sidebar is the whole chrome. Three modes, one hotkey (Alt+Shift+S)
// cycles them, and the choice is remembered per machine:
//   full    one list: new terminal, every workspace with its terminals, icons
//   rail    30px of dots, so the state of every terminal is still in view
//   hidden  nothing at all; a small floating "+" sits at the terminal's top
//           left corner
export const SIDEBAR_MODES = ["full", "rail", "hidden"];
const SIDEBAR_MODE_KEY = "quickterm.sidebarMode";
const LEGACY_COLLAPSED_KEY = "quickterm.sidebarCollapsed";
const SIDEBAR_WIDTH_KEY = "quickterm.sidebarWidth";
const SIDEBAR_GROUPS_KEY = "quickterm.sidebarClosedGroups";

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

function exitText(session) {
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

const COUNTED_STATES = ["attention", "finished", "open", "busy", "unread"];
const KIND_ORDER = { workspace: 0, scratch: 1, unassigned: 2 };

function lookup(map, id) {
  if (!map) return undefined;
  if (map instanceof Map) return map.get(id);
  return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined;
}

function byText(a, b) {
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
function folderName(path) {
  if (!path) return "";
  const parts = String(path).split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || String(path);
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The agent mode of a profile. `claude_mode` is the pre-4.0 field name and is
// still written for Claude Code profiles, so it is read as the fallback.
const AGENT_MODE_LABELS = {
  new: "new conversation",
  continue: "continue latest",
  resume: "choose session",
  fork: "fork a session",
  agents: "agent manager",
};

function agentMode(profile) {
  return profile.agent_mode ?? profile.claude_mode ?? (profile.terminal_type === "codex" ? "new" : "continue");
}

function shellLabel(profile) {
  const target = profile.ssh_host
    ? (profile.ssh_user ? `${profile.ssh_user}@${profile.ssh_host}` : profile.ssh_host)
    : "";
  const mode = AGENT_MODE_LABELS[agentMode(profile)] || agentMode(profile);
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

const SYSTEM_META = {
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
const AGENT_CHOICES = {
  "claude-code": {
    group: "Claude",
    prefix: "claude",
    modes: [
      ["continue", ["--continue"], "Claude · continue", "Continue the latest conversation in this folder"],
      ["new", [], "Claude · new", "Start a new conversation in this folder"],
      ["resume", ["--resume"], "Claude · resume", "Choose one of Claude's sessions in this folder"],
    ],
  },
  codex: {
    group: "Codex",
    prefix: "codex",
    modes: [
      ["new", [], "Codex · new conversation", "Start a new Codex conversation in this folder"],
      ["continue", ["resume", "--last"], "Codex · continue latest", "Continue the latest Codex conversation in this folder"],
      ["resume", ["resume"], "Codex · choose session", "Choose one of Codex's sessions"],
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
    for (const [mode, args, label, detail] of agent.modes) {
      const prefix = agent.prefix;
      choices.push({
        key: prefix === "claude" ? `claude:${mode}` : `${prefix}:${mode}`,
        group: agent.group,
        kind: "system",
        id,
        cmd: found.executable,
        args,
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

function choiceKey(choice) {
  return choice?.key || "";
}

function iconButton(className, iconName, title, onClick) {
  const button = make("button", className);
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.append(icon(iconName, 14));
  if (onClick) button.addEventListener("click", onClick);
  return button;
}

function setLabel(button, title) {
  setAttrs(button, { title, "aria-label": title });
}

function loadMode() {
  try {
    const stored = sessionStorage.getItem(SIDEBAR_MODE_KEY) || localStorage.getItem(SIDEBAR_MODE_KEY);
    if (SIDEBAR_MODES.includes(stored)) return stored;
    // Sidebars collapsed before modes existed stay collapsed.
    return localStorage.getItem(LEGACY_COLLAPSED_KEY) === "1" ? "rail" : "full";
  } catch (_) { return "full"; }
}

function saveMode(mode) {
  try { sessionStorage.setItem(SIDEBAR_MODE_KEY, mode); } catch (_) { /* optional */ }
  try { localStorage.setItem(SIDEBAR_MODE_KEY, mode); } catch (_) { /* optional */ }
}

function loadWidth() {
  try {
    const raw = sessionStorage.getItem(SIDEBAR_WIDTH_KEY) || localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw === null) return SIDEBAR_WIDTH_DEFAULT;
    return clampSidebarWidth(parseInt(raw, 10), window.innerWidth);
  } catch (_) { return SIDEBAR_WIDTH_DEFAULT; }
}

function saveWidth(width) {
  try { sessionStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)); } catch (_) { /* optional */ }
  try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)); } catch (_) { /* optional */ }
}

// Folded groups are stored by workspace name (Unassigned by its label), not by
// position: workspaces come and go and the fold has to stay with its group.
function loadClosedGroups() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(SIDEBAR_GROUPS_KEY) || "[]");
    return new Set(Array.isArray(raw) ? raw.filter((name) => typeof name === "string") : []);
  } catch (_) { return new Set(); }
}

function saveClosedGroups(names) {
  try { sessionStorage.setItem(SIDEBAR_GROUPS_KEY, JSON.stringify([...names])); } catch (_) { /* optional */ }
}

function foldId(group) {
  return group.name || UNASSIGNED_GROUP;
}

// The floating "+" that stands in for the sidebar while it is hidden. It is
// static in index.html and pinned by CSS at the top left; it does not move.
function wireFloat(actions, signal, showSidebar) {
  const float = document.getElementById("float-launch");
  if (!float) return { show() {}, hide() {} };
  const open = float.querySelector(".float-new");
  const reveal = float.querySelector(".float-show");
  open?.addEventListener("click", () => actions.newTerminal?.(), { signal });
  open?.addEventListener("contextmenu", (event) => { event.preventDefault(); showSidebar(); }, { signal });
  reveal?.addEventListener("click", showSidebar, { signal });
  return {
    show() { float.hidden = false; },
    hide() { float.hidden = true; },
  };
}

// A click synthesised by Enter or Space has no pointer behind it.
function fromKeyboard(event) {
  return event?.detail === 0;
}

export function initLauncher(el, { actions = {}, chrome = [], elevated = false } = {}) {
  if (el._launcherAbort) el._launcherAbort.abort();
  const abort = new AbortController();
  const signal = abort.signal;
  el._launcherAbort = abort;
  el.textContent = "";
  el.classList.add("sidebar");

  let model = {
    profiles: [], inventory: null, defaultProfile: null, selectedTerminal: null, logoUrl: null,
    workspaces: [], views: [], sessions: [], attached: {}, owned: {}, here: null,
  };

  // Hand the keyboard back to the terminal once a choice is made, or the next
  // keystroke lands on the control that was just used instead of the shell.
  // Menus and confirmations claim the keyboard in focus.js while open and
  // release it before this runs.
  const handBack = () => requestAnimationFrame(() => actions.handBack?.());

  // Mode -------------------------------------------------------------------
  let mode = loadMode();
  const float = wireFloat(actions, signal, () => setMode("full"));
  const applyMode = () => {
    document.body.classList.toggle("sidebar-collapsed", mode === "rail");
    document.body.classList.toggle("sidebar-hidden", mode === "hidden");
    el.setAttribute("aria-hidden", String(mode === "hidden"));
    if (mode === "hidden") float.show(); else float.hide();
    saveMode(mode);
    actions.sidebarResized?.();
  };
  let describeCollapse = () => {};
  const setMode = (next) => {
    if (!SIDEBAR_MODES.includes(next) || next === mode) return;
    mode = next;
    applyMode();
    describeCollapse();
    handBack();
  };

  // New terminal -----------------------------------------------------------
  // One button that opens whatever is selected, and a chevron beside it that
  // opens the list of choices as a menu (menu.js). Built once; the choices are
  // recomputed when profiles, inventory or the selection change.
  const launch = make("div", "sidebar-launch");
  let menuChoices = [];
  let choices = [];
  let selected = null;

  const open = make("button", "sidebar-new");
  open.type = "button";
  const openLabel = make("span", "sidebar-label");
  open.append(icon("plus", 15), openLabel);
  const describeOpen = () => {
    setText(openLabel, selected ? selected.label : "Set up terminal");
    open.title = selected
      ? `New ${selected.label} (Alt+N) · ${selected.detail}`
      : "No shell was found on this computer";
    open.disabled = !selected && !actions.setup;
  };
  open.addEventListener("click", () => {
    if (!selected) { actions.setup?.(); return; }
    const launched = selected.kind === "profile"
      ? actions.runProfile?.(selected.profile)
      : actions.runSystem?.(selected);
    Promise.resolve(launched).finally(handBack);
  }, { signal });

  const pick = iconButton("sidebar-terminal-pick", "chevron-down", "Choose what a new terminal runs");
  pick.setAttribute("aria-haspopup", "menu");
  pick.setAttribute("aria-expanded", "false");
  const select = (choice) => {
    selected = choice;
    // Kept here as well, so a later profiles update cannot restore the old pick
    // before the shell has echoed the new one.
    model = { ...model, selectedTerminal: choice };
    if (choice) actions.selectTerminal?.(choice);
    describeOpen();
  };
  const openTerminalMenu = () => {
    if (!menuChoices.length) { actions.setup?.(); return; }
    const items = [];
    let group = null;
    for (const choice of menuChoices) {
      if (choice.group !== group) {
        group = choice.group;
        items.push({ heading: group });
      }
      items.push({
        label: choice.label,
        detail: choice.detail,
        icon: canLaunch(choice) ? undefined : "plus",
        selected: choice.key === choiceKey(selected),
        run: () => (canLaunch(choice) ? select(choice) : actions.install?.(choice)),
      });
    }
    items.push({ separator: true }, { label: "Manage terminals and connections", icon: "settings", run: () => actions.setup?.() });
    toggleMenu({ anchor: launch, trigger: pick, items, label: "Terminal for new panes", onClose: handBack });
  };
  pick.addEventListener("click", openTerminalMenu, { signal });
  // Right-clicking "+" is the fast way to the same list.
  open.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openTerminalMenu();
  }, { signal });
  launch.append(open, pick);
  launch.append(iconButton("sidebar-setup", "settings", "Manage terminals and connections", () => actions.setup?.()));
  if (!elevated) {
    // Elevation spawns a separate process, so success is invisible here and a
    // declined UAC prompt is indistinguishable from a dead button. Hold the
    // button while the request is in flight and let the shell report the outcome.
    const admin = iconButton("sidebar-admin", "shield", "New administrator terminal", () => {
      if (!selected || admin.disabled) return;
      admin.disabled = true;
      const request = selected.kind === "profile"
        ? actions.elevateProfile?.(selected.profile)
        : actions.elevateSystem?.(selected);
      Promise.resolve(request).finally(() => { admin.disabled = false; });
    });
    launch.append(admin);
  }
  el.append(launch);

  const patchLaunch = () => {
    // The configured launcher lists saved terminals only (setup adds them); a
    // model can opt back into the raw inventory with configuredOnly: false.
    menuChoices = terminalChoices({ ...model, configuredOnly: model.configuredOnly ?? true });
    choices = menuChoices.filter(canLaunch);
    const wanted = choiceKey(model.selectedTerminal) || choiceKey(selected);
    let next = choices.find((choice) => choice.key === wanted);
    if (!next && model.defaultProfile) {
      // A profile name, or a system shell id ("git-bash"; "wsl" is its first
      // distribution). A profile of the same name wins.
      next = choices.find((choice) => choice.key === `profile:${model.defaultProfile}`)
        || choices.find((choice) => choice.kind === "system" && choice.id === model.defaultProfile);
    }
    next ||= choices[0] || null;
    pick.disabled = !menuChoices.length;
    if (next && choiceKey(next) !== choiceKey(model.selectedTerminal)) select(next);
    else { selected = next; describeOpen(); }
  };

  // Workspaces -------------------------------------------------------------
  const section = make("div", "sidebar-section");
  const add = iconButton("sidebar-section-add", "plus", "New scratch view, workspace here, or a new window");
  add.setAttribute("aria-haspopup", "menu");
  add.setAttribute("aria-expanded", "false");
  add.addEventListener("click", () => {
    const here = model.here;
    toggleMenu({
      anchor: section,
      trigger: add,
      label: "Workspaces",
      items: [
        { label: "New scratch view", icon: "plus", detail: "a fresh disposable layout", run: () => actions.newScratch?.() },
        here ? {
          label: `Workspace here: ${here.name}`, icon: "folder", detail: folderName(here.folder), title: hereTitle(here),
          run: () => actions.workspaceHere?.(),
        } : null,
        { label: "Open in new window…", icon: "new-window", run: () => actions.newWindow?.() },
      ],
      onClose: (reason) => { if (reason !== "run") handBack(); },
    });
  }, { signal });
  section.append(make("span", "sidebar-section-label", "Workspaces"), add);
  el.append(section);

  // The active workspace's second line: its folder, the "workspace here"
  // offer, Explorer and VS Code, and the save dot. One node, moved under
  // whichever group head is active, so #sb-save is always the same element.
  const activeLine = make("div", "sidebar-active-line");
  const folderLine = make("small", "sidebar-folder");
  const hereButton = make("button", "sidebar-here");
  hereButton.type = "button";
  hereButton.hidden = true;
  const hereText = make("span", "sidebar-label");
  hereButton.append(icon("plus", 11), hereText);
  hereButton.addEventListener("click", () => {
    actions.workspaceHere?.();
    handBack();
  }, { signal });
  const tools = make("div", "sidebar-folder-tools");
  const openIn = (app, iconName, label) => {
    const button = iconButton("sidebar-folder-open", iconName, label, () => {
      actions.openFolder?.(app);
      handBack();
    });
    button.dataset.app = app;
    return button;
  };
  // The folder is resolved by the shell at click time, so it is where the
  // focused terminal is right now (a `cd` counts), else the workspace folder.
  tools.append(
    openIn("explorer", "folder", "Open the focused terminal's folder in Explorer (Alt+Shift+E)"),
    openIn("vscode", "code", "Open the focused terminal's folder in VS Code (Alt+Shift+C)"),
  );
  const save = make("span", "sidebar-save");
  save.id = "sb-save";
  save.setAttribute("role", "status");
  save.setAttribute("aria-live", "polite");
  activeLine.append(folderLine, hereButton, tools, save);
  // Where the line waits while no view is open, so #sb-save stays in the DOM.
  const parking = make("div", "sidebar-parking");
  parking.hidden = true;
  parking.append(activeLine);

  const hereLabel = (here) => (here.action === "open" ? `open ${here.name}` : `workspace here: ${here.name}`);
  function hereTitle(here) {
    return here.action === "open"
      ? `${here.folder} is the folder of workspace ${here.name}. Open it and take this terminal along.`
      : `Make ${here.folder} a workspace named ${here.name} and move this terminal into it`;
  }
  // The offer to make the focused terminal's folder a workspace. The shell
  // patches it on every focus and folder change.
  const patchHere = () => {
    const here = model.here || null;
    hereButton.hidden = !here;
    if (!here) return;
    setText(hereText, hereLabel(here));
    setLabel(hereButton, hereTitle(here));
  };
  const patchActiveLine = (group) => {
    const path = group?.path || "";
    const folder = folderName(path);
    // Scratch says where its terminals start, so the line is never blank.
    const fallback = group?.kind === "workspace" ? "no folder" : group?.kind === "scratch" ? "scratch folder" : "";
    setText(folderLine, folder || fallback);
    // "acme / acme" says nothing twice.
    folderLine.hidden = !folderLine.textContent
      || folder.toLowerCase() === String(group?.label || "").toLowerCase();
    setClass(folderLine, "warning", group?.pathExists === false);
    folderLine.title = !path
      ? (group?.kind === "scratch"
        ? "Scratch terminals start in QuickTerm's disposable scratch folder."
        : "This workspace has no folder. Terminals open in your home folder.")
      : group.pathExists === false ? `${path} (missing)` : path;
  };

  // Terminals --------------------------------------------------------------
  const sessionList = make("div", "sidebar-sessions");
  const groupList = make("div", "sidebar-groups");
  const emptyNote = make("div", "sidebar-empty", "no workspaces and no terminals");
  emptyNote.hidden = true;
  sessionList.append(groupList, emptyNote);
  el.append(sessionList, parking);

  const closedGroups = loadClosedGroups();
  const parts = new WeakMap();
  // Open confirmations by what they are about (`session:<id>`, `group:<key>`),
  // so one whose row has gone, or moved to another group, can be closed on the
  // next update.
  const confirms = new Map();

  const groupOf = (node) => itemFor(node.closest(".session-group"));

  const openConfirm = (key, holder, trigger, options) => {
    confirms.get(key)?.handle.close("replaced");
    holder.classList.add("armed");
    const handle = confirmNear(trigger, {
      owner: "sidebar-confirm",
      ...options,
      onClose: (reason) => {
        if (confirms.get(key)?.handle === handle) confirms.delete(key);
        holder.classList.remove("armed");
        // Blur: the keyboard already went where the person clicked.
        // Replaced: a newer bar holds it, and a deferred hand-back would
        // pull it out of that bar.
        if (reason !== "blur" && reason !== "replaced") handBack();
      },
    });
    confirms.set(key, { handle, trigger });
    return handle;
  };

  const killConfirm = (entry, keyboard) => {
    const item = itemFor(entry);
    if (!item?.session || item.session.alive === false) return;
    const { kill, row } = parts.get(entry);
    const name = item.session.name || item.session.id;
    // In rail mode the row's actions are display:none, and a trigger without
    // a box drops the confirmation in the corner and closes it on the first
    // scroll as "gone". The row itself is the visible trigger then.
    const trigger = kill.getClientRects().length ? kill : row;
    openConfirm(`session:${item.session.id}`, entry, trigger, {
      message: `Kill ${name}? This stops its whole process tree.`,
      confirmLabel: "Kill",
      keyboard,
      acceptsAltW: true,
      // Read at confirm time: the row may have been patched since it opened.
      action: () => actions.killTerminal?.(itemFor(entry)?.session || item.session),
    });
  };

  const detach = (entry) => {
    const session = itemFor(entry)?.session;
    if (!session) return;
    Promise.resolve(actions.detachTerminal?.(session)).finally(handBack);
  };

  // Double-click or F2 renames in place. The input claims the keyboard, and the
  // row is marked as being edited, so the 10 s poll leaves it alone.
  const startRename = (entry) => {
    const { row, name } = parts.get(entry);
    const session = itemFor(entry)?.session;
    if (!session || row.querySelector("input")) return;
    const input = make("input", "session-rename");
    input.value = session.name || "";
    input.spellcheck = false;
    input.setAttribute("aria-label", "Terminal name");
    markEditing(entry, true);
    claimFocus("sidebar-rename");
    name.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = (keep) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      input.replaceWith(name);
      markEditing(entry, false);
      releaseFocus("sidebar-rename");
      const current = itemFor(entry)?.session || session;
      if (keep && value && value !== current.name) {
        setText(name, value);
        actions.renameTerminal?.(current, value);
      }
      handBack();
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") commit(true);
      else if (event.key === "Escape") commit(false);
    });
    input.addEventListener("blur", () => commit(true));
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("dblclick", (event) => event.stopPropagation());
  };

  const activeView = () => (model.views || []).find((view) => view.active) || null;

  const rowMenu = (entry, keyboard) => {
    const item = itemFor(entry);
    if (!item?.session) return;
    const { session, attachedIn } = item;
    const group = groupOf(entry);
    const target = activeView();
    const owner = group?.name || null;
    const items = [
      { label: "Open", icon: "arrow-up-right", run: () => actions.activateTerminal?.(itemFor(entry)?.session || session) },
    ];
    if (target && session.alive !== false && owner !== target.workspace) {
      items.push({
        label: `Move to ${target.label || workspaceLabel(target.workspace)}`, icon: "workspaces",
        run: () => Promise.resolve(actions.moveTerminalHere?.(itemFor(entry)?.session || session)).finally(handBack),
      });
    }
    if (attachedIn) items.push({ label: "Detach", icon: "unplug", hint: "keeps running", run: () => detach(entry) });
    items.push({ label: "Rename", hint: "F2", run: () => startRename(entry) });
    if (session.alive !== false) {
      items.push({ separator: true }, { label: "Kill…", icon: "stop", danger: true, hint: "Del", run: () => killConfirm(entry, keyboard) });
    }
    const { row } = parts.get(entry);
    toggleMenu({
      anchor: row,
      trigger: row,
      items,
      label: `Terminal ${session.name || session.id}`,
      onClose: (reason) => { if (reason !== "run") handBack(); },
    });
  };

  const createRow = () => {
    const entry = make("div", "session-entry");
    const row = make("button", "session-row");
    row.type = "button";
    const dot = make("span", "session-state");
    const name = make("span", "session-name");
    const chip = make("span", "session-chip");
    const where = make("small", "session-where");
    row.append(dot, name, chip, where);
    const tray = make("div", "session-actions");
    const detachButton = iconButton("session-action session-detach", "unplug", "Detach", () => detach(entry));
    const kill = iconButton("session-action session-kill danger", "stop", "Kill", (event) => killConfirm(entry, fromKeyboard(event)));
    tray.append(detachButton, kill);
    entry.append(row, tray);
    parts.set(entry, { row, name, chip, where, detach: detachButton, kill });

    row.addEventListener("click", () => {
      const session = itemFor(entry)?.session;
      if (session) actions.activateTerminal?.(session);
    });
    row.addEventListener("dblclick", (event) => {
      event.preventDefault();
      startRename(entry);
    });
    let keyboardMenuAt = 0;
    row.addEventListener("keydown", (event) => {
      if (event.target !== row) return;
      if (event.key === "F2") {
        event.preventDefault();
        startRename(entry);
      } else if (event.key === "Delete") {
        event.preventDefault();
        killConfirm(entry, true);
      } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
        event.preventDefault();
        keyboardMenuAt = Date.now();
        rowMenu(entry, true);
      }
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      // The ContextMenu key raises this event too, after its keydown did the work.
      if (Date.now() - keyboardMenuAt < 400) return;
      rowMenu(entry, false);
    });
    return entry;
  };

  // `group` is passed in rather than read from the DOM: a new row is updated
  // before patchList inserts it.
  const updateRow = (entry, item, group) => {
    const { session, state, attachedIn, finished } = item;
    const { row, name, chip, where, detach: detachButton, kill } = parts.get(entry);
    const label = session.name || String(session.id).slice(0, 8);
    setClass(entry, "needs-you", state.key === "attention");
    row.className = [
      "session-row",
      `state-${state.key}`,
      attachedIn ? "attached" : "detached",
      state.key === "unread" ? "unread" : "",
      finished ? "finished" : "",
    ].filter(Boolean).join(" ");
    setText(name, label);
    let title = sessionTooltip(session, group?.label || "");
    const profile = (model.profiles || []).find((each) => each.name === session.profile);
    if (profile) {
      title += `\n${connectionLabel(profile)}: ${connectionTarget(profile)}`;
      row.dataset.connectionType = profile.terminal_type || "custom";
    } else {
      delete row.dataset.connectionType;
    }
    setAttrs(row, { title });
    // The folder is the fact that tells one project's shell from another's, so
    // it gets its own line as soon as the sidebar is wide enough to hold it.
    const folder = folderName(sessionFolder(session));
    setText(where, folder);
    where.hidden = !folder;
    // Chips only for the states worth interrupting for: a plain background
    // shell is a hollow dot, or the list turns into a wall of badges.
    const chipped = ["attention", "unread", "busy", "elsewhere"].includes(state.key);
    chip.hidden = !chipped;
    chip.className = chipped ? `session-chip chip-${state.key}` : "session-chip";
    setText(chip, chipped ? (state.key === "unread" ? "new" : state.label) : "");
    detachButton.hidden = !attachedIn;
    setLabel(detachButton, `Detach ${label}: keeps running`);
    kill.hidden = finished;
    setLabel(kill, `Kill ${label}…`);
  };

  const toggleFold = (node, wantClosed) => {
    const group = itemFor(node);
    if (!group?.sessions.length) return;
    const id = foldId(group);
    const closed = wantClosed ?? !closedGroups.has(id);
    if (closed === closedGroups.has(id)) return;
    if (closed) closedGroups.add(id); else closedGroups.delete(id);
    saveClosedGroups(closedGroups);
    // A DOM toggle, not a re-render: rebuilding the group would drop the
    // keyboard out of the very control that was just pressed.
    updateGroup(node, group);
  };

  const groupMenu = (node, keyboard) => {
    const group = itemFor(node);
    if (!group?.name) return;
    const { kebab, headline } = parts.get(node);
    const items = [];
    if (group.kind === "workspace") {
      items.push({ label: "Open in new window", icon: "new-window", run: () => actions.openWorkspaceInWindow?.(group.name) });
    }
    items.push({ label: "Workspace settings", icon: "settings", run: () => actions.editWorkspace?.(group.name) });
    if (group.kind === "workspace") {
      items.push({ separator: true }, {
        label: "Delete workspace…", icon: "trash", danger: true,
        run: () => openConfirm(`group:${group.key}`, node, kebab, {
          message: `Delete workspace ${group.name}? Detached terminals it owns are killed; attached ones keep running.`,
          confirmLabel: "Delete",
          keyboard,
          action: () => actions.deleteWorkspace?.(group.name),
        }),
      });
    }
    toggleMenu({
      anchor: headline,
      trigger: kebab,
      items,
      label: `Workspace ${group.label}`,
      onClose: (reason) => { if (reason !== "run") handBack(); },
    });
  };

  const createGroup = () => {
    const node = make("div", "session-group");
    const headline = make("div", "session-group-headline");
    const head = make("button", "session-group-head");
    head.type = "button";
    const chevron = make("span", "session-group-chevron");
    const dot = make("span", "session-group-dot");
    const name = make("span", "session-group-name");
    const count = make("span", "sidebar-count");
    head.append(chevron, dot, name, count);
    const tray = make("div", "group-actions");
    const closeView = iconButton("group-action group-close", "x", "Close view");
    const kebab = iconButton("group-action group-more", "more", "Workspace actions");
    kebab.setAttribute("aria-haspopup", "menu");
    kebab.setAttribute("aria-expanded", "false");
    tray.append(closeView, kebab);
    headline.append(head, tray);
    const slot = make("div", "session-group-detail");
    const rows = make("div", "session-group-rows");
    node.append(headline, slot, rows);
    parts.set(node, { headline, head, chevron, dot, name, count, closeView, kebab, slot, rows });

    head.addEventListener("click", (event) => {
      const group = itemFor(node);
      if (!group) return;
      // A closed scratch view is never reopened (its id would come back as
      // a workspace of that name); its terminals are rows to attach instead.
      const closedScratch = group.kind === "scratch" && !group.open;
      if (!group.name || closedScratch || event.target.closest?.(".session-group-chevron")) {
        toggleFold(node);
        return;
      }
      actions.openWorkspace?.(group.name);
    });
    head.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        toggleFold(node, event.key === "ArrowLeft");
      }
    });
    closeView.addEventListener("click", () => {
      const group = itemFor(node);
      if (group?.name) Promise.resolve(actions.closeWorkspace?.(group.name)).finally(handBack);
    });
    kebab.addEventListener("click", (event) => groupMenu(node, fromKeyboard(event)));
    return node;
  };

  const updateGroup = (node, group) => {
    const { head, chevron, dot, name, count, closeView, kebab, slot, rows } = parts.get(node);
    const hasRows = group.sessions.length > 0;
    const closed = hasRows && closedGroups.has(foldId(group));
    for (const kind of ["workspace", "scratch", "unassigned"]) setClass(node, kind, group.kind === kind);
    setClass(node, "open", group.open);
    setClass(node, "active", group.active);
    setClass(node, "has-attention", group.counts.attention > 0);
    setClass(node, "folded", closed);
    setClass(head, "warning", group.pathExists === false);
    // Kept in the layout so every name lines up; `hidden` would collapse it.
    setClass(chevron, "empty", !hasRows);
    const glyph = closed ? "chevron-right" : "chevron-down";
    if (chevron.dataset.glyph !== glyph) {
      chevron.dataset.glyph = glyph;
      chevron.textContent = "";
      chevron.append(icon(glyph, 10));
    }
    setClass(dot, "hollow", !group.open);
    if (group.open && group.color) dot.style.setProperty("--group-color", group.color);
    else dot.style.removeProperty("--group-color");
    setText(name, group.label);
    setText(count, String(group.sessions.length));
    const where = group.kind === "unassigned" ? "Live terminals no workspace owns"
      : group.path ? `${group.path}${group.pathExists === false ? " (missing)" : ""}`
        : group.label;
    setAttrs(head, {
      title: `${where} · ${groupSummary(group)}`,
      "aria-expanded": hasRows ? String(!closed) : false,
      "aria-current": group.active ? "true" : false,
    });
    closeView.hidden = !group.open;
    setLabel(closeView, `Close view ${group.label}: saves it, terminals keep running`);
    kebab.hidden = !group.name;
    setLabel(kebab, `${group.label}: workspace actions`);
    if (group.active) {
      if (activeLine.parentNode !== slot) slot.append(activeLine);
      patchActiveLine(group);
    }
    // Folding is the `.folded` class, not `hidden`: the rail still shows the
    // dots of a folded group.
    patchList(rows, group.sessions, {
      key: (entry) => `session:${entry.session.id}`,
      create: createRow,
      update: (entry, item) => updateRow(entry, item, group),
    });
  };

  const patchGroups = () => {
    const focused = sessionList.contains(document.activeElement) ? document.activeElement : null;
    const groups = sidebarGroups(model.sessions, model);
    const nodes = patchList(groupList, groups, {
      key: (group) => `group:${group.key}`,
      create: createGroup,
      update: updateGroup,
    });
    if (!nodes.some((node) => itemFor(node)?.active) && activeLine.parentNode !== parking) parking.append(activeLine);
    emptyNote.hidden = groups.length > 0;
    // Close a confirmation whose terminal or workspace is no longer listed.
    const listed = new Set();
    for (const group of groups) {
      listed.add(`group:${group.key}`);
      for (const entry of group.sessions) listed.add(`session:${entry.session.id}`);
    }
    for (const [key, { handle, trigger }] of [...confirms]) {
      if (!listed.has(key) || !trigger.isConnected) handle.close("gone");
    }
    if (focused && focused.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
  };

  // Footer -----------------------------------------------------------------
  // Keyed by the label the shell passes in `chrome`, so a new footer entry is
  // one map line away from its own glyph instead of silently falling back
  // to the terminal one.
  const footer = make("nav", "sidebar-footer");
  footer.setAttribute("aria-label", "Application");
  const navIcons = {
    dashboard: "dashboard", settings: "settings", help: "help",
    commands: "terminal", "new window": "new-window",
  };
  for (const [label, onClick, shortcut] of chrome || []) {
    const button = iconButton("sidebar-nav-button", navIcons[label] || "terminal",
      shortcut ? `${label} (${shortcut})` : label, onClick);
    button.dataset.nav = label;
    footer.append(button);
  }
  if (elevated) {
    const badge = make("span", "sidebar-admin-badge");
    badge.title = "Administrator mode";
    badge.append(icon("shield", 13));
    footer.prepend(badge);
  }
  const collapse = iconButton("sidebar-collapse", "chevron-right", "", () => {
    setMode(mode === "rail" ? "full" : "rail");
  });
  describeCollapse = () => {
    const title = mode === "rail" ? "Expand sidebar (Alt+Shift+S cycles)" : "Collapse sidebar to dots (Alt+Shift+S cycles)";
    collapse.title = title;
    collapse.setAttribute("aria-label", title);
    collapse.setAttribute("aria-expanded", String(mode !== "rail"));
  };
  footer.append(collapse);
  el.append(footer);

  // Resize grip -------------------------------------------------------------
  // The sidebar is a grid column of #app, so the width lives in --sidebar-w on
  // the root rather than on this element: the column has to know it.
  const grip = make("div", "sidebar-grip");
  grip.tabIndex = 0;
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-orientation", "vertical");
  grip.setAttribute("aria-label", "Resize sidebar");
  grip.title = "Drag to resize the sidebar, double-click to reset";
  el.append(grip);

  let desired = loadWidth();
  let width = desired;
  const applyWidth = (next, persist = false) => {
    width = clampSidebarWidth(next, window.innerWidth);
    if (persist) { desired = width; saveWidth(width); }
    document.documentElement.style.setProperty("--sidebar-w", `${width}px`);
    // A dragged-wide sidebar earns the extra line on every terminal row. The
    // class rides the same coalesced write as the width, so a drag still costs
    // one style write per frame.
    document.body.classList.toggle("sidebar-wide", isWideSidebar(width));
    grip.setAttribute("aria-valuenow", String(width));
    grip.setAttribute("aria-valuemin", String(SIDEBAR_WIDTH_MIN));
    grip.setAttribute("aria-valuemax", String(maxSidebarWidth(window.innerWidth)));
  };

  let frame = 0;
  let pending = width;
  let fitTimer = 0;
  // The shell answers sidebarResized by re-fitting every xterm to its new
  // pixel size, which is far too heavy to run per pointermove. So the width
  // write is coalesced into one animation frame and the fit trails the last
  // change; the end of a drag asks for it straight away.
  const notifyResize = (now = false) => {
    clearTimeout(fitTimer);
    if (now) { actions.sidebarResized?.(); return; }
    fitTimer = setTimeout(() => actions.sidebarResized?.(), 90);
  };
  const commit = () => {
    frame = 0;
    applyWidth(pending);
    notifyResize();
  };
  const queueWidth = (next) => {
    pending = next;
    if (!frame) frame = requestAnimationFrame(commit);
  };

  let dragging = false;
  let originLeft = 0;
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || mode !== "full") return;
    dragging = true;
    // Measured once: reading the rect on every move forces a layout inside the
    // very gesture that must stay smooth.
    originLeft = el.getBoundingClientRect().left;
    grip.setPointerCapture(event.pointerId);
    grip.classList.add("dragging");
    document.body.classList.add("sidebar-resizing", "sidebar-sizing");
    // Leave the keyboard where it was. Dragging a grip is not a request to
    // take focus off the terminal, and focus.js would hand it straight back.
    event.preventDefault();
  }, { signal });

  grip.addEventListener("pointermove", (event) => {
    if (dragging) queueWidth(event.clientX - originLeft);
  }, { signal });

  const endDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    try { grip.releasePointerCapture(event.pointerId); } catch (_) { /* already gone */ }
    grip.classList.remove("dragging");
    document.body.classList.remove("sidebar-resizing", "sidebar-sizing");
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    applyWidth(pending, true);
    notifyResize(true);
  };
  // Pointer capture is what makes this correct: a drag that ends outside the
  // window still delivers its pointerup here, so the body class cannot stick.
  grip.addEventListener("pointerup", endDrag, { signal });
  grip.addEventListener("pointercancel", endDrag, { signal });

  const resetWidth = () => {
    applyWidth(SIDEBAR_WIDTH_DEFAULT, true);
    notifyResize(true);
  };
  grip.addEventListener("dblclick", resetWidth, { signal });

  // A pointer-only resize is unreachable without a pointer, so the grip is in
  // the tab order and answers the arrows. Shift takes a coarse step, Home/End
  // go to the bounds, Enter/Space are the double-click reset.
  grip.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 32 : 8;
    let next = null;
    if (event.key === "ArrowLeft") next = width - step;
    else if (event.key === "ArrowRight") next = width + step;
    else if (event.key === "Home") next = SIDEBAR_WIDTH_MIN;
    else if (event.key === "End") next = maxSidebarWidth(window.innerWidth);
    else if (event.key === "Enter" || event.key === " ") next = SIDEBAR_WIDTH_DEFAULT;
    else return;
    event.preventDefault();
    applyWidth(next, true);
    notifyResize();
  }, { signal });

  // The cap is relative to the window, so a shrinking window has to pull the
  // sidebar in. The stored width is left alone: it comes back when there is
  // room for it again.
  window.addEventListener("resize", () => {
    const before = width;
    applyWidth(desired);
    if (width !== before) notifyResize();
  }, { signal });

  signal.addEventListener("abort", () => {
    if (frame) cancelAnimationFrame(frame);
    clearTimeout(fitTimer);
    for (const { handle } of [...confirms.values()]) handle.close("gone");
  });

  // The stored width must land before the grid animates, or every start slides
  // the sidebar out from the default in the stylesheet.
  document.body.classList.add("sidebar-sizing");
  applyWidth(desired);
  applyMode();
  describeCollapse();
  requestAnimationFrame(() => { if (!dragging) document.body.classList.remove("sidebar-sizing"); });

  const LAUNCH_KEYS = ["profiles", "inventory", "defaultProfile", "selectedTerminal", "configuredOnly"];
  const update = (partial = {}) => {
    model = { ...model, ...partial };
    if (LAUNCH_KEYS.some((key) => key in partial)) patchLaunch();
    if ("here" in partial) patchHere();
    patchGroups();
  };

  const updateHere = (here) => update({ here: here || null });

  patchLaunch();
  patchHere();
  patchGroups();
  return {
    update,
    updateHere,
    cycleTerminal(delta = 1) {
      if (!choices.length) return null;
      const current = Math.max(0, choices.findIndex((choice) => choice.key === choiceKey(selected)));
      select(choices[(current + (delta < 0 ? -1 : 1) + choices.length) % choices.length]);
      handBack();
      return selected;
    },
    mode: () => mode,
    setMode,
    cycleMode() { setMode(nextSidebarMode(mode)); return mode; },
  };
}
