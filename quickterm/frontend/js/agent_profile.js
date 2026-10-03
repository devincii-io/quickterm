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

const MODE_LABELS = {
  new: "new conversation",
  continue: "continue latest",
  resume: "choose session",
  fork: "fork a session",
  agents: "agent manager",
};

const AGENT_LABELS = { "claude-code": "Claude", codex: "Codex" };

// What the recovery and continue actions run, shown as their title so the
// user can tell which CLI flag QuickTerm is about to use.
const CONTINUE_COMMANDS = { "claude-code": "claude --continue", codex: "codex resume --last" };
const PICKER_COMMANDS = { "claude-code": "claude --resume", codex: "codex resume" };

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
// Null for a profile that is not an agent.
export function agentModeOf(profile) {
  const type = agentTypeOf(profile);
  if (!type) return null;
  return profile.agent_mode ?? profile.claude_mode ?? defaultAgentMode(type);
}

export function modeLabel(mode) {
  return MODE_LABELS[mode] || String(mode || "");
}

export function agentLabel(type) {
  return AGENT_LABELS[type] || "Agent";
}

export function continueCommand(type) {
  return CONTINUE_COMMANDS[type] || CONTINUE_COMMANDS["claude-code"];
}

export function pickerCommand(type) {
  return PICKER_COMMANDS[type] || PICKER_COMMANDS["claude-code"];
}

export function isAgentSessionId(value) {
  return typeof value === "string" && SESSION_ID.test(value);
}
