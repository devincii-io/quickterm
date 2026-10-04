// Built-in themes. Each one carries an xterm.js ITheme taken from the theme's
// own upstream terminal port, and six chrome colours taken from the same
// theme's editor UI palette, so the sidebar and the sheets look like that
// editor rather than like QuickTerm in a different terminal. The selected id is
// persisted in the backend config ("theme"); ids that were dropped from the
// list resolve through THEME_ALIASES so no saved config breaks.
//
// `ansi` lists the sixteen colours in terminal order (black, red, green,
// yellow, blue, magenta, cyan, white, then the bright row). The scrollbar,
// overview ruler and inactive selection keys are derived, never chosen.
// Licences and copyright lines are in THIRD-PARTY-NOTICES.md.

const ANSI_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];

// Keys every built-in theme defines with an opaque #RRGGBB value.
export const REQUIRED_XTERM_KEYS = [
  "background", "foreground", "cursor", "cursorAccent",
  "selectionBackground", "selectionInactiveBackground",
  "scrollbarSliderBackground", "scrollbarSliderHoverBackground",
  "scrollbarSliderActiveBackground", "overviewRulerBorder",
  ...ANSI_KEYS,
];
export const CHROME_KEYS = ["background", "surface", "text", "muted", "accent", "danger"];

function withDerived(xterm) {
  const { background, foreground, selectionBackground } = xterm;
  return {
    ...xterm,
    selectionInactiveBackground: mix(background, selectionBackground, 0.6),
    scrollbarSliderBackground: mix(background, foreground, 0.2),
    scrollbarSliderHoverBackground: mix(background, foreground, 0.32),
    scrollbarSliderActiveBackground: mix(background, foreground, 0.45),
    overviewRulerBorder: mix(background, foreground, 0.12),
  };
}

function theme({ label, note, light = false, chrome, terminal }) {
  const { ansi, ...rest } = terminal;
  const xterm = { cursorAccent: rest.background, ...rest };
  ANSI_KEYS.forEach((key, index) => { xterm[key] = ansi[index]; });
  return {
    label,
    note,
    light,
    accent: chrome.accent,
    chrome: { ...chrome, light },
    xterm: withDerived(xterm),
  };
}

export const DEFAULT_THEME = "graphite";
export const CUSTOM_THEME = "custom";
// Six colours are the whole chrome contract: applyChromeTheme() mixes every
// other surface, line and state out of them. They double as the fallback when
// a custom theme omits a field, so they must stay a coherent palette on their
// own. Warm amber on near-black, matched to the sibling QuickCode UI.
export const CUSTOM_THEME_DEFAULTS = {
  background: "#15140f",
  surface: "#24221b",
  text: "#e9e3d5",
  // Ink at 62% over the background. 55% reads as the right weight but measures
  // 4.38:1 on --surface, so readableColor() would drag it back up anyway.
  muted: "#98948a",
  accent: "#c8973f",
  danger: "#d76c53",
};

export const TERMINAL_THEMES = {
  // QuickTerm's house theme and the default. Its chrome is
  // CUSTOM_THEME_DEFAULTS, and css/app.css carries what chromeTokens() derives
  // from it, so the pre-boot paint matches. The ANSI ramp sits on one OKLCH
  // lightness per row (0.69 normal, 0.80 bright) with warm-leaning hues; red
  // is the chrome's danger coral and yellow its amber accent.
  graphite: theme({
    label: "Graphite", note: "QuickTerm's warm house theme",
    chrome: { background: "#15140F", surface: "#24221B", text: "#E9E3D5", muted: "#98948A", accent: "#C8973F", danger: "#D76C53" },
    terminal: {
      background: "#1B1A15", foreground: "#D9D3C5", cursor: "#D9A441", selectionBackground: "#463822",
      ansi: ["#302E27", "#D76C53", "#85A95E", "#C8973F", "#69A3CB", "#BD86B7", "#65AEA4", "#C2BDB1",
        "#726E64", "#F0917B", "#A8CB86", "#E6BA65", "#91C5EA", "#DCABD6", "#8CD0C7", "#ECE7DC"],
    },
  }),
  // https://github.com/catppuccin/ghostty (chrome: https://github.com/catppuccin/palette)
  "catppuccin-mocha": theme({
    label: "Catppuccin Mocha", note: "Soothing pastels on deep blue",
    chrome: { background: "#181825", surface: "#313244", text: "#CDD6F4", muted: "#9399B2", accent: "#CBA6F7", danger: "#F38BA8" },
    terminal: {
      background: "#1E1E2E", foreground: "#CDD6F4", cursor: "#F5E0DC", cursorAccent: "#11111B",
      selectionBackground: "#353749", selectionForeground: "#CDD6F4",
      ansi: ["#45475A", "#F38BA8", "#A6E3A1", "#F9E2AF", "#89B4FA", "#F5C2E7", "#94E2D5", "#A6ADC8",
        "#585B70", "#F38BA8", "#A6E3A1", "#F9E2AF", "#89B4FA", "#F5C2E7", "#94E2D5", "#BAC2DE"],
    },
  }),
  // https://github.com/folke/tokyonight.nvim (extras/ghostty/tokyonight_night)
  "tokyo-night": theme({
    label: "Tokyo Night", note: "Neon city lights at night",
    chrome: { background: "#16161E", surface: "#292E42", text: "#C0CAF5", muted: "#737AA2", accent: "#7AA2F7", danger: "#F7768E" },
    terminal: {
      background: "#1A1B26", foreground: "#C0CAF5", cursor: "#C0CAF5",
      selectionBackground: "#283457", selectionForeground: "#C0CAF5",
      ansi: ["#15161E", "#F7768E", "#9ECE6A", "#E0AF68", "#7AA2F7", "#BB9AF7", "#7DCFFF", "#A9B1D6",
        "#414868", "#FF899D", "#9FE044", "#FABA4A", "#8DB0FF", "#C7A9FF", "#A4DAFF", "#C0CAF5"],
    },
  }),
  // https://github.com/folke/tokyonight.nvim (extras/ghostty/tokyonight_storm)
  "tokyo-night-storm": theme({
    label: "Tokyo Night Storm", note: "Tokyo Night on a softer slate",
    chrome: { background: "#1F2335", surface: "#292E42", text: "#C0CAF5", muted: "#737AA2", accent: "#7AA2F7", danger: "#F7768E" },
    terminal: {
      background: "#24283B", foreground: "#C0CAF5", cursor: "#C0CAF5",
      selectionBackground: "#2E3C64", selectionForeground: "#C0CAF5",
      ansi: ["#1D202F", "#F7768E", "#9ECE6A", "#E0AF68", "#7AA2F7", "#BB9AF7", "#7DCFFF", "#A9B1D6",
        "#414868", "#FF899D", "#9FE044", "#FABA4A", "#8DB0FF", "#C7A9FF", "#A4DAFF", "#C0CAF5"],
    },
  }),
  // https://github.com/rose-pine/ghostty (chrome: https://github.com/rose-pine/palette)
  "rose-pine": theme({
    label: "Rosé Pine", note: "Muted pine, rose and iris",
    chrome: { background: "#191724", surface: "#1F1D2E", text: "#E0DEF4", muted: "#908CAA", accent: "#C4A7E7", danger: "#EB6F92" },
    terminal: {
      background: "#191724", foreground: "#E0DEF4", cursor: "#E0DEF4", cursorAccent: "#191724",
      selectionBackground: "#403D52", selectionForeground: "#E0DEF4",
      ansi: ["#26233A", "#EB6F92", "#31748F", "#F6C177", "#9CCFD8", "#C4A7E7", "#EBBCBA", "#E0DEF4",
        "#6E6A86", "#EB6F92", "#31748F", "#F6C177", "#9CCFD8", "#C4A7E7", "#EBBCBA", "#E0DEF4"],
    },
  }),
  // https://github.com/rebelot/kanagawa.nvim (extras/ghostty/kanagawa-wave)
  kanagawa: theme({
    label: "Kanagawa Wave", note: "Ink wash after Hokusai",
    chrome: { background: "#16161D", surface: "#2A2A37", text: "#DCD7BA", muted: "#727169", accent: "#7E9CD8", danger: "#E82424" },
    terminal: {
      background: "#1F1F28", foreground: "#DCD7BA", cursor: "#C8C093",
      selectionBackground: "#2D4F67", selectionForeground: "#C8C093",
      ansi: ["#16161D", "#C34043", "#76946A", "#C0A36E", "#7E9CD8", "#957FB8", "#6A9589", "#C8C093",
        "#727169", "#E82424", "#98BB6C", "#E6C384", "#7FB4CA", "#938AA9", "#7AA89F", "#DCD7BA"],
    },
  }),
  // https://github.com/rebelot/kanagawa.nvim (extras/ghostty/kanagawa-dragon)
  "kanagawa-dragon": theme({
    label: "Kanagawa Dragon", note: "Kanagawa in charcoal and ash",
    chrome: { background: "#0D0C0C", surface: "#282727", text: "#C5C9C5", muted: "#737C73", accent: "#8BA4B0", danger: "#C4746E" },
    terminal: {
      background: "#181616", foreground: "#C5C9C5", cursor: "#C8C093",
      selectionBackground: "#2D4F67", selectionForeground: "#C8C093",
      ansi: ["#0D0C0C", "#C4746E", "#8A9A7B", "#C4B28A", "#8BA4B0", "#A292A3", "#8EA4A2", "#C8C093",
        "#A6A69C", "#E46876", "#87A987", "#E6C384", "#7FB4CA", "#938AA9", "#7AA89F", "#C5C9C5"],
    },
  }),
  // https://github.com/morhetz/gruvbox (terminal: https://github.com/morhetz/gruvbox-contrib xresources)
  "gruvbox-dark": theme({
    label: "Gruvbox Dark", note: "Retro groove, warm and earthy",
    chrome: { background: "#1D2021", surface: "#32302F", text: "#EBDBB2", muted: "#A89984", accent: "#FABD2F", danger: "#FB4934" },
    terminal: {
      // Gruvbox selects by inverting; bg2 is the gruvbox grey for a filled one.
      background: "#282828", foreground: "#EBDBB2", cursor: "#EBDBB2", selectionBackground: "#504945",
      ansi: ["#282828", "#CC241D", "#98971A", "#D79921", "#458588", "#B16286", "#689D6A", "#A89984",
        "#928374", "#FB4934", "#B8BB26", "#FABD2F", "#83A598", "#D3869B", "#8EC07C", "#EBDBB2"],
    },
  }),
  // https://github.com/sainnhe/everforest (dark, medium; colors/everforest.vim terminal colours)
  everforest: theme({
    label: "Everforest", note: "Calm green forest, medium contrast",
    chrome: { background: "#232A2E", surface: "#343F44", text: "#D3C6AA", muted: "#859289", accent: "#A7C080", danger: "#E67E80" },
    terminal: {
      background: "#2D353B", foreground: "#D3C6AA", cursor: "#D3C6AA", selectionBackground: "#543A48",
      ansi: ["#475258", "#E67E80", "#A7C080", "#DBBC7F", "#7FBBB3", "#D699B6", "#83C092", "#D3C6AA",
        "#475258", "#E67E80", "#A7C080", "#DBBC7F", "#7FBBB3", "#D699B6", "#83C092", "#D3C6AA"],
    },
  }),
  // https://github.com/nordtheme/alacritty (src/nord.yaml)
  nord: theme({
    label: "Nord", note: "Arctic, north-bluish calm",
    chrome: { background: "#2E3440", surface: "#3B4252", text: "#D8DEE9", muted: "#616E88", accent: "#88C0D0", danger: "#BF616A" },
    terminal: {
      background: "#2E3440", foreground: "#D8DEE9", cursor: "#D8DEE9", selectionBackground: "#4C566A",
      ansi: ["#3B4252", "#BF616A", "#A3BE8C", "#EBCB8B", "#81A1C1", "#B48EAD", "#88C0D0", "#E5E9F0",
        "#4C566A", "#BF616A", "#A3BE8C", "#EBCB8B", "#81A1C1", "#B48EAD", "#8FBCBB", "#ECEFF4"],
    },
  }),
  // https://github.com/dracula/ghostty (chrome: https://github.com/dracula/visual-studio-code)
  dracula: theme({
    label: "Dracula", note: "Vivid neon on dusk purple",
    chrome: { background: "#21222C", surface: "#343746", text: "#F8F8F2", muted: "#6272A4", accent: "#BD93F9", danger: "#FF5555" },
    terminal: {
      background: "#282A36", foreground: "#F8F8F2", cursor: "#F8F8F2", cursorAccent: "#282A36",
      selectionBackground: "#44475A", selectionForeground: "#F8F8F2",
      ansi: ["#21222C", "#FF5555", "#50FA7B", "#F1FA8C", "#BD93F9", "#FF79C6", "#8BE9FD", "#F8F8F2",
        "#6272A4", "#FF6E6E", "#69FF94", "#FFFFA5", "#D6ACFF", "#FF92DF", "#A4FFFF", "#FFFFFF"],
    },
  }),
  // https://github.com/primer/github-vscode-theme (dark default; colours from @primer/primitives 7.10.0)
  "github-dark": theme({
    label: "GitHub Dark", note: "GitHub's own dark default",
    chrome: { background: "#010409", surface: "#161B22", text: "#E6EDF3", muted: "#7D8590", accent: "#2F81F7", danger: "#F85149" },
    terminal: {
      // The editor selection is accent.fg at 20%, flattened onto the canvas.
      background: "#0D1117", foreground: "#E6EDF3", cursor: "#2F81F7",
      selectionBackground: mix("#0D1117", "#2F81F7", 0.2),
      ansi: ["#484F58", "#FF7B72", "#3FB950", "#D29922", "#58A6FF", "#BC8CFF", "#39C5CF", "#B1BAC4",
        "#6E7681", "#FFA198", "#56D364", "#E3B341", "#79C0FF", "#D2A8FF", "#56D4DD", "#FFFFFF"],
    },
  }),
  // https://github.com/EdenEast/nightfox.nvim (extra/carbonfox/carbonfox.ghostty)
  carbonfox: theme({
    label: "Carbonfox", note: "Nightfox on IBM Carbon black",
    chrome: { background: "#0C0C0C", surface: "#252525", text: "#F2F4F8", muted: "#7B7C7E", accent: "#78A9FF", danger: "#EE5396" },
    terminal: {
      background: "#161616", foreground: "#F2F4F8", cursor: "#F2F4F8", cursorAccent: "#161616",
      selectionBackground: "#2A2A2A", selectionForeground: "#F2F4F8",
      ansi: ["#282828", "#EE5396", "#25BE6A", "#08BDBA", "#78A9FF", "#BE95FF", "#33B1FF", "#DFDFE0",
        "#484848", "#F16DA6", "#46C880", "#2DC7C4", "#8CB6FF", "#C8A5FF", "#52BDFF", "#E4E4E5"],
    },
  }),
  // https://github.com/catppuccin/ghostty (chrome: https://github.com/catppuccin/palette)
  "catppuccin-latte": theme({
    label: "Catppuccin Latte", note: "Catppuccin's light, milky pastels", light: true,
    chrome: { background: "#E6E9EF", surface: "#EFF1F5", text: "#4C4F69", muted: "#6C6F85", accent: "#8839EF", danger: "#D20F39" },
    terminal: {
      background: "#EFF1F5", foreground: "#4C4F69", cursor: "#DC8A78", cursorAccent: "#EFF1F5",
      selectionBackground: "#D8DAE1", selectionForeground: "#4C4F69",
      ansi: ["#5C5F77", "#D20F39", "#40A02B", "#DF8E1D", "#1E66F5", "#EA76CB", "#179299", "#ACB0BE",
        "#6C6F85", "#D20F39", "#40A02B", "#DF8E1D", "#1E66F5", "#EA76CB", "#179299", "#BCC0CC"],
    },
  }),
  // https://github.com/folke/tokyonight.nvim (extras/ghostty/tokyonight_day)
  "tokyo-night-day": theme({
    label: "Tokyo Night Day", note: "Tokyo Night in daylight", light: true,
    chrome: { background: "#D0D5E3", surface: "#E1E2E7", text: "#3760BF", muted: "#68709A", accent: "#2E7DE9", danger: "#F52A65" },
    terminal: {
      background: "#E1E2E7", foreground: "#3760BF", cursor: "#3760BF", cursorAccent: "#E1E2E7",
      selectionBackground: "#B7C1E3", selectionForeground: "#3760BF",
      ansi: ["#B4B5B9", "#F52A65", "#587539", "#8C6C3E", "#2E7DE9", "#9854F1", "#007197", "#6172B0",
        "#A1A6C5", "#FF4774", "#5C8524", "#A27629", "#358AFF", "#A463FF", "#007EA8", "#3760BF"],
    },
  }),
  // https://github.com/rose-pine/ghostty (chrome: https://github.com/rose-pine/palette)
  "rose-pine-dawn": theme({
    label: "Rosé Pine Dawn", note: "Rosé Pine on morning paper", light: true,
    chrome: { background: "#FAF4ED", surface: "#FFFAF3", text: "#575279", muted: "#797593", accent: "#907AA9", danger: "#B4637A" },
    terminal: {
      background: "#FAF4ED", foreground: "#575279", cursor: "#575279", cursorAccent: "#FAF4ED",
      selectionBackground: "#DFDAD9", selectionForeground: "#575279",
      ansi: ["#F2E9E1", "#B4637A", "#286983", "#EA9D34", "#56949F", "#907AA9", "#D7827E", "#575279",
        "#9893A5", "#B4637A", "#286983", "#EA9D34", "#56949F", "#907AA9", "#D7827E", "#575279"],
    },
  }),
  // https://github.com/rebelot/kanagawa.nvim (extras/ghostty/kanagawa-lotus)
  "kanagawa-lotus": theme({
    label: "Kanagawa Lotus", note: "Kanagawa on aged rice paper", light: true,
    chrome: { background: "#E5DDB0", surface: "#F2ECBC", text: "#545464", muted: "#8A8980", accent: "#4D699B", danger: "#C84053" },
    terminal: {
      background: "#F2ECBC", foreground: "#545464", cursor: "#43436C",
      selectionBackground: "#C9CBD1", selectionForeground: "#43436C",
      ansi: ["#1F1F28", "#C84053", "#6F894E", "#77713F", "#4D699B", "#B35B79", "#597B75", "#545464",
        "#8A8980", "#D7474B", "#6E915F", "#836F4A", "#6693BF", "#624C83", "#5E857A", "#43436C"],
    },
  }),
  // https://github.com/morhetz/gruvbox (terminal: https://github.com/morhetz/gruvbox-contrib xresources)
  "gruvbox-light": theme({
    label: "Gruvbox Light", note: "Gruvbox on warm cream", light: true,
    chrome: { background: "#F2E5BC", surface: "#F9F5D7", text: "#3C3836", muted: "#7C6F64", accent: "#076678", danger: "#9D0006" },
    terminal: {
      background: "#FBF1C7", foreground: "#3C3836", cursor: "#3C3836", selectionBackground: "#D5C4A1",
      ansi: ["#FDF4C1", "#CC241D", "#98971A", "#D79921", "#458588", "#B16286", "#689D6A", "#7C6F64",
        "#928374", "#9D0006", "#79740E", "#B57614", "#076678", "#8F3F71", "#427B58", "#3C3836"],
    },
  }),
  // https://github.com/sainnhe/everforest (light, medium; colors/everforest.vim terminal colours)
  "everforest-light": theme({
    label: "Everforest Light", note: "Everforest on soft parchment", light: true,
    chrome: { background: "#EFEBD4", surface: "#FDF6E3", text: "#5C6A72", muted: "#939F91", accent: "#3A94C5", danger: "#F85552" },
    terminal: {
      background: "#FDF6E3", foreground: "#5C6A72", cursor: "#5C6A72", selectionBackground: "#EAEDC8",
      ansi: ["#5C6A72", "#F85552", "#8DA101", "#DFA000", "#3A94C5", "#DF69BA", "#35A77C", "#E6E2CC",
        "#5C6A72", "#F85552", "#8DA101", "#DFA000", "#3A94C5", "#DF69BA", "#35A77C", "#E6E2CC"],
    },
  }),
  // https://github.com/primer/github-vscode-theme (light default; colours from @primer/primitives 7.10.0)
  "github-light": theme({
    label: "GitHub Light", note: "GitHub's own light default", light: true,
    chrome: { background: "#F6F8FA", surface: "#FFFFFF", text: "#1F2328", muted: "#656D76", accent: "#0969DA", danger: "#CF222E" },
    terminal: {
      background: "#FFFFFF", foreground: "#1F2328", cursor: "#0969DA",
      selectionBackground: mix("#FFFFFF", "#0969DA", 0.2),
      ansi: ["#24292F", "#CF222E", "#116329", "#4D2D00", "#0969DA", "#8250DF", "#1B7C83", "#6E7781",
        "#57606A", "#A40E26", "#1A7F37", "#633C01", "#218BFF", "#A475F9", "#3192AA", "#8C959F"],
    },
  }),
};

// Ids that earlier releases shipped, mapped to the nearest theme in the
// current list. A saved config keeps its id; it only resolves here.
export const THEME_ALIASES = {
  "catppuccin-macchiato": "catppuccin-mocha",
  "catppuccin-frappe": "catppuccin-mocha",
  "rose-pine-moon": "rose-pine",
  "github-dark-dimmed": "github-dark",
  "one-dark": "tokyo-night-storm",
  "ayu-mirage": "tokyo-night-storm",
  cobalt2: "tokyo-night-storm",
  "material-ocean": "tokyo-night",
  "night-owl": "tokyo-night",
  oxocarbon: "carbonfox",
  monokai: "dracula",
  horizon: "rose-pine",
  "solarized-dark": "nord",
  "solarized-light": "everforest-light",
};

// The Settings chooser's sections: dark themes, then light, each in the
// order TERMINAL_THEMES lists them.
export function themeGroups() {
  const ids = Object.keys(TERMINAL_THEMES);
  return [
    ["Dark", ids.filter((id) => !TERMINAL_THEMES[id].light)],
    ["Light", ids.filter((id) => TERMINAL_THEMES[id].light)],
  ];
}

export function resolveThemeId(id) {
  if (id === CUSTOM_THEME) return id;
  const resolved = THEME_ALIASES[id] || id;
  return Object.hasOwn(TERMINAL_THEMES, resolved) ? resolved : DEFAULT_THEME;
}

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

function luminance(hex) {
  const channels = rgb(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

export function contrast(a, b) {
  const high = Math.max(luminance(a), luminance(b));
  const low = Math.min(luminance(a), luminance(b));
  return (high + 0.05) / (low + 0.05);
}

function readableColor(candidate, endpoint, backgrounds, minimum = 4.5) {
  for (let step = 0; step <= 20; step += 1) {
    const value = mix(candidate, endpoint, step / 20);
    if (backgrounds.every((background) => contrast(value, background) >= minimum)) return value;
  }
  return endpoint;
}

export function customColors(value = {}) {
  return Object.fromEntries(Object.entries(CUSTOM_THEME_DEFAULTS).map(([key, fallback]) => [
    key,
    normalizeHex(value[key], fallback.toUpperCase()),
  ]));
}

export function getTheme(id, custom = {}) {
  if (id !== CUSTOM_THEME) return TERMINAL_THEMES[resolveThemeId(id)];
  const colors = customColors(custom);
  const graphite = TERMINAL_THEMES.graphite.xterm;
  return {
    label: "Custom",
    note: "Your own app and terminal colours",
    light: luminance(colors.background) > 0.5,
    accent: colors.accent,
    chrome: colors,
    xterm: withDerived({
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
    }),
  };
}

// The workspace colours: one per open view, taken from the theme's own ANSI
// hues so a view frame reads as part of the palette (workspace_views.js).
export const VIEW_COLOR_KEYS = ["yellow", "blue", "green", "magenta", "red", "cyan"];

// Every CSS custom property applyChromeTheme() writes, for the theme `id`.
// Pure, so tests can compare the default against the app.css :root block.
export function chromeTokens(id, custom = {}) {
  const selected = getTheme(id, custom);
  // Derive secondary surfaces from six restrained semantic colours instead of
  // spraying terminal ANSI colours over the UI. Status and view colours are
  // the exception: they borrow the theme's own hues, made readable.
  const colors = selected.chrome || CUSTOM_THEME_DEFAULTS;
  const surface = normalizeHex(colors.surface, colors.background);
  const background = normalizeHex(colors.background, CUSTOM_THEME_DEFAULTS.background);
  const light = typeof colors.light === "boolean" ? colors.light : luminance(background) > 0.5;
  const rawText = normalizeHex(colors.text, CUSTOM_THEME_DEFAULTS.text);
  const accent = normalizeHex(colors.accent, CUSTOM_THEME_DEFAULTS.accent);
  const rawDanger = normalizeHex(colors.danger, CUSTOM_THEME_DEFAULTS.danger);
  // Light themes tint surfaces toward black; dark themes toward white.
  const lift = light ? "#000000" : "#FFFFFF";
  const field = mix(background, surface, 0.4);
  const contrastEndpoint = light ? "#000000" : "#FFFFFF";
  const chromeBackgrounds = [background, surface, field];
  const text = readableColor(rawText, contrastEndpoint, chromeBackgrounds);
  const textSoft = readableColor(mix(text, background, 0.16), text, chromeBackgrounds);
  const muted = readableColor(
    normalizeHex(colors.muted, CUSTOM_THEME_DEFAULTS.muted),
    text,
    chromeBackgrounds,
  );
  const darkAccentText = "#111318";
  const onAccent = contrast(accent, "#FFFFFF") >= contrast(accent, darkAccentText)
    ? "#FFFFFF"
    : darkAccentText;
  const danger = readableColor(rawDanger, contrastEndpoint, chromeBackgrounds);
  const hue = (key) => normalizeHex(selected.xterm[key], accent);
  // A shadow is ink on both kinds of paper. On a light theme it is the
  // theme's own ink at half strength, so it reads as a shadow and not a smudge.
  const shadowColor = light ? rgba(mix(text, "#000000", 0.4), 0.5) : "#000000";
  // The scrim dims what is behind a sheet. Paper over paper would be no scrim
  // at all, so a light theme dims with a thin layer of its ink instead.
  const scrim = light
    ? rgba(mix(text, "#000000", 0.3), 0.36)
    : rgba(mix(background, "#000000", 0.6), 0.72);
  const values = {
    "--bg": background,
    "--surface": surface,
    "--surface-raised": mix(surface, lift, 0.04),
    "--surface-soft": mix(surface, lift, 0.075),
    "--well": background,
    "--card": mix(background, surface, 0.62),
    "--field": field,
    "--text": text,
    "--text-soft": textSoft,
    "--muted": muted,
    "--accent": accent,
    "--accent-soft": mix(background, accent, 0.17),
    "--accent-hover": mix(accent, lift, 0.16),
    "--accent-press": mix(accent, light ? "#FFFFFF" : "#000000", 0.12),
    "--accent-border": mix(background, accent, 0.5),
    "--accent-ring": rgba(accent, 0.14),
    "--on-accent": onAccent,
    "--sage": mix(muted, "#A7D5B3", 0.36),
    "--danger": danger,
    "--danger-soft": rgba(danger, 0.1),
    "--success": readableColor(hue("green"), contrastEndpoint, chromeBackgrounds),
    "--warning": readableColor(hue("yellow"), contrastEndpoint, chromeBackgrounds),
    "--line": mix(surface, text, 0.09),
    "--line-strong": mix(surface, text, 0.16),
    "--line-hover": mix(surface, text, 0.3),
    "--shadow-color": shadowColor,
    "--scrim": scrim,
  };
  VIEW_COLOR_KEYS.forEach((key, index) => {
    values[`--view-${index + 1}`] = readableColor(hue(key), contrastEndpoint, [background, surface], 3);
  });
  return { light, values };
}

export function applyChromeTheme(id, custom = {}) {
  const { light, values } = chromeTokens(id, custom);
  const root = document.documentElement.style;
  for (const [key, value] of Object.entries(values)) root.setProperty(key, value);
  // app.css keys color-scheme off this, so native scrollbars, the colour
  // inputs and any unstyled control follow the theme's mode.
  document.documentElement.dataset.themeMode = light ? "light" : "dark";
}
