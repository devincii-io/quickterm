import { icon } from "./icons.js";
import { toggleMenu } from "./menu.js";
import { formatBytes, formatUptime } from "./panel_shared.js";

// The sidebar is the whole chrome. Three modes, one hotkey (Alt+Shift+S)
// cycles them, and the choice is remembered per machine:
//   full    a list: new terminal, workspace, every live terminal, four icons
//   rail    30px of dots, so the state of every terminal is still in view
//   hidden  nothing at all; a small floating "+" sits over the terminal's left
//           edge and can be dragged up and down
export const SIDEBAR_MODES = ["full", "rail", "hidden"];
const SIDEBAR_MODE_KEY = "quickterm.sidebarMode";
const LEGACY_COLLAPSED_KEY = "quickterm.sidebarCollapsed";
const SIDEBAR_WIDTH_KEY = "quickterm.sidebarWidth";
const SIDEBAR_GROUPS_KEY = "quickterm.sidebarClosedGroups";
const FLOAT_TOP_KEY = "quickterm.floatTop";

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
const SCRATCH_GROUP = "scratch";

function asSet(value) {
  return value instanceof Set ? value : new Set(value || []);
}

// What one terminal is doing, in one word.
//
// `busy` is null on the sidebar's poll: main.js asks for `metrics: false`
// because the truthful answer costs a full OS process snapshot every 10 s. A
// null therefore means "not measured" and must never be printed as "idle", so
// only an explicit `true` claims busy and the quiet figure below comes from
// `activity.idle_seconds`, which the cheap payload does carry.
//
// `attachments` counts subscribers on the backend, not panes in this window,
// so a terminal open in another QuickTerm window says so rather than looking
// abandoned. That matters before moving it.
export function sessionState(session, isAttached) {
  const activity = session?.activity || {};
  if (isAttached) return { key: "open", label: "open" };
  if (session?.busy === true) return { key: "busy", label: "busy" };
  if ((activity.background_output_bytes || 0) > 0) return { key: "unread", label: "new output" };
  if ((session?.attachments || 0) > 0) return { key: "elsewhere", label: "open elsewhere" };
  return { key: "idle", label: "background" };
}

// The line under the name, in the order someone scans it: what kind of terminal
// this is, then why it wants attention, then how long since anything happened.
// Memory only joins when a metrics-carrying payload actually measured it.
export function sessionSummary(session) {
  const activity = session?.activity || {};
  const unread = activity.background_output_bytes || 0;
  const parts = [session?.profile || "terminal"];
  if (unread > 0) {
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
  const lines = [session?.name || session?.id, sessionSummary(session), `workspace: ${groupName}`];
  if (session?.cwd) lines.push(session.cwd);
  if ((session?.attachments || 0) > 0) lines.push(`${session.attachments} viewer${session.attachments === 1 ? "" : "s"} attached`);
  if (usage?.available) {
    lines.push(`${formatBytes(usage.working_set_bytes || 0)} · ${(usage.cpu_percent ?? 0).toFixed(1)}% CPU · ${usage.process_count || 0} processes`);
    lines.push(`up ${formatUptime(usage.uptime_seconds)}`);
  }
  lines.push(session?.id || "");
  return lines.filter(Boolean).join("\n");
}

// Group every live terminal on the backend by the workspace that owns it.
//
// The ownership rule has to be the dashboard's rule or the two views disagree
// about the same machine. panel_dashboard.js derives it from each saved
// workspace's `session_ids` plus the ids in its layout; the backend mirrors
// exactly that set onto every session as `workspace` on each workspace PUT
// (`SessionManager.sync_workspace`), so reading the field here is the same
// answer from the end the sidebar can afford. What the backend cannot know is
// what this window has claimed since its last autosave, which is what
// ownedIds/attachedIds add on top.
export function groupSessionsByWorkspace(sessions = [], context = {}) {
  const owned = asSet(context.ownedIds);
  const attached = asSet(context.attachedIds);
  const currentName = context.currentWorkspace || SCRATCH_GROUP;
  const groups = new Map();
  const groupFor = (name, kind) => {
    let group = groups.get(name);
    if (!group) {
      group = { name, kind, sessions: [], open: 0, busy: 0, unread: 0 };
      groups.set(name, group);
    }
    return group;
  };

  for (const session of sessions || []) {
    if (!session || !session.alive) continue;
    const isAttached = attached.has(session.id);
    const claimed = session.workspace || null;
    const isHere = isAttached || owned.has(session.id) || (claimed !== null && claimed === currentName);
    const group = isHere
      ? groupFor(currentName, "current")
      : groupFor(claimed || UNASSIGNED_GROUP, claimed ? "workspace" : "unassigned");
    const state = sessionState(session, isAttached);
    group.sessions.push({ session, isAttached, isHere, state });
    if (state.key === "open") group.open += 1;
    else if (state.key === "busy") group.busy += 1;
    else if (state.key === "unread") group.unread += 1;
  }
  if (groups.size && !groups.has(currentName)) groupFor(currentName, "current");

  // Attention first inside a group, name second. A terminal you are looking at
  // is the anchor, then the ones asking for you, then the rest.
  const rank = { open: 0, unread: 1, busy: 2, elsewhere: 3, idle: 4 };
  for (const group of groups.values()) {
    group.sessions.sort((a, b) => (rank[a.state.key] ?? 9) - (rank[b.state.key] ?? 9)
      || (a.session.name || a.session.id).localeCompare(b.session.name || b.session.id));
  }
  // Your workspace first, unassigned last, everything else alphabetical.
  const order = (group) => (group.kind === "current" ? 0 : group.kind === "unassigned" ? 2 : 1);
  return [...groups.values()].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
}

// The group's one-line summary. A collapsed group has to keep saying what is
// inside it, or folding one away hides exactly what this section exists to
// show. The count itself lives in the pill beside the name.
export function groupSummary(group) {
  if (!group.sessions.length) return "nothing running";
  const parts = [];
  if (group.open) parts.push(`${group.open} open`);
  if (group.unread) parts.push(`${group.unread} new output`);
  if (group.busy) parts.push(`${group.busy} busy`);
  const quiet = group.sessions.length - group.open - group.unread - group.busy;
  if (quiet > 0) parts.push(`${quiet} background`);
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

function shellLabel(profile) {
  const target = profile.ssh_host
    ? (profile.ssh_user ? `${profile.ssh_user}@${profile.ssh_host}` : profile.ssh_host)
    : "";
  const labels = {
    "claude-code": `Claude Code · ${profile.claude_mode === "resume" ? "choose session" : profile.claude_mode === "agents" ? "agent manager" : profile.claude_mode === "new" ? "new" : "continue"}`,
    "powershell-core": "PowerShell 7",
    "windows-powershell": "Windows PowerShell",
    "command-prompt": "Command Prompt",
    wsl: profile.wsl_distro ? `WSL · ${profile.wsl_distro}` : "WSL",
    ssh: target ? `SSH · ${target}` : "SSH (PuTTY plink)",
    sftp: target ? `SFTP · ${target}` : "SFTP (PuTTY psftp)",
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

// Claude needs no profile. When the inventory finds the CLI, three choices
// exist out of the box, each just the CLI plus one flag; the workspace folder
// is where they open, exactly like a shell.
const CLAUDE_MODES = [
  ["continue", ["--continue"], "Claude · continue", "Continue the latest conversation in this folder"],
  ["new", [], "Claude · new", "Start a new conversation in this folder"],
  ["resume", ["--resume"], "Claude · resume", "Choose one of Claude's sessions in this folder"],
];

// Every choice carries its own `key`, and the selection is compared by that
// key alone, so a choice object from a previous build of the sidebar still
// selects the right row after the list is rebuilt.
export function terminalChoices(options) {
  const choices = [];
  for (const profile of options.profiles || []) {
    choices.push({
      key: `profile:${profile.name}`,
      group: "Personal",
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
  const types = options.inventory?.types || [];
  for (const type of types) {
    if (!type.executable || type.available === false || ["custom", "ssh", "sftp", "claude-code"].includes(type.id)) continue;
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
  const claude = types.find((type) => type.id === "claude-code" && type.executable && type.available !== false);
  if (claude) {
    for (const [mode, args, label, detail] of CLAUDE_MODES) {
      choices.push({
        key: `claude:${mode}`,
        group: "Claude",
        kind: "system",
        id: "claude-code",
        cmd: claude.executable,
        args,
        mode,
        label,
        detail,
      });
    }
  }
  return choices;
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

// Hand the keyboard back to the terminal once a choice is made, or the next
// keystroke lands on the control that was just used instead of the shell. The
// menus claim the keyboard in focus.js while open and call this on close.
function handBack(options) {
  requestAnimationFrame(() => options.onLaunchComplete?.());
}

function loadMode() {
  try {
    const stored = localStorage.getItem(SIDEBAR_MODE_KEY);
    if (SIDEBAR_MODES.includes(stored)) return stored;
    // Sidebars collapsed before modes existed stay collapsed.
    return localStorage.getItem(LEGACY_COLLAPSED_KEY) === "1" ? "rail" : "full";
  } catch (_) { return "full"; }
}

function saveMode(mode) {
  try { localStorage.setItem(SIDEBAR_MODE_KEY, mode); } catch (_) { /* optional */ }
}

function loadWidth() {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw === null) return SIDEBAR_WIDTH_DEFAULT;
    return clampSidebarWidth(parseInt(raw, 10), window.innerWidth);
  } catch (_) { return SIDEBAR_WIDTH_DEFAULT; }
}

function saveWidth(width) {
  try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)); } catch (_) { /* optional */ }
}

// Folded groups are stored by name, not by index: workspaces come and go, and
// the fold has to survive `buildLauncher()` throwing the whole sidebar away on
// every config change.
function loadClosedGroups() {
  try {
    const raw = JSON.parse(localStorage.getItem(SIDEBAR_GROUPS_KEY) || "[]");
    return new Set(Array.isArray(raw) ? raw.filter((name) => typeof name === "string") : []);
  } catch (_) { return new Set(); }
}

function saveClosedGroups(names) {
  try { localStorage.setItem(SIDEBAR_GROUPS_KEY, JSON.stringify([...names])); } catch (_) { /* optional */ }
}

function loadFloatTop() {
  try {
    const raw = Number.parseInt(localStorage.getItem(FLOAT_TOP_KEY), 10);
    return Number.isFinite(raw) ? raw : 12;
  } catch (_) { return 12; }
}

function saveFloatTop(top) {
  try { localStorage.setItem(FLOAT_TOP_KEY, String(top)); } catch (_) { /* optional */ }
}

// The floating "+" that stands in for the sidebar while it is hidden. It is
// static in index.html, so it survives every rebuild; only its listeners hang
// off the launcher's AbortController. Dragging the handle moves it up and down
// and the position is remembered.
function wireFloat(options, abort, showSidebar) {
  const float = document.getElementById("float-launch");
  if (!float) return { show() {}, hide() {} };
  const handle = float.querySelector(".float-handle");
  const open = float.querySelector(".float-new");
  const reveal = float.querySelector(".float-show");
  const signal = abort.signal;

  const clampTop = (top) => Math.max(4, Math.min(window.innerHeight - float.offsetHeight - 4, Math.round(top)));
  const place = (top) => { float.style.top = `${clampTop(top)}px`; };

  open?.addEventListener("click", () => options.onNewTerminal?.(), { signal });
  open?.addEventListener("contextmenu", (event) => { event.preventDefault(); showSidebar(); }, { signal });
  reveal?.addEventListener("click", showSidebar, { signal });

  let dragging = false;
  let grabOffset = 0;
  handle?.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragging = true;
    grabOffset = event.clientY - float.getBoundingClientRect().top;
    handle.setPointerCapture(event.pointerId);
    float.classList.add("dragging");
    event.preventDefault();
  }, { signal });
  handle?.addEventListener("pointermove", (event) => {
    if (dragging) place(event.clientY - grabOffset);
  }, { signal });
  const endDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    try { handle.releasePointerCapture(event.pointerId); } catch (_) { /* already gone */ }
    float.classList.remove("dragging");
    saveFloatTop(Number.parseInt(float.style.top, 10) || 12);
  };
  handle?.addEventListener("pointerup", endDrag, { signal });
  handle?.addEventListener("pointercancel", endDrag, { signal });
  window.addEventListener("resize", () => { if (!float.hidden) place(Number.parseInt(float.style.top, 10) || 12); }, { signal });

  return {
    show() { float.hidden = false; place(loadFloatTop()); },
    hide() { float.hidden = true; },
  };
}

export function initLauncher(el, options) {
  if (el._launcherAbort) el._launcherAbort.abort();
  const abort = new AbortController();
  el._launcherAbort = abort;
  el.textContent = "";
  el.classList.add("sidebar");
  const workspaceName = options.currentWorkspace || "scratch";

  // Mode -------------------------------------------------------------------
  let mode = loadMode();
  const float = wireFloat(options, abort, () => setMode("full"));
  const applyMode = () => {
    document.body.classList.toggle("sidebar-collapsed", mode === "rail");
    document.body.classList.toggle("sidebar-hidden", mode === "hidden");
    el.setAttribute("aria-hidden", String(mode === "hidden"));
    if (mode === "hidden") float.show(); else float.hide();
    saveMode(mode);
    options.onSidebarResize?.();
  };
  let describeCollapse = () => {};
  const setMode = (next) => {
    if (!SIDEBAR_MODES.includes(next) || next === mode) return;
    mode = next;
    applyMode();
    describeCollapse();
    handBack(options);
  };

  // New terminal -----------------------------------------------------------
  // One button that opens whatever is selected, and a chevron beside it that
  // opens the list of choices as a menu (menu.js): personal profiles, system
  // shells and the built-in Claude choices, grouped, the current one marked.
  const launch = make("div", "sidebar-launch");
  const choices = terminalChoices(options);
  let selected = choices.find((choice) => choice.key === choiceKey(options.selectedTerminal));
  if (!selected && options.defaultProfile) {
    selected = choices.find((choice) =>
      choice.key === `profile:${options.defaultProfile}` || choice.key === `system:${options.defaultProfile}`);
  }
  selected ||= choices[0] || null;

  const open = make("button", "sidebar-new");
  open.type = "button";
  const openLabel = make("span", "sidebar-label");
  open.append(icon("plus", 15), openLabel);
  const describeOpen = () => {
    openLabel.textContent = selected ? selected.label : "no shell found";
    open.title = selected
      ? `New ${selected.label} (Alt+N) · ${selected.detail}`
      : "No shell was found on this computer";
    open.disabled = !selected;
  };
  open.addEventListener("click", () => {
    if (!selected) return;
    const launched = selected.kind === "profile"
      ? options.onRunProfile(selected.profile)
      : options.onRunSystem(selected);
    Promise.resolve(launched).finally(() => options.onLaunchComplete?.());
  });

  const pick = iconButton("sidebar-terminal-pick", "chevron-down", "Choose what a new terminal runs");
  pick.setAttribute("aria-haspopup", "menu");
  pick.setAttribute("aria-expanded", "false");
  pick.disabled = !choices.length;
  const openTerminalMenu = () => {
    if (!choices.length) return;
    const items = [];
    let group = null;
    for (const choice of choices) {
      if (choice.group !== group) {
        group = choice.group;
        items.push({ heading: group });
      }
      items.push({
        label: choice.label,
        detail: choice.detail,
        selected: choice === selected,
        run: () => {
          selected = choice;
          options.onSelectTerminal?.(selected);
          describeOpen();
        },
      });
    }
    toggleMenu({
      anchor: launch,
      trigger: pick,
      items,
      label: "Terminal for new panes",
      onClose: () => handBack(options),
    });
  };
  pick.addEventListener("click", openTerminalMenu);
  if (selected) options.onSelectTerminal?.(selected);
  // Right-clicking "+" is the fast way to the same list.
  open.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openTerminalMenu();
  });
  describeOpen();
  launch.append(open, pick);
  if (!options.elevated) {
    // Elevation spawns a separate process, so success is invisible here and a
    // declined UAC prompt is indistinguishable from a dead button. Hold the
    // button while the request is in flight and let main.js report the outcome.
    const admin = iconButton("sidebar-admin", "shield", "New administrator terminal", () => {
      if (!selected || admin.disabled) return;
      admin.disabled = true;
      const request = selected.kind === "profile"
        ? options.onElevateProfile(selected.profile)
        : options.onElevateSystem(selected);
      Promise.resolve(request).finally(() => { admin.disabled = false; });
    });
    launch.append(admin);
  }
  el.append(launch);

  // Workspace --------------------------------------------------------------
  // One row: the workspace name as a menu button, the folder under it, the
  // "workspace here" offer when the focused terminal is somewhere else, and
  // the save dot main.js drives through #sb-save. The menu lists scratch and
  // every saved workspace with its folder, marks the ones this window already
  // shows in another view in that view's colour (choosing one focuses that
  // view), offers to tile any other beside this one, and ends with "new
  // scratch", which main.js confirms before anything running is replaced.
  const where = make("div", "sidebar-where");
  const workspaceButton = make("button", "sidebar-workspace-button");
  workspaceButton.type = "button";
  workspaceButton.setAttribute("aria-haspopup", "menu");
  workspaceButton.setAttribute("aria-expanded", "false");
  workspaceButton.setAttribute("aria-label", `Workspace: ${workspaceName}`);
  workspaceButton.append(make("span", "sidebar-label", workspaceName), icon("chevron-down", 11));
  let here = options.here || null;
  const hereLabel = () => (here.action === "open" ? `open ${here.name}` : `workspace here: ${here.name}`);
  const hereTitle = () => (here.action === "open"
    ? `${here.folder} is the folder of workspace ${here.name}. Switch to it and take this terminal along.`
    : `Make ${here.folder} a workspace named ${here.name} and move this terminal into it`);
  const workspaceItems = () => {
    const shown = typeof options.shownViews === "function" ? options.shownViews() : [];
    const roots = typeof options.workspaceRoots === "function" ? options.workspaceRoots() : new Map();
    const canBeside = typeof options.onOpenBeside === "function" && options.canOpenBeside?.() !== false;
    const entry = (name, value) => {
      const current = name === workspaceName;
      const view = current ? null : shown.find((each) => each.name === name);
      const root = roots.get(name) || null;
      const item = {
        label: name,
        detail: current || !root ? undefined : folderName(root),
        title: root || undefined,
        selected: current,
        color: view ? view.color : undefined,
        hint: view ? "shown here" : undefined,
        run: () => {
          if (current) return;
          if (view) options.onFocusView?.(name);
          else options.onWorkspace?.(value);
        },
      };
      if (!current && !view && canBeside && value) {
        item.actions = [{
          icon: "workspaces",
          title: `Show ${name} beside ${workspaceName}`,
          run: () => options.onOpenBeside(name),
        }];
      }
      return item;
    };
    const named = (options.workspaces || []).filter((name) => name !== "scratch");
    const items = [entry("scratch", null)];
    if (named.length) items.push({ separator: true });
    for (const name of named) items.push(entry(name, name));
    items.push({ separator: true });
    if (here) {
      items.push({ label: hereLabel(), icon: "plus", detail: folderName(here.folder), title: hereTitle(),
        run: () => options.onWorkspaceHere?.() });
    }
    items.push({ label: "new scratch", icon: "plus", detail: "a fresh disposable layout",
      run: () => options.onNewScratch?.() });
    return items;
  };
  workspaceButton.addEventListener("click", () => {
    toggleMenu({
      anchor: where,
      trigger: workspaceButton,
      items: workspaceItems(),
      label: "Workspace",
      onClose: () => handBack(options),
    });
  });
  // "scratch / scratch" says nothing twice: the folder line is dropped when it
  // only repeats the workspace name.
  const folder = folderName(options.workspacePath);
  const folderLine = make("small", "sidebar-folder", folder || "no folder");
  if (folder && folder.toLowerCase() === workspaceName.toLowerCase()) folderLine.hidden = true;
  if (options.workspacePath) {
    folderLine.title = options.workspacePathExists === false
      ? `${options.workspacePath} (missing)`
      : options.workspacePath;
    if (options.workspacePathExists === false) folderLine.classList.add("warning");
  } else {
    folderLine.title = "This workspace has no folder. Terminals open in your home folder.";
  }
  workspaceButton.title = folderLine.title;
  // The offer to make the focused terminal's folder a workspace. main.js
  // patches it through updateHere() on every focus and folder change; the
  // row itself is only rebuilt on config changes.
  const hereButton = make("button", "sidebar-here");
  hereButton.type = "button";
  hereButton.hidden = true;
  const hereText = make("span", "sidebar-label");
  hereButton.append(icon("plus", 11), hereText);
  hereButton.addEventListener("click", () => {
    options.onWorkspaceHere?.();
    handBack(options);
  });
  const updateHere = (state) => {
    here = state || null;
    hereButton.hidden = !here;
    if (!here) return;
    hereText.textContent = hereLabel();
    hereButton.title = hereTitle();
    hereButton.setAttribute("aria-label", hereTitle());
  };
  updateHere(here);
  const save = make("span", "sidebar-save");
  save.id = "sb-save";
  save.setAttribute("role", "status");
  save.setAttribute("aria-live", "polite");
  const whereCopy = make("div", "sidebar-where-copy");
  whereCopy.append(workspaceButton, folderLine, hereButton);
  where.append(whereCopy);
  // Two buttons for the folder this row is about: Explorer and VS Code. The
  // folder is resolved by main.js at click time, so it is where the focused
  // terminal is right now (a `cd` counts), else the workspace folder. The
  // titles stay generic because this row is rebuilt only on config changes.
  if (typeof options.onOpenFolder === "function") {
    const tools = make("div", "sidebar-folder-tools");
    const openIn = (app, iconName, label) => {
      const button = iconButton("sidebar-folder-open", iconName, label, () => {
        options.onOpenFolder(app);
        handBack(options);
      });
      button.dataset.app = app;
      return button;
    };
    tools.append(
      openIn("explorer", "folder", "Open the focused terminal's folder in Explorer (Alt+Shift+E)"),
      openIn("vscode", "code", "Open the focused terminal's folder in VS Code (Alt+Shift+C)"),
    );
    where.append(tools);
  }
  where.append(save);
  el.append(where);

  // Terminals --------------------------------------------------------------
  const sessionList = make("div", "sidebar-sessions");
  el.append(sessionList);

  // Footer -----------------------------------------------------------------
  // Keyed by the label main.js passes in `chrome`, so a new footer entry is
  // one map line away from its own glyph instead of silently falling back
  // to the terminal one.
  const footer = make("nav", "sidebar-footer");
  footer.setAttribute("aria-label", "Application");
  const navIcons = {
    dashboard: "dashboard", settings: "settings", help: "help",
    commands: "terminal", "new window": "new-window", "workspace beside": "workspaces",
  };
  for (const [label, onClick, shortcut] of options.chrome || []) {
    const button = iconButton("sidebar-nav-button", navIcons[label] || "terminal",
      shortcut ? `${label} (${shortcut})` : label, onClick);
    button.dataset.nav = label;
    footer.append(button);
  }
  if (options.elevated) {
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
  // the root rather than on this element: the column has to know it, and the
  // element is thrown away and rebuilt on every config change. The grip is
  // rebuilt with it, so its listeners hang off the same AbortController the
  // rest of the launcher already uses; the window listener below would
  // otherwise pile up one copy per rebuild.
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
  // main.js answers onSidebarResize by re-fitting every xterm to its new pixel
  // size, which is far too heavy to run per pointermove. So the width write is
  // coalesced into one animation frame and the fit trails the last change;
  // the end of a drag asks for it straight away.
  const notifyResize = (now = false) => {
    clearTimeout(fitTimer);
    if (now) { options.onSidebarResize?.(); return; }
    fitTimer = setTimeout(() => options.onSidebarResize?.(), 90);
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
  }, { signal: abort.signal });

  grip.addEventListener("pointermove", (event) => {
    if (dragging) queueWidth(event.clientX - originLeft);
  }, { signal: abort.signal });

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
  grip.addEventListener("pointerup", endDrag, { signal: abort.signal });
  grip.addEventListener("pointercancel", endDrag, { signal: abort.signal });

  const resetWidth = () => {
    applyWidth(SIDEBAR_WIDTH_DEFAULT, true);
    notifyResize(true);
  };
  grip.addEventListener("dblclick", resetWidth, { signal: abort.signal });

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
  }, { signal: abort.signal });

  // The cap is relative to the window, so a shrinking window has to pull the
  // sidebar in. The stored width is left alone: it comes back when there is
  // room for it again.
  window.addEventListener("resize", () => {
    const before = width;
    applyWidth(desired);
    if (width !== before) notifyResize();
  }, { signal: abort.signal });

  abort.signal.addEventListener("abort", () => {
    if (frame) cancelAnimationFrame(frame);
    clearTimeout(fitTimer);
  });

  // The stored width must land before the grid animates, or every start slides
  // the sidebar out from the default in the stylesheet.
  document.body.classList.add("sidebar-sizing");
  applyWidth(desired);
  applyMode();
  describeCollapse();
  requestAnimationFrame(() => { if (!dragging) document.body.classList.remove("sidebar-sizing"); });

  // Terminals ---------------------------------------------------------------
  // The list shows every live terminal on this backend, grouped by the
  // workspace that owns it. It used to show only what this window held, so a
  // machine running seven terminals across three projects looked like two.
  const closedGroups = loadClosedGroups();
  // The foreign terminal whose choices are open. One at a time, and it survives
  // the 10 s poll below, which rebuilds this list from scratch.
  let armedSessionId = null;

  const setArmed = (id) => {
    armedSessionId = id;
    for (const entry of sessionList.querySelectorAll(".session-entry")) {
      const on = entry.dataset.sessionId === id;
      entry.classList.toggle("armed", on);
      const strip = entry.querySelector(".session-choices");
      if (strip) strip.hidden = !on;
      const row = entry.querySelector(".session-row[aria-expanded]");
      if (row) row.setAttribute("aria-expanded", String(on));
    }
  };

  // Double-click renames in place, the same gesture the pane header had. The
  // header is gone on a lone pane, so this is where the name is edited now.
  const startRename = (row, nameEl, session) => {
    if (row.querySelector("input")) return;
    const input = make("input", "session-rename");
    input.value = session.name || "";
    input.spellcheck = false;
    input.setAttribute("aria-label", "Terminal name");
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      input.replaceWith(nameEl);
      if (save && value && value !== session.name) options.onRenameSession?.(session, value);
      handBack(options);
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") commit(true);
      else if (event.key === "Escape") commit(false);
    });
    input.addEventListener("blur", () => commit(true));
    input.addEventListener("click", (event) => event.stopPropagation());
  };

  const sessionEntry = (entry, group) => {
    const { session, isAttached, isHere, state } = entry;
    // Foreign means "another workspace owns it". Unassigned is not foreign:
    // there is nobody to take it from, so attaching is the honest reading of a
    // click, and main.js already allows exactly that.
    const foreign = !isHere && group.kind === "workspace";
    const wrap = make("div", `session-entry${foreign ? " foreign" : ""}`);
    wrap.dataset.sessionId = session.id;
    const row = make("button", [
      "session-row",
      `state-${state.key}`,
      isAttached ? "attached" : "detached",
      state.key === "unread" ? "unread" : "",
    ].filter(Boolean).join(" "));
    row.type = "button";
    row.dataset.rowKey = session.id;
    row.title = sessionTooltip(session, group.name);
    const name = make("span", "session-name", session.name || session.id.slice(0, 8));
    row.append(make("span", "session-state"), name);
    // The folder is the fact that tells one project's shell from another's, so
    // it gets its own line as soon as the sidebar is wide enough to hold it.
    if (session.cwd) row.append(make("small", "session-where", folderName(session.cwd)));
    // Chips only for the states worth interrupting for: a plain background
    // shell is a hollow dot, or the list turns into a wall of badges.
    if (state.key === "unread" || state.key === "busy" || state.key === "elsewhere") {
      row.append(make("span", `session-chip chip-${state.key}`, state.key === "unread" ? "new" : state.label));
    }
    wrap.append(row);

    if (!foreign) {
      row.addEventListener("click", () => {
        if (isAttached) options.onFocusSession?.(session.id);
        else options.onAttachSession?.(session);
      });
      row.addEventListener("dblclick", (event) => {
        event.preventDefault();
        startRename(row, name, session);
      });
      return wrap;
    }

    // Clicking a terminal another workspace owns must never silently take it.
    // The row offers the two honest choices instead, each labelled with what it
    // does to which workspace.
    row.setAttribute("aria-expanded", String(armedSessionId === session.id));
    const choices = make("div", "session-choices");
    choices.hidden = armedSessionId !== session.id;
    const target = group.name === SCRATCH_GROUP ? null : group.name;
    const choiceButton = (iconName, label, title, onClick) => {
      const button = make("button", "session-choice");
      button.type = "button";
      button.title = title;
      button.append(icon(iconName, 12), make("span", "sidebar-label", label));
      button.addEventListener("click", onClick);
      return button;
    };
    const openThere = choiceButton("diamond", `open ${group.name}`,
      `Switch this window to ${group.name}, where this terminal already runs`,
      () => options.onWorkspace?.(target));
    openThere.dataset.rowKey = `${session.id}:open`;
    choices.append(openThere);
    // The third way: keep this window where it is and tile that workspace
    // beside it. If the window already shows it, the choice focuses that view.
    if (target && typeof options.onOpenBeside === "function" && options.canOpenBeside?.() !== false) {
      const shown = (typeof options.shownViews === "function" ? options.shownViews() : [])
        .find((each) => each.name === group.name);
      const beside = shown
        ? choiceButton("workspaces", `focus ${group.name}`,
          `${group.name} is already shown in this window. Focus that view.`,
          () => { setArmed(null); options.onFocusView?.(group.name); })
        : choiceButton("workspaces", `show ${group.name} beside`,
          `Tile ${group.name} beside ${workspaceName} in this window; this terminal stays where it is`,
          () => { setArmed(null); options.onOpenBeside(target); });
      beside.dataset.rowKey = `${session.id}:beside`;
      choices.append(beside);
    }
    if (typeof options.onMoveSession === "function") {
      const move = choiceButton("arrow-up-right", "move here",
        `Take this terminal out of ${group.name} and attach it in ${workspaceName}`,
        () => {
          setArmed(null);
          options.onMoveSession(session, target);
        });
      move.dataset.rowKey = `${session.id}:move`;
      choices.append(move);
    } else {
      choices.append(make("p", "session-choice-note",
        `Moving it into ${workspaceName} is a Dashboard action.`));
    }
    // Escape backs out of a decision without making it. It stops here so the
    // global key layer does not also read it as "close whatever is open".
    choices.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setArmed(null);
      row.focus();
    });
    row.addEventListener("click", () => setArmed(armedSessionId === session.id ? null : session.id));
    wrap.append(choices);
    return wrap;
  };

  // `bare` drops the heading when everything alive belongs to this workspace.
  // A single group headed by its own name is a label for a list of one thing.
  const sessionGroup = (group, bare = false) => {
    const box = make("div", `session-group ${group.kind}`);
    const closed = !bare && closedGroups.has(group.name);
    const head = make("button", "session-group-head");
    head.type = "button";
    head.dataset.rowKey = `group:${group.name}`;
    head.setAttribute("aria-expanded", String(!closed));
    head.title = (group.kind === "current"
      ? `Terminals in ${group.name}, the workspace this window is in`
      : group.kind === "unassigned"
        ? "Live terminals no workspace owns"
        : `Terminals owned by workspace ${group.name}`) + ` · ${groupSummary(group)}`;
    const chevron = make("span", "session-group-chevron");
    chevron.append(icon(closed ? "chevron-right" : "chevron-down", 10));
    head.append(chevron, make("span", "session-group-name", group.name),
      make("span", "sidebar-count", String(group.sessions.length)));

    const rows = make("div", "session-group-rows");
    rows.hidden = closed;
    for (const entry of group.sessions) rows.append(sessionEntry(entry, group));
    if (!group.sessions.length) {
      rows.append(make("div", "sidebar-empty", "nothing running"));
    }
    // Folding is a DOM toggle, not a re-render: rebuilding the list would drop
    // the keyboard out of the very control that was just pressed.
    head.addEventListener("click", () => {
      const nowClosed = !rows.hidden;
      rows.hidden = nowClosed;
      head.setAttribute("aria-expanded", String(!nowClosed));
      chevron.textContent = "";
      chevron.append(icon(nowClosed ? "chevron-right" : "chevron-down", 10));
      if (nowClosed) closedGroups.add(group.name);
      else closedGroups.delete(group.name);
      saveClosedGroups(closedGroups);
    });
    if (!bare) box.append(head);
    box.append(rows);
    return box;
  };

  const updateSessions = (sessions = [], attachedIds = [], ownedIds = []) => {
    const groups = groupSessionsByWorkspace(sessions, {
      currentWorkspace: options.currentWorkspace,
      attachedIds,
      ownedIds,
    });
    const totalLive = (sessions || []).filter((session) => session.alive).length;
    const here = groups.find((group) => group.kind === "current")?.sessions.length || 0;
    sessionList.title = `${here} in ${workspaceName} · ${totalLive} live on this backend`;

    // main.js repolls every 10 s and this list is rebuilt from the answer, so
    // whatever the keyboard was inside has to be put back. Without it, opening
    // the choices under a foreign terminal and reading them for ten seconds
    // dropped focus to <body> mid-decision. A rename in progress is left alone
    // for the same reason.
    if (sessionList.querySelector("input")) return;
    const activeKey = sessionList.contains(document.activeElement)
      ? document.activeElement.dataset.rowKey || null
      : null;
    sessionList.textContent = "";
    if (!groups.length) {
      sessionList.append(make("div", "sidebar-empty", "no terminals"));
      return;
    }
    const solo = groups.length === 1 && groups[0].kind === "current";
    for (const group of groups) sessionList.append(sessionGroup(group, solo));
    if (!activeKey) return;
    for (const node of sessionList.querySelectorAll("[data-row-key]")) {
      if (node.dataset.rowKey === activeKey) { node.focus(); break; }
    }
  };

  updateSessions(options.sessions, options.attachedSessionIds, options.ownedSessionIds);
  return {
    updateSessions,
    updateHere,
    cycleTerminal(delta = 1) {
      if (!choices.length) return null;
      const current = Math.max(0, choices.indexOf(selected));
      selected = choices[(current + (delta < 0 ? -1 : 1) + choices.length) % choices.length];
      options.onSelectTerminal?.(selected);
      describeOpen();
      handBack(options);
      return selected;
    },
    mode: () => mode,
    setMode,
    cycleMode() { setMode(nextSidebarMode(mode)); return mode; },
  };
}
