import * as api from "./api.js";
import { icon } from "./icons.js";
import { inferTerminalType, make, environmentError } from "./panel_shared.js";
import { configChoice } from "./panel_settings_kit.js";
import { settingsPatch } from "./global_settings.js";

export const CONNECTION_CATALOG = [
  { id: "windows-powershell", label: "Windows PowerShell", group: "Local terminals", cmd: "powershell.exe" },
  { id: "powershell-core", label: "PowerShell 7", group: "Local terminals", cmd: "pwsh.exe" },
  { id: "command-prompt", label: "Command Prompt", group: "Local terminals", cmd: "cmd.exe" },
  { id: "git-bash", label: "Git Bash", group: "Local terminals", cmd: "bash.exe" },
  { id: "bash", label: "Bash", group: "Local terminals", cmd: "bash" },
  { id: "zsh", label: "Zsh", group: "Local terminals", cmd: "zsh" },
  { id: "fish", label: "Fish", group: "Local terminals", cmd: "fish" },
  { id: "nushell", label: "Nushell", group: "Local terminals", cmd: "nu" },
  { id: "wsl", label: "WSL", group: "Local terminals", cmd: "wsl.exe" },
  { id: "claude-code", label: "Claude Code", group: "Tools", cmd: "claude" },
  { id: "custom", label: "Custom command", group: "Tools", cmd: "" },
  { id: "ssh", label: "SSH", group: "Remote terminals", cmd: "" },
  { id: "sftp", label: "SFTP", group: "Remote terminals", cmd: "" },
  { id: "telnet", label: "Telnet", group: "Remote terminals", cmd: "" },
  { id: "serial", label: "Serial console", group: "Devices", cmd: "" },
  { id: "docker", label: "Docker", group: "Containers", cmd: "docker" },
  { id: "podman", label: "Podman", group: "Containers", cmd: "podman" },
  { id: "kubernetes", label: "Kubernetes", group: "Containers", cmd: "kubectl" },
  { id: "rdp", label: "Remote Desktop", group: "Desktop windows", cmd: "" },
  { id: "vnc", label: "VNC", group: "Desktop windows", cmd: "" },
];

export function connectionLabel(profile) {
  return CONNECTION_CATALOG.find((item) => item.id === inferTerminalType(profile))?.label || "Custom command";
}

export function connectionTarget(profile) {
  const options = profile.connection || {};
  return profile.ssh_host ? `${profile.ssh_user ? `${profile.ssh_user}@` : ""}${profile.ssh_host}`
    : options.host || options.target || options.device || profile.wsl_distro || profile.cmd || connectionLabel(profile);
}

export function connectionProblems(profile, profiles) {
  const errors = [];
  const name = (profile.name || "").trim();
  if (!name) errors.push("Enter a name.");
  if (profiles.some((other) => other !== profile && (other.name || "").trim().toLowerCase() === name.toLowerCase())) errors.push("This name is already used.");
  const kind = inferTerminalType(profile);
  const options = profile.connection || {};
  if (["ssh", "sftp"].includes(kind) && !profile.ssh_host?.trim()) errors.push("Enter a host.");
  if (["rdp", "vnc", "telnet"].includes(kind) && !options.host?.trim()) errors.push("Enter a host.");
  if (["docker", "podman", "kubernetes"].includes(kind) && !options.target?.trim()) errors.push("Enter a container or pod.");
  if (kind === "serial" && !options.device?.trim()) errors.push("Enter a serial device.");
  if (["custom", "vnc"].includes(kind) && !profile.cmd?.trim()) errors.push("Choose a client executable.");
  for (const [value, label, low, high] of [
    [profile.ssh_port, "Port", 1, 65535], [options.port, "Port", 1, 65535],
    [options.baud, "Baud rate", 50, 4000000], [options.width, "Width", 200, 16384], [options.height, "Height", 200, 16384],
  ]) {
    if (value !== null && value !== undefined && value !== "" && (!/^\d+$/.test(String(value)) || Number(value) < low || Number(value) > high)) errors.push(`${label} must be between ${low} and ${high}.`);
  }
  const envError = environmentError(profile.env);
  if (envError) errors.push(envError);
  return errors;
}

export function newConnection(type, inventory, profiles) {
  const known = inventory?.types?.find((item) => item.id === type.id);
  let name = type.label;
  let index = 2;
  while (profiles.some((item) => item.name.toLowerCase() === name.toLowerCase())) name = `${type.label} ${index++}`;
  return {
    name, cmd: known?.executable || type.cmd, terminal_type: type.id, description: "",
    args: [], env: {}, keybinding: null, autostart: false,
    start_command: null, claude_mode: type.id === "claude-code" ? "new" : null,
    wsl_distro: null, ssh_host: null, ssh_port: null, ssh_user: null, ssh_key: null,
    connection: type.id === "serial" ? { baud: "9600", data_bits: "8", parity: "n", stop_bits: "1", flow: "N" }
      : ["docker", "podman", "kubernetes"].includes(type.id) ? { shell: "/bin/sh" } : {},
  };
}

export function renderConnections(host, rerender) {
  const cfg = this.settingsDraft;
  cfg.profiles ||= [];
  const profiles = cfg.profiles;
  const heading = make("div", "connection-heading");
  heading.append(make("h2", "", "Terminals and connections"));
  const add = this._button("Add", "primary-button compact");
  add.disabled = Boolean(this.connectionEditor?.draft);
  add.prepend(icon("plus", 14));
  add.addEventListener("click", () => { this.connectionEditor = { choosing: true }; rerender(); });
  heading.append(add);
  host.append(heading);
  const editor = this.connectionEditor;
  if (editor?.choosing) {
    const back = this._button("Back", "secondary-button compact");
    back.addEventListener("click", () => { this.connectionEditor = null; rerender(); });
    host.append(back);
    for (const group of [...new Set(CONNECTION_CATALOG.map((type) => type.group))]) {
      host.append(make("h3", "connection-group-heading", group));
      const choices = make("div", "connection-types");
      for (const type of CONNECTION_CATALOG.filter((item) => item.group === group)) {
        const button = this._button(type.label, "connection-type");
        button.prepend(icon(group === "Desktop windows" ? "new-window" : group === "Local terminals" ? "terminal" : "link", 16));
        const detected = this.terminalInventory?.types?.find((item) => item.id === type.id);
        if (detected && type.id !== "custom") button.append(make("small", "", detected.available === false ? "Client not found" : "Available"));
        button.addEventListener("click", () => {
          this.connectionEditor = { draft: newConnection(type, this.terminalInventory, profiles), original: null };
          rerender();
        });
        choices.append(button);
      }
      host.append(choices);
    }
    return;
  }
  if (editor?.draft) {
    renderEditor.call(this, host, rerender, editor, profiles);
    return;
  }
  const search = this._textInput(this.connectionFilter || "", "Search terminals and connections");
  search.type = "search";
  const list = make("div", "connection-list");
  const draw = () => {
    list.textContent = "";
    const query = search.value.toLowerCase().trim();
    const matches = profiles.filter((profile) => [profile.name, connectionLabel(profile), connectionTarget(profile), profile.description].join(" ").toLowerCase().includes(query));
    for (const profile of matches) {
      const row = make("article", "connection-row");
      const info = make("div", "connection-info");
      info.append(make("strong", "", profile.name), make("small", "", `${connectionLabel(profile)} · ${connectionTarget(profile)}`));
      const edit = this._button("Edit", "secondary-button compact");
      edit.addEventListener("click", () => {
        this.connectionEditor = { draft: structuredClone(profile), original: profile };
        rerender();
      });
      const launch = this._button(["rdp", "vnc"].includes(profile.terminal_type) ? "Open window" : "Open terminal", "secondary-button compact");
      launch.disabled = !this.app.profiles.some((saved) => saved.name === profile.name) || Boolean(connectionProblems(profile, profiles).length);
      launch.title = launch.disabled ? "Save changes before opening" : profile.name;
      launch.addEventListener("click", () => {
        const saved = this.app.profiles.find((item) => item.name === profile.name);
        this.close();
        this.app.runProfile(saved);
      });
      const remove = this._button("", "icon-button danger-text");
      remove.append(icon("trash", 14));
      remove.title = `Remove ${profile.name}`;
      remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", () => this._confirmNear(remove, `Remove "${profile.name}" from saved connections? Running sessions stay open.`, "Remove", () => {
        profiles.splice(profiles.indexOf(profile), 1);
        if (cfg.default_profile === profile.name) cfg.default_profile = "";
        rerender();
      }));
      row.append(info, launch, edit, remove);
      list.append(row);
    }
    if (!matches.length) list.append(make("p", "connection-empty", profiles.length ? "No matches." : "No terminals or connections saved."));
  };
  search.addEventListener("input", () => { this.connectionFilter = search.value; draw(); });
  host.append(search, list);
  draw();
}

function renderEditor(host, rerender, editor, profiles) {
  const profile = editor.draft;
  profile.connection ||= {};
  const kind = inferTerminalType(profile);
  host.append(make("h3", "connection-group-heading", `${editor.original ? "Edit" : "Set up"} ${connectionLabel(profile)}`));
  const fields = make("div", "settings-grid two-column connection-fields");
  const text = (label, object, key, placeholder = "", numeric = false) => {
    const input = this._textInput(object[key] ?? "", placeholder);
    if (numeric) { input.type = "number"; input.min = "1"; input.step = "1"; }
    input.addEventListener("input", () => { object[key] = numeric && key === "ssh_port" ? (input.value ? Number(input.value) : null) : input.value; });
    fields.append(this._field(label, input));
    return input;
  };
  const choice = (label, object, key, values, fallback = "") => {
    const control = configChoice({ label, value: object[key] || fallback, options: values.map((value) => typeof value === "string" ? { value, label: value } : value), onChange: (value) => { object[key] = value; } });
    fields.append(this._field(label, control.el));
  };
  text("Name", profile, "name");
  text("Description", profile, "description");
  if (["ssh", "sftp"].includes(kind)) {
    text("Host", profile, "ssh_host", "server.example.com");
    text("Username", profile, "ssh_user");
    text("Port", profile, "ssh_port", "22", true);
    text("Private key file", profile, "ssh_key", "C:\\keys\\server.ppk");
    if (kind === "ssh") text("Remote command", profile, "start_command");
  } else if (["telnet", "rdp", "vnc"].includes(kind)) {
    text("Host", profile.connection, "host", "server.example.com");
    text("Port", profile.connection, "port", kind === "rdp" ? "3389" : kind === "vnc" ? "5900" : "23", true);
    if (kind === "rdp") {
      choice("Window mode", profile.connection, "fullscreen", [{ value: "false", label: "Window" }, { value: "true", label: "Full screen" }], "false");
      text("Width", profile.connection, "width", "1280", true);
      text("Height", profile.connection, "height", "720", true);
    }
    if (kind === "vnc") text("VNC viewer executable", profile, "cmd", "C:\\Program Files\\TigerVNC\\vncviewer.exe");
  } else if (kind === "serial") {
    text("Device", profile.connection, "device", "COM3");
    text("Baud rate", profile.connection, "baud", "9600", true);
    choice("Data bits", profile.connection, "data_bits", ["5", "6", "7", "8"], "8");
    choice("Parity", profile.connection, "parity", [{ value: "n", label: "None" }, { value: "e", label: "Even" }, { value: "o", label: "Odd" }, { value: "m", label: "Mark" }, { value: "s", label: "Space" }], "n");
    choice("Stop bits", profile.connection, "stop_bits", ["1", "1.5", "2"], "1");
    choice("Flow control", profile.connection, "flow", [{ value: "N", label: "None" }, { value: "X", label: "XON/XOFF" }, { value: "R", label: "RTS/CTS" }, { value: "D", label: "DSR/DTR" }], "N");
  } else if (["docker", "podman", "kubernetes"].includes(kind)) {
    text(kind === "kubernetes" ? "Pod" : "Container name or ID", profile.connection, "target");
    text("Shell inside container", profile.connection, "shell", "/bin/sh");
    text(kind === "podman" ? "Podman connection" : "Context", profile.connection, "context");
    if (kind === "kubernetes") {
      text("Namespace", profile.connection, "namespace", "default");
      text("Container within pod", profile.connection, "container");
    } else text("User inside container", profile.connection, "user");
    text("Client executable", profile, "cmd");
  } else {
    text("Executable", profile, "cmd");
    if (kind === "wsl") {
      const distros = this.terminalInventory?.wsl_distributions || [];
      if (distros.length) choice("Distribution", profile, "wsl_distro", [{ value: "", label: "Default distribution" }, ...distros], "");
      else text("WSL distribution", profile, "wsl_distro");
    }
    if (kind === "claude-code") choice("Launch mode", profile, "claude_mode", [{ value: "new", label: "New conversation" }, { value: "continue", label: "Continue last conversation" }, { value: "resume", label: "Choose conversation" }, { value: "agents", label: "Agent manager" }], "new");
    else if (kind !== "custom") text("Startup command", profile, "start_command");
  }
  host.append(fields);
  const args = make("textarea", "ui-input connection-args");
  args.value = (profile.args || []).join("\n");
  args.rows = 3;
  args.spellcheck = false;
  args.addEventListener("input", () => { profile.args = args.value ? args.value.split("\n") : []; });
  host.append(this._field("Arguments, one per line", args));
  const environment = make("div", "connection-environment");
  const envRows = Object.entries(profile.env || {}).map(([key, value]) => ({ key, value }));
  const syncEnv = () => {
    profile.env = Object.fromEntries(envRows.filter((row) => row.key).map((row) => [row.key, row.value]));
  };
  const drawEnv = () => {
    environment.textContent = "";
    for (const row of envRows) {
      const line = make("div", "connection-env-row");
      for (const key of ["key", "value"]) {
        const input = this._textInput(row[key], key === "key" ? "Variable" : "Value");
        input.setAttribute("aria-label", key === "key" ? "Environment variable name" : "Environment variable value");
        input.addEventListener("input", () => { row[key] = input.value; syncEnv(); });
        line.append(input);
      }
      const remove = this._button("", "icon-button");
      remove.append(icon("x", 14));
      remove.title = "Remove variable";
      remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", () => { envRows.splice(envRows.indexOf(row), 1); syncEnv(); drawEnv(); });
      line.append(remove);
      environment.append(line);
    }
  };
  const addEnv = this._button("Add variable", "secondary-button compact");
  addEnv.addEventListener("click", () => { envRows.push({ key: "", value: "" }); drawEnv(); environment.lastElementChild?.querySelector("input")?.focus(); });
  host.append(make("h3", "connection-group-heading", "Environment"), environment, addEnv);
  drawEnv();
  const behavior = make("div", "settings-grid two-column connection-fields");
  const shortcut = this._textInput(profile.keybinding || "", "Optional global shortcut");
  shortcut.disabled = ["rdp", "vnc"].includes(kind);
  if (shortcut.disabled) shortcut.title = "Desktop clients are opened explicitly from Connections";
  shortcut.addEventListener("input", () => { profile.keybinding = shortcut.value || null; });
  behavior.append(this._field("Global shortcut", shortcut));
  const autostart = make("label", "toggle-row");
  const checkbox = make("input", "sr-only");
  checkbox.type = "checkbox";
  checkbox.checked = Boolean(profile.autostart);
  checkbox.disabled = ["rdp", "vnc"].includes(kind);
  checkbox.addEventListener("change", () => { profile.autostart = checkbox.checked; });
  autostart.append(checkbox, make("span", "toggle-control"), make("span", "toggle-copy", "Start with QuickTerm"));
  behavior.append(autostart);
  host.append(behavior);
  const footer = make("div", "connection-editor-footer");
  const message = make("span", "settings-message");
  const cancel = this._button("Cancel", "secondary-button");
  cancel.addEventListener("click", () => { this.connectionEditor = null; rerender(); });
  const done = this._button("Save connection", "primary-button");
  done.addEventListener("click", async () => {
    syncEnv();
    const errors = connectionProblems(profile, profiles.filter((item) => item !== editor.original));
    const keys = envRows.filter((row) => row.key).map((row) => row.key.toLowerCase());
    if (new Set(keys).size !== keys.length) errors.push("Environment variable names must be unique.");
    if (errors.length) { message.textContent = errors.join(" "); message.classList.add("error"); return; }
    done.disabled = true;
    const updated = profiles.map((item) => item === editor.original ? profile : item);
    if (!editor.original) updated.push(profile);
    try {
      const fresh = await api.getFullConfig();
      const defaultProfile = fresh.default_profile === editor.original?.name ? profile.name : fresh.default_profile;
      const patch = settingsPatch({ profiles: updated }, { profiles: this.settingsBaseline.profiles }, fresh);
      await api.putConfig({ ...patch, ...(defaultProfile !== fresh.default_profile ? { default_profile: defaultProfile } : {}) });
      this.settingsDraft.profiles = updated;
      this.settingsBaseline.profiles = structuredClone(updated);
      if (defaultProfile !== fresh.default_profile) this.settingsBaseline.default_profile = defaultProfile;
      if (this.settingsDraft.default_profile === editor.original?.name) this.settingsDraft.default_profile = profile.name;
      await this.app.onConfigSaved();
      this.connectionEditor = null;
      rerender();
    } catch (error) { message.textContent = error.detail || error.message || "Could not save connection."; message.classList.add("error"); }
    finally { done.disabled = false; }
  });
  footer.append(message, cancel, done);
  host.append(footer);
}
