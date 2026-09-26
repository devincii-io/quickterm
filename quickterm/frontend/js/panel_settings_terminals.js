import { icon } from "./icons.js";
import {
  TERMINAL_TYPES, envToLines, environmentError, inferTerminalType, make,
  parseEnvLines, shortPath,
} from "./panel_shared.js";
import {
  FILTER_THRESHOLD, configChoice, configDescription, configEmpty, configFilter,
  configGroupHeading, configNoMatch, configProblems, configSummary, matchesQuery,
} from "./panel_settings_kit.js";

// A profile is a name and a command, optionally a start command. That is all
// a card shows; everything else a profile can carry sits behind one "More"
// per card. The user found eight to twelve controls per card, each with a
// line of prose under it, too much to read for what is usually "PowerShell,
// then uv run dev".

// What each kind of profile is. It used to open every card as a paragraph;
// now it is the tooltip on the type chooser, one hover away.
const KIND_PURPOSE = {
  "claude-code": "Claude Code, started in the folder of the workspace you launch it from. The launch mode decides whether it picks up your last conversation there or starts a fresh one.",
  wsl: "A Linux shell inside WSL. It starts in your Linux home directory; the workspace folder is reachable through /mnt.",
  ssh: "A remote shell over the bundled PuTTY plink. Only what you type here is stored; the passphrase for a key is asked in the terminal, never saved.",
  sftp: "A remote file transfer session over the bundled PuTTY psftp. It is an interactive sftp prompt, not a shell, so it takes no start command.",
  custom: "Any executable on this computer, run as a terminal. You own the executable and its arguments outright; nothing is added for you.",
};
const DEFAULT_PURPOSE = "A shell on this computer with your own start command, environment and shortcut. The workspace supplies the folder, so the same profile works in every project.";

export function purposeFor(kind) {
  return KIND_PURPOSE[kind] || DEFAULT_PURPOSE;
}

// Kinds the inventory offers on one platform only. A profile typed on the
// other one still needs a name for its kind.
const KIND_LABELS = { "git-bash": "Git Bash", nushell: "Nushell", bash: "Bash", zsh: "Zsh", fish: "Fish" };

function typeLabel(types, kind) {
  const found = types.find((item) => item.id === kind) || TERMINAL_TYPES.find((item) => item.id === kind);
  return found ? found.label : (KIND_LABELS[kind] || kind);
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
  const start = takesStartCommand(kind) ? (profile.start_command || "").trim() : "";
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

// Local shells a typed command can turn a profile into. Claude Code stays
// opt-in (see inferTerminalType), and SSH and SFTP are a host rather than a
// command, so typing never switches a card to either of those.
const SHELL_KINDS = new Set([
  "powershell-core", "windows-powershell", "command-prompt", "wsl",
  "bash", "zsh", "fish", "git-bash", "nushell",
]);

/**
 * The kind a card has once its command reads `cmd` and `args`, given the kind
 * it had when it was drawn. It is worked out from that starting kind every
 * time, never from the previous keystroke: "pwsh.exe" edited into
 * "C:\...\pwsh.exe" passes through "C" on the way, and a card that remembered
 * the detour would come back without its arguments.
 */
export function kindForCommand(origin, cmd, args = []) {
  const inferred = inferTerminalType({ cmd, args });
  const shell = SHELL_KINDS.has(inferred);
  if (SHELL_KINDS.has(origin)) return shell ? inferred : "custom";
  return shell ? inferred : origin;
}

/** The arguments a kind starts with, as choosing it from the type menu sets them. */
export function defaultArgsFor(kind) {
  return kind === "powershell-core" || kind === "windows-powershell" ? ["-NoLogo"] : [];
}

/** Whether launch.resolve_profile runs a start command for this kind. */
export function takesStartCommand(kind) {
  return kind !== "custom" && kind !== "sftp" && kind !== "claude-code";
}

// A custom profile's command field is its whole command line. Double quotes
// group, exactly as on a Windows command line, and nothing else is special:
// a backslash is a path separator there, not an escape.
export function splitCommandLine(text) {
  const parts = [];
  let current = "";
  let started = false;
  let quoted = false;
  for (const ch of String(text || "")) {
    if (ch === "\"") {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(ch)) {
      if (started) parts.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) parts.push(current);
  return parts;
}

export function joinCommandLine(parts) {
  return parts.map((part) => (part === "" || /\s/.test(part) ? `"${part}"` : part)).join(" ");
}

// A double quote inside one part has no spelling in that syntax. Such a
// profile keeps its executable and its arguments in separate fields instead,
// and the arguments are left for the Advanced tab.
export function fitsCommandLine(parts) {
  return parts.every((part) => !String(part).includes("\""));
}

export function commandLineText(profile) {
  const args = profile.args || [];
  if (!profile.cmd && !args.length) return "";
  return joinCommandLine([profile.cmd || "", ...args]);
}

/**
 * Whether a card's "More" starts open. It does when the card has a problem to
 * show, and when its type is not the one its command implies, since nothing in
 * the main row would reveal that: a custom profile running pwsh.exe, or a
 * PowerShell profile pointed at python.exe. Claude Code, SSH and SFTP say what
 * they are in the run line and the main row.
 */
export function moreStartsOpen(profile, kind, problems = []) {
  if (problems.length) return true;
  if (kind === "claude-code" || kind === "ssh" || kind === "sftp") return false;
  return inferTerminalType({ cmd: profile.cmd, args: profile.args }) !== kind;
}

let moreIds = 0;

export function renderTerminalSettings(host, rerender) {
    const cfg = this.settingsDraft;
    cfg.profiles ||= [];
    this.settingsFilters ||= { terminals: "", snippets: "" };
    // Which cards have "More" open, by profile object, so a rerender (a type
    // chosen, a profile added or removed) leaves every one as it was.
    this.profileMoreOpen ||= new WeakMap();
    const heading = this._sectionHeading(
      "Terminal profiles",
      "A name and a command. The workspace supplies the folder.",
    );
    const addProfile = () => {
      let n = 1;
      const names = new Set(cfg.profiles.map((profile) => profile.name));
      while (names.has(`Terminal ${n}`)) n += 1;
      const available = (this.terminalInventory.types || []).find((type) =>
        type.executable && type.available !== false && type.id !== "claude-code");
      const base = available || { id: "custom", executable: "" };
      const args = defaultArgsFor(base.id);
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
        lead: "No profiles yet.",
        body: "Every installed shell is already in the launcher. A profile gives a command a name, like PowerShell that starts your dev server.",
        action: emptyAdd,
      }));
      return;
    }

    const inventoryTypeList = this.terminalInventory.types || TERMINAL_TYPES;
    const typeOptions = (kind) => {
      const options = inventoryTypeList.map((type) => ({
        value: type.id,
        label: type.label,
        detail: type.available === false ? "not found on this computer" : undefined,
      }));
      if (!options.some((option) => option.value === kind)) {
        options.push({ value: kind, label: typeLabel(inventoryTypeList, kind) });
      }
      return options;
    };
    const distros = this.terminalInventory.wsl_distributions || [];

    const buildCard = (profile) => {
      let kind = inferTerminalType(profile);
      const remote = kind === "ssh" || kind === "sftp";
      // What a typed command is measured against (kindForCommand). The
      // arguments follow an explicit edit of the Arguments field.
      const origin = { kind, args: [...(profile.args || [])] };
      // A custom card types its whole command line; every other kind types
      // its executable and keeps its arguments under More. Fixed for the life
      // of the card, so a kind inferred mid-word never changes what the field
      // under the caret means.
      const lineMode = kind === "custom" && fitsCommandLine([profile.cmd || "", ...(profile.args || [])]);
      const el = make("article", "terminal-profile-card");
      el.dataset.kind = kind;

      // ---- the main row: name, command (or host), start command, remove ----
      const main = make("div", "profile-main");
      const name = this._textInput(profile.name, "My terminal");
      name.title = "Shown in the launcher, the palette and every split menu.";
      main.append(this._field("Profile name", name));

      let command = null;
      if (remote) {
        const hostInput = this._textInput(profile.ssh_host, "server.example.com");
        hostInput.addEventListener("input", () => {
          profile.ssh_host = hostInput.value || null;
          refresh();
        });
        main.append(this._field("Host", hostInput));
      } else {
        command = this._textInput(
          lineMode ? commandLineText(profile) : profile.cmd,
          lineMode ? "\"C:\\path with spaces\\tool.exe\" --flag" : "pwsh.exe",
        );
        command.classList.add("mono-input");
        command.title = lineMode
          ? "The program and its arguments. Quote a part that contains spaces."
          : "The program this terminal runs, by name or full path.";
        main.append(this._field("Command", command));
      }

      const start = this._textInput(
        profile.start_command,
        kind === "ssh" ? "Optional, runs on the remote host" : "Optional, e.g. uv run dev",
      );
      start.classList.add("mono-input");
      start.title = kind === "ssh"
        ? "Runs instead of a remote shell; the session ends when it finishes."
        : "Runs inside the shell and keeps it open.";
      start.addEventListener("input", () => {
        profile.start_command = start.value || null;
        refresh();
      });
      const startField = this._field(kind === "ssh" ? "Remote command" : "Start command", start);
      main.append(startField);

      const remove = this._button("", "icon-button danger-text profile-remove");
      remove.append(icon("trash", 13));
      remove.title = "Remove this profile";
      remove.setAttribute("aria-label", "Remove this profile");
      remove.addEventListener("click", () => {
        // Splice by identity: the visible list is grouped and filtered, so its
        // position is not the position in the draft.
        const at = cfg.profiles.indexOf(profile);
        if (at >= 0) cfg.profiles.splice(at, 1);
        if (cfg.default_profile === profile.name) cfg.default_profile = cfg.profiles[0]?.name || "";
        rerender();
      });
      main.append(remove);
      el.append(main);

      const problemSlot = make("div", "config-problem-slot");
      el.append(problemSlot);

      // ---- the one line: More, what it is for, what it runs ----
      const foot = make("div", "profile-foot");
      const toggle = make("button", "profile-more-toggle");
      toggle.type = "button";
      toggle.append(icon("chevron-right", 12), make("span", "", "More"));
      let description = configDescription(profile.description, "");
      const summary = configSummary(runLine(profile, kind));
      foot.append(toggle, description, summary);
      el.append(foot);

      const more = make("div", "profile-more");
      more.id = `profile-more-${++moreIds}`;
      toggle.setAttribute("aria-controls", more.id);
      const setOpen = (open) => {
        more.hidden = !open;
        toggle.setAttribute("aria-expanded", String(open));
        el.classList.toggle("more-open", open);
      };
      toggle.addEventListener("click", () => {
        const open = more.hidden;
        this.profileMoreOpen.set(profile, open);
        setOpen(open);
      });

      const refresh = () => {
        summary.textContent = runLine(profile, kind);
        summary.title = summary.textContent;
        problemSlot.textContent = "";
        const box = configProblems(profileProblems(profile, cfg.profiles, kind));
        if (box) problemSlot.append(box);
      };

      // ---- More ----
      const fields = make("div", "settings-grid two-column");
      const typeChoice = configChoice({
        options: typeOptions(kind),
        value: kind,
        label: "Terminal type",
        title: purposeFor(kind),
        onChange: (value) => {
          if (value === kind) return;
          profile.terminal_type = value;
          // Prefer the live inventory (real resolved paths, includes git-bash,
          // nushell, ssh/sftp); the static list is only the pre-load fallback.
          const known = (this.terminalInventory.types || []).find((item) => item.id === value)
            || TERMINAL_TYPES.find((item) => item.id === value);
          // Clear an executable from the previous type even when the newly
          // selected integration is not installed. Otherwise PowerShell could
          // accidentally be launched with Claude's `--continue` arguments.
          profile.cmd = known?.executable || "";
          profile.args = defaultArgsFor(value);
          if (value === "claude-code" && !profile.claude_mode) profile.claude_mode = "continue";
          // The card is redrawn for its new kind with More still open and the
          // chooser keeping the keyboard, where the choice was made.
          this.profileMoreOpen.set(profile, true);
          this._focusProfileType = profile;
          rerender();
        },
      });
      fields.append(this._field("Terminal type", typeChoice.el));

      const describe = this._textInput(profile.description, "What this terminal is for");
      describe.addEventListener("input", () => {
        profile.description = describe.value;
        const fresh = configDescription(describe.value, "");
        description.replaceWith(fresh);
        description = fresh;
      });
      fields.append(this._field("Description", describe));

      let argsInput = null;
      let argsField = null;
      if (!remote && !lineMode) {
        const parts = profile.args || [];
        argsInput = this._textInput(joinCommandLine(parts), "Optional arguments");
        argsInput.classList.add("mono-input");
        if (fitsCommandLine(parts)) {
          argsInput.title = "Arguments after the program. Quote one that contains spaces.";
          argsInput.addEventListener("input", () => {
            profile.args = splitCommandLine(argsInput.value);
            origin.args = [...profile.args];
            refresh();
          });
        } else {
          // Rewriting it here would lose the quote; the JSON keeps it exact.
          argsInput.disabled = true;
          argsInput.title = "An argument contains a double quote. Edit it in the Advanced tab.";
        }
        argsField = this._field("Arguments", argsInput);
        fields.append(argsField);
      }

      let distroField = null;
      let claudeField = null;
      if (remote) {
        const portInput = this._textInput(profile.ssh_port ? String(profile.ssh_port) : "", "22");
        portInput.addEventListener("input", () => {
          const parsed = Number.parseInt(portInput.value, 10);
          profile.ssh_port = Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : null;
          refresh();
        });
        const userInput = this._textInput(profile.ssh_user, "Optional, e.g. deploy");
        userInput.addEventListener("input", () => {
          profile.ssh_user = userInput.value || null;
          refresh();
        });
        const keyInput = this._textInput(profile.ssh_key, "Optional, C:\\Users\\you\\key.ppk");
        keyInput.title = "PuTTY .ppk file. Passphrases are never stored; you are asked in the terminal.";
        keyInput.addEventListener("input", () => {
          profile.ssh_key = keyInput.value || null;
          refresh();
        });
        fields.append(
          this._field("Port", portInput),
          this._field("Username", userInput),
          this._field("Private key", keyInput),
        );
      } else {
        // Built for every local card and shown per kind, because typing a
        // command can turn a custom card into WSL without a redraw.
        const distroChoice = configChoice({
          options: [
            { value: "", label: distros.length ? "Default distribution" : "No distributions detected" },
            ...distros.map((distro) => ({ value: distro, label: distro })),
          ],
          value: profile.wsl_distro || "",
          label: "Linux distribution",
          title: distros.length ? "Detected from WSL on this computer." : "Install a distribution with wsl --install.",
          onChange: (value) => {
            profile.wsl_distro = value || null;
            refresh();
          },
        });
        distroField = this._field("Linux distribution", distroChoice.el);
        const launchMode = configChoice({
          options: [
            { value: "continue", label: "Continue latest in this project" },
            { value: "resume", label: "Choose from Claude sessions" },
            { value: "agents", label: "Open Claude background-agent manager" },
            { value: "new", label: "Always start a new conversation" },
          ],
          value: profile.claude_mode || "continue",
          label: "Claude launch",
          title: "Uses Claude's native continue, session picker, or background-agent view in the project folder.",
          onChange: (value) => {
            profile.claude_mode = value;
            refresh();
          },
        });
        claudeField = this._field("Claude launch", launchMode.el);
        fields.append(distroField, claudeField);
      }

      const shortcut = this._textInput(profile.keybinding, "Optional, e.g. ctrl+alt+1");
      shortcut.title = "Opens this profile from anywhere. Applied after restarting QuickTerm.";
      shortcut.addEventListener("input", () => { profile.keybinding = shortcut.value || null; });
      fields.append(this._field("Global shortcut", shortcut));
      more.append(fields);

      const envArea = make("textarea", "ui-input env-input");
      envArea.value = envToLines(profile.env);
      envArea.placeholder = "API_TOKEN=...\nNODE_ENV=development";
      envArea.title = "One KEY=value per line. Values are encrypted on disk with your Windows account.";
      envArea.spellcheck = false;
      envArea.rows = 3;
      envArea.addEventListener("keydown", (event) => event.stopPropagation());
      envArea.addEventListener("input", () => {
        profile.env = parseEnvLines(envArea.value);
        refresh();
      });
      more.append(this._field("Environment variables", envArea));

      const autostart = make("label", "toggle-row");
      const checkbox = make("input", "sr-only");
      checkbox.type = "checkbox";
      checkbox.checked = Boolean(profile.autostart);
      checkbox.addEventListener("change", () => { profile.autostart = checkbox.checked; });
      autostart.append(checkbox, make("span", "toggle-control"), make("span", "toggle-copy", "Open automatically with a restored workspace"));
      more.append(autostart);
      el.append(more);

      // The parts of the card that depend on its kind, set in place. A redraw
      // here would replace the field the user is typing into.
      const syncKind = () => {
        el.dataset.kind = kind;
        startField.hidden = !takesStartCommand(kind);
        // launch.py builds these argument lists itself; a field it ignores
        // would only be a place to type something that never runs.
        if (argsField) argsField.hidden = kind === "wsl" || kind === "bash" || kind === "zsh" || kind === "fish";
        if (distroField) distroField.hidden = kind !== "wsl";
        if (claudeField) claudeField.hidden = kind !== "claude-code";
        typeChoice.set(kind);
        typeChoice.el.title = purposeFor(kind);
      };

      if (command) {
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
            // Back on the kind the card started with, its own arguments
            // return; a different kind starts from that kind's defaults.
            profile.args = next === origin.kind ? [...origin.args] : defaultArgsFor(next);
            if (argsInput && !argsInput.disabled) argsInput.value = joinCommandLine(profile.args);
          }
          if (next !== kind) {
            kind = next;
            profile.terminal_type = next;
            syncKind();
          }
          refresh();
        });
      }
      name.addEventListener("input", () => {
        if (cfg.default_profile === profile.name) cfg.default_profile = name.value;
        profile.name = name.value;
        refresh();
      });

      syncKind();
      refresh();
      const remembered = this.profileMoreOpen.get(profile);
      setOpen(remembered ?? moreStartsOpen(profile, kind, profileProblems(profile, cfg.profiles, kind)));
      if (this._focusProfileType === profile) {
        this._focusProfileType = null;
        requestAnimationFrame(() => typeChoice.el.focus());
      }
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
