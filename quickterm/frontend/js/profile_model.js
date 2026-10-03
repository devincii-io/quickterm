// Pure rules about a terminal profile in the Settings draft: what it runs, what
// is wrong with it, and how a typed command line maps onto `cmd` and `args`.
// No DOM, so the rules are testable on their own and must not quietly disagree
// with the backend validation in config.py, agents.py and connections.py.

import { environmentError, inferTerminalType, shortPath } from "./panel_shared.js";

export const AGENT_TYPES = new Set(["claude-code", "codex"]);

export const AGENT_MODE_LABELS = {
  new: "new conversation",
  continue: "continue latest",
  resume: "choose session",
  fork: "fork a session",
  agents: "agent manager",
};

// Used when the agent catalog cannot be loaded: the launch mode still works.
export const AGENT_MODES = {
  "claude-code": ["new", "continue", "resume", "agents"],
  codex: ["new", "continue", "resume", "fork", "agents"],
};

export function isAgentType(kind) {
  return AGENT_TYPES.has(kind);
}

export function agentModeOf(profile, kind = inferTerminalType(profile)) {
  return profile.agent_mode ?? profile.claude_mode ?? (kind === "codex" ? "new" : "continue");
}

const KIND_PURPOSE = {
  "claude-code": "Claude Code, started in the folder of the workspace you launch it from. The launch mode decides whether it picks up your last conversation there or starts a fresh one.",
  codex: "Codex, started in the folder of the workspace you launch it from. The launch mode decides whether it resumes, forks or starts a conversation.",
  wsl: "A Linux shell inside WSL. It starts in your Linux home directory; the workspace folder is reachable through /mnt.",
  ssh: "A remote shell over OpenSSH or the bundled PuTTY plink. Only what you type here is stored; a key passphrase is asked in the terminal, never saved.",
  sftp: "An interactive sftp prompt over OpenSSH or the bundled PuTTY psftp. It is not a shell, so it takes no start command.",
  custom: "Any executable on this computer, run as a terminal. You own the executable and its arguments outright; nothing is added for you.",
};
const DEFAULT_PURPOSE = "A shell on this computer with your own start command, environment and shortcut. The workspace supplies the folder, so the same profile works in every project.";

export function purposeFor(kind) {
  return KIND_PURPOSE[kind] || DEFAULT_PURPOSE;
}

export function usesOpenSsh(profile) {
  return profile.ssh_client === "openssh";
}

function agentRunParts(profile, kind) {
  const mode = agentModeOf(profile, kind);
  if (kind === "codex") {
    const parts = [profile.cmd || "codex"];
    if (mode === "continue") parts.push("resume", "--last");
    else if (mode === "resume" || mode === "fork" || mode === "agents") parts.push(mode);
    return parts;
  }
  const parts = [profile.cmd || "claude"];
  if (mode === "continue") parts.push("--continue");
  else if (mode === "resume") parts.push("--resume");
  else if (mode === "agents") parts.push("agents");
  return parts;
}

function remoteRunParts(profile, kind) {
  const openssh = usesOpenSsh(profile);
  const parts = [openssh ? kind : (kind === "sftp" ? "psftp" : "plink -ssh")];
  if (profile.ssh_port) parts.push(openssh && kind === "ssh" ? "-p" : "-P", String(profile.ssh_port));
  if (profile.ssh_key) parts.push("-i", shortPath(profile.ssh_key, 28));
  if (openssh && profile.ssh_proxy_jump) parts.push("-J", profile.ssh_proxy_jump);
  const host = profile.ssh_host || "no host yet";
  parts.push(profile.ssh_user ? `${profile.ssh_user}@${host}` : host);
  return parts;
}

// The compact "what this actually runs" line every row wears. It is built from
// the profile alone, so it stays true to what was typed rather than promising
// an argv the backend might resolve differently.
export function runLine(profile, kind) {
  let parts;
  if (isAgentType(kind)) parts = agentRunParts(profile, kind);
  else if (kind === "ssh" || kind === "sftp") parts = remoteRunParts(profile, kind);
  else if (kind === "wsl") {
    parts = [profile.cmd || "wsl.exe"];
    if (profile.wsl_distro) parts.push("-d", profile.wsl_distro);
    parts.push("--cd", "~");
  } else {
    parts = [profile.cmd || "no executable yet", ...(profile.args || [])];
  }
  const line = parts.join(" ");
  const start = takesStartCommand(kind) ? (profile.start_command || "").trim() : "";
  return start ? `${line} · then ${start}` : line;
}

// Everything that would stop this one profile from starting, said at the
// profile. The footer Save still refuses the save; this only answers "which?".
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

// Mirrors agents.validate in the backend for the one rule a person can break
// by combining otherwise valid choices.
export function agentConflicts(kind, agent = {}) {
  if (kind !== "codex" || agent.bypass !== "true") return [];
  const clash = Boolean(agent.approval) || Boolean(agent.sandbox) || agent.approve_for_me === "true";
  return clash ? ["bypass replaces approval and sandbox; clear them first"] : [];
}

const PROXY_JUMP = /^[A-Za-z0-9._@:,[\]%-]+$/;
const UNSAFE_ARGUMENT = /[\s\x00-\x1f\x7f]/;

// Mirrors the ssh validation on save (spec 1.4): these values become ssh or
// plink arguments, so a leading dash or whitespace would smuggle in options.
export function sshProblems(profile) {
  const problems = [];
  for (const [value, label] of [[profile.ssh_host, "Host"], [profile.ssh_user, "User"]]) {
    if (!value) continue;
    if (String(value).startsWith("-")) problems.push(`${label} must not start with -.`);
    else if (UNSAFE_ARGUMENT.test(String(value))) problems.push(`${label} must not contain spaces or control characters.`);
  }
  const jump = profile.ssh_proxy_jump;
  if (jump) {
    if (!usesOpenSsh(profile)) problems.push("ProxyJump needs the OpenSSH client");
    else if (jump.startsWith("-") || !PROXY_JUMP.test(jump)) problems.push("ProxyJump must be a host list such as user@bastion:22.");
  }
  if (usesOpenSsh(profile) && /\.ppk$/i.test(profile.ssh_key || "")) {
    problems.push("OpenSSH cannot read PuTTY .ppk keys; choose the PuTTY client or an OpenSSH key");
  }
  return problems;
}

// Local shells a typed command can turn a profile into. The agents stay
// opt-in (see inferTerminalType), and SSH and SFTP are a host rather than a
// command, so typing never switches a profile to any of those.
const SHELL_KINDS = new Set([
  "powershell-core", "windows-powershell", "command-prompt", "wsl",
  "bash", "zsh", "fish", "git-bash", "nushell",
]);

export function isShellKind(kind) {
  return SHELL_KINDS.has(kind);
}

/**
 * The kind a profile has once its command reads `cmd` and `args`, given the
 * kind it had when the editor opened. It is worked out from that starting kind
 * every time, never from the previous keystroke: "pwsh.exe" edited into
 * "C:\...\pwsh.exe" passes through "C" on the way, and an editor that
 * remembered the detour would come back without its arguments.
 */
export function kindForCommand(origin, cmd, args = []) {
  const inferred = inferTerminalType({ cmd, args });
  const shell = SHELL_KINDS.has(inferred);
  if (SHELL_KINDS.has(origin)) return shell ? inferred : "custom";
  return shell ? inferred : origin;
}

/** The arguments a kind starts with. */
export function defaultArgsFor(kind) {
  return kind === "powershell-core" || kind === "windows-powershell" ? ["-NoLogo"] : [];
}

/** Whether launch.resolve_profile runs a start command for this kind. */
export function takesStartCommand(kind) {
  return kind !== "custom" && kind !== "sftp" && !isAgentType(kind);
}

// launch.py builds these argument lists itself; an Arguments field there would
// only be a place to type something that never runs.
export function takesArguments(kind) {
  return !["wsl", "bash", "zsh", "fish"].includes(kind);
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
// profile keeps its executable and its arguments in separate fields instead.
export function fitsCommandLine(parts) {
  return parts.every((part) => !String(part).includes("\""));
}

export function commandLineText(profile) {
  const args = profile.args || [];
  if (!profile.cmd && !args.length) return "";
  return joinCommandLine([profile.cmd || "", ...args]);
}
