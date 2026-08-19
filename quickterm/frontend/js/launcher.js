import { icon } from "./icons.js";
import { formatBytes, formatUptime, shortPath } from "./panel_shared.js";

const SIDEBAR_KEY = "quickterm.sidebarCollapsed";
const SIDEBAR_WIDTH_KEY = "quickterm.sidebarWidth";
const SIDEBAR_GROUPS_KEY = "quickterm.sidebarClosedGroups";

// Bounds for the expanded sidebar only; the collapsed rail keeps its own fixed
// width in CSS. Below ~180px the 8.5-12px monospace labels lose their tails,
// and past 40% of the window the workspace stops being the point of the app.
export const SIDEBAR_WIDTH_DEFAULT = 244;
export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 460;

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

// Past this the terminal rows get a third line (the folder each shell is
// sitting in) instead of hiding it behind a tooltip. Dragging the sidebar wide
// should buy information, not whitespace.
export const SIDEBAR_WIDE_AT = 300;

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
  const lines = [session?.name || session?.id, `workspace: ${groupName}`];
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

function terminalChoices(options) {
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
  for (const type of options.inventory?.types || []) {
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
  return choices;
}

function choiceKey(choice) {
  if (!choice) return "";
  if (choice.kind === "profile") return `profile:${choice.profile?.name || ""}`;
  return choice.distro ? `system:${choice.id}:${choice.distro}` : `system:${choice.id}`;
}

function section(title, count) {
  const head = make("div", "sidebar-section-head");
  head.append(make("span", "sidebar-label", title));
  if (count !== undefined) head.append(make("span", "sidebar-count", String(count)));
  return head;
}

function actionButton(iconName, label, onClick, shortcut = null) {
  const button = make("button", "sidebar-action");
  button.type = "button";
  // The shortcut belongs in the tooltip too: the visible chip disappears with
  // the labels once the sidebar is collapsed to icons.
  button.title = shortcut ? `${label} (${shortcut})` : label;
  button.append(icon(iconName, 15), make("span", "sidebar-label", label));
  if (shortcut) button.append(make("span", "sidebar-shortcut", shortcut));
  button.addEventListener("click", onClick);
  return button;
}

function workspaceButton(name, currentWorkspace, onOpen) {
  const scratch = name === null || name === "scratch";
  const active = scratch
    ? !currentWorkspace || currentWorkspace === "scratch"
    : currentWorkspace === name;
  const button = make("button", `sidebar-row workspace-row${active ? " active" : ""}`);
  button.type = "button";
  // Clicking the row you are already on is a no-op for every workspace,
  // scratch included. Replacing scratch is the separate "New scratch" action.
  button.title = active
    ? `${scratch ? "Scratch" : name} is already open`
    : scratch ? "Open the disposable scratch workspace" : `Open workspace ${name}`;
  const mark = make("span", `sidebar-mark${scratch ? " scratch" : ""}`);
  mark.append(icon(scratch ? "circle-dashed" : "diamond", 12));
  const copy = make("span", "sidebar-row-copy");
  copy.append(
    make("strong", "", scratch ? "scratch" : name),
    make("small", "", active ? "current" : scratch ? "disposable" : "saved"),
  );
  button.append(mark, copy);
  button.addEventListener("click", () => onOpen(name));
  return button;
}

function defaultBrandMark() {
  const image = make("img", "sidebar-logo");
  image.src = "/assets/icon-64.png";
  image.alt = "";
  return image;
}

function loadCollapsed() {
  try { return localStorage.getItem(SIDEBAR_KEY) === "1"; } catch (_) { return false; }
}

function saveCollapsed(collapsed) {
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0"); } catch (_) { /* optional */ }
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

export function initLauncher(el, options) {
  if (el._launcherAbort) el._launcherAbort.abort();
  const abort = new AbortController();
  el._launcherAbort = abort;
  el.textContent = "";
  el.classList.add("sidebar");

  const head = make("div", "sidebar-head");
  const brand = make("div", "sidebar-brand");
  if (options.logoUrl) {
    const image = make("img", "sidebar-logo");
    image.src = options.logoUrl;
    image.alt = "";
    image.addEventListener("error", () => image.replaceWith(defaultBrandMark()));
    brand.append(image);
  } else {
    brand.append(defaultBrandMark());
  }
  const brandCopy = make("span", "sidebar-brand-copy sidebar-label");
  const workspaceName = options.currentWorkspace || "scratch";
  const folder = folderName(options.workspacePath);
  // "scratch · scratch" says nothing twice; drop the folder when it repeats
  // the workspace name.
  const showFolder = folder && folder.toLowerCase() !== workspaceName.toLowerCase();
  const where = make("small", "", showFolder ? `${workspaceName} · ${folder}` : workspaceName);
  if (options.workspacePath) {
    where.title = options.workspacePathExists === false
      ? `${options.workspacePath} (missing)`
      : options.workspacePath;
    if (options.workspacePathExists === false) where.classList.add("warning");
  }
  brandCopy.append(make("strong", "", "quickterm"), where);
  brand.append(brandCopy);
  const collapse = make("button", "sidebar-collapse");
  collapse.type = "button";
  collapse.setAttribute("aria-label", "Collapse sidebar");
  collapse.append(icon("chevron-right", 14));
  head.append(brand, collapse);
  el.append(head);

  let collapsed = loadCollapsed();
  const applyCollapsed = () => {
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    collapse.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
    collapse.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
    collapse.setAttribute("aria-expanded", String(!collapsed));
    saveCollapsed(collapsed);
    if (options.onSidebarResize) options.onSidebarResize();
  };
  collapse.addEventListener("click", () => {
    collapsed = !collapsed;
    applyCollapsed();
    requestAnimationFrame(() => options.onLaunchComplete?.());
  });
  applyCollapsed();

  const launch = make("section", "sidebar-section sidebar-launch");
  launch.append(section("new terminal"));
  const choices = terminalChoices(options);
  const select = make("select", "sidebar-terminal-select");
  select.setAttribute("aria-label", "Terminal for new panes");
  const grouped = new Map();
  for (const choice of choices) {
    if (!grouped.has(choice.group)) grouped.set(choice.group, []);
    grouped.get(choice.group).push(choice);
  }
  for (const [label, items] of grouped) {
    const group = document.createElement("optgroup");
    group.label = label;
    for (const choice of items) {
      const option = make("option", "", choice.label);
      option.value = choice.key;
      option.title = choice.detail;
      group.append(option);
    }
    select.append(group);
  }
  let selected = choices.find((choice) => choice.key === choiceKey(options.selectedTerminal));
  if (!selected && options.defaultProfile) {
    selected = choices.find((choice) =>
      choice.key === `profile:${options.defaultProfile}` || choice.key === `system:${options.defaultProfile}`);
  }
  selected ||= choices[0] || null;
  if (selected) {
    select.value = selected.key;
    options.onSelectTerminal?.(selected);
  } else {
    const empty = make("option", "", "No shell found");
    empty.value = "";
    select.append(empty);
    select.disabled = true;
  }
  select.addEventListener("change", () => {
    selected = choices.find((choice) => choice.key === select.value) || null;
    if (selected) options.onSelectTerminal?.(selected);
  });
  const launchActions = make("div", "sidebar-launch-actions");
  const open = actionButton("plus", "New terminal", () => {
    if (!selected) return;
    const launched = selected.kind === "profile"
      ? options.onRunProfile(selected.profile)
      : options.onRunSystem(selected);
    Promise.resolve(launched).finally(() => options.onLaunchComplete?.());
  });
  open.querySelector(".sidebar-label").textContent = "open";
  open.classList.add("primary");
  launchActions.append(open);
  if (!options.elevated) {
    // Elevation spawns a separate process, so success is invisible here and a
    // declined UAC prompt is indistinguishable from a dead button. Hold the
    // button while the request is in flight and let main.js report the outcome.
    const admin = actionButton("shield", "New administrator terminal", () => {
      if (!selected || admin.disabled) return;
      admin.disabled = true;
      const request = selected.kind === "profile"
        ? options.onElevateProfile(selected.profile)
        : options.onElevateSystem(selected);
      Promise.resolve(request).finally(() => { admin.disabled = false; });
    });
    admin.querySelector(".sidebar-label").textContent = "admin";
    launchActions.append(admin);
  }
  launch.append(select, launchActions);
  el.append(launch);

  const workspaces = make("section", "sidebar-section sidebar-workspaces");
  workspaces.append(section("workspaces", (options.workspaces || []).filter((name) => name !== "scratch").length));
  const workspaceList = make("div", "sidebar-list");
  workspaceList.append(workspaceButton(null, options.currentWorkspace, options.onWorkspace));
  for (const name of options.workspaces || []) {
    if (name === "scratch") continue;
    workspaceList.append(workspaceButton(name, options.currentWorkspace, options.onWorkspace));
  }
  workspaces.append(workspaceList);
  // Explicit, confirmed replacement of the live scratch layout. The scratch row
  // itself only opens scratch; it never discards running terminals.
  const newScratch = actionButton("circle-dashed", "New scratch workspace", () => options.onNewScratch?.());
  newScratch.querySelector(".sidebar-label").textContent = "new scratch";
  newScratch.classList.add("sidebar-manage");
  workspaces.append(newScratch);
  el.append(workspaces);

  const terminals = make("section", "sidebar-section sidebar-sessions");
  const terminalsHead = section("terminals", 0);
  const terminalsCount = terminalsHead.querySelector(".sidebar-count");
  const sessionList = make("div", "sidebar-list sidebar-session-list");
  terminals.append(terminalsHead, sessionList);
  el.append(terminals);

  const footer = make("nav", "sidebar-footer");
  footer.setAttribute("aria-label", "Application");
  // Keyed by the label main.js passes in `chrome`, so a new footer entry is
  // one map line away from its own glyph instead of silently falling back
  // to the terminal one.
  const navIcons = {
    dashboard: "dashboard", settings: "settings", help: "help",
    commands: "terminal", "new window": "new-window",
  };
  for (const [label, onClick, shortcut] of options.chrome || []) {
    const button = actionButton(navIcons[label] || "terminal", label, onClick, shortcut);
    button.classList.add("sidebar-nav-button");
    footer.append(button);
  }
  if (options.elevated) {
    const badge = make("div", "sidebar-admin");
    badge.title = "Administrator mode";
    badge.append(icon("shield", 14), make("span", "sidebar-label", "administrator"));
    footer.prepend(badge);
  }
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
    if (event.button !== 0 || collapsed) return;
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
  // the sidebar out from the 244px default in the stylesheet.
  document.body.classList.add("sidebar-sizing");
  applyWidth(desired);
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

  const sessionEntry = (entry, group) => {
    const { session, isAttached, isHere, state } = entry;
    // Foreign means "another workspace owns it". Unassigned is not foreign:
    // there is nobody to take it from, so attaching is the honest reading of a
    // click, and main.js already allows exactly that.
    const foreign = !isHere && group.kind === "workspace";
    const wrap = make("div", `session-entry${foreign ? " foreign" : ""}`);
    wrap.dataset.sessionId = session.id;
    const row = make("button", [
      "sidebar-row session-row",
      `state-${state.key}`,
      isAttached ? "attached" : "detached",
      state.key === "unread" ? "unread" : "",
    ].filter(Boolean).join(" "));
    row.type = "button";
    row.dataset.rowKey = session.id;
    row.title = sessionTooltip(session, group.name);
    const copy = make("span", "sidebar-row-copy");
    copy.append(
      make("strong", "", session.name || session.id.slice(0, 8)),
      make("small", "session-meta", sessionSummary(session)),
    );
    // The folder is the fact that tells one project's shell from another's, so
    // it gets its own line as soon as the sidebar is wide enough to hold it.
    if (session.cwd) copy.append(make("small", "session-where", shortPath(session.cwd, 44)));
    row.append(make("span", "session-state"), copy, make("span", `session-chip chip-${state.key}`, state.label));
    wrap.append(row);

    if (!foreign) {
      row.addEventListener("click", () => {
        if (isAttached) options.onFocusSession?.(session.id);
        else options.onAttachSession?.(session);
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
    const openThere = actionButton("diamond", `open ${group.name}`,
      () => options.onWorkspace?.(target));
    openThere.dataset.rowKey = `${session.id}:open`;
    openThere.classList.add("session-choice");
    openThere.title = `Switch this window to ${group.name}, where this terminal already runs`;
    choices.append(openThere);
    if (typeof options.onMoveSession === "function") {
      const move = actionButton("arrow-up-right", "move here & attach", () => {
        setArmed(null);
        options.onMoveSession(session, target);
      });
      move.dataset.rowKey = `${session.id}:move`;
      move.classList.add("session-choice");
      move.title = `Take this terminal out of ${group.name} and attach it in ${workspaceName}`;
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
  // A single group headed by its own name is a label for a list of one thing,
  // and the section head above already says "terminals".
  const sessionGroup = (group, bare = false) => {
    const box = make("div", `session-group ${group.kind}`);
    const closed = !bare && closedGroups.has(group.name);
    const head = make("button", "session-group-head");
    head.type = "button";
    head.dataset.rowKey = `group:${group.name}`;
    head.setAttribute("aria-expanded", String(!closed));
    head.title = group.kind === "current"
      ? `Terminals in ${group.name}, the workspace this window is in`
      : group.kind === "unassigned"
        ? "Live terminals no workspace owns"
        : `Terminals owned by workspace ${group.name}`;
    const chevron = make("span", "session-group-chevron");
    chevron.append(icon(closed ? "chevron-right" : "chevron-down", 11));
    const copy = make("span", "sidebar-row-copy");
    copy.append(make("strong", "", group.name), make("small", "", groupSummary(group)));
    head.append(chevron, copy, make("span", "sidebar-count", String(group.sessions.length)));

    const rows = make("div", "session-group-rows");
    rows.hidden = closed;
    for (const entry of group.sessions) rows.append(sessionEntry(entry, group));
    if (!group.sessions.length) {
      rows.append(make("div", "sidebar-empty sidebar-label", "nothing running here"));
    }
    // Folding is a DOM toggle, not a re-render: rebuilding the list would drop
    // the keyboard out of the very control that was just pressed.
    head.addEventListener("click", () => {
      const nowClosed = !rows.hidden;
      rows.hidden = nowClosed;
      head.setAttribute("aria-expanded", String(!nowClosed));
      chevron.textContent = "";
      chevron.append(icon(nowClosed ? "chevron-right" : "chevron-down", 11));
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
    // The pill counts what is actually running on this backend. The old
    // "2/7" counted the two this window held and left the other five with no
    // way in at all, which is the complaint this section answers.
    terminalsCount.textContent = String(totalLive);
    terminalsCount.title = `${here} in ${workspaceName} · ${totalLive} live on this backend`;

    // main.js repolls every 10 s and this list is rebuilt from the answer, so
    // whatever the keyboard was inside has to be put back. Without it, opening
    // the choices under a foreign terminal and reading them for ten seconds
    // dropped focus to <body> mid-decision.
    const activeKey = sessionList.contains(document.activeElement)
      ? document.activeElement.dataset.rowKey || null
      : null;
    sessionList.textContent = "";
    if (!groups.length) {
      sessionList.append(make("div", "sidebar-empty sidebar-label", "no live terminals"));
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
    cycleTerminal(delta = 1) {
      if (!choices.length) return null;
      const current = Math.max(0, choices.indexOf(selected));
      selected = choices[(current + (delta < 0 ? -1 : 1) + choices.length) % choices.length];
      select.value = selected.key;
      options.onSelectTerminal?.(selected);
      requestAnimationFrame(() => options.onLaunchComplete?.());
      return selected;
    },
    setCollapsed(value) { collapsed = Boolean(value); applyCollapsed(); },
  };
}
