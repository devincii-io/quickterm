import { icon } from "./icons.js";

const SIDEBAR_KEY = "quickterm.sidebarCollapsed";

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
      detail: shellLabel(profile),
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

function actionButton(iconName, label, onClick) {
  const button = make("button", "sidebar-action");
  button.type = "button";
  button.title = label;
  button.append(icon(iconName, 15), make("span", "sidebar-label", label));
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
  button.title = scratch ? "New disposable scratch workspace" : `Open workspace ${name}`;
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
  brandCopy.append(make("strong", "", "quickterm"), make("small", "", options.currentWorkspace || "scratch"));
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
    const admin = actionButton("shield", "New administrator terminal", () => {
      if (!selected) return;
      if (selected.kind === "profile") options.onElevateProfile(selected.profile);
      else options.onElevateSystem(selected);
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
  const manage = actionButton("dashboard", "Manage workspaces", options.onManage);
  manage.classList.add("sidebar-manage");
  workspaces.append(manage);
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
  for (const [label, onClick] of options.chrome || []) {
    const button = actionButton(navIcons[label] || "terminal", label, onClick);
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

  const updateSessions = (sessions = [], attachedIds = [], ownedIds = []) => {
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
