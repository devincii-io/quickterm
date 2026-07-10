function shellLabel(profile) {
  const labels = {
    "powershell-core": "PowerShell 7",
    "windows-powershell": "Windows PowerShell",
    "command-prompt": "Command Prompt",
    wsl: profile.wsl_distro ? `WSL · ${profile.wsl_distro}` : "WSL",
    custom: "Custom command",
  };
  return labels[profile.terminal_type] || profile.cmd || "Terminal";
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function menuItem(label, detail, icon) {
  const button = element("button", "dropdown-item");
  button.type = "button";
  const mark = element("span", "dropdown-item-mark", icon || ">");
  const copy = element("span", "dropdown-item-copy");
  copy.append(element("strong", "", label));
  if (detail) copy.append(element("small", "", detail));
  button.append(mark, copy);
  return button;
}

function dropdownShell(className) {
  const root = element("div", `app-dropdown ${className}`);
  const trigger = element("button", "dropdown-trigger");
  trigger.type = "button";
  trigger.setAttribute("aria-expanded", "false");
  const menu = element("div", "dropdown-menu");
  menu.hidden = true;
  root.append(trigger, menu);
  const setOpen = (open) => {
    menu.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    root.classList.toggle("open", open);
  };
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    document.dispatchEvent(new CustomEvent("quickterm:close-dropdowns", { detail: root }));
    setOpen(menu.hidden);
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setOpen(false);
      trigger.focus();
    }
    event.stopPropagation();
  });
  return { root, trigger, menu, setOpen };
}

function sectionLabel(text) {
  return element("div", "dropdown-section-label", text);
}

function buildWorkspaceDropdown(options) {
  const { root, trigger, menu, setOpen } = dropdownShell("workspace-dropdown");
  const renderTrigger = () => {
    trigger.textContent = "";
    const copy = element("span", "dropdown-trigger-copy");
    copy.append(
      element("small", "", "Workspace"),
      element("strong", "", options.currentWorkspace || "Scratch"),
    );
    trigger.append(element("span", `workspace-state ${options.currentWorkspace ? "saved" : "scratch"}`), copy, element("span", "dropdown-chevron", "⌄"));
  };
  renderTrigger();

  menu.append(sectionLabel("Workspace mode"));
  const scratch = menuItem("Scratch", "Disposable · closes with the app", "○");
  if (!options.currentWorkspace) scratch.classList.add("selected");
  scratch.addEventListener("click", () => {
    setOpen(false);
    options.onWorkspace(null);
  });
  menu.append(scratch, sectionLabel("Saved workspaces"));
  if (!options.workspaces.length) {
    menu.append(element("div", "dropdown-empty", "No workspaces saved yet"));
  }
  for (const name of options.workspaces) {
    const item = menuItem(name, name === options.currentWorkspace ? "Currently open" : "Sessions and layout saved", "◇");
    if (name === options.currentWorkspace) item.classList.add("selected");
    item.addEventListener("click", () => {
      setOpen(false);
      options.onWorkspace(name);
    });
    menu.append(item);
  }
  const footer = element("button", "dropdown-footer", "Manage workspaces →");
  footer.type = "button";
  footer.addEventListener("click", () => {
    setOpen(false);
    options.onManage();
  });
  menu.append(footer);
  return root;
}

function systemChoices(inventory) {
  const types = new Map((inventory.types || []).map((type) => [type.id, type]));
  return [
    { id: "powershell-core", label: "PowerShell 7", detail: "Modern PowerShell", cmd: "pwsh.exe", args: ["-NoLogo"], icon: "PS" },
    { id: "windows-powershell", label: "Windows PowerShell", detail: "Built into Windows", cmd: "powershell.exe", args: ["-NoLogo"], icon: "PS" },
    { id: "command-prompt", label: "Command Prompt", detail: "Classic Windows shell", cmd: "cmd.exe", args: [], icon: "C:\\" },
    { id: "wsl", label: "WSL", detail: "Linux on Windows", cmd: "wsl.exe", args: [], icon: "LX" },
  ].filter((choice) => {
    const detected = types.get(choice.id);
    return detected ? detected.available !== false : choice.id !== "powershell-core";
  });
}

function buildTerminalControl(options) {
  const control = element("div", "launch-control");
  const { root, trigger, menu, setOpen } = dropdownShell("terminal-dropdown");
  root.classList.add("launch-dropdown");
  const systems = systemChoices(options.inventory);
  let selected = options.profiles.length
    ? { kind: "profile", profile: options.profiles[0], label: options.profiles[0].name, detail: shellLabel(options.profiles[0]) }
    : systems.length ? { kind: "system", ...systems[0] } : null;

  const renderTrigger = () => {
    trigger.textContent = "";
    const copy = element("span", "dropdown-trigger-copy");
    copy.append(element("small", "", "New terminal"));
    const value = element("span", "launch-value");
    value.append(element("strong", "", selected ? selected.label : "No terminal found"));
    if (selected) value.append(element("em", "", selected.detail || ""));
    copy.append(value);
    trigger.append(copy, element("span", "dropdown-chevron", "⌄"));
  };

  const select = (choice) => {
    selected = choice;
    renderTrigger();
    setOpen(false);
  };

  menu.append(sectionLabel("Personal"));
  if (!options.profiles.length) menu.append(element("div", "dropdown-empty", "Create profiles in Settings"));
  for (const profile of options.profiles) {
    const item = menuItem(profile.name, shellLabel(profile), (profile.name || "> ").slice(0, 2).toUpperCase());
    item.addEventListener("click", () => select({ kind: "profile", profile, label: profile.name, detail: shellLabel(profile) }));
    menu.append(item);
  }

  menu.append(sectionLabel("System terminals"));
  for (const system of systems) {
    const item = menuItem(system.label, system.detail, system.icon);
    if (system.id !== "wsl") {
      item.addEventListener("click", () => select({ kind: "system", ...system }));
      menu.append(item);
      continue;
    }

    const distros = options.inventory.wsl_distributions || [];
    const group = element("div", "dropdown-nested-group");
    item.append(element("span", "nested-chevron", "›"));
    const distroList = element("div", "dropdown-nested");
    distroList.hidden = true;
    if (!distros.length) {
      item.disabled = true;
      item.querySelector("small").textContent = "No Linux distributions installed";
    } else if (distros.length === 1) {
      item.querySelector("small").textContent = `${distros[0]} · auto-selected`;
      item.addEventListener("click", () => select({
        kind: "system", ...system, label: `WSL · ${distros[0]}`,
        detail: distros[0], distro: distros[0], args: ["-d", distros[0]],
      }));
    } else {
      item.querySelector("small").textContent = `${distros.length} distributions · choose one`;
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        distroList.hidden = !distroList.hidden;
        group.classList.toggle("expanded", !distroList.hidden);
      });
      for (const distro of distros) {
        const distroItem = menuItem(distro, "WSL distribution", "LX");
        distroItem.addEventListener("click", () => select({
          kind: "system", ...system, label: `WSL · ${distro}`,
          detail: distro, distro, args: ["-d", distro],
        }));
        distroList.append(distroItem);
      }
    }
    group.append(item, distroList);
    menu.append(group);
  }
  renderTrigger();

  const openButton = element("button", "launch-button");
  openButton.type = "button";
  openButton.append(element("span", "", "Open"), element("span", "", "↗"));
  openButton.addEventListener("click", () => {
    if (!selected) return;
    if (selected.kind === "profile") options.onRunProfile(selected.profile);
    else options.onRunSystem(selected);
  });
  control.append(root, openButton);
  return control;
}

export function initLauncher(el, options) {
  if (el._launcherAbort) el._launcherAbort.abort();
  const abort = new AbortController();
  el._launcherAbort = abort;
  el.textContent = "";

  const brand = element("div", "launcher-brand");
  brand.innerHTML = '<span class="brand-mark"><i></i><i></i><i></i></span>' +
    '<span class="brand-copy"><strong>QuickTerm</strong><small>workspaces</small></span>';
  el.append(brand, buildWorkspaceDropdown(options), buildTerminalControl(options));

  const nav = element("nav", "launcher-nav");
  nav.setAttribute("aria-label", "Application");
  const icons = { dashboard: "◇", settings: "◫", help: "?" };
  for (const [label, onClick] of options.chrome || []) {
    const button = element("button", "nav-button");
    button.type = "button";
    button.append(element("span", "", icons[label] || "·"), element("span", "", label));
    button.addEventListener("click", onClick);
    nav.append(button);
  }
  el.append(nav);

  document.addEventListener("quickterm:close-dropdowns", (event) => {
    for (const root of el.querySelectorAll(".app-dropdown.open")) {
      if (root === event.detail) continue;
      root.classList.remove("open");
      root.querySelector(":scope > .dropdown-menu").hidden = true;
      root.querySelector(":scope > .dropdown-trigger").setAttribute("aria-expanded", "false");
    }
  }, { signal: abort.signal });
  document.addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("quickterm:close-dropdowns"));
  }, { signal: abort.signal });
}
