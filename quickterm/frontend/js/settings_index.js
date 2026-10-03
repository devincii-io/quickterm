// Every field in Settings, by the id its `[data-setting]` carries, so search
// (in the sheet and in the palette) can find a setting and reveal it.
// Pure: no DOM, testable on its own.

// [id, label, note]. The ids are frozen; Terminals keeps the id "connections".
export const SETTINGS_TABS = [
  ["general", "General", "Appearance and default terminal"],
  ["window", "Window", "Size and overlay"],
  ["shortcuts", "Shortcuts", "Global and in-app keys"],
  ["connections", "Terminals", "Saved terminal configs"],
  ["snippets", "Snippets", "Palette commands"],
  ["advanced", "Advanced", "Server, cleanup, updates"],
  ["about", "About", "Version and history"],
];

export const SETTINGS_INDEX = [
  { id: "font_family", tab: "general", label: "Terminal font", keywords: "font family typeface monospace", hint: "Any monospace font installed on this computer" },
  { id: "font_size", tab: "general", label: "Terminal text size", keywords: "font size zoom px", hint: "Also Ctrl+plus, minus and 0" },
  { id: "default_profile", tab: "general", label: "Default terminal", keywords: "default profile startup shell", hint: "Opened when QuickTerm starts" },
  { id: "theme", tab: "general", label: "Theme", keywords: "colors colours dark light palette appearance", hint: "Terminal and app colours" },
  { id: "logo", tab: "general", label: "App logo", keywords: "branding icon image mark", hint: "Shown when a workspace has none" },
  { id: "window.size", tab: "window", label: "Window size", keywords: "width height default size resolution", hint: "Size of a new window" },
  { id: "window.remember_bounds", tab: "window", label: "Remember size and position", keywords: "bounds restore position maximized", hint: "Reopen where you left it" },
  { id: "overlay.enabled", tab: "window", label: "Drop-down overlay", keywords: "quake overlay drop down dropdown slide", hint: "The summon shortcut drops QuickTerm from a screen edge" },
  { id: "overlay.edge", tab: "window", label: "Overlay edge", keywords: "top bottom edge", hint: "Where the overlay slides in from" },
  { id: "overlay.width_pct", tab: "window", label: "Overlay width", keywords: "percent width size", hint: "Share of the screen width" },
  { id: "overlay.height_pct", tab: "window", label: "Overlay height", keywords: "percent height size", hint: "Share of the screen height" },
  { id: "overlay.always_on_top", tab: "window", label: "Overlay stays on top", keywords: "topmost always on top", hint: "Above other windows" },
  { id: "overlay.hide_on_blur", tab: "window", label: "Hide overlay when focus leaves", keywords: "blur focus hide auto", hint: "Clicking another program hides it" },
  { id: "overlay.monitor", tab: "window", label: "Overlay monitor", keywords: "screen display cursor primary", hint: "Where the overlay appears" },
  { id: "overlay.animate", tab: "window", label: "Overlay animation", keywords: "slide animate motion", hint: "Slide in and out" },
  { id: "summon_hotkey", tab: "shortcuts", label: "Summon shortcut", keywords: "hotkey global show hide summon key", hint: "Show or hide QuickTerm from anywhere" },
  { id: "terminal_shortcuts", tab: "shortcuts", label: "Terminal shortcuts", keywords: "hotkey global keybinding profile key", hint: "A global key per saved terminal" },
  { id: "app_keys", tab: "shortcuts", label: "In-app keys", keywords: "keyboard alt keys reference help", hint: "The keys QuickTerm uses inside the window" },
  { id: "host", tab: "advanced", label: "Loopback address", keywords: "server host bind ip localhost", hint: "Applies after restart" },
  { id: "port", tab: "advanced", label: "Local server port", keywords: "server port network", hint: "Applies after restart" },
  { id: "scrollback_bytes", tab: "advanced", label: "In-memory scrollback", keywords: "history buffer memory lines", hint: "Per live terminal" },
  { id: "idle_timeout_s", tab: "advanced", label: "Clean unused shells", keywords: "idle timeout cleanup reap", hint: "Only untouched, detached shells" },
  { id: "max_sessions", tab: "advanced", label: "Live terminal limit", keywords: "max sessions limit count", hint: "0 means unlimited" },
  { id: "scratch_dir", tab: "advanced", label: "Scratch folder", keywords: "scratch temp folder directory", hint: "Where scratch terminals start" },
  { id: "update_check", tab: "advanced", label: "Update notifications", keywords: "updates release version check notify", hint: "Tell me when a new version is out" },
  { id: "voice", tab: "advanced", label: "Voice input", keywords: "voice whisper speech dictation", hint: "Parked for now" },
  { id: "updates", tab: "about", label: "Check for updates", keywords: "update install version release", hint: "Compare with the latest release" },
  { id: "config_history", tab: "about", label: "Settings history", keywords: "history restore undo backup versions", hint: "The last 20 saved versions" },
];

const TAB_ORDER = SETTINGS_TABS.map(([id]) => id);

// Higher is better; 0 means no match. Whole-label and word-start matches beat
// a hit somewhere in the keywords, and a subsequence ("ovh" for "overlay
// height") is the weakest match that still counts.
export function matchScore(query, { label = "", keywords = "", hint = "" }) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return 0;
  const text = label.toLowerCase();
  if (text === q) return 1000;
  if (text.startsWith(q)) return 800;
  if (text.split(/[\s:._-]+/).some((word) => word.startsWith(q))) return 600;
  if (text.includes(q)) return 400;
  const words = q.split(/\s+/);
  const haystack = `${text} ${keywords.toLowerCase()} ${hint.toLowerCase()}`;
  if (words.every((word) => haystack.includes(word))) return 300 - Math.min(99, haystack.indexOf(words[0]));
  let at = -1;
  let gaps = 0;
  for (const ch of q.replace(/\s+/g, "")) {
    const next = text.indexOf(ch, at + 1);
    if (next < 0) return 0;
    gaps += next - at - 1;
    at = next;
  }
  return Math.max(1, 100 - gaps);
}

/**
 * Settings fields, terminals and snippets matching `query`, best first. A
 * terminal or snippet row carries `kind` and `name` so the sheet can select it
 * in its list.
 */
export function searchSettings(query, draft = {}) {
  const rows = SETTINGS_INDEX.map((entry) => ({ ...entry, kind: "setting" }));
  for (const profile of draft.profiles || []) {
    if (!profile?.name) continue;
    rows.push({
      id: `terminal:${profile.name}`, tab: "connections", kind: "terminal", name: profile.name,
      label: `terminal: ${profile.name}`, keywords: `${profile.terminal_type || ""} ${profile.cmd || ""} ${profile.ssh_host || ""}`,
      hint: profile.description || profile.terminal_type || "",
    });
  }
  for (const snippet of draft.snippets || []) {
    if (!snippet?.name) continue;
    rows.push({
      id: `snippet:${snippet.name}`, tab: "snippets", kind: "snippet", name: snippet.name,
      label: `snippet: ${snippet.name}`, keywords: snippet.text || "", hint: snippet.description || "",
    });
  }
  return rows
    .map((row) => ({ row, score: matchScore(query, row) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score
      || TAB_ORDER.indexOf(a.row.tab) - TAB_ORDER.indexOf(b.row.tab)
      || a.row.label.localeCompare(b.row.label))
    .map(({ row }) => row);
}
