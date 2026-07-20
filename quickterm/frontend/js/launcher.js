import { icon } from "./icons.js";

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

// mark: a short monogram string ("PS") or an icon name passed as {icon: "..."}.
function menuItem(label, detail, mark) {
  const button = element("button", "dropdown-item");
  button.type = "button";
  const markEl = element("span", "dropdown-item-mark");
  if (mark && typeof mark === "object" && mark.icon) markEl.append(icon(mark.icon, 13));
  else markEl.textContent = mark || ">";
  const copy = element("span", "dropdown-item-copy");
  copy.append(element("strong", "", label));
  if (detail) copy.append(element("small", "", detail));
  button.append(markEl, copy);
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

function chevron() {
  const wrap = element("span", "dropdown-chevron");
  wrap.append(icon("chevron-down", 14));
  return wrap;
}

function sectionLabel(text) {
  return element("div", "dropdown-section-label", text);
}

function selectedMark() {
  const mark = element("span", "dropdown-selected-mark");
  mark.append(icon("check", 12));
  return mark;
}

function buildWorkspaceDropdown(options) {
  const { root, trigger, menu, setOpen } = dropdownShell("workspace-dropdown");
  // "scratch" is the adopted disposable workspace: it autosaves during the
  // run but the file dies with the app, so it is never presented as saved.
  const isScratch = !options.currentWorkspace || options.currentWorkspace === "scratch";
  const renderTrigger = () => {
    trigger.textContent = "";
    const copy = element("span", "dropdown-trigger-copy");
    copy.append(
      element("small", "", "Workspace"),
      element("strong", "", isScratch ? "Scratch" : options.currentWorkspace),
    );
    trigger.append(element("span", `workspace-state ${isScratch ? "scratch" : "saved"}`), copy, chevron());
  };
  renderTrigger();

  menu.append(sectionLabel("Workspace mode"));
  const scratch = menuItem("New scratch", "Disposable · closes with the app", { icon: "circle-dashed" });
  if (!options.currentWorkspace) {
    scratch.classList.add("selected");
    scratch.append(selectedMark());
  }
  scratch.addEventListener("click", () => {
    setOpen(false);
    options.onWorkspace(null);
  });
  menu.append(scratch, sectionLabel("Saved workspaces"));
  if (!options.workspaces.length) {
    menu.append(element("div", "dropdown-empty", "No workspaces saved yet"));
  }
  for (const name of options.workspaces) {
    // The adopted "scratch" workspace stays listed (that is how you return
    // to it) but is labelled for what it is: gone when the app quits.
    const disposable = name === "scratch";
    const item = menuItem(
      name,
      name === options.currentWorkspace ? "Currently open" : disposable ? "Disposable · this run only" : "Sessions and layout saved",
      { icon: disposable ? "circle-dashed" : "diamond" },
    );
    if (name === options.currentWorkspace) {
      item.classList.add("selected");
      item.append(selectedMark());
    }
    item.addEventListener("click", () => {
      setOpen(false);
      options.onWorkspace(name);
    });
    menu.append(item);
  }
  const footer = element("button", "dropdown-footer");
  footer.type = "button";
  footer.append(element("span", "", "Manage workspaces"), icon("chevron-right", 13));
  footer.addEventListener("click", () => {
    setOpen(false);
    options.onManage();
  });
  menu.append(footer);
  return root;
}

// Known system terminal metadata; anything else from the server inventory
// still shows up with generic defaults, so posix shells work unchanged.
const SYSTEM_META = {
  "powershell-core": { detail: "Modern PowerShell", mark: "PS", args: ["-NoLogo"] },
  "windows-powershell": { detail: "Built into Windows", mark: "PS", args: ["-NoLogo"] },
  "command-prompt": { detail: "Classic Windows shell", mark: "C:\\", args: [] },
  wsl: { detail: "Linux on Windows", mark: "LX", args: [] },
  bash: { detail: "GNU Bash", mark: "$", args: ["-l"] },
  zsh: { detail: "Z shell", mark: "%", args: ["-l"] },
  fish: { detail: "Friendly shell", mark: "><>", args: ["-l"] },
  "git-bash": { detail: "Git for Windows shell", mark: "$", args: ["-l"] },
  nushell: { detail: "Modern structured shell", mark: "nu", args: [] },
};

function systemChoices(inventory) {
  return (inventory.types || [])
    .filter((type) => type.executable && type.available !== false && type.id !== "custom")
    .map((type) => {
      const meta = SYSTEM_META[type.id] || { detail: type.executable, mark: ">", args: [] };
      return { id: type.id, label: type.label, detail: meta.detail, cmd: type.executable, args: meta.args, mark: meta.mark };
    });
}

function buildTerminalControl(options) {
  const control = element("div", "launch-control");
  const { root, trigger, menu, setOpen } = dropdownShell("terminal-dropdown");
  root.classList.add("launch-dropdown");
  const systems = systemChoices(options.inventory);
  // The current selection is the window's default terminal: splits and new
  // panes open it. Survive launcher rebuilds by restoring the prior choice.
  const prior = options.selectedTerminal;
  let selected = null;
  if (prior && prior.kind === "profile") {
    const match = options.profiles.find((profile) => profile.name === prior.profile.name);
    if (match) selected = { kind: "profile", profile: match, label: match.name, detail: shellLabel(match) };
  } else if (prior && prior.kind === "system" && systems.some((system) => system.id === prior.id)) {
    selected = { ...prior };
  }
  if (!selected) {
    const preferredProfile = options.profiles.find((profile) => profile.name === options.defaultProfile);
    const preferredSystem = systems.find((system) => system.id === options.defaultProfile);
    selected = preferredProfile
      ? { kind: "profile", profile: preferredProfile, label: preferredProfile.name, detail: shellLabel(preferredProfile) }
      : preferredSystem ? { kind: "system", ...preferredSystem }
      : options.profiles.length
        ? { kind: "profile", profile: options.profiles[0], label: options.profiles[0].name, detail: shellLabel(options.profiles[0]) }
        : systems.length ? { kind: "system", ...systems[0] } : null;
  }
  if (options.onSelectTerminal && selected) options.onSelectTerminal(selected);

  const renderTrigger = () => {
    trigger.textContent = "";
    const copy = element("span", "dropdown-trigger-copy");
    copy.append(element("small", "", "New terminal"));
    const value = element("span", "launch-value");
    value.append(element("strong", "", selected ? selected.label : "No terminal found"));
    if (selected) value.append(element("em", "", selected.detail || ""));
    copy.append(value);
    trigger.append(copy, chevron());
  };

  const select = (choice) => {
    selected = choice;
    if (options.onSelectTerminal) options.onSelectTerminal(choice);
    renderTrigger();
    setOpen(false);
  };

  menu.append(sectionLabel("Personal"));
  if (!options.profiles.length) menu.append(element("div", "dropdown-empty", "No personal terminals yet — create one in Settings"));
  for (const profile of options.profiles) {
    const item = menuItem(profile.name, shellLabel(profile), (profile.name || "> ").slice(0, 2).toUpperCase());
    item.addEventListener("click", () => select({ kind: "profile", profile, label: profile.name, detail: shellLabel(profile) }));
    menu.append(item);
  }

  menu.append(sectionLabel("System terminals"));
  for (const system of systems) {
    const item = menuItem(system.label, system.detail, system.mark);
    if (system.id !== "wsl") {
      item.addEventListener("click", () => select({ kind: "system", ...system }));
      menu.append(item);
      continue;
    }

    const distros = options.inventory.wsl_distributions || [];
    const group = element("div", "dropdown-nested-group");
    const nestedChevron = element("span", "nested-chevron");
    nestedChevron.append(icon("chevron-right", 14));
    item.append(nestedChevron);
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
  openButton.append(element("span", "", "Open"), icon("arrow-up-right", 14));
  openButton.addEventListener("click", () => {
    if (!selected) return;
    if (selected.kind === "profile") options.onRunProfile(selected.profile);
    else options.onRunSystem(selected);
  });
  control.append(root, openButton);
  // In an elevated window every new terminal is already an administrator (it
  // inherits the elevated server), so the "open a new admin window" button is
  // pointless there — the red frame and badge already say you are admin.
  if (options.elevated) {
    control.classList.add("no-admin");
  } else {
    const adminButton = element("button", "admin-button");
    adminButton.type = "button";
    adminButton.title = "Open in a new administrator window (shows a Windows UAC prompt)";
    adminButton.setAttribute("aria-label", "Open as administrator");
    adminButton.append(icon("shield", 15), element("span", "", "Admin"));
    adminButton.addEventListener("click", () => {
      if (!selected) return;
      if (selected.kind === "profile") options.onElevateProfile(selected.profile);
      else options.onElevateSystem(selected);
    });
    control.append(adminButton);
  }
  return control;
}

export function initLauncher(el, options) {
  if (el._launcherAbort) el._launcherAbort.abort();
  const abort = new AbortController();
  el._launcherAbort = abort;
  el.textContent = "";

  const brand = element("div", "launcher-brand");
  if (options.logoUrl) {
    const frame = element("span", "brand-logo-frame");
    const image = element("img", "brand-logo");
    image.src = options.logoUrl;
    image.alt = "";
    image.addEventListener("error", () => frame.replaceWith(defaultBrandMark()));
    frame.append(image);
    brand.append(frame);
  } else {
    brand.append(defaultBrandMark());
  }
  const brandCopy = element("span", "brand-copy");
  brandCopy.append(
    element("strong", "", "QuickTerm"),
    element("small", "", options.currentWorkspace || "workspaces"),
  );
  brand.append(brandCopy);
  if (options.elevated) {
    const badge = element("span", "admin-badge");
    badge.append(icon("shield", 13), element("span", "", "Administrator"));
    brand.append(badge);
  }
  const controls = element("div", "launcher-controls");
  controls.append(buildWorkspaceDropdown(options), buildTerminalControl(options));
  el.append(brand, controls);

  const nav = element("nav", "launcher-nav");
  nav.setAttribute("aria-label", "Application");
  const navIcons = { dashboard: "dashboard", settings: "settings", help: "help" };
  for (const [label, onClick] of options.chrome || []) {
    const button = element("button", "nav-button");
    button.type = "button";
    button.append(icon(navIcons[label] || "terminal", 15), element("span", "", label));
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

function defaultBrandMark() {
  const frame = element("span", "brand-logo-frame");
  const image = element("img", "brand-logo");
  image.src = "/assets/icon-64.png";
  image.alt = "";
  frame.append(image);
  return frame;
}
