import { CUSTOM_THEME } from "./themes.js";

export const DASHBOARD_REFRESH_MS = 5000;

export const THEME_CATALOG_GROUPS = [
  ["Dark", ["graphite", "one-dark", "dracula", "github-dark", "github-dark-dimmed", "solarized-dark", "material-ocean", "night-owl", "oxocarbon"]],
  ["Neon", ["tokyo-night", "tokyo-night-storm", "cobalt2"]],
  ["Soft", ["catppuccin-mocha", "catppuccin-macchiato", "catppuccin-frappe", "nord", "everforest", "rose-pine", "rose-pine-moon", "ayu-mirage"]],
  ["Warm", ["gruvbox-dark", "kanagawa", "monokai", "horizon"]],
  ["Light", ["rose-pine-dawn", "github-light", "solarized-light"]],
  ["Custom", [CUSTOM_THEME]],
];

export const TERMINAL_TYPES = [
  { id: "claude-code", label: "Claude Code", executable: "claude.exe" },
  { id: "powershell-core", label: "PowerShell 7", executable: "pwsh.exe" },
  { id: "windows-powershell", label: "Windows PowerShell", executable: "powershell.exe" },
  { id: "command-prompt", label: "Command Prompt", executable: "cmd.exe" },
  { id: "wsl", label: "Windows Subsystem for Linux", executable: "wsl.exe" },
  { id: "ssh", label: "SSH (PuTTY plink)", executable: "" },
  { id: "sftp", label: "SFTP (PuTTY psftp)", executable: "" },
  { id: "custom", label: "Custom command", executable: "" },
];

export function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function envToLines(env) {
  return Object.entries(env || {}).map(([key, value]) => `${key}=${value}`).join("\n");
}

export function parseEnvLines(text) {
  const env = {};
  for (const raw of (text || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key) env[key] = line.slice(eq + 1);
  }
  return env;
}

export function environmentError(env) {
  const seen = new Set();
  for (const [key, value] of Object.entries(env || {})) {
    if (!key || key.includes("=") || /[\x00-\x1f]/.test(key)) return `Invalid environment variable name: ${key || "(empty)"}.`;
    if (typeof value !== "string" || value.includes("\0")) return `Invalid value for environment variable ${key}.`;
    const folded = key.toLocaleLowerCase();
    if (seen.has(folded)) return `Environment variable names must be unique ignoring case: ${key}.`;
    seen.add(folded);
  }
  return "";
}

export function inferTerminalType(profile) {
  if (profile.terminal_type) return profile.terminal_type;
  const cmd = (profile.cmd || "").toLowerCase().split(/[\\/]/).pop();
  // Claude integration is opt-in via terminal_type. A legacy custom command
  // named `claude` may carry bespoke args and must not silently acquire
  // continue/picker semantics merely by opening Settings.
  if (cmd === "pwsh" || cmd === "pwsh.exe") return "powershell-core";
  if (cmd === "powershell" || cmd === "powershell.exe") return "windows-powershell";
  if (cmd === "cmd" || cmd === "cmd.exe") return "command-prompt";
  if (cmd === "wsl" || cmd === "wsl.exe") return "wsl";
  if (cmd === "plink" || cmd === "plink.exe") return "ssh";
  if (cmd === "psftp" || cmd === "psftp.exe") return "sftp";
  return "custom";
}

export function countPanes(layout) {
  if (!layout) return 0;
  if (layout.type !== "split") return 1;
  return (layout.children || []).reduce((sum, child) => sum + countPanes(child), 0);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "Unavailable";
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 100 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
}

export function layoutSessionIds(node, out = new Set()) {
  if (!node) return out;
  if (node.type === "split") {
    for (const child of node.children || []) layoutSessionIds(child, out);
  } else if (node.session_id) {
    out.add(node.session_id);
  }
  return out;
}

// Snippets store the exact keystrokes sent to the shell, including the trailing
// carriage return that runs the command. The editor hides that CR and re-adds
// it on change, so a one-line snippet "just runs" when picked from the palette.
export function displaySnippet(text) {
  return String(text || "").replace(/\r\n?/g, "\n").replace(/\n$/, "");
}
export function runnableSnippet(text) {
  const body = String(text || "").replace(/\r\n?/g, "\n");
  return body ? `${body}\r` : "";
}
