import { icon } from "./icons.js";
import {
  TERMINAL_TYPES, envToLines, inferTerminalType, make,
  parseEnvLines,
} from "./panel_shared.js";
export function renderTerminalSettings(host, rerender) {
    const cfg = this.settingsDraft;
    const heading = this._sectionHeading("Terminal profiles", "Your own terminals: a shell plus start command and shortcut. The workspace supplies the folder. System shells are always available in the launcher without any setup.");
    const add = this._button("", "primary-button compact");
    add.append(icon("plus", 13), make("span", "", "Add terminal"));
    add.addEventListener("click", () => {
      let n = 1;
      const names = new Set(cfg.profiles.map((profile) => profile.name));
      while (names.has(`Terminal ${n}`)) n += 1;
      const available = (this.terminalInventory.types || []).find((type) =>
        type.executable && type.available !== false && type.id !== "claude-code");
      const base = available || { id: "custom", executable: "" };
      const args = base.id === "powershell-core" || base.id === "windows-powershell" ? ["-NoLogo"] : [];
      cfg.profiles.push({ name: `Terminal ${n}`, cmd: base.executable || "", args, env: {}, keybinding: null, autostart: false, terminal_type: base.id, wsl_distro: null, start_command: null, claude_mode: null, ssh_host: null, ssh_port: null, ssh_user: null, ssh_key: null });
      rerender();
      host.lastElementChild?.scrollIntoView({ block: "nearest" });
    });
    heading.append(add);
    host.append(heading);
    if (!cfg.profiles.length) {
      const empty = make("div", "profiles-empty");
      empty.append(make("p", "", "No personal terminals yet. The launcher already offers every shell installed on this computer. Add a profile when you want a start command or a global shortcut."));
      host.append(empty);
    }

    const inventoryTypes = (this.terminalInventory.types || TERMINAL_TYPES).map((type) => ({
      value: type.id,
      label: `${type.label}${type.available === false ? " (not found)" : ""}`,
    }));
    const distros = this.terminalInventory.wsl_distributions || [];
    for (const [index, profile] of cfg.profiles.entries()) {
      const card = make("article", "terminal-profile-card");
      const cardHead = make("div", "terminal-card-head");
      const identity = make("div", "terminal-identity");
      identity.append(make("span", "profile-mark large", (profile.name || "> ").slice(0, 2).toUpperCase()), make("div", "", undefined));
      identity.lastElementChild.append(make("h3", "", profile.name || "Untitled terminal"), make("p", "", this._terminalLabel(profile)));
      const remove = this._button("", "text-button danger-text");
      remove.append(icon("trash", 13), make("span", "", "Remove"));
      remove.addEventListener("click", () => {
        cfg.profiles.splice(index, 1);
        if (cfg.default_profile === profile.name) cfg.default_profile = cfg.profiles[0]?.name || "";
        rerender();
      });
      cardHead.append(identity, remove);
      card.append(cardHead);

      const fields = make("div", "settings-grid two-column");
      const name = this._textInput(profile.name, "My terminal");
      name.addEventListener("input", () => {
        if (cfg.default_profile === profile.name) cfg.default_profile = name.value;
        profile.name = name.value;
        identity.querySelector("h3").textContent = name.value || "Untitled terminal";
      });
      const type = this._select(inventoryTypes, inferTerminalType(profile));
      type.addEventListener("change", () => {
        profile.terminal_type = type.value;
        // Prefer the live inventory (real resolved paths, includes git-bash,
        // nushell, ssh/sftp); the static list is only the pre-load fallback.
        const known = (this.terminalInventory.types || []).find((item) => item.id === type.value)
          || TERMINAL_TYPES.find((item) => item.id === type.value);
        // Clear an executable from the previous type even when the newly
        // selected integration is not installed. Otherwise PowerShell could
        // accidentally be launched with Claude's `--continue` arguments.
        profile.cmd = known?.executable || "";
        if (type.value === "powershell-core" || type.value === "windows-powershell") profile.args = ["-NoLogo"];
        else profile.args = [];
        if (type.value === "claude-code" && !profile.claude_mode) profile.claude_mode = "continue";
        rerender();
      });
      fields.append(this._field("Profile name", name), this._field("Terminal type", type));

      if (inferTerminalType(profile) === "wsl") {
        const distroOptions = [{ value: "", label: distros.length ? "Default WSL distribution" : "No distributions detected" }, ...distros.map((distro) => ({ value: distro, label: distro }))];
        const distro = this._select(distroOptions, profile.wsl_distro || "");
        distro.addEventListener("change", () => { profile.wsl_distro = distro.value || null; });
        fields.append(this._field("Linux distribution", distro, distros.length ? "Detected from WSL on this computer." : "Install a distribution with wsl --install."));
      }
      if (inferTerminalType(profile) === "custom") {
        const command = this._textInput(profile.cmd, "executable.exe");
        command.addEventListener("input", () => { profile.cmd = command.value; });
        const args = this._textInput((profile.args || []).join(" "), "--optional arguments");
        args.addEventListener("input", () => { profile.args = args.value.trim() ? args.value.trim().split(/\s+/) : []; });
        fields.append(this._field("Executable", command), this._field("Arguments", args, "Arguments containing spaces can be edited precisely in Advanced."));
      }
      const kind = inferTerminalType(profile);
      const remote = kind === "ssh" || kind === "sftp";
      if (remote) {
        const hostInput = this._textInput(profile.ssh_host, "server.example.com");
        hostInput.addEventListener("input", () => {
          profile.ssh_host = hostInput.value || null;
          identity.querySelector("p").textContent = this._terminalLabel(profile);
        });
        const portInput = this._textInput(profile.ssh_port ? String(profile.ssh_port) : "", "22");
        portInput.addEventListener("input", () => {
          const parsed = Number.parseInt(portInput.value, 10);
          profile.ssh_port = Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : null;
        });
        const userInput = this._textInput(profile.ssh_user, "Optional, e.g. deploy");
        userInput.addEventListener("input", () => {
          profile.ssh_user = userInput.value || null;
          identity.querySelector("p").textContent = this._terminalLabel(profile);
        });
        const keyInput = this._textInput(profile.ssh_key, "Optional, C:\\Users\\you\\key.ppk");
        keyInput.addEventListener("input", () => { profile.ssh_key = keyInput.value || null; });
        fields.append(
          this._field("Host", hostInput),
          this._field("Port", portInput, "Leave empty for 22."),
          this._field("Username", userInput),
          this._field("Private key", keyInput, "PuTTY .ppk file. Passphrases are never stored; you are asked in the terminal."),
        );
      } else {
        // The workspace owns the folder outright. A profile has no folder of
        // any kind, so one "Claude Code" or "PowerShell" profile is usable in
        // every project and nothing can point somewhere invisible.
        fields.append(this._note(
          kind === "claude-code"
            ? "Claude opens in the folder of the workspace you launch it from. Set that folder in the Dashboard."
            : "This terminal opens in the folder of the workspace you launch it from. Set that folder in the Dashboard.",
        ));
      }
      if (kind === "claude-code") {
        const launchMode = this._select([
          { value: "continue", label: "Continue latest in this project" },
          { value: "resume", label: "Choose from Claude sessions" },
          { value: "agents", label: "Open Claude background-agent manager" },
          { value: "new", label: "Always start a new conversation" },
        ], profile.claude_mode || "continue");
        launchMode.addEventListener("change", () => { profile.claude_mode = launchMode.value; });
        fields.append(this._field(
          "Claude launch",
          launchMode,
          "Uses Claude's native continue, session picker, or background-agent view in the project folder.",
        ));
      } else if (kind !== "custom" && kind !== "sftp") {
        const start = this._textInput(profile.start_command, kind === "ssh" ? "Optional, runs on the remote host" : "Optional, e.g. uv run dev");
        start.addEventListener("input", () => { profile.start_command = start.value || null; });
        fields.append(this._field(
          kind === "ssh" ? "Remote command" : "Start command",
          start,
          kind === "ssh" ? "Runs instead of a remote shell; the session ends when it finishes." : "Runs inside the shell and keeps it open.",
        ));
      }
      const shortcut = this._textInput(profile.keybinding, "Optional, e.g. ctrl+alt+1");
      shortcut.addEventListener("input", () => { profile.keybinding = shortcut.value || null; });
      fields.append(this._field("Global shortcut", shortcut, "Applied after restarting QuickTerm."));
      card.append(fields);

      const envArea = make("textarea", "ui-input env-input");
      envArea.value = envToLines(profile.env);
      envArea.placeholder = "API_TOKEN=...\nNODE_ENV=development";
      envArea.spellcheck = false;
      envArea.rows = 3;
      envArea.addEventListener("keydown", (event) => event.stopPropagation());
      envArea.addEventListener("input", () => { profile.env = parseEnvLines(envArea.value); });
      card.append(this._field(
        "Environment variables",
        envArea,
        "One KEY=value per line, inherited by every process in this terminal. Values are encrypted on disk with your Windows account.",
      ));

      const toggle = make("label", "toggle-row");
      const checkbox = make("input");
      checkbox.type = "checkbox";
      checkbox.checked = Boolean(profile.autostart);
      checkbox.addEventListener("change", () => { profile.autostart = checkbox.checked; });
      toggle.append(checkbox, make("span", "toggle-control"), make("span", "toggle-copy", "Open automatically with a restored workspace"));
      card.append(toggle);

      host.append(card);
    }
  }
