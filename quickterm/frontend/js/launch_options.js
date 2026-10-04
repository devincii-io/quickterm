// What a profile pane was started with beyond its profile and folder: the
// agent mode ("Claude new conversation: X"), the agent session it resumed or
// forked, a recovery start command, or an argument list. A profile alone
// restarts in the profile's default mode, so a pane started as a new
// conversation came back as "continue"; these travel in the saved pane node as
// `launch_options` so a restart and a workspace restore repeat the launch
// exactly. Pure, tested under node.

import { isAgentMode, isAgentSessionId, isAgentType } from "./agent_profile.js";

// launch.START_COMMAND_MAX_CHARS; a longer one would only 400 on restore.
const START_COMMAND_MAX = 8192;
const ARGS_MAX = 256;
// The backend accepts a session id only for these modes; null means resume.
const SESSION_MODES = new Set([undefined, "resume", "fork"]);

function cleanArgs(value) {
  if (!Array.isArray(value) || value.length > ARGS_MAX) return undefined;
  return value.every((item) => typeof item === "string") ? [...value] : undefined;
}

// The spawn options object as spawnInto takes it, reduced to what is worth
// repeating. Null when nothing is. `claudeMode` is the pre-4.0 name of
// `agentMode` and is still read.
export function launchOptions(options) {
  if (!options || typeof options !== "object") return null;
  const out = {};
  const mode = options.agentMode ?? options.claudeMode;
  if (isAgentMode(mode)) out.agentMode = mode;
  if (isAgentSessionId(options.agentSession)) out.agentSession = options.agentSession;
  if (typeof options.startCommand === "string" && options.startCommand.length <= START_COMMAND_MAX) {
    out.startCommand = options.startCommand;
  }
  const args = cleanArgs(options.args);
  if (args) out.args = args;
  return Object.keys(out).length ? out : null;
}

export function launchOptionsToNode(options) {
  const clean = launchOptions(options);
  if (!clean) return null;
  const out = {};
  if (clean.agentMode) out.agent_mode = clean.agentMode;
  if (clean.agentSession) out.agent_session = clean.agentSession;
  if (clean.startCommand !== undefined) out.start_command = clean.startCommand;
  if (clean.args) out.args = clean.args;
  return out;
}

// A saved node is a file on disk anyone can edit, and layouts written before
// this field existed have none: both read as "no options", never as an error.
// Layouts saved before 4.0 name the mode `claude_mode`.
export function launchOptionsFromNode(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return launchOptions({
    agentMode: value.agent_mode ?? value.claude_mode,
    agentSession: value.agent_session,
    startCommand: value.start_command,
    args: value.args,
  });
}

// The agent fields only while the profile is still an agent of a type that
// accepts that mode: the backend refuses agent_mode for anything else, and
// refuses a session id outside resume and fork.
function forType(options, terminalType) {
  const out = { ...options };
  if (out.claudeMode !== undefined) {
    if (out.agentMode === undefined) out.agentMode = out.claudeMode;
    delete out.claudeMode;
  }
  if (!isAgentType(terminalType)) {
    delete out.agentMode;
    delete out.agentSession;
    return out;
  }
  if (out.agentMode !== undefined && !isAgentMode(out.agentMode, terminalType)) {
    // The session belonged to the mode this type lacks (a Codex fork).
    delete out.agentMode;
    delete out.agentSession;
  }
  if (!SESSION_MODES.has(out.agentMode)) delete out.agentSession;
  return out;
}

// What a respawn of this pane sends. Options the caller passed win; with none,
// a pane repeats its own launch, but only for the profile it was started with.
export function repeatLaunchOptions(pane, profileName, explicit, terminalType) {
  if (explicit !== undefined) return forType(explicit || {}, terminalType);
  if (!pane || pane.profileName !== profileName || !pane.launchOptions) return {};
  return forType(pane.launchOptions, terminalType);
}
