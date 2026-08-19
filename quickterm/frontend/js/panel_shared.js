import { openFolderBrowser } from "./folder_browser.js";
import { icon } from "./icons.js";
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

// The OS dialog is the secondary route now, not the mechanism. It exists only
// inside the installed pywebview shell, and it is injected late, so anything
// that depends on it has to cope with both absence and late arrival.
export function nativeFolderPickerAvailable() {
  return typeof globalThis.pywebview?.api?.pick_folder === "function";
}

export async function pickNativeFolder(initialDirectory = "") {
  const picker = globalThis.pywebview?.api?.pick_folder;
  if (typeof picker !== "function") return { available: false, path: null, failed: false };
  try {
    const selected = await picker(String(initialDirectory || ""));
    const path = typeof selected === "string" && selected ? selected : null;
    return { available: true, path, failed: false };
  } catch (_) {
    return { available: true, path: null, failed: true };
  }
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

// The backend answers 404 once it has dropped a session from its registry,
// which is what the idle reaper does to a terminal whose process already
// exited. Kill and retain then have nothing left to act on, so the caller must
// still close the pane. Treating that 404 as a failure stranded the pane with a
// Retry that could never succeed and no other way to remove it.
export function sessionAlreadyGone(error) {
  return error?.status === 404;
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


// One folder field, one Browse button, everywhere a directory is chosen.
// Picking a folder dispatches a bubbling "input" event on the field, so a
// caller only ever needs the listener it already has for typing.
//
// Browse opens the in-app directory browser (folder_browser.js), which works in
// every viewer. The native OS dialog is offered from inside that modal when the
// pywebview bridge is there, because some people prefer the dialog they know.
// It used to be the only mechanism, which left Browse disabled outright in a
// plain browser and dropped focus out of the page in the installed app.
export function folderPickerControl(input, options = {}) {
  const control = make("span", "folder-picker-control");
  const browse = make("button", "secondary-button folder-picker-button");
  browse.type = "button";
  browse.append(icon("folder", 14), make("span", "", "Browse"));
  browse.setAttribute("aria-label", options.label || "Choose a folder");
  browse.title = "Choose a folder";
  browse.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    browse.disabled = true;
    let chosen = null;
    try {
      chosen = await openFolderBrowser({
        startPath: input.value || options.startIn || "",
        label: options.label || "Choose a folder",
        title: options.label || "Choose a folder",
        // Injected rather than imported by folder_browser.js: the dependency
        // runs this way only, so the two modules never form a cycle.
        nativePicker: {
          available: nativeFolderPickerAvailable,
          pick: pickNativeFolder,
        },
      });
    } finally {
      browse.disabled = false;
    }
    if (chosen) {
      input.value = chosen;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    }
  });
  control.append(input, browse);
  return control;
}

// Long absolute paths blow up narrow rows. Keep the tail, which is the part
// that identifies the project.
export function shortPath(value, max = 46) {
  const text = String(value || "");
  if (text.length <= max) return text;
  return `…${text.slice(-(max - 1))}`;
}
