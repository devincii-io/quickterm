// The configured shell (config `shell`, CONTRACTS 4.3) as the frontend names
// and treats it. Pure, tested under node; quickterm/shells.py is the backend
// half and decides what actually starts.

const LABELS = { powershell: "PowerShell", cmd: "Command Prompt", "git-bash": "Git Bash", wsl: "WSL" };
const TYPES = { powershell: "powershell-core", cmd: "command-prompt", "git-bash": "git-bash" };

export const DEFAULT_SHELL = "powershell";

export function shellValueLabel(value) {
  const text = String(value ?? "");
  if (text.startsWith("wsl:")) return `WSL: ${text.slice(4)}`;
  if (!text) return "Shell";
  return LABELS[text] || text;
}

// The pane type a shell behaves like: WSL panes map Windows paths, a split
// from one starts in its Linux folder.
export function shellTerminalType(value) {
  const text = String(value ?? "");
  if (text === "wsl" || text.startsWith("wsl:")) return "wsl";
  return TYPES[text] || (text ? null : "bash");
}

// The inventory's `shells`, available ones only. An inventory cached by an
// older build has none; the configured shell is then the only entry, so the
// menu and Settings never come up empty.
export function availableShells(inventory, configured = DEFAULT_SHELL) {
  const listed = (inventory?.shells || []).filter((entry) => entry && entry.available !== false
    && typeof entry.value === "string");
  if (listed.length) return listed.map((entry) => ({ value: entry.value, label: entry.label || shellValueLabel(entry.value) }));
  const value = configured ?? DEFAULT_SHELL;
  return [{ value, label: shellValueLabel(value) }];
}
