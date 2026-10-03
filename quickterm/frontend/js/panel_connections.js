// Settings > Terminals: every saved terminal config as one compact row, and
// the editor of the selected one beside the list (config_list.js). The editor
// edits `settingsDraft.profiles[i]` in place; the footer Save is the only
// thing that persists, so an unsaved or changed row carries a marker and
// cannot be opened until it is saved.

import * as api from "./api.js";
import { icon } from "./icons.js";
import { TERMINAL_TYPES, inferTerminalType, make, environmentError } from "./panel_shared.js";
import {
  comboInput, configChoice, configEmpty, configProblems, configToggle,
} from "./panel_settings_kit.js";
import { itemDirty, renderConfigList } from "./config_list.js";
import { renderAgentFields } from "./panel_agent_fields.js";
import { shortcutInput, shortcutWarnings } from "./shortcut_input.js";
import {
  AGENT_MODE_LABELS, agentConflicts, agentModeOf, commandLineText, defaultArgsFor, fitsCommandLine,
  isAgentType, isShellKind, kindForCommand, purposeFor, runLine, splitCommandLine, sshProblems,
  takesArguments, takesStartCommand,
} from "./profile_model.js";

export const CONNECTION_CATALOG = [
  { id: "windows-powershell", label: "Windows PowerShell", group: "Shells", cmd: "powershell.exe" },
  { id: "powershell-core", label: "PowerShell 7", group: "Shells", cmd: "pwsh.exe" },
  { id: "command-prompt", label: "Command Prompt", group: "Shells", cmd: "cmd.exe" },
  { id: "git-bash", label: "Git Bash", group: "Shells", cmd: "bash.exe" },
  { id: "bash", label: "Bash", group: "Shells", cmd: "bash" },
  { id: "zsh", label: "Zsh", group: "Shells", cmd: "zsh" },
  { id: "fish", label: "Fish", group: "Shells", cmd: "fish" },
  { id: "nushell", label: "Nushell", group: "Shells", cmd: "nu" },
  { id: "wsl", label: "WSL", group: "Shells", cmd: "wsl.exe" },
  { id: "custom", label: "Custom command", group: "Shells", cmd: "" },
  { id: "claude-code", label: "Claude Code", group: "Agents", cmd: "claude" },
  { id: "codex", label: "Codex", group: "Agents", cmd: "codex" },
  { id: "ssh", label: "SSH", group: "Remote", cmd: "" },
  { id: "sftp", label: "SFTP", group: "Remote", cmd: "" },
  { id: "telnet", label: "Telnet", group: "Remote", cmd: "" },
  { id: "serial", label: "Serial console", group: "Devices", cmd: "" },
  { id: "docker", label: "Docker", group: "Containers", cmd: "docker" },
  { id: "podman", label: "Podman", group: "Containers", cmd: "podman" },
  { id: "kubernetes", label: "Kubernetes", group: "Containers", cmd: "kubectl" },
  { id: "rdp", label: "Remote Desktop", group: "Desktop", cmd: "" },
  { id: "vnc", label: "VNC", group: "Desktop", cmd: "" },
];

const DESKTOP = new Set(["rdp", "vnc"]);
const CONTAINERS = new Set(["docker", "podman", "kubernetes"]);

export function kindLabel(kind) {
  return CONNECTION_CATALOG.find((item) => item.id === kind)?.label || "Custom command";
}

export function connectionLabel(profile) {
  const kind = inferTerminalType(profile);
  const base = kindLabel(kind);
  if (isAgentType(kind)) {
    const mode = agentModeOf(profile, kind);
    return `${base} · ${AGENT_MODE_LABELS[mode] || mode}`;
  }
  if (kind === "ssh" || kind === "sftp") return `${base} · ${profile.ssh_client === "openssh" ? "OpenSSH" : "PuTTY"}`;
  return base;
}

export function terminalTypeLabel(type) {
  return TERMINAL_TYPES.find((item) => item.id === type)?.label || connectionLabel({ terminal_type: type });
}

// The type line the dashboard shows for a saved terminal.
export function profileTypeLabel(profile) {
  const type = inferTerminalType(profile);
  if (isAgentType(type)) return connectionLabel(profile);
  if (type === "wsl" && profile.wsl_distro) return `WSL · ${profile.wsl_distro}`;
  if ((type === "ssh" || type === "sftp") && profile.ssh_host) {
    const target = profile.ssh_user ? `${profile.ssh_user}@${profile.ssh_host}` : profile.ssh_host;
    return `${type.toUpperCase()} · ${target}`;
  }
  return terminalTypeLabel(type);
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
  if (["ssh", "sftp"].includes(kind)) errors.push(...sshProblems(profile));
  if (["rdp", "vnc", "telnet"].includes(kind) && !options.host?.trim()) errors.push("Enter a host.");
  if (CONTAINERS.has(kind) && !options.target?.trim()) errors.push("Enter a container or pod.");
  if (kind === "serial" && !options.device?.trim()) errors.push("Enter a serial device.");
  if (["custom", "vnc"].includes(kind) && !profile.cmd?.trim()) errors.push("Choose a client executable.");
  errors.push(...agentConflicts(kind, profile.agent));
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

function inventoryEntry(inventory, id) {
  return inventory?.types?.find((item) => item.id === id) || null;
}

// OpenSSH when it is installed, else the bundled PuTTY. An older backend
// reports no `openssh` key at all, which also means PuTTY.
export function defaultSshClient(inventory, id = "ssh") {
  const entry = inventoryEntry(inventory, id) || inventoryEntry(inventory, "ssh");
  return entry?.openssh ? "openssh" : "putty";
}

function sshClients(inventory, id) {
  const entry = inventoryEntry(inventory, id) || inventoryEntry(inventory, "ssh");
  const clients = [];
  if (entry?.openssh) clients.push("openssh");
  if (entry?.putty || (entry && !("putty" in entry) && entry.executable) || !entry) clients.push("putty");
  return clients;
}

export function uniqueName(wanted, profiles) {
  const taken = (name) => profiles.some((item) => (item.name || "").toLowerCase() === name.toLowerCase());
  let name = wanted;
  let index = 2;
  while (taken(name)) name = `${wanted} ${index++}`;
  return name;
}

export function newConnection(type, inventory, profiles, extra = {}) {
  const known = inventoryEntry(inventory, type.id);
  const agent = isAgentType(type.id);
  const remote = type.id === "ssh" || type.id === "sftp";
  const profile = {
    name: uniqueName(extra.name || type.label, profiles),
    // ssh and sftp pick their client by `ssh_client`, never by `cmd`. An
    // agent resolves its executable at launch (agents.resolve prefers the
    // native exe behind npm's shim), so pinning today's path would outlive
    // the next update; empty means "the one on PATH".
    cmd: remote || agent ? "" : (known?.executable || type.cmd), terminal_type: type.id, description: "",
    args: [], env: {}, keybinding: null, autostart: false,
    start_command: null, agent_mode: agent ? "new" : null,
    wsl_distro: null, ssh_host: null, ssh_port: null, ssh_user: null, ssh_key: null,
    ssh_client: remote ? defaultSshClient(inventory, type.id) : null, ssh_proxy_jump: null,
    connection: type.id === "serial" ? { baud: "9600", data_bits: "8", parity: "n", stop_bits: "1", flow: "N" }
      : CONTAINERS.has(type.id) ? { shell: "/bin/sh" } : {},
  };
  if (agent) profile.agent = {};
  if (type.id === "claude-code") profile.claude_mode = "new";
  for (const [key, value] of Object.entries(extra)) if (key !== "name") profile[key] = value;
  return profile;
}

function hostDetail(host) {
  const target = host.hostname || host.alias;
  return `${host.user ? `${host.user}@` : ""}${target}${host.port ? `:${host.port}` : ""}`;
}

function services(panel) {
  return panel.services || api;
}

function sshHosts(panel) {
  panel.sshHostsLoad ||= Promise.resolve()
    .then(() => services(panel).getSshHosts?.())
    .then((result) => {
      panel.sshHostList = result?.hosts || [];
      return panel.sshHostList;
    })
    .catch(() => {
      panel.sshHostList = [];
      return [];
    });
  return panel.sshHostsLoad;
}

function agentCatalog(panel) {
  panel.agentCatalogLoad ||= Promise.resolve()
    .then(() => services(panel).getAgentCatalog?.())
    .catch(() => null);
  return panel.agentCatalogLoad;
}

function addMenuItems(panel, addProfile) {
  const inventory = panel.terminalInventory;
  const items = [];
  for (const group of ["Shells", "Agents", "Remote", "Devices", "Containers", "Desktop"]) {
    items.push({ heading: group });
    for (const type of CONNECTION_CATALOG.filter((item) => item.group === group)) {
      const detected = inventoryEntry(inventory, type.id);
      items.push({
        label: type.label,
        detail: detected && type.id !== "custom" && detected.available === false ? "Client not found" : undefined,
        icon: group === "Desktop" ? "new-window" : group === "Remote" ? "link" : "terminal",
        run: () => addProfile(type),
      });
    }
    if (group !== "Remote") continue;
    const hosts = panel.sshHostList;
    if (hosts === undefined) {
      items.push({ heading: "From ~/.ssh/config" }, { label: "Reading ~/.ssh/config…", disabled: true });
    } else if (hosts.length) {
      items.push({ heading: "From ~/.ssh/config" });
      const ssh = CONNECTION_CATALOG.find((item) => item.id === "ssh");
      for (const host of hosts) {
        items.push({
          label: host.alias,
          detail: hostDetail(host),
          icon: "link",
          run: () => addProfile(ssh, { name: host.alias, ssh_host: host.alias, ssh_client: "openssh" }),
        });
      }
    }
  }
  return items;
}

export function renderConnections(host) {
  const cfg = this.settingsDraft;
  cfg.profiles ||= [];
  this.configSelection ||= {};
  this.configFilters ||= {};
  sshHosts(this);
  host.append(this._sectionHeading("Terminals", "Saved terminal configs. The workspace supplies the folder, so one config works in every project."));

  const focus = this.configFocus?.kind === "terminal" ? this.configFocus : null;
  this.configFocus = null;
  const remembered = this.configSelection.terminal;
  const selected = (focus?.name && cfg.profiles.find((profile) => profile.name === focus.name))
    || (cfg.profiles.includes(remembered) ? remembered : cfg.profiles.find((profile) => profile.name === this.configSelection.terminalName))
    || null;

  const addProfile = (type, extra) => {
    const profile = newConnection(type, this.terminalInventory, cfg.profiles, extra);
    cfg.profiles.push(profile);
    list.add(profile);
  };
  const saved = (profile) => (this.app.profiles || []).some((item) => item.name === profile.name);

  const list = renderConfigList({
    host,
    items: () => cfg.profiles,
    noun: "terminals",
    filterPlaceholder: "Filter terminals",
    addLabel: "Add terminal",
    addMenu: () => addMenuItems(this, addProfile),
    filter: this.configFilters.terminals || "",
    onFilter: (value) => { this.configFilters.terminals = value; },
    selected,
    onSelect: (profile) => {
      this.configSelection.terminal = profile;
      this.configSelection.terminalName = profile?.name || "";
    },
    placeholder: "Choose a terminal on the left to edit it, or add one.",
    row: (profile) => {
      const kind = inferTerminalType(profile);
      const problems = connectionProblems(profile, cfg.profiles);
      const dirty = itemDirty(this.savedSnapshots, profile);
      const ready = saved(profile) && !dirty && !problems.length;
      return {
        name: profile.name,
        kind: kindLabel(kind),
        summary: runLine(profile, kind),
        search: `${profile.description || ""} ${connectionTarget(profile)}`,
        problems,
        dirty,
        dot: kind,
        openLabel: DESKTOP.has(kind) ? "Open window" : "Open",
        openDisabled: !ready,
        openTitle: ready ? `Open ${profile.name}` : "Save changes before opening",
      };
    },
    editor: (profile, pane, { updateRow }) => renderEditor.call(this, profile, pane, updateRow),
    onOpen: (profile) => {
      const savedProfile = (this.app.profiles || []).find((item) => item.name === profile.name);
      if (!savedProfile) return;
      this.close();
      this.app.runProfile(savedProfile);
    },
    removeMessage: (profile) => `Remove "${profile.name}" from saved terminals? Running terminals stay open.`,
    confirm: (button, message, label, action, options) => this._confirmNear(button, message, label, action, options),
    onRemove: (profile) => {
      const at = cfg.profiles.indexOf(profile);
      if (at >= 0) cfg.profiles.splice(at, 1);
      if (cfg.default_profile === profile.name) cfg.default_profile = "";
    },
    emptyState: () => {
      const add = this._button("Add a terminal", "primary-button compact");
      add.addEventListener("click", () => list.openAdd());
      return configEmpty({
        lead: "No terminals saved yet.",
        body: "Every installed shell is already in the launcher. Save one here to give it a name, a start command, a shortcut, or to reach an agent, a server or a container.",
        action: add,
      });
    },
  });
  this._configList = list;
  if (focus && !focus.name) requestAnimationFrame(() => list.openAdd());
  return list;
}

function renderEditor(profile, pane, updateRow) {
  const cfg = this.settingsDraft;
  // Drawing an editor must not change the draft, or merely looking at a
  // profile would mark it unsaved; the dict is attached on the first write.
  const connection = profile.connection || {};
  let kind = inferTerminalType(profile);
  const origin = { kind, args: [...(profile.args || [])] };
  const remote = kind === "ssh" || kind === "sftp";
  const desktop = DESKTOP.has(kind);
  const local = isShellKind(kind) || kind === "custom";
  const lineMode = kind === "custom" && fitsCommandLine([profile.cmd || "", ...(profile.args || [])]);
  // Settings shows an inferred type for a hand-edited profile but stores none
  // until a field that only means something for that type is edited.
  const settle = () => { if (!profile.terminal_type) profile.terminal_type = kind; };

  const title = make("h3", "config-editor-title", kindLabel(kind));
  const purpose = make("p", "config-purpose", purposeFor(kind));
  const problemSlot = make("div", "config-problem-slot");
  pane.append(title, purpose, problemSlot);
  const showProblems = () => {
    problemSlot.textContent = "";
    const box = configProblems(connectionProblems(profile, cfg.profiles));
    if (box) problemSlot.append(box);
  };
  const touched = () => {
    showProblems();
    updateRow();
  };

  const fields = make("div", "settings-grid two-column connection-fields");
  pane.append(fields);
  const text = (label, object, key, { placeholder = "", numeric = false, hint = "", nullable = true, typed = true, onInput } = {}) => {
    const input = this._textInput(object[key] ?? "", placeholder);
    input.setAttribute("aria-label", label);
    if (numeric) { input.type = "number"; input.min = "1"; input.step = "1"; }
    input.addEventListener("input", () => {
      const raw = input.value;
      if (object === connection) {
        if (raw === "") delete object[key];
        else object[key] = raw;
        profile.connection = connection;
      } else if (numeric) {
        object[key] = raw ? Number(raw) : null;
      } else {
        object[key] = raw === "" && nullable ? null : raw;
      }
      onInput?.(raw);
      if (typed) settle();
      touched();
    });
    const node = this._field(label, input, hint);
    fields.append(node);
    return { input, field: node };
  };
  const choice = (label, object, key, values, fallback = "") => {
    const control = configChoice({
      label,
      value: object[key] || fallback,
      options: values.map((value) => (typeof value === "string" ? { value, label: value } : value)),
      onChange: (value) => {
        object[key] = value;
        if (object === connection) profile.connection = connection;
        settle();
        touched();
      },
    });
    const node = this._field(label, control.el);
    fields.append(node);
    return { control, field: node };
  };

  let previousName = profile.name;
  text("Name", profile, "name", {
    placeholder: "My terminal",
    nullable: false,
    typed: false,
    onInput: () => {
      // The default terminal is stored by name, so it follows a rename.
      if (cfg.default_profile && cfg.default_profile === previousName) cfg.default_profile = profile.name;
      previousName = profile.name;
    },
  });
  text("Description", profile, "description", { placeholder: "What this terminal is for", nullable: false, typed: false });

  // Fields whose visibility follows the kind, which typing a command can change.
  let startField = null;
  let argsField = null;
  let distroField = null;
  let argsArea = null;
  const syncKind = () => {
    title.textContent = kindLabel(kind);
    purpose.textContent = purposeFor(kind);
    if (startField) startField.hidden = !takesStartCommand(kind);
    if (argsField) argsField.hidden = lineMode || !takesArguments(kind);
    if (distroField) distroField.hidden = kind !== "wsl";
  };

  const modeHost = make("div", "settings-grid two-column connection-fields");
  const agentAdvanced = make("div");

  if (isAgentType(kind)) {
    text("Executable", profile, "cmd", {
      placeholder: kind === "codex" ? "codex" : "claude",
      hint: "Empty means the one found on PATH.",
      nullable: false,
    });
    const agentHost = make("div", "agent-fields");
    agentHost.append(make("p", "config-detail-placeholder", "Loading options…"));
    pane.append(agentHost);
    agentCatalog(this).then((catalog) => {
      if (this._configList?.selected?.() !== profile) return;
      agentHost.textContent = "";
      const type = catalog?.types?.find((item) => item.id === kind) || null;
      renderAgentFields(agentHost, profile, type, {
        modeHost,
        advancedHost: agentAdvanced,
        onChange: () => {
          settle();
          touched();
        },
      });
    });
  } else if (remote) {
    renderSshFields.call(this, profile, kind, fields, { text, settle, touched });
  } else if (["telnet", "rdp", "vnc"].includes(kind)) {
    text("Host", connection, "host", { placeholder: "server.example.com" });
    text("Port", connection, "port", { placeholder: kind === "rdp" ? "3389" : kind === "vnc" ? "5900" : "23", numeric: true });
    if (kind === "rdp") {
      choice("Window mode", connection, "fullscreen", [{ value: "false", label: "Window" }, { value: "true", label: "Full screen" }], "false");
      text("Width", connection, "width", { placeholder: "1280", numeric: true });
      text("Height", connection, "height", { placeholder: "720", numeric: true });
    }
    if (kind === "vnc") text("VNC viewer executable", profile, "cmd", { placeholder: "C:\\Program Files\\TigerVNC\\vncviewer.exe", nullable: false });
  } else if (kind === "serial") {
    text("Device", connection, "device", { placeholder: "COM3" });
    text("Baud rate", connection, "baud", { placeholder: "9600", numeric: true });
    choice("Data bits", connection, "data_bits", ["5", "6", "7", "8"], "8");
    choice("Parity", connection, "parity", [{ value: "n", label: "None" }, { value: "e", label: "Even" }, { value: "o", label: "Odd" }, { value: "m", label: "Mark" }, { value: "s", label: "Space" }], "n");
    choice("Stop bits", connection, "stop_bits", ["1", "1.5", "2"], "1");
    choice("Flow control", connection, "flow", [{ value: "N", label: "None" }, { value: "X", label: "XON/XOFF" }, { value: "R", label: "RTS/CTS" }, { value: "D", label: "DSR/DTR" }], "N");
  } else if (CONTAINERS.has(kind)) {
    text(kind === "kubernetes" ? "Pod" : "Container name or ID", connection, "target");
    text("Shell inside container", connection, "shell", { placeholder: "/bin/sh" });
    text(kind === "podman" ? "Podman connection" : "Context", connection, "context");
    if (kind === "kubernetes") {
      text("Namespace", connection, "namespace", { placeholder: "default" });
      text("Container within pod", connection, "container");
    } else text("User inside container", connection, "user");
    text("Client executable", profile, "cmd", { nullable: false });
  } else {
    const command = this._textInput(
      lineMode ? commandLineText(profile) : profile.cmd,
      lineMode ? "\"C:\\path with spaces\\tool.exe\" --flag" : "pwsh.exe",
    );
    command.classList.add("mono-input");
    command.setAttribute("aria-label", "Command");
    command.title = lineMode
      ? "The program and its arguments. Quote a part that contains spaces."
      : "The program this terminal runs, by name or full path.";
    command.addEventListener("input", () => {
      let next;
      if (lineMode) {
        const typed = splitCommandLine(command.value);
        profile.cmd = typed[0] || "";
        profile.args = typed.slice(1);
        next = kindForCommand(origin.kind, profile.cmd, profile.args);
      } else {
        profile.cmd = command.value;
        next = kindForCommand(origin.kind, profile.cmd);
        // Back on the kind it started with, its own arguments return; another
        // kind starts from that kind's defaults.
        profile.args = next === origin.kind ? [...origin.args] : defaultArgsFor(next);
        if (argsArea) argsArea.value = profile.args.join("\n");
      }
      if (next !== kind) {
        kind = next;
        profile.terminal_type = next;
        syncKind();
      }
      touched();
    });
    fields.append(this._field("Command", command));
    const distros = this.terminalInventory?.wsl_distributions || [];
    const distro = configChoice({
      label: "Linux distribution",
      value: profile.wsl_distro || "",
      options: [
        { value: "", label: distros.length ? "Default distribution" : "No distributions detected" },
        ...distros.map((item) => ({ value: item, label: item })),
      ],
      onChange: (value) => {
        profile.wsl_distro = value || null;
        settle();
        touched();
      },
    });
    distroField = this._field("Linux distribution", distro.el);
    fields.append(distroField);
  }

  pane.append(modeHost);

  const behavior = make("div", "settings-grid two-column connection-fields");
  const warnings = make("div", "shortcut-warnings");
  const showWarnings = () => {
    warnings.textContent = "";
    for (const row of shortcutWarnings(profile.keybinding, {
      summon: cfg.summon_hotkey, profiles: cfg.profiles, selfIndex: cfg.profiles.indexOf(profile),
    })) warnings.append(make("p", `shortcut-${row.level}`, row.text));
  };
  const shortcut = shortcutInput({
    value: profile.keybinding,
    label: "Global shortcut",
    disabled: desktop,
    onChange: (binding) => {
      profile.keybinding = binding || null;
      showWarnings();
      touched();
    },
  });
  const shortcutField = this._field("Global shortcut", shortcut.el,
    desktop ? "Desktop clients are opened from this list or the palette." : "Opens this terminal from anywhere in Windows.");
  shortcutField.append(warnings);
  behavior.append(shortcutField);
  const autostart = configToggle({
    label: "Open automatically with a restored workspace",
    checked: profile.autostart,
    disabled: desktop,
    onChange: (checked) => {
      profile.autostart = checked;
      touched();
    },
  });
  behavior.append(autostart.el);
  pane.append(behavior);
  showWarnings();

  // ---- Advanced: arguments, environment, start command ----
  const advanced = make("details", "config-advanced");
  advanced.append(make("summary", "", "Advanced"));
  advanced.append(agentAdvanced);
  argsArea = make("textarea", "ui-input connection-args");
  argsArea.value = (profile.args || []).join("\n");
  argsArea.rows = 3;
  argsArea.spellcheck = false;
  argsArea.setAttribute("aria-label", "Arguments, one per line");
  argsArea.addEventListener("keydown", (event) => event.stopPropagation());
  argsArea.addEventListener("input", () => {
    const lines = argsArea.value.split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    profile.args = lines;
    origin.args = [...lines];
    touched();
  });
  argsField = this._field("Arguments, one per line", argsArea, isAgentType(kind) ? "Added after the options above." : "");
  advanced.append(argsField);
  // Only the local shells run a start command (launch.resolve_profile); ssh
  // shows its remote command up front instead.
  if (local) {
    const start = this._textInput(profile.start_command || "", "Optional, e.g. uv run dev");
    start.classList.add("mono-input");
    start.setAttribute("aria-label", "Start command");
    start.addEventListener("input", () => {
      profile.start_command = start.value || null;
      settle();
      touched();
    });
    startField = this._field("Start command", start, "Runs inside the shell and keeps it open.");
    advanced.append(startField);
  }
  advanced.append(renderEnvironment.call(this, profile, touched));
  advanced.open = Boolean(environmentError(profile.env));
  pane.append(advanced);

  const footer = make("div", "config-editor-footer");
  const save = this._button("Save changes", "primary-button compact");
  save.title = "Save every change in Settings (Ctrl+S)";
  save.addEventListener("click", () => this._saveSettings?.());
  footer.append(save);
  pane.append(footer);

  syncKind();
  showProblems();
}

function renderSshFields(profile, kind, fields, { text, settle, touched }) {
  const panel = this;
  const inventory = this.terminalInventory;
  const clients = sshClients(inventory, kind);
  const openssh = () => profile.ssh_client === "openssh";
  let resolved = null;

  const hostField = comboInput({
    value: profile.ssh_host || "",
    label: "Host",
    placeholder: "server.example.com or a ~/.ssh/config alias",
    suggestions: async () => (await sshHosts(this)).map((host) => ({ value: host.alias, detail: hostDetail(host) })),
    onInput: (value) => {
      profile.ssh_host = value.trim() || null;
      resolved = null;
      fill.hidden = true;
      settle();
      touched();
    },
    onPick: (alias) => {
      if (clients.includes("openssh")) {
        profile.ssh_client = "openssh";
        client?.control.set("openssh");
      }
      syncClient();
      touched();
      resolve(alias);
    },
  });
  fields.append(this._field("Host", hostField.el));

  let client = null;
  if (clients.length > 1) {
    const control = configChoice({
      label: "Client",
      value: profile.ssh_client || "putty",
      options: [
        { value: "openssh", label: "OpenSSH", detail: "Reads ~/.ssh/config and OpenSSH keys" },
        { value: "putty", label: "PuTTY", detail: "The bundled plink and psftp, with .ppk keys" },
      ],
      onChange: (value) => {
        profile.ssh_client = value;
        settle();
        syncClient();
        touched();
      },
    });
    client = { control, field: this._field("Client", control.el) };
    fields.append(client.field);
  }
  const user = text("User", profile, "ssh_user", { placeholder: "Optional, e.g. deploy" });
  const port = text("Port", profile, "ssh_port", { placeholder: "22", numeric: true });
  const key = text("Private key", profile, "ssh_key", { onInput: () => syncClient() });
  const jump = text("ProxyJump", profile, "ssh_proxy_jump", { placeholder: "Optional, e.g. user@bastion" });
  if (kind === "ssh") {
    text("Remote command", profile, "start_command", { placeholder: "Optional, runs instead of a remote shell", hint: "The session ends when it finishes." });
  }

  const actions = make("div", "ssh-actions");
  const fill = this._button("Fill from ~/.ssh/config", "text-button compact");
  fill.hidden = true;
  fill.title = "Copy the resolved user, port, key and ProxyJump into the fields";
  fill.addEventListener("click", () => {
    if (!resolved) return;
    const values = {
      ssh_user: resolved.user || null,
      ssh_port: resolved.port ? Number(resolved.port) : null,
      ssh_key: resolved.identity_files?.[0] || resolved.identity_file || null,
      ssh_proxy_jump: openssh() ? (resolved.proxy_jump || null) : profile.ssh_proxy_jump,
    };
    for (const [field, input] of [["ssh_user", user.input], ["ssh_port", port.input], ["ssh_key", key.input], ["ssh_proxy_jump", jump.input]]) {
      profile[field] = values[field];
      input.value = values[field] ?? "";
    }
    settle();
    syncClient();
    touched();
  });
  const switchClient = this._button("Switch to OpenSSH", "text-button compact");
  switchClient.title = "This key is not a PuTTY .ppk file, so OpenSSH can probably read it";
  switchClient.addEventListener("click", () => {
    profile.ssh_client = "openssh";
    client?.control.set("openssh");
    settle();
    syncClient();
    touched();
  });
  actions.append(fill, switchClient);
  fields.append(actions);

  function syncClient() {
    const open = openssh();
    jump.field.hidden = !open;
    const hint = key.field.querySelector?.(".field-hint");
    const hintText = open
      ? "An OpenSSH key such as ~/.ssh/id_ed25519. Empty uses ssh-agent or ~/.ssh/config."
      : "A PuTTY .ppk file. A passphrase is asked in the terminal, never saved.";
    if (hint) hint.textContent = hintText;
    else key.field.append(make("span", "field-hint", hintText));
    key.input.placeholder = resolved?.identity_files?.[0] || (open ? "~/.ssh/id_ed25519" : "C:\\keys\\server.ppk");
    const keyPath = profile.ssh_key || "";
    switchClient.hidden = open || !clients.includes("openssh") || !keyPath || /\.ppk$/i.test(keyPath);
  }

  // The values ssh will use for an alias, shown as placeholders: an empty
  // field means "from ~/.ssh/config".
  async function resolve(alias) {
    let result = null;
    try { result = await services(panel).resolveSshHost?.(alias); } catch (_) { result = null; }
    if (!result || profile.ssh_host !== alias) return;
    resolved = result;
    user.input.placeholder = result.user || "Optional, e.g. deploy";
    port.input.placeholder = result.port ? String(result.port) : "22";
    jump.input.placeholder = result.proxy_jump || "Optional, e.g. user@bastion";
    fill.hidden = false;
    syncClient();
  }

  syncClient();
  if (profile.ssh_host && openssh()) {
    sshHosts(this).then((hosts) => {
      if (hosts.some((host) => host.alias === profile.ssh_host)) resolve(profile.ssh_host);
    });
  }
}

function renderEnvironment(profile, touched) {
  const box = make("div", "connection-environment-field");
  box.dataset.setting = "environment";
  box.append(make("span", "field-label", "Environment"));
  const rowsHost = make("div", "connection-environment");
  const rows = Object.entries(profile.env || {}).map(([key, value]) => ({ key, value }));
  const sync = () => {
    profile.env = Object.fromEntries(rows.filter((row) => row.key).map((row) => [row.key, row.value]));
    touched();
  };
  const draw = () => {
    rowsHost.textContent = "";
    for (const row of rows) {
      const line = make("div", "connection-env-row");
      for (const part of ["key", "value"]) {
        const input = this._textInput(row[part], part === "key" ? "Variable" : "Value");
        input.setAttribute("aria-label", part === "key" ? "Environment variable name" : "Environment variable value");
        input.addEventListener("input", () => { row[part] = input.value; sync(); });
        line.append(input);
      }
      const remove = this._button("", "icon-button");
      remove.append(icon("x", 14));
      remove.title = "Remove variable";
      remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", () => { rows.splice(rows.indexOf(row), 1); sync(); draw(); });
      line.append(remove);
      rowsHost.append(line);
    }
  };
  const add = this._button("Add variable", "secondary-button compact");
  add.title = "Values are encrypted on disk with your Windows account.";
  add.addEventListener("click", () => {
    rows.push({ key: "", value: "" });
    draw();
    rowsHost.lastElementChild?.querySelector?.("input")?.focus();
  });
  box.append(rowsHost, add);
  draw();
  return box;
}
