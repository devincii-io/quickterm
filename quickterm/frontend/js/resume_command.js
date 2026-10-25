// "copy resume command": the line that reopens an agent's conversation from
// any terminal, in the folder it ran in, written for the configured shell.
// Pure apart from `copyText`, which writes the clipboard.

// Claude's session ids and Codex's thread ids are UUIDs; the backend passes
// nothing else, and nothing else goes into a command line.
const CONVERSATION_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,99}$/;

const AGENT_COMMANDS = {
  claude: (id) => `claude --resume ${id}`,
  "claude-code": (id) => `claude --resume ${id}`,
  codex: (id) => `codex resume ${id}`,
};

const posixQuote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
const powershellQuote = (text) => `'${String(text).replaceAll("'", "''")}'`;

// `kind`: "claude" | "codex" (or the terminal types "claude-code" | "codex");
// `shell`: the Settings shell value ("powershell", "cmd", "git-bash", "wsl...",
// "" for a POSIX login shell). null when there is no usable id.
export function resumeCommand({ kind, id, folder = "", shell = "powershell" } = {}) {
  const build = AGENT_COMMANDS[kind];
  if (!build || !CONVERSATION_ID.test(String(id || ""))) return null;
  const command = build(id);
  const where = String(folder || "");
  if (!where || /[\r\n\0]/.test(where)) return command;
  const value = String(shell ?? "powershell");
  if (value === "cmd") {
    // cmd has no escape for a double quote inside a quoted path; such a folder
    // cannot be named, so the line goes without it.
    return where.includes('"') ? command : `cd /d "${where}" && ${command}`;
  }
  if (value === "powershell") return `Set-Location -LiteralPath ${powershellQuote(where)}; ${command}`;
  return `cd ${posixQuote(where)} && ${command}`;
}

// The shell the "+" menu marks as the default, which is the Settings shell.
export function configuredShell(app) {
  const row = (app?.newTerminalMenu?.() || []).find((entry) => entry?.kind === "shell" && entry.isDefault);
  return row?.value ?? "powershell";
}

// Write `text` to the clipboard. WebView2 can refuse the async API silently,
// so a hidden textarea and execCommand are the fallback. Resolves to whether
// either worked.
export async function copyText(text, doc = globalThis.document) {
  try {
    await globalThis.navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // fall through to the old path
  }
  if (!doc) return false;
  const previous = doc.activeElement;
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  doc.body.append(area);
  area.select();
  let ok = false;
  try { ok = doc.execCommand("copy"); } catch (_) { ok = false; }
  area.remove();
  previous?.focus?.();
  return ok;
}
