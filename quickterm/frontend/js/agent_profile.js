// Agent terminals (Claude Code and Codex): which profile types are agents,
// which launch modes each accepts, and how a mode is named in the UI. Pure,
// tested under node. The backend's mode sets live in quickterm/agents.py and
// must agree with AGENT_MODES.

export const AGENT_TYPES = ["claude-code", "codex"];

export const AGENT_MODES = {
  "claude-code": ["new", "continue", "resume", "agents"],
  codex: ["new", "continue", "resume", "fork", "agents"],
};

// Every mode either type accepts, for places that do not know the type yet
// (a saved pane node is read before its profile is looked up).
export const ALL_AGENT_MODES = [...new Set(Object.values(AGENT_MODES).flat())];

// The one copy of these names: Settings, the sidebar's terminal choices and
// the palette all read them from here.
export const AGENT_MODE_LABELS = Object.freeze({
  new: "new conversation",
  continue: "continue latest",
  resume: "choose session",
  fork: "fork a session",
  agents: "agent manager",
});

const AGENT_LABELS = { "claude-code": "Claude", codex: "Codex" };

const AGENT_CLIS = { "claude-code": "claude", codex: "codex" };

// The arguments a launch mode adds after the CLI, as quickterm/agents.py
// builds them (minus the options and the folder it adds itself).
const MODE_ARGS = {
  "claude-code": { new: [], continue: ["--continue"], resume: ["--resume"], agents: ["agents"] },
  codex: { new: [], continue: ["resume", "--last"], resume: ["resume"], fork: ["fork"], agents: ["agents"] },
};

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAgentType(type) {
  return AGENT_TYPES.includes(type);
}

export function agentTypeOf(profile) {
  return isAgentType(profile?.terminal_type) ? profile.terminal_type : null;
}

export function modesFor(type) {
  return AGENT_MODES[type] || [];
}

export function isAgentMode(mode, type = null) {
  return (type ? modesFor(type) : ALL_AGENT_MODES).includes(mode);
}

export function defaultAgentMode(type) {
  return type === "codex" ? "new" : "continue";
}

// A profile saved before 4.0 carries `claude_mode`; the backend migrates it
// on load, but a config read before that save can still hold only the old key.
// `type` defaults to the profile's own terminal_type; Settings passes the
// type it inferred for a profile that has none yet. Null when it is not an
// agent type.
export function agentModeOf(profile, type = profile?.terminal_type) {
  if (!isAgentType(type)) return null;
  return profile?.agent_mode ?? profile?.claude_mode ?? defaultAgentMode(type);
}

export function modeLabel(mode) {
  return AGENT_MODE_LABELS[mode] || String(mode || "");
}

export function agentLabel(type) {
  return AGENT_LABELS[type] || "Agent";
}

/** What `mode` adds after the CLI for `type` (an empty list for new). */
export function modeArgs(type, mode) {
  return [...(MODE_ARGS[type]?.[mode] || [])];
}

// What the recovery and continue actions run, shown as their title so the
// user can tell which CLI flag QuickTerm is about to use.
function modeCommand(type, mode) {
  const kind = isAgentType(type) ? type : "claude-code";
  return [AGENT_CLIS[kind], ...modeArgs(kind, mode)].join(" ");
}

export function continueCommand(type) {
  return modeCommand(type, "continue");
}

export function pickerCommand(type) {
  return modeCommand(type, "resume");
}

// What Shift+Enter sends in an agent pane: ESC CR, the bytes of Alt+Enter.
// xterm.js 6.0 sends a bare CR for Shift+Enter, so the agent submits. ConPTY
// turns ESC CR into an Alt+Enter key event, which Claude Code reads as
// meta+Enter and Codex binds to insert_newline; a bare LF arrives as
// Ctrl+Enter on Windows, which Codex does not bind.
export const AGENT_NEWLINE = "\x1b\r";

// What the WSL agent wrap prints when the agent exits (quickterm/shells.py,
// AGENT_EXIT_PRINTF): an OSC the pane swallows.
export const AGENT_EXIT_OSC = 7770;
export const AGENT_EXIT_MARK = "quickterm-agent-exit";

// The sequence a key event should send instead of xterm's own, or null.
// Only Shift+Enter in an agent pane: in a shell Shift+Enter keeps meaning
// Enter, and ESC CR there would be a stray Alt+Enter.
export function agentNewlineFor(event, type) {
  if (!isAgentType(type) || !event || event.key !== "Enter" || !event.shiftKey) return null;
  if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return null;
  return AGENT_NEWLINE;
}

// Claude Code and Codex are settings (config `agents`), not profiles. The
// launch code still takes a profile-shaped object, named by its kind, which is
// also what a launch request sends as `profile`.
export const AGENT_NAMES = Object.freeze({ "claude-code": "Claude Code", codex: "Codex" });

export function agentProfile(kind, settings = {}) {
  return {
    name: kind,
    label: AGENT_NAMES[kind],
    builtin: true,
    terminal_type: kind,
    cmd: settings?.cmd || "",
    args: [...(settings?.args || [])],
    agent_mode: settings?.agent_mode ?? null,
    agent: { ...(settings?.agent || {}) },
  };
}

// Found by the inventory, or given an executable of its own in Settings.
export function agentInstalled(inventory, kind, settings = null) {
  if (String(settings?.cmd || "").trim()) return true;
  return (inventory?.types || []).some((type) => type.id === kind && type.executable && type.available !== false);
}

export function agentProfiles(cfg, inventory) {
  return AGENT_TYPES
    .filter((kind) => agentInstalled(inventory, kind, cfg?.agents?.[kind]))
    .map((kind) => agentProfile(kind, cfg?.agents?.[kind]));
}

// What the settings start, as a command line: Settings shows it on the
// agent's row. Display only; the backend builds the real argv. `options` is
// the type's schema from GET /api/system/agents, which names each flag.
export function agentCommandLine(kind, settings = {}, options = []) {
  const mode = settings?.agent_mode ?? defaultAgentMode(kind);
  const quote = (word) => (/[\s"]/.test(word) ? `"${word.replace(/"/g, '\\"')}"` : word);
  const flagOf = new Map((options || []).map((option) => [option.key, option.flag]));
  const words = [String(settings?.cmd || "").trim() || AGENT_CLIS[kind], ...modeArgs(kind, mode)];
  for (const [key, value] of Object.entries(settings?.agent || {})) {
    if (value === "" || value === "false") continue;
    const flag = flagOf.get(key) || `--${key.replace(/_/g, "-")}`;
    if (value === "true") { words.push(flag); continue; }
    for (const line of String(value).split(/\r?\n/).filter((item) => item.trim())) words.push(flag, quote(line.trim()));
  }
  words.push(...(settings?.args || []).map(quote));
  return words.join(" ");
}

export function isAgentSessionId(value) {
  return typeof value === "string" && SESSION_ID.test(value);
}

// Mirrors agents.validate in the backend for the one rule a person can break
// by combining otherwise valid choices.
export function agentConflicts(kind, agent = {}) {
  if (kind !== "codex" || agent.bypass !== "true") return [];
  const clash = Boolean(agent.approval) || Boolean(agent.sandbox) || agent.approve_for_me === "true";
  return clash ? ["bypass replaces approval and sandbox; clear them first"] : [];
}
