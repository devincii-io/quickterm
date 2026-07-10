// Compact app chrome: one intentional launch control and quiet navigation.

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

export function initLauncher(el, profiles, onRun, chrome) {
  el.textContent = "";

  const brand = document.createElement("div");
  brand.className = "launcher-brand";
  brand.innerHTML = '<span class="brand-mark"><i></i><i></i><i></i></span>' +
    '<span class="brand-copy"><strong>QuickTerm</strong><small>workspaces</small></span>';
  el.appendChild(brand);

  const launch = document.createElement("div");
  launch.className = "launch-control";
  const selectWrap = document.createElement("label");
  selectWrap.className = "launch-select-wrap";
  const label = document.createElement("span");
  label.textContent = "New terminal";
  const select = document.createElement("select");
  select.className = "launch-select";
  select.title = "Choose a terminal profile";
  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.name;
    option.textContent = `${profile.name}  —  ${shellLabel(profile)}`;
    select.appendChild(option);
  }
  selectWrap.append(label, select);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "launch-button";
  button.innerHTML = '<span>Open</span><span aria-hidden="true">↗</span>';
  const run = () => {
    const profile = profiles.find((item) => item.name === select.value);
    if (profile) onRun(profile);
  };
  button.addEventListener("click", run);
  select.addEventListener("keydown", (event) => {
    if (event.key === "Enter") run();
    event.stopPropagation();
  });
  launch.append(selectWrap, button);
  el.appendChild(launch);

  const nav = document.createElement("nav");
  nav.className = "launcher-nav";
  nav.setAttribute("aria-label", "Application");
  const icons = { dashboard: "◇", settings: "◫", help: "?" };
  for (const [navLabel, onClick] of chrome || []) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "nav-button";
    b.innerHTML = `<span aria-hidden="true">${icons[navLabel] || "·"}</span><span>${navLabel}</span>`;
    b.addEventListener("click", onClick);
    nav.appendChild(b);
  }
  el.appendChild(nav);
}
