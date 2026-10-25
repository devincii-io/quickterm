// A workspace's setup (CONTRACTS 4.5 wave 2): its environment variables and
// the terminals it starts with. Pure, tested under node: the rules the
// workspace settings sheet checks inline, the list edits it makes, the
// request each item turns into, and whether a view that opens runs the list.

import { isAgentMode, isAgentType } from "./agent_profile.js";

export const ENV_MAX = 64;
export const ENV_VALUE_MAX_BYTES = 8 * 1024;
export const STARTUP_MAX = 8;
// The backend's limits (workspace.py COMMAND_MAX_CHARS, STARTUP_NAME_MAX_CHARS).
const COMMAND_MAX = 4096;
const NAME_MAX = 80;
// What cmd.exe would read as more than one plain command (shells.py _CMD_UNSAFE).
const CMD_UNSAFE = /["&|<>^%!]/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const STARTUP_KINDS = Object.freeze([
  Object.freeze({ id: "shell", label: "Shell" }),
  Object.freeze({ id: "claude-code", label: "Claude Code" }),
  Object.freeze({ id: "codex", label: "Codex" }),
]);
const KIND_IDS = STARTUP_KINDS.map((kind) => kind.id);

export function startupKindLabel(kind) {
  return STARTUP_KINDS.find((entry) => entry.id === kind)?.label || "Shell";
}

// ---------- environment ----------

function byteLength(text) {
  return new TextEncoder().encode(String(text)).length;
}

export function envNameProblem(name) {
  const text = String(name ?? "");
  if (!text) return "Give the variable a name.";
  if (!ENV_NAME.test(text)) return "Letters, digits and _ only, not starting with a digit.";
  if (/^QUICKTERM_/i.test(text)) return "Names starting with QUICKTERM_ are QuickTerm's own.";
  if (/^WSLENV$/i.test(text)) return "WSLENV is set by QuickTerm.";
  return null;
}

export function envValueProblem(value) {
  const text = String(value ?? "");
  if (text.includes("\0")) return "A value cannot contain a NUL character.";
  if (byteLength(text) > ENV_VALUE_MAX_BYTES) return "A value can be at most 8 KB.";
  return null;
}

// Editor rows from the stored object. `key` is the row's identity in the
// list, so patching keeps a focused input while rows come and go.
let rowSerial = 0;
export function envRows(env) {
  return Object.entries(env && typeof env === "object" ? env : {})
    .map(([name, value]) => ({ key: `env${++rowSerial}`, name, value: String(value ?? "") }));
}

export function newEnvRow() {
  return { key: `env${++rowSerial}`, name: "", value: "" };
}

// A row left completely empty is a row the user has not filled in yet; it
// is neither saved nor reported.
function blankRow(row) {
  return !String(row?.name ?? "").trim() && !String(row?.value ?? "");
}

// Problems by row key, `{name?, value?}`, plus `list` for the whole set.
// Windows reads names without case, so two that differ only in case clash.
export function envProblems(rows) {
  const byKey = new Map();
  const seen = new Map();
  const filled = (rows || []).filter((row) => !blankRow(row));
  for (const row of filled) {
    const problem = {};
    const name = String(row.name ?? "").trim();
    const nameProblem = envNameProblem(name);
    if (nameProblem) problem.name = nameProblem;
    else if (seen.has(name.toUpperCase())) problem.name = `${name} is set twice.`;
    seen.set(name.toUpperCase(), row.key);
    const valueProblem = envValueProblem(row.value);
    if (valueProblem) problem.value = valueProblem;
    if (problem.name || problem.value) byKey.set(row.key, problem);
  }
  const list = filled.length > ENV_MAX ? `At most ${ENV_MAX} variables.` : null;
  return { byKey, list, ok: byKey.size === 0 && !list };
}

export function envFromRows(rows) {
  const out = {};
  for (const row of rows || []) {
    if (blankRow(row)) continue;
    out[String(row.name).trim()] = String(row.value ?? "");
  }
  return out;
}

// A value is masked until its field has the keyboard.
export function envValueType(focused) {
  return focused ? "text" : "password";
}

// ---------- the start list ----------

let itemSerial = 0;

export function newStartupItem(kind = "shell") {
  return {
    key: `start${++itemSerial}`,
    kind: KIND_IDS.includes(kind) ? kind : "shell",
    name: null, shell: null, command: null, agent_mode: null, agent: null, env: null,
  };
}

// The stored list as editor items; anything unreadable is dropped.
export function startupItems(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object" && KIND_IDS.includes(item.kind))
    .slice(0, STARTUP_MAX)
    .map((item) => ({
      ...newStartupItem(item.kind),
      name: typeof item.name === "string" && item.name ? item.name : null,
      shell: item.kind === "shell" && typeof item.shell === "string" && item.shell ? item.shell : null,
      command: item.kind === "shell" && typeof item.command === "string" && item.command ? item.command : null,
      agent_mode: isAgentType(item.kind) && isAgentMode(item.agent_mode, item.kind) ? item.agent_mode : null,
      agent: isAgentType(item.kind) && item.agent && typeof item.agent === "object" ? { ...item.agent } : null,
      env: item.env && typeof item.env === "object" && Object.keys(item.env).length ? { ...item.env } : null,
    }));
}

export function canAddStartup(items) {
  return (items || []).length < STARTUP_MAX;
}

export function addStartupItem(items, kind = "shell") {
  const list = [...(items || [])];
  if (!canAddStartup(list)) return list;
  list.push(newStartupItem(kind));
  return list;
}

export function removeStartupItem(items, index) {
  const list = [...(items || [])];
  if (index >= 0 && index < list.length) list.splice(index, 1);
  return list;
}

// One step up (-1) or down (+1); held at the ends.
export function moveStartupItem(items, index, delta) {
  const list = [...(items || [])];
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return list;
  [list[index], list[target]] = [list[target], list[index]];
  return list;
}

// Changing the type keeps the name and the variables; a command belongs to a
// shell and the agent options to the agent they were set for.
export function setStartupKind(item, kind) {
  if (!KIND_IDS.includes(kind) || item.kind === kind) return item;
  item.kind = kind;
  item.shell = null;
  item.command = null;
  item.agent_mode = null;
  item.agent = null;
  return item;
}

function cleanOptions(agent) {
  const out = {};
  for (const [key, value] of Object.entries(agent || {})) {
    if (typeof value === "string" && value !== "") out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

// The item as the workspace file stores it (CONTRACTS: every key present).
export function cleanStartupItem(item) {
  const agent = isAgentType(item.kind);
  const name = String(item.name ?? "").trim();
  const command = String(item.command ?? "").trim();
  const env = item.env && Object.keys(item.env).length ? { ...item.env } : null;
  return {
    kind: item.kind,
    name: name || null,
    shell: !agent && item.shell ? item.shell : null,
    command: !agent && command ? command : null,
    agent_mode: agent && isAgentMode(item.agent_mode, item.kind) ? item.agent_mode : null,
    agent: agent ? cleanOptions(item.agent) : null,
    env,
  };
}

// `defaultShell` is the configured shell an item without its own runs in;
// null (a WSL or SSH workspace) skips the cmd rule.
export function startupProblems(items, { defaultShell = null } = {}) {
  const byKey = new Map();
  const list = (items || []).length > STARTUP_MAX ? `At most ${STARTUP_MAX} terminals.` : null;
  for (const item of items || []) {
    const problem = {};
    if (String(item.name ?? "").trim().length > NAME_MAX) problem.name = `A name can be at most ${NAME_MAX} characters.`;
    if (item.kind === "shell" && String(item.command ?? "").length > COMMAND_MAX) problem.command = "The command is too long.";
    if (item.kind === "shell" && /[\r\n\0]/.test(String(item.command ?? ""))) problem.command = "Write the command on one line.";
    else if (item.kind === "shell" && (item.shell || defaultShell) === "cmd" && CMD_UNSAFE.test(String(item.command ?? ""))) {
      problem.command = "Command Prompt would misread \" & | < > ^ % ! here; pick PowerShell for this terminal.";
    }
    if (item.env) {
      const env = envProblems(Object.entries(item.env).map(([name, value]) => ({ key: name, name, value })));
      if (!env.ok) problem.env = env.list || [...env.byKey.values()].map((entry) => entry.name || entry.value)[0];
    }
    if (Object.keys(problem).length) byKey.set(item.key, problem);
  }
  return { byKey, list, ok: byKey.size === 0 && !list };
}

// The POST /api/sessions body that starts one item. The backend adds the
// workspace's own variables from the workspace the request names.
export function startupRequest(item, { workspace, cwd } = {}) {
  const clean = cleanStartupItem(item);
  const body = {};
  if (isAgentType(clean.kind)) body.profile = clean.kind;
  if (cwd) body.cwd = cwd;
  if (workspace) body.workspace = workspace;
  if (clean.name) body.name = clean.name;
  if (clean.shell) body.shell = clean.shell;
  if (clean.command) body.command = clean.command;
  if (clean.agent_mode) body.agent_mode = clean.agent_mode;
  if (clean.agent) body.agent = clean.agent;
  if (clean.env) body.env = clean.env;
  return body;
}

// ---------- when a view runs it ----------

function layoutSessionIds(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.type === "split" && Array.isArray(node.children)) {
    for (const child of node.children) layoutSessionIds(child, out);
  } else if (typeof node.session_id === "string" && node.session_id) {
    out.push(node.session_id);
  }
  return out;
}

// "startup" when the view has nothing to restore (no saved panes), or when
// the workspace has a Start with list and none of the terminals it names (in
// its layout or its ownership list) still runs. A dead layout without a list
// is restored as before, with its Restart and Resume offers.
export function startupDecision(saved, isAlive) {
  if (!hasLeaves(saved?.layout)) return "startup";
  const ids = [...layoutSessionIds(saved?.layout), ...(Array.isArray(saved?.session_ids) ? saved.session_ids : [])];
  if (ids.some((id) => isAlive(id))) return "restore";
  return Array.isArray(saved?.startup) && saved.startup.length ? "startup" : "restore";
}

function hasLeaves(node) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "split") return Array.isArray(node.children) && node.children.some(hasLeaves);
  return true;
}
