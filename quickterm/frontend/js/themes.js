// Curated terminal color themes. Each entry maps to an xterm.js ITheme.
// The selected theme id is persisted in the backend config ("theme").

function theme(label, note, base, accent) {
  return {
    label,
    note,
    accent: accent || base.brightYellow,
    xterm: {
      cursorAccent: base.background,
      selectionBackground: base.selectionBackground || base.brightBlack,
      ...base,
    },
  };
}

export const DEFAULT_THEME = "graphite";
export const CUSTOM_THEME = "custom";
export const CUSTOM_THEME_DEFAULTS = {
  background: "#171b1a",
  surface: "#222826",
  text: "#ecebe5",
  muted: "#858e88",
  accent: "#e6a94b",
  danger: "#d47c73",
};

export const TERMINAL_THEMES = {
  graphite: theme("Graphite", "QuickTerm's warm default", {
    background: "#1E2124", foreground: "#D6D3C9", cursor: "#E0A030",
    selectionBackground: "#3A4046",
    black: "#22262A", red: "#B4544B", green: "#7C9B6E", yellow: "#C89543",
    blue: "#6E8898", magenta: "#9A7F9E", cyan: "#6FA090", white: "#B9B6AD",
    brightBlack: "#4C545C", brightRed: "#C97B70", brightGreen: "#98B58B",
    brightYellow: "#E0A030", brightBlue: "#8FA9BA", brightMagenta: "#B49CB8",
    brightCyan: "#8FBCAC", brightWhite: "#D6D3C9",
  }),
  "one-dark": theme("One Dark", "The Atom classic", {
    background: "#282C34", foreground: "#ABB2BF", cursor: "#528BFF",
    selectionBackground: "#3E4451",
    black: "#3F4451", red: "#E06C75", green: "#98C379", yellow: "#E5C07B",
    blue: "#61AFEF", magenta: "#C678DD", cyan: "#56B6C2", white: "#ABB2BF",
    brightBlack: "#5C6370", brightRed: "#E06C75", brightGreen: "#98C379",
    brightYellow: "#D19A66", brightBlue: "#61AFEF", brightMagenta: "#C678DD",
    brightCyan: "#56B6C2", brightWhite: "#E6E6E6",
  }, "#61AFEF"),
  dracula: theme("Dracula", "High-contrast purple", {
    background: "#282A36", foreground: "#F8F8F2", cursor: "#F8F8F2",
    selectionBackground: "#44475A",
    black: "#21222C", red: "#FF5555", green: "#50FA7B", yellow: "#F1FA8C",
    blue: "#BD93F9", magenta: "#FF79C6", cyan: "#8BE9FD", white: "#F8F8F2",
    brightBlack: "#6272A4", brightRed: "#FF6E6E", brightGreen: "#69FF94",
    brightYellow: "#FFFFA5", brightBlue: "#D6ACFF", brightMagenta: "#FF92DF",
    brightCyan: "#A4FFFF", brightWhite: "#FFFFFF",
  }, "#BD93F9"),
  "gruvbox-dark": theme("Gruvbox Dark", "Retro and earthy", {
    background: "#282828", foreground: "#EBDBB2", cursor: "#EBDBB2",
    selectionBackground: "#504945",
    black: "#282828", red: "#CC241D", green: "#98971A", yellow: "#D79921",
    blue: "#458588", magenta: "#B16286", cyan: "#689D6A", white: "#A89984",
    brightBlack: "#928374", brightRed: "#FB4934", brightGreen: "#B8BB26",
    brightYellow: "#FABD2F", brightBlue: "#83A598", brightMagenta: "#D3869B",
    brightCyan: "#8EC07C", brightWhite: "#EBDBB2",
  }, "#FABD2F"),
  nord: theme("Nord", "Cool arctic blues", {
    background: "#2E3440", foreground: "#D8DEE9", cursor: "#D8DEE9",
    selectionBackground: "#434C5E",
    black: "#3B4252", red: "#BF616A", green: "#A3BE8C", yellow: "#EBCB8B",
    blue: "#81A1C1", magenta: "#B48EAD", cyan: "#88C0D0", white: "#E5E9F0",
    brightBlack: "#4C566A", brightRed: "#BF616A", brightGreen: "#A3BE8C",
    brightYellow: "#EBCB8B", brightBlue: "#81A1C1", brightMagenta: "#B48EAD",
    brightCyan: "#8FBCBB", brightWhite: "#ECEFF4",
  }),
  "solarized-dark": theme("Solarized Dark", "The scientific classic", {
    background: "#002B36", foreground: "#839496", cursor: "#839496",
    selectionBackground: "#073642",
    black: "#073642", red: "#DC322F", green: "#859900", yellow: "#B58900",
    blue: "#268BD2", magenta: "#D33682", cyan: "#2AA198", white: "#EEE8D5",
    brightBlack: "#586E75", brightRed: "#CB4B16", brightGreen: "#93A1A1",
    brightYellow: "#657B83", brightBlue: "#6C71C4", brightMagenta: "#D33682",
    brightCyan: "#2AA198", brightWhite: "#FDF6E3",
  }),
  "catppuccin-mocha": theme("Catppuccin Mocha", "Soft pastel dark", {
    background: "#1E1E2E", foreground: "#CDD6F4", cursor: "#F5E0DC",
    selectionBackground: "#45475A",
    black: "#45475A", red: "#F38BA8", green: "#A6E3A1", yellow: "#F9E2AF",
    blue: "#89B4FA", magenta: "#F5C2E7", cyan: "#94E2D5", white: "#BAC2DE",
    brightBlack: "#585B70", brightRed: "#F38BA8", brightGreen: "#A6E3A1",
    brightYellow: "#F9E2AF", brightBlue: "#89B4FA", brightMagenta: "#F5C2E7",
    brightCyan: "#94E2D5", brightWhite: "#A6ADC8",
  }),
  "tokyo-night": theme("Tokyo Night", "Neon city dark", {
    background: "#1A1B26", foreground: "#C0CAF5", cursor: "#C0CAF5",
    selectionBackground: "#33467C",
    black: "#15161E", red: "#F7768E", green: "#9ECE6A", yellow: "#E0AF68",
    blue: "#7AA2F7", magenta: "#BB9AF7", cyan: "#7DCFFF", white: "#A9B1D6",
    brightBlack: "#414868", brightRed: "#F7768E", brightGreen: "#9ECE6A",
    brightYellow: "#E0AF68", brightBlue: "#7AA2F7", brightMagenta: "#BB9AF7",
    brightCyan: "#7DCFFF", brightWhite: "#C0CAF5",
  }),
};

function normalizeHex(value, fallback) {
  const text = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toUpperCase() : fallback;
}

function rgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function mix(a, b, amount) {
  const aa = rgb(a);
  const bb = rgb(b);
  const parts = aa.map((value, index) => Math.round(value + (bb[index] - value) * amount));
  return `#${parts.map((value) => value.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

export function customColors(value = {}) {
  return Object.fromEntries(Object.entries(CUSTOM_THEME_DEFAULTS).map(([key, fallback]) => [
    key,
    normalizeHex(value[key], fallback.toUpperCase()),
  ]));
}

export function getTheme(id, custom = {}) {
  if (id !== CUSTOM_THEME) return TERMINAL_THEMES[id] || TERMINAL_THEMES[DEFAULT_THEME];
  const colors = customColors(custom);
  const graphite = TERMINAL_THEMES.graphite.xterm;
  return {
    label: "Custom",
    note: "Your own app and terminal colors",
    accent: colors.accent,
    chrome: colors,
    xterm: {
      ...graphite,
      background: colors.surface,
      foreground: colors.text,
      cursor: colors.accent,
      cursorAccent: colors.surface,
      selectionBackground: mix(colors.surface, colors.accent, 0.32),
      red: colors.danger,
      yellow: colors.accent,
      brightYellow: mix(colors.accent, "#FFFFFF", 0.18),
      brightWhite: colors.text,
    },
  };
}

export function applyChromeTheme(id, custom = {}) {
  const selected = getTheme(id, custom);
  const colors = selected.chrome || {
    background: selected.xterm.background,
    surface: mix(selected.xterm.background, "#FFFFFF", 0.055),
    text: selected.xterm.foreground,
    muted: mix(selected.xterm.foreground, selected.xterm.background, 0.48),
    accent: selected.accent || selected.xterm.cursor,
    danger: selected.xterm.red,
  };
  const root = document.documentElement.style;
  const surface = normalizeHex(colors.surface, colors.background);
  const background = normalizeHex(colors.background, CUSTOM_THEME_DEFAULTS.background);
  const text = normalizeHex(colors.text, CUSTOM_THEME_DEFAULTS.text);
  const muted = normalizeHex(colors.muted, CUSTOM_THEME_DEFAULTS.muted);
  const accent = normalizeHex(colors.accent, CUSTOM_THEME_DEFAULTS.accent);
  const danger = normalizeHex(colors.danger, CUSTOM_THEME_DEFAULTS.danger);
  const values = {
    "--bg": background,
    "--surface": surface,
    "--surface-raised": mix(surface, "#FFFFFF", 0.04),
    "--surface-soft": mix(surface, "#FFFFFF", 0.075),
    "--text": text,
    "--text-soft": mix(text, background, 0.16),
    "--muted": muted,
    "--accent": accent,
    "--accent-soft": mix(background, accent, 0.17),
    "--sage": mix(muted, "#A7D5B3", 0.36),
    "--danger": danger,
    "--line": mix(surface, text, 0.09),
    "--line-strong": mix(surface, text, 0.16),
  };
  for (const [key, value] of Object.entries(values)) root.setProperty(key, value);
}
