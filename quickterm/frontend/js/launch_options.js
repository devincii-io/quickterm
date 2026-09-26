// What a profile pane was started with beyond its profile and folder: the
// Claude mode ("claude new conversation: X"), a recovery start command, or an
// argument list. A profile alone restarts in the profile's default mode, so a
// pane started as a new conversation came back as "continue"; these three
// travel in the saved pane node as `launch_options` so a restart and a
// workspace restore repeat the launch exactly. Pure, tested under node.

const CLAUDE_MODES = new Set(["new", "continue", "resume", "agents"]);
// launch.START_COMMAND_MAX_CHARS; a longer one would only 400 on restore.
const START_COMMAND_MAX = 8192;
const ARGS_MAX = 256;

function cleanArgs(value) {
  if (!Array.isArray(value) || value.length > ARGS_MAX) return undefined;
  return value.every((item) => typeof item === "string") ? [...value] : undefined;
}

// The spawn options object as spawnInto takes it, reduced to what is worth
// repeating. Null when nothing is.
export function launchOptions(options) {
  if (!options || typeof options !== "object") return null;
  const out = {};
  if (CLAUDE_MODES.has(options.claudeMode)) out.claudeMode = options.claudeMode;
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
  if (clean.claudeMode) out.claude_mode = clean.claudeMode;
  if (clean.startCommand !== undefined) out.start_command = clean.startCommand;
  if (clean.args) out.args = clean.args;
  return out;
}

// A saved node is a file on disk anyone can edit, and layouts written before
// this field existed have none: both read as "no options", never as an error.
export function launchOptionsFromNode(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return launchOptions({
    claudeMode: value.claude_mode,
    startCommand: value.start_command,
    args: value.args,
  });
}

// What a respawn of this pane sends. Options the caller passed win; with none,
// a pane repeats its own launch, but only for the profile it was started
// with, and a Claude mode only while that profile is still a Claude profile
// (the backend refuses claude_mode for anything else).
export function repeatLaunchOptions(pane, profileName, explicit, terminalType) {
  if (explicit !== undefined) return explicit || {};
  if (!pane || pane.profileName !== profileName || !pane.launchOptions) return {};
  const out = { ...pane.launchOptions };
  if (terminalType !== "claude-code") delete out.claudeMode;
  return out;
}
