import { icon } from "./icons.js";

const SIDEBAR_KEY = "quickterm.sidebarCollapsed";
const SIDEBAR_WIDTH_KEY = "quickterm.sidebarWidth";

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
  const navIcons = { dashboard: "dashboard", settings: "settings", help: "help", commands: "terminal" };
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

  const updateSessions =(sessions = [], attachedIds = [], ownedIds = []) => {
    const attached = new Set(attachedIds);
    const owned = new Set(ownedIds);
    const visible = sessions
      .filter((session) => session.alive && (owned.has(session.id) || attached.has(session.id)))
      .sort((a, b) => Number(attached.has(b.id)) - Number(attached.has(a.id))
        || (a.name || a.id).localeCompare(b.name || b.id));
    const totalLive = sessions.filter((session) => session.alive).length;
    terminalsCount.textContent = totalLive === visible.length
      ? String(visible.length)
      : `${visible.length}/${totalLive}`;
    terminalsCount.title = totalLive === visible.length
      ? `${totalLive} live in this workspace`
      : `${visible.length} in this workspace · ${totalLive} live overall`;
    sessionList.textContent = "";
    if (!visible.length) {
      sessionList.append(make("div", "sidebar-empty sidebar-label", "no live terminals"));
      return;
    }
    for (const session of visible) {
      const isAttached = attached.has(session.id);
      const unread = session.activity?.background_output_bytes || 0;
      const row = make("button", `sidebar-row session-row${isAttached ? " attached" : " detached"}${unread ? " unread" : ""}`);
      row.type = "button";
      row.title = isAttached
        ? `Focus ${session.name || session.id}`
        : `Attach background terminal ${session.name || session.id}`;
      const state = make("span", "session-state");
      const copy = make("span", "sidebar-row-copy");
      copy.append(
        make("strong", "", session.name || session.id.slice(0, 8)),
        make("small", "", isAttached ? "open" : unread ? "new output" : "background"),
      );
      row.append(state, copy);
      row.addEventListener("click", () => {
        if (isAttached) options.onFocusSession?.(session.id);
        else options.onAttachSession?.(session);
      });
      sessionList.append(row);
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
