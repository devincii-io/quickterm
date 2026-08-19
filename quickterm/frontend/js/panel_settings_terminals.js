import { icon } from "./icons.js";
import {
  TERMINAL_TYPES, envToLines, environmentError, inferTerminalType, make,
  parseEnvLines, shortPath,
} from "./panel_shared.js";
import {
  FILTER_THRESHOLD, configDescription, configEmpty, configFilter,
  configGroupHeading, configNoMatch, configProblems, configPurpose,
  configSummary, matchesQuery,
} from "./panel_settings_kit.js";

// What each kind of profile is, stated once, at the top of its editor. A
// profile is not a form to fill in: it is a decision about how a terminal
// starts, and the fields below only make sense once that is said.
const KIND_PURPOSE = {
  "claude-code": "Claude Code, started in the folder of the workspace you launch it from. The launch mode below decides whether it picks up your last conversation there or starts a fresh one.",
  wsl: "A Linux shell inside WSL. It starts in your Linux home directory; the workspace folder is reachable through /mnt.",
  ssh: "A remote shell over the bundled PuTTY plink. Only what you type here is stored; the passphrase for a key is asked in the terminal, never saved.",
  sftp: "A remote file transfer session over the bundled PuTTY psftp. It is an interactive sftp prompt, not a shell, so it takes no start command.",
  custom: "Any executable on this computer, run as a terminal. You own the executable and its arguments outright; nothing is added for you.",
};
const DEFAULT_PURPOSE = "A shell on this computer with your own start command, environment and shortcut. The workspace supplies the folder, so the same profile works in every project.";

export function purposeFor(kind) {
  return KIND_PURPOSE[kind] || DEFAULT_PURPOSE;
}

function typeLabel(types, kind) {
  const found = types.find((item) => item.id === kind) || TERMINAL_TYPES.find((item) => item.id === kind);
  return found ? found.label : kind;
}

// The compact "what this actually runs" line every row wears. It is built from
// the profile alone, so it stays true to what was typed rather than promising
// an argv the backend might resolve differently.
export function runLine(profile, kind) {
  const parts = [];
  if (kind === "claude-code") {
    parts.push(profile.cmd || "claude");
    const mode = profile.claude_mode || "continue";
    if (mode === "continue") parts.push("--continue");
    else if (mode === "resume") parts.push("--resume");
    else if (mode === "agents") parts.push("agents");
  } else if (kind === "wsl") {
    parts.push(profile.cmd || "wsl.exe");
    if (profile.wsl_distro) parts.push("-d", profile.wsl_distro);
    parts.push("--cd", "~");
  } else if (kind === "ssh" || kind === "sftp") {
    parts.push(kind === "sftp" ? "psftp" : "plink -ssh");
    if (profile.ssh_port) parts.push("-P", String(profile.ssh_port));
    if (profile.ssh_key) parts.push("-i", shortPath(profile.ssh_key, 28));
    const host = profile.ssh_host || "no host yet";
    parts.push(profile.ssh_user ? `${profile.ssh_user}@${host}` : host);
  } else {
    parts.push(profile.cmd || "no executable yet");
    parts.push(...(profile.args || []));
  }
  const line = parts.join(" ");
  const start = kind === "sftp" || kind === "claude-code" ? "" : (profile.start_command || "").trim();
  return start ? `${line} · then ${start}` : line;
}

// Everything that would stop this one profile from starting, said at the
// profile. The footer check in panels.js `_settings()` still refuses the save;
// this only answers "which of them?".
export function profileProblems(profile, all, kind) {
  const name = (profile.name || "").trim();
  const problems = [];
  if (!name) {
    problems.push("This profile has no name, so nothing can launch it.");
  } else if (all.filter((other) => (other.name || "").trim().toLowerCase() === name.toLowerCase()).length > 1) {
    problems.push("Another profile already has this name. Names must be unique.");
  }
  if (kind === "custom" && !(profile.cmd || "").trim()) {
    problems.push("No executable. A custom terminal has nothing to run without one.");
  }
  if ((kind === "ssh" || kind === "sftp") && !(profile.ssh_host || "").trim()) {
    problems.push("No host. A remote profile needs somewhere to connect to.");
  }
  const badEnvironment = environmentError(profile.env);
  if (badEnvironment) problems.push(badEnvironment);
  return problems;
}

export function renderTerminalSettings(host, rerender) {
    const cfg = this.settingsDraft;
    cfg.profiles ||= [];
    this.settingsFilters ||= { terminals: "", snippets: "" };
    const heading = this._sectionHeading(
      "Terminal profiles",
      "Your own terminals: a shell, what it runs on start, and a line saying what it is for. The workspace supplies the folder, so one profile works in every project. System shells are always in the launcher without any setup.",
    );
    const addProfile = () => {
      let n = 1;
      const names = new Set(cfg.profiles.map((profile) => profile.name));
      while (names.has(`Terminal ${n}`)) n += 1;
      const available = (this.terminalInventory.types || []).find((type) =>
        type.executable && type.available !== false && type.id !== "claude-code");
      const base = available || { id: "custom", executable: "" };
      const args = base.id === "powershell-core" || base.id === "windows-powershell" ? ["-NoLogo"] : [];
      cfg.profiles.push({ name: `Terminal ${n}`, description: "", cmd: base.executable || "", args, env: {}, keybinding: null, autostart: false, terminal_type: base.id, wsl_distro: null, start_command: null, claude_mode: null, ssh_host: null, ssh_port: null, ssh_user: null, ssh_key: null });
      // A new card the active filter would hide reads as a button that did
      // nothing, so adding always clears the filter.
      this.settingsFilters.terminals = "";
      rerender();
      host.lastElementChild?.scrollIntoView({ block: "nearest" });
    };
    const add = this._button("", "primary-button compact");
    add.append(icon("plus", 13), make("span", "", "Add terminal"));
    add.addEventListener("click", addProfile);
    heading.append(add);
    host.append(heading);

    if (!cfg.profiles.length) {
      const emptyAdd = this._button("", "primary-button compact");
      emptyAdd.append(icon("plus", 13), make("span", "", "Add your first profile"));
      emptyAdd.addEventListener("click", addProfile);
      host.append(configEmpty({
        lead: "No personal terminals yet.",
        body: "The launcher already offers every shell installed on this computer, so a profile is for the terminal those cannot give you: "
          + "PowerShell that starts your dev server, Claude Code set to continue the conversation, a server you reach over SSH. "
          + "Add one when a terminal deserves a name.",
        action: emptyAdd,
      }));
      return;
    }

    const inventoryTypeList = this.terminalInventory.types || TERMINAL_TYPES;
    const inventoryTypes = inventoryTypeList.map((type) => ({
      value: type.id,
      label: `${type.label}${type.available === false ? " (not found)" : ""}`,
    }));
    const distros = this.terminalInventory.wsl_distributions || [];

    const buildCard = (profile) => {
      const kind = inferTerminalType(profile);
      const el = make("article", "terminal-profile-card");
      const cardHead = make("div", "terminal-card-head");
      const identity = make("div", "terminal-identity");
      const copy = make("div", "config-identity");
      const title = make("h3", "", profile.name || "Untitled terminal");
      let description = configDescription(profile.description);
      const kindLine = make("p", "config-kind", this._terminalLabel(profile));
      const summary = configSummary(runLine(profile, kind));
      copy.append(title, description, kindLine, summary);
      identity.append(make("span", "profile-mark large", (profile.name || "> ").slice(0, 2).toUpperCase()), copy);
      const remove = this._button("", "text-button danger-text");
      remove.append(icon("trash", 13), make("span", "", "Remove"));
      remove.addEventListener("click", () => {
        // Splice by identity: the visible list is grouped and filtered, so its
        // position is not the position in the draft.
        const at = cfg.profiles.indexOf(profile);
        if (at >= 0) cfg.profiles.splice(at, 1);
        if (cfg.default_profile === profile.name) cfg.default_profile = cfg.profiles[0]?.name || "";
        rerender();
      });
      cardHead.append(identity, remove);
      el.append(cardHead);

      const problemSlot = make("div", "config-problem-slot");
      const showProblems = () => {
        problemSlot.textContent = "";
        const box = configProblems(profileProblems(profile, cfg.profiles, kind));
        if (box) problemSlot.append(box);
      };
      const refreshSummary = () => {
        kindLine.textContent = this._terminalLabel(profile);
        summary.textContent = runLine(profile, kind);
        summary.title = summary.textContent;
        showProblems();
      };
      showProblems();
      el.append(problemSlot);
      el.append(configPurpose(purposeFor(kind)));

      const fields = make("div", "settings-grid two-column");
      const name = this._textInput(profile.name, "My terminal");
      name.addEventListener("input", () => {
        if (cfg.default_profile === profile.name) cfg.default_profile = name.value;
        profile.name = name.value;
        title.textContent = name.value || "Untitled terminal";
        showProblems();
      });
      const describe = this._textInput(profile.description, "What this terminal is for");
      describe.addEventListener("input", () => {
        profile.description = describe.value;
        const fresh = configDescription(describe.value);
        description.replaceWith(fresh);
        description = fresh;
      });
      const type = this._select(inventoryTypes, kind);
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
      fields.append(
        this._field("Profile name", name, "Shown in the launcher, the palette and every split menu."),
        this._field("Description", describe, "One line about when you open this terminal. It is what tells two similar profiles apart."),
        this._field("Terminal type", type, "Changing this resets the executable and arguments to the ones that type needs."),
      );

      if (kind === "wsl") {
        const distroOptions = [{ value: "", label: distros.length ? "Default WSL distribution" : "No distributions detected" }, ...distros.map((distro) => ({ value: distro, label: distro }))];
        const distro = this._select(distroOptions, profile.wsl_distro || "");
        distro.addEventListener("change", () => {
          profile.wsl_distro = distro.value || null;
          refreshSummary();
        });
        fields.append(this._field("Linux distribution", distro, distros.length ? "Detected from WSL on this computer." : "Install a distribution with wsl --install."));
      }
      if (kind === "custom") {
        const command = this._textInput(profile.cmd, "executable.exe");
        command.addEventListener("input", () => {
          profile.cmd = command.value;
          refreshSummary();
        });
        const args = this._textInput((profile.args || []).join(" "), "--optional arguments");
        args.addEventListener("input", () => {
          profile.args = args.value.trim() ? args.value.trim().split(/\s+/) : [];
          refreshSummary();
        });
        fields.append(
          this._field("Executable", command, "A program on this computer, or anything on PATH."),
          this._field("Arguments", args, "Arguments containing spaces can be edited precisely in Advanced."),
        );
      }
      const remote = kind === "ssh" || kind === "sftp";
      if (remote) {
        const hostInput = this._textInput(profile.ssh_host, "server.example.com");
        hostInput.addEventListener("input", () => {
          profile.ssh_host = hostInput.value || null;
          refreshSummary();
        });
        const portInput = this._textInput(profile.ssh_port ? String(profile.ssh_port) : "", "22");
        portInput.addEventListener("input", () => {
          const parsed = Number.parseInt(portInput.value, 10);
          profile.ssh_port = Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : null;
          refreshSummary();
        });
        const userInput = this._textInput(profile.ssh_user, "Optional, e.g. deploy");
        userInput.addEventListener("input", () => {
          profile.ssh_user = userInput.value || null;
          refreshSummary();
        });
        const keyInput = this._textInput(profile.ssh_key, "Optional, C:\\Users\\you\\key.ppk");
        keyInput.addEventListener("input", () => {
          profile.ssh_key = keyInput.value || null;
          refreshSummary();
        });
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
        launchMode.addEventListener("change", () => {
          profile.claude_mode = launchMode.value;
          refreshSummary();
        });
        fields.append(this._field(
          "Claude launch",
          launchMode,
          "Uses Claude's native continue, session picker, or background-agent view in the project folder.",
        ));
      } else if (kind !== "custom" && kind !== "sftp") {
        const start = this._textInput(profile.start_command, kind === "ssh" ? "Optional, runs on the remote host" : "Optional, e.g. uv run dev");
        start.addEventListener("input", () => {
          profile.start_command = start.value || null;
          refreshSummary();
        });
        fields.append(this._field(
          kind === "ssh" ? "Remote command" : "Start command",
          start,
          kind === "ssh" ? "Runs instead of a remote shell; the session ends when it finishes." : "Runs inside the shell and keeps it open.",
        ));
      }
      const shortcut = this._textInput(profile.keybinding, "Optional, e.g. ctrl+alt+1");
      shortcut.addEventListener("input", () => { profile.keybinding = shortcut.value || null; });
      fields.append(this._field("Global shortcut", shortcut, "Applied after restarting QuickTerm."));
      el.append(fields);

      const envArea = make("textarea", "ui-input env-input");
      envArea.value = envToLines(profile.env);
      envArea.placeholder = "API_TOKEN=...\nNODE_ENV=development";
      envArea.spellcheck = false;
      envArea.rows = 3;
      envArea.addEventListener("keydown", (event) => event.stopPropagation());
      envArea.addEventListener("input", () => {
        profile.env = parseEnvLines(envArea.value);
        showProblems();
      });
      el.append(this._field(
        "Environment variables",
        envArea,
        "One KEY=value per line, inherited by every process in this terminal. Values are encrypted on disk with your Windows account.",
      ));

      const toggle = make("label", "toggle-row");
      const checkbox = make("input", "sr-only");
      checkbox.type = "checkbox";
      checkbox.checked = Boolean(profile.autostart);
      checkbox.addEventListener("change", () => { profile.autostart = checkbox.checked; });
      toggle.append(checkbox, make("span", "toggle-control"), make("span", "toggle-copy", "Open automatically with a restored workspace"));
      el.append(toggle);
      return el;
    };

    // The list lives in its own host so typing in the filter repaints only the
    // cards. Rebuilding the input under the caret would drop focus on every
    // keystroke.
    const listHost = make("div", "config-list");
    let filterCount = null;
    const paint = () => {
      const query = this.settingsFilters.terminals;
      listHost.textContent = "";
      const visible = cfg.profiles.filter((profile) => matchesQuery(
        query, profile.name, profile.description, profile.cmd, profile.ssh_host,
        profile.start_command, this._terminalLabel(profile),
      ));
      if (filterCount) {
        filterCount.textContent = visible.length === cfg.profiles.length
          ? `${cfg.profiles.length} profiles`
          : `${visible.length} of ${cfg.profiles.length}`;
      }
      if (!visible.length) {
        listHost.append(configNoMatch(query, "profiles"));
        return;
      }
      // Grouped by terminal type, in the order the inventory offers the types,
      // because that is the order the same list has everywhere else in the app.
      const order = inventoryTypeList.map((type) => type.id);
      const kinds = [...new Set(visible.map((profile) => inferTerminalType(profile)))]
        .sort((a, b) => {
          const ai = order.indexOf(a), bi = order.indexOf(b);
          return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi);
        });
      // One kind is not a grouping, it is just a list with a redundant title.
      const grouped = kinds.length > 1;
      for (const kind of kinds) {
        const inKind = visible.filter((profile) => inferTerminalType(profile) === kind);
        if (grouped) listHost.append(configGroupHeading(typeLabel(inventoryTypeList, kind), inKind.length));
        for (const profile of inKind) listHost.append(buildCard(profile));
      }
    };

    if (cfg.profiles.length >= FILTER_THRESHOLD) {
      const filter = configFilter({
        value: this.settingsFilters.terminals,
        placeholder: "Filter profiles by name, description, type or command",
        onInput: (value) => {
          this.settingsFilters.terminals = value;
          paint();
        },
      });
      filterCount = filter.count;
      host.append(filter.el);
    }
    host.append(listHost);
    paint();
  }
