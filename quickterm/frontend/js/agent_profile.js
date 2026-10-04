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

export function isAgentSessionId(value) {
  return typeof value === "string" && SESSION_ID.test(value);
}
