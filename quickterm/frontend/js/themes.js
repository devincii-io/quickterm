// Curated terminal themes. Each entry carries an xterm.js ITheme plus legacy
// chrome metadata used only to select light or dark neutral application chrome.
// The selected theme id is persisted in the backend config ("theme").

function theme(label, note, chrome, base, accent) {
  return {
    label,
    note,
    accent: accent || chrome.accent,
    chrome,
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
  graphite: theme("Graphite", "QuickTerm's warm default",
    { background: "#171B1A", surface: "#222826", text: "#ECEBE5", muted: "#858E88", accent: "#E6A94B", danger: "#D47C73" }, {
    background: "#1E2124", foreground: "#D6D3C9", cursor: "#E0A030",
    selectionBackground: "#3A4046",
    black: "#22262A", red: "#B4544B", green: "#7C9B6E", yellow: "#C89543",
    blue: "#6E8898", magenta: "#9A7F9E", cyan: "#6FA090", white: "#B9B6AD",
    brightBlack: "#4C545C", brightRed: "#C97B70", brightGreen: "#98B58B",
    brightYellow: "#E0A030", brightBlue: "#8FA9BA", brightMagenta: "#B49CB8",
    brightCyan: "#8FBCAC", brightWhite: "#D6D3C9",
  }),
  "one-dark": theme("One Dark", "The Atom classic",
    { background: "#21252B", surface: "#2C313C", text: "#ABB2BF", muted: "#7F848E", accent: "#61AFEF", danger: "#E06C75" }, {
    background: "#282C34", foreground: "#ABB2BF", cursor: "#528BFF",
    selectionBackground: "#3E4451",
    black: "#3F4451", red: "#E06C75", green: "#98C379", yellow: "#E5C07B",
    blue: "#61AFEF", magenta: "#C678DD", cyan: "#56B6C2", white: "#ABB2BF",
    brightBlack: "#5C6370", brightRed: "#E06C75", brightGreen: "#98C379",
    brightYellow: "#D19A66", brightBlue: "#61AFEF", brightMagenta: "#C678DD",
    brightCyan: "#56B6C2", brightWhite: "#E6E6E6",
  }),
  dracula: theme("Dracula", "High-contrast purple",
    { background: "#21222C", surface: "#343746", text: "#F8F8F2", muted: "#8B8FA3", accent: "#BD93F9", danger: "#FF5555" }, {
    background: "#282A36", foreground: "#F8F8F2", cursor: "#F8F8F2",
    selectionBackground: "#44475A",
    black: "#21222C", red: "#FF5555", green: "#50FA7B", yellow: "#F1FA8C",
    blue: "#BD93F9", magenta: "#FF79C6", cyan: "#8BE9FD", white: "#F8F8F2",
    brightBlack: "#6272A4", brightRed: "#FF6E6E", brightGreen: "#69FF94",
    brightYellow: "#FFFFA5", brightBlue: "#D6ACFF", brightMagenta: "#FF92DF",
    brightCyan: "#A4FFFF", brightWhite: "#FFFFFF",
  }),
  "tokyo-night": theme("Tokyo Night", "Neon city dark",
    { background: "#16161E", surface: "#24283B", text: "#C0CAF5", muted: "#787C99", accent: "#7AA2F7", danger: "#F7768E" }, {
    background: "#1A1B26", foreground: "#C0CAF5", cursor: "#C0CAF5",
    selectionBackground: "#33467C",
    black: "#15161E", red: "#F7768E", green: "#9ECE6A", yellow: "#E0AF68",
    blue: "#7AA2F7", magenta: "#BB9AF7", cyan: "#7DCFFF", white: "#A9B1D6",
    brightBlack: "#414868", brightRed: "#F7768E", brightGreen: "#9ECE6A",
    brightYellow: "#E0AF68", brightBlue: "#7AA2F7", brightMagenta: "#BB9AF7",
    brightCyan: "#7DCFFF", brightWhite: "#C0CAF5",
  }),
  "catppuccin-mocha": theme("Catppuccin Mocha", "Soft pastel dark",
    { background: "#181825", surface: "#313244", text: "#CDD6F4", muted: "#9399B2", accent: "#CBA6F7", danger: "#F38BA8" }, {
    background: "#1E1E2E", foreground: "#CDD6F4", cursor: "#F5E0DC",
    selectionBackground: "#45475A",
    black: "#45475A", red: "#F38BA8", green: "#A6E3A1", yellow: "#F9E2AF",
    blue: "#89B4FA", magenta: "#F5C2E7", cyan: "#94E2D5", white: "#BAC2DE",
    brightBlack: "#585B70", brightRed: "#F38BA8", brightGreen: "#A6E3A1",
    brightYellow: "#F9E2AF", brightBlue: "#89B4FA", brightMagenta: "#F5C2E7",
    brightCyan: "#94E2D5", brightWhite: "#A6ADC8",
  }, "#CBA6F7"),
  "catppuccin-macchiato": theme("Catppuccin Macchiato", "Warmer pastel dark",
    { background: "#1A1C2A", surface: "#363A4F", text: "#CAD3F5", muted: "#939AB7", accent: "#C6A0F6", danger: "#ED8796" }, {
    background: "#24273A", foreground: "#CAD3F5", cursor: "#F4DBD6",
    selectionBackground: "#5B6078",
    black: "#494D64", red: "#ED8796", green: "#A6DA95", yellow: "#EED49F",
    blue: "#8AADF4", magenta: "#F5BDE6", cyan: "#8BD5CA", white: "#B8C0E0",
    brightBlack: "#5B6078", brightRed: "#ED8796", brightGreen: "#A6DA95",
    brightYellow: "#EED49F", brightBlue: "#8AADF4", brightMagenta: "#F5BDE6",
    brightCyan: "#8BD5CA", brightWhite: "#A5ADCB",
  }, "#C6A0F6"),
  nord: theme("Nord", "Cool arctic blues",
    { background: "#2E3440", surface: "#3B4252", text: "#ECEFF4", muted: "#7B88A1", accent: "#88C0D0", danger: "#BF616A" }, {
    background: "#2E3440", foreground: "#D8DEE9", cursor: "#D8DEE9",
    selectionBackground: "#434C5E",
    black: "#3B4252", red: "#BF616A", green: "#A3BE8C", yellow: "#EBCB8B",
    blue: "#81A1C1", magenta: "#B48EAD", cyan: "#88C0D0", white: "#E5E9F0",
    brightBlack: "#4C566A", brightRed: "#BF616A", brightGreen: "#A3BE8C",
    brightYellow: "#EBCB8B", brightBlue: "#81A1C1", brightMagenta: "#B48EAD",
    brightCyan: "#8FBCBB", brightWhite: "#ECEFF4",
  }, "#88C0D0"),
  "gruvbox-dark": theme("Gruvbox Dark", "Retro and earthy",
    { background: "#1D2021", surface: "#32302F", text: "#EBDBB2", muted: "#A89984", accent: "#FABD2F", danger: "#FB4934" }, {
    background: "#282828", foreground: "#EBDBB2", cursor: "#EBDBB2",
    selectionBackground: "#504945",
    black: "#282828", red: "#CC241D", green: "#98971A", yellow: "#D79921",
    blue: "#458588", magenta: "#B16286", cyan: "#689D6A", white: "#A89984",
    brightBlack: "#928374", brightRed: "#FB4934", brightGreen: "#B8BB26",
    brightYellow: "#FABD2F", brightBlue: "#83A598", brightMagenta: "#D3869B",
    brightCyan: "#8EC07C", brightWhite: "#EBDBB2",
  }, "#FABD2F"),
  everforest: theme("Everforest", "Calm forest green",
    { background: "#272E33", surface: "#374145", text: "#D3C6AA", muted: "#859289", accent: "#A7C080", danger: "#E67E80" }, {
    background: "#2D353B", foreground: "#D3C6AA", cursor: "#D3C6AA",
    selectionBackground: "#4F585E",
    black: "#4B565C", red: "#E67E80", green: "#A7C080", yellow: "#DBBC7F",
    blue: "#7FBBB3", magenta: "#D699B6", cyan: "#83C092", white: "#D3C6AA",
    brightBlack: "#859289", brightRed: "#E67E80", brightGreen: "#A7C080",
    brightYellow: "#DBBC7F", brightBlue: "#7FBBB3", brightMagenta: "#D699B6",
    brightCyan: "#83C092", brightWhite: "#D3C6AA",
  }, "#A7C080"),
  kanagawa: theme("Kanagawa", "Ink-wash dusk",
    { background: "#16161D", surface: "#2A2A37", text: "#DCD7BA", muted: "#727169", accent: "#7E9CD8", danger: "#E82424" }, {
    background: "#1F1F28", foreground: "#DCD7BA", cursor: "#C8C093",
    selectionBackground: "#2D4F67",
    black: "#090618", red: "#C34043", green: "#76946A", yellow: "#C0A36E",
    blue: "#7E9CD8", magenta: "#957FB8", cyan: "#6A9589", white: "#C8C093",
    brightBlack: "#727169", brightRed: "#E82424", brightGreen: "#98BB6C",
    brightYellow: "#E6C384", brightBlue: "#7FB4CA", brightMagenta: "#938AA9",
    brightCyan: "#7AA89F", brightWhite: "#DCD7BA",
  }, "#7E9CD8"),
  "rose-pine": theme("Rosé Pine", "Moody rose and iris",
    { background: "#191724", surface: "#26233A", text: "#E0DEF4", muted: "#908CAA", accent: "#C4A7E7", danger: "#EB6F92" }, {
    background: "#191724", foreground: "#E0DEF4", cursor: "#E0DEF4",
    selectionBackground: "#403D52",
    black: "#26233A", red: "#EB6F92", green: "#31748F", yellow: "#F6C177",
    blue: "#9CCFD8", magenta: "#C4A7E7", cyan: "#EBBCBA", white: "#E0DEF4",
    brightBlack: "#6E6A86", brightRed: "#EB6F92", brightGreen: "#31748F",
    brightYellow: "#F6C177", brightBlue: "#9CCFD8", brightMagenta: "#C4A7E7",
    brightCyan: "#EBBCBA", brightWhite: "#E0DEF4",
  }, "#C4A7E7"),
  "github-dark": theme("GitHub Dark", "Familiar and crisp",
    { background: "#0D1117", surface: "#161B22", text: "#C9D1D9", muted: "#8B949E", accent: "#58A6FF", danger: "#F85149" }, {
    background: "#0D1117", foreground: "#C9D1D9", cursor: "#C9D1D9",
    selectionBackground: "#163356",
    black: "#484F58", red: "#FF7B72", green: "#3FB950", yellow: "#D29922",
    blue: "#58A6FF", magenta: "#BC8CFF", cyan: "#39C5CF", white: "#B1BAC4",
    brightBlack: "#6E7681", brightRed: "#FFA198", brightGreen: "#56D364",
    brightYellow: "#E3B341", brightBlue: "#79C0FF", brightMagenta: "#D2A8FF",
    brightCyan: "#56D4DD", brightWhite: "#F0F6FC",
  }, "#58A6FF"),
  "solarized-dark": theme("Solarized Dark", "The scientific classic",
    { background: "#002B36", surface: "#083F4C", text: "#93A1A1", muted: "#5E7079", accent: "#268BD2", danger: "#DC322F" }, {
    background: "#002B36", foreground: "#839496", cursor: "#839496",
    selectionBackground: "#073642",
    black: "#073642", red: "#DC322F", green: "#859900", yellow: "#B58900",
    blue: "#268BD2", magenta: "#D33682", cyan: "#2AA198", white: "#EEE8D5",
    brightBlack: "#586E75", brightRed: "#CB4B16", brightGreen: "#93A1A1",
    brightYellow: "#657B83", brightBlue: "#6C71C4", brightMagenta: "#D33682",
    brightCyan: "#2AA198", brightWhite: "#FDF6E3",
  }, "#268BD2"),
  "rose-pine-dawn": theme("Rosé Pine Dawn", "Soft rose · light",
    { background: "#FAF4ED", surface: "#FFFAF3", text: "#575279", muted: "#797593", accent: "#907AA9", danger: "#B4637A", light: true }, {
    background: "#FAF4ED", foreground: "#575279", cursor: "#575279",
    selectionBackground: "#DFDAD9",
    black: "#F2E9E1", red: "#B4637A", green: "#286983", yellow: "#EA9D34",
    blue: "#56949F", magenta: "#907AA9", cyan: "#D7827E", white: "#575279",
    brightBlack: "#9893A5", brightRed: "#B4637A", brightGreen: "#286983",
    brightYellow: "#EA9D34", brightBlue: "#56949F", brightMagenta: "#907AA9",
    brightCyan: "#D7827E", brightWhite: "#575279",
  }, "#907AA9"),
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

function rgba(hex, alpha) {
  const [r, g, b] = rgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
  // Terminal palettes belong to the terminal. Keep application chrome neutral
  // so switching to Dracula, Tokyo Night, or a custom shell palette does not
  // turn every button and panel into a different product.
  const light = Boolean(selected.chrome && selected.chrome.light);
  const colors = light
    ? { background: "#F6F8FA", surface: "#FFFFFF", text: "#1F2328", muted: "#656D76", accent: "#0969DA", danger: "#CF222E" }
    : { background: "#0D1117", surface: "#161B22", text: "#E6EDF3", muted: "#8B949E", accent: "#58A6FF", danger: "#F85149" };
  const root = document.documentElement.style;
  const surface = normalizeHex(colors.surface, colors.background);
  const background = normalizeHex(colors.background, CUSTOM_THEME_DEFAULTS.background);
  const text = normalizeHex(colors.text, CUSTOM_THEME_DEFAULTS.text);
  const muted = normalizeHex(colors.muted, CUSTOM_THEME_DEFAULTS.muted);
  const accent = normalizeHex(colors.accent, CUSTOM_THEME_DEFAULTS.accent);
  const danger = normalizeHex(colors.danger, CUSTOM_THEME_DEFAULTS.danger);
  // Light themes tint surfaces toward black; dark themes toward white.
  const lift = light ? "#000000" : "#FFFFFF";
  const values = {
    "--bg": background,
    "--surface": surface,
    "--surface-raised": mix(surface, lift, 0.04),
    "--surface-soft": mix(surface, lift, 0.075),
    // semantic surfaces that used to be hardcoded graphite hexes
    "--well": background,
    "--card": mix(background, surface, 0.62),
    "--field": mix(background, surface, 0.4),
    "--text": text,
    "--text-soft": mix(text, background, 0.16),
    "--muted": muted,
    "--accent": accent,
    "--accent-soft": mix(background, accent, 0.17),
    "--accent-hover": mix(accent, lift, 0.16),
    "--accent-press": mix(accent, light ? "#FFFFFF" : "#000000", 0.12),
    "--accent-border": mix(background, accent, 0.5),
    "--accent-ring": rgba(accent, 0.14),
    "--on-accent": light ? "#FFFFFF" : mix(background, "#000000", 0.35),
    "--sage": mix(muted, "#A7D5B3", 0.36),
    "--danger": danger,
    "--line": mix(surface, text, 0.09),
    "--line-strong": mix(surface, text, 0.16),
    "--line-hover": mix(surface, text, 0.3),
  };
  for (const [key, value] of Object.entries(values)) root.setProperty(key, value);
  document.documentElement.dataset.themeMode = light ? "light" : "dark";
}
