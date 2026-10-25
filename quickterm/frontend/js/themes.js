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
//
// `chrome` names six colours: `background` is the editor's sidebar or panel
// colour (the sidebar, sheet heads and wells here), `surface` its editor or
// popup colour (sheets, cards), `text`, `muted` (its comment or description
// colour), `accent` and `danger`. An optional seventh, `selection`, is the
// palette's own selected-row colour (a list selection, `sel0`, `surface1`);
// without it the terminal's selection colour stands in. Upstream values with
// an alpha channel are flattened with over() onto the colour they sit on in
// that editor, so nothing here is a guess.

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
export const OPTIONAL_CHROME_KEYS = ["selection"];

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
  // 4.38:1 on --surface, so readableColor() would drag it back up anyway. On
  // --surface-soft even 62% is short (4.19:1), and the token lands at #a09c92.
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
  // https://github.com/catppuccin/ghostty (themes/catppuccin-macchiato.conf; chrome: https://github.com/catppuccin/palette)
  "catppuccin-macchiato": theme({
    label: "Catppuccin Macchiato", note: "Catppuccin between Mocha and Frappé",
    chrome: { background: "#1E2030", surface: "#363A4F", selection: "#494D64", text: "#CAD3F5", muted: "#939AB7", accent: "#C6A0F6", danger: "#ED8796" },
    terminal: {
      background: "#24273A", foreground: "#CAD3F5", cursor: "#F4DBD6", cursorAccent: "#181926",
      selectionBackground: "#3A3E53", selectionForeground: "#CAD3F5",
      ansi: ["#494D64", "#ED8796", "#A6DA95", "#EED49F", "#8AADF4", "#F5BDE6", "#8BD5CA", "#A5ADCB",
        "#5B6078", "#ED8796", "#A6DA95", "#EED49F", "#8AADF4", "#F5BDE6", "#8BD5CA", "#B8C0E0"],
    },
  }),
  // https://github.com/catppuccin/ghostty (themes/catppuccin-frappe.conf; chrome: https://github.com/catppuccin/palette)
  "catppuccin-frappe": theme({
    label: "Catppuccin Frappé", note: "Catppuccin's muted, frosty slate",
    chrome: { background: "#292C3C", surface: "#414559", selection: "#51576D", text: "#C6D0F5", muted: "#949CBB", accent: "#CA9EE6", danger: "#E78284" },
    terminal: {
      background: "#303446", foreground: "#C6D0F5", cursor: "#F2D5CF", cursorAccent: "#232634",
      selectionBackground: "#44495D", selectionForeground: "#C6D0F5",
      ansi: ["#51576D", "#E78284", "#A6D189", "#E5C890", "#8CAAEE", "#F4B8E4", "#81C8BE", "#A5ADCE",
        "#626880", "#E78284", "#A6D189", "#E5C890", "#8CAAEE", "#F4B8E4", "#81C8BE", "#B5BFE2"],
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
  // https://github.com/folke/tokyonight.nvim (extras/ghostty/tokyonight_moon; chrome: lua/tokyonight/colors/moon.lua)
  "tokyo-night-moon": theme({
    label: "Tokyo Night Moon", note: "Tokyo Night under a pale blue moon",
    chrome: { background: "#1E2030", surface: "#2F334D", selection: "#2D3F76", text: "#C8D3F5", muted: "#737AA2", accent: "#82AAFF", danger: "#FF757F" },
    terminal: {
      background: "#222436", foreground: "#C8D3F5", cursor: "#C8D3F5",
      selectionBackground: "#2D3F76", selectionForeground: "#C8D3F5",
      ansi: ["#1B1D2B", "#FF757F", "#C3E88D", "#FFC777", "#82AAFF", "#C099FF", "#86E1FC", "#828BB8",
        "#444A73", "#FF8D94", "#C7FB6D", "#FFD8AB", "#9AB8FF", "#CAABFF", "#B2EBFF", "#C8D3F5"],
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
  // https://github.com/rose-pine/ghostty (dist/rose-pine-moon; chrome: https://github.com/rose-pine/palette)
  "rose-pine-moon": theme({
    label: "Rosé Pine Moon", note: "Rosé Pine on a lighter violet dusk",
    chrome: { background: "#232136", surface: "#2A273F", selection: "#44415A", text: "#E0DEF4", muted: "#908CAA", accent: "#C4A7E7", danger: "#EB6F92" },
    terminal: {
      background: "#232136", foreground: "#E0DEF4", cursor: "#E0DEF4", cursorAccent: "#232136",
      selectionBackground: "#44415A", selectionForeground: "#E0DEF4",
      ansi: ["#393552", "#EB6F92", "#3E8FB0", "#F6C177", "#9CCFD8", "#C4A7E7", "#EA9A97", "#E0DEF4",
        "#6E6A86", "#EB6F92", "#3E8FB0", "#F6C177", "#9CCFD8", "#C4A7E7", "#EA9A97", "#E0DEF4"],
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
  // https://github.com/sainnhe/gruvbox-material (autoload/gruvbox_material.vim: dark, medium, material
  // foreground; terminal colours from colors/gruvbox-material.vim)
  "gruvbox-material": theme({
    label: "Gruvbox Material", note: "Gruvbox softened for long sessions",
    chrome: { background: "#1B1B1B", surface: "#32302F", selection: "#45403D", text: "#D4BE98", muted: "#928374", accent: "#D8A657", danger: "#EA6962" },
    terminal: {
      background: "#282828", foreground: "#D4BE98", cursor: "#D4BE98", selectionBackground: "#45403D",
      ansi: ["#5A524C", "#EA6962", "#A9B665", "#D8A657", "#7DAEA3", "#D3869B", "#89B482", "#D4BE98",
        "#5A524C", "#EA6962", "#A9B665", "#D8A657", "#7DAEA3", "#D3869B", "#89B482", "#D4BE98"],
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
  // https://github.com/primer/github-vscode-theme (dark dimmed; colours from @primer/primitives 7.10.0)
  "github-dark-dimmed": theme({
    label: "GitHub Dark Dimmed", note: "GitHub's softer, low-glare dark",
    chrome: {
      background: "#1C2128", surface: "#2D333B", text: "#ADBAC7", muted: "#768390", accent: "#539BF5", danger: "#E5534B",
      // accent.subtle (rgba(65, 132, 228, 0.15)) on canvas.subtle.
      selection: over("#2D333B", "#4184E4", 0.15),
    },
    terminal: {
      background: "#22272E", foreground: "#ADBAC7", cursor: "#539BF5",
      selectionBackground: mix("#22272E", "#539BF5", 0.2),
      ansi: ["#545D68", "#F47067", "#57AB5A", "#C69026", "#539BF5", "#B083F0", "#39C5CF", "#909DAB",
        "#636E7B", "#FF938A", "#6BC46D", "#DAAA3F", "#6CB6FF", "#DCBDFB", "#56D4DD", "#CDD9E5"],
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
  // https://github.com/EdenEast/nightfox.nvim (extra/nightfox/nightfox.ghostty; chrome: lua/nightfox/palette/nightfox.lua)
  nightfox: theme({
    label: "Nightfox", note: "Deep ocean blue with soft pastels",
    chrome: { background: "#131A24", surface: "#212E3F", selection: "#2B3B51", text: "#CDCECF", muted: "#738091", accent: "#719CD6", danger: "#C94F6D" },
    terminal: {
      background: "#192330", foreground: "#CDCECF", cursor: "#CDCECF",
      selectionBackground: "#2B3B51", selectionForeground: "#CDCECF",
      ansi: ["#393B44", "#C94F6D", "#81B29A", "#DBC074", "#719CD6", "#9D79D6", "#63CDCF", "#DFDFE0",
        "#575860", "#D16983", "#8EBAA4", "#E0C989", "#86ABDC", "#BAA1E2", "#7AD5D6", "#E4E4E5"],
    },
  }),
  // https://github.com/EdenEast/nightfox.nvim (extra/duskfox/duskfox.ghostty; chrome: lua/nightfox/palette/duskfox.lua)
  duskfox: theme({
    label: "Duskfox", note: "Nightfox in violet twilight",
    chrome: { background: "#191726", surface: "#2D2A45", selection: "#433C59", text: "#E0DEF4", muted: "#817C9C", accent: "#C4A7E7", danger: "#EB6F92" },
    terminal: {
      background: "#232136", foreground: "#E0DEF4", cursor: "#E0DEF4",
      selectionBackground: "#433C59", selectionForeground: "#E0DEF4",
      ansi: ["#393552", "#EB6F92", "#A3BE8C", "#F6C177", "#569FBA", "#C4A7E7", "#9CCFD8", "#E0DEF4",
        "#47407D", "#F083A2", "#B1D196", "#F9CB8C", "#65B1CD", "#CCB1ED", "#A6DAE3", "#E2E0F7"],
    },
  }),
  // https://github.com/EdenEast/nightfox.nvim (extra/terafox/terafox.ghostty; chrome: lua/nightfox/palette/terafox.lua)
  terafox: theme({
    label: "Terafox", note: "Nightfox in deep teal and clay",
    chrome: { background: "#0F1C1E", surface: "#1D3337", selection: "#293E40", text: "#E6EAEA", muted: "#6D7F8B", accent: "#7AA4A1", danger: "#E85C51" },
    terminal: {
      background: "#152528", foreground: "#E6EAEA", cursor: "#E6EAEA",
      selectionBackground: "#293E40", selectionForeground: "#E6EAEA",
      ansi: ["#2F3239", "#E85C51", "#7AA4A1", "#FDA47F", "#5A93AA", "#AD5C7C", "#A1CDD8", "#EBEBEB",
        "#4E5157", "#EB746B", "#8EB2AF", "#FDB292", "#73A3B7", "#B97490", "#AFD4DE", "#EEEEEE"],
    },
  }),
  // https://github.com/zed-industries/zed (assets/themes/one/one.json, "One Dark")
  "one-dark": theme({
    label: "One Dark", note: "Atom's classic, as Zed ships it",
    chrome: { background: "#2F343E", surface: "#3B414D", selection: "#454A56", text: "#DCE0E5", muted: "#A9AFBC", accent: "#74ADE8", danger: "#D07277" },
    terminal: {
      background: "#282C34", foreground: "#ABB2BF", cursor: "#74ADE8",
      // The player selection (#74ADE83D) on the terminal background.
      selectionBackground: over("#282C34", "#74ADE83D"),
      ansi: ["#282C34", "#E06C75", "#98C379", "#E5C07B", "#61AFEF", "#C678DD", "#56B6C2", "#ABB2BF",
        "#636D83", "#EA858B", "#AAD581", "#FFD885", "#85C1FF", "#D398EB", "#6ED5DE", "#FAFAFA"],
    },
  }),
  // https://github.com/ayu-theme/vscode-ayu (ayu-dark.json)
  "ayu-dark": theme({
    label: "Ayu Dark", note: "Ayu's inky dark with marigold",
    chrome: {
      background: "#0D1017", surface: "#141821", text: "#BFBDB6", muted: "#5A6378", accent: "#E6B450", danger: "#D95757",
      selection: over("#0D1017", "#47526640"),
    },
    terminal: {
      background: "#0D1017", foreground: "#BFBDB6", cursor: "#E6B450",
      selectionBackground: over("#0D1017", "#3388FF40"),
      ansi: ["#1B1F29", "#F06B73", "#70BF56", "#FDB04C", "#4FBFFF", "#D0A1FF", "#93E2C8", "#C7C7C7",
        "#686868", "#F07178", "#AAD94C", "#FFB454", "#59C2FF", "#D2A6FF", "#95E6CB", "#FFFFFF"],
    },
  }),
  // https://github.com/ayu-theme/vscode-ayu (ayu-mirage.json)
  "ayu-mirage": theme({
    label: "Ayu Mirage", note: "Ayu on a hazy blue-grey",
    chrome: {
      background: "#1F2430", surface: "#282E3B", text: "#CCCAC2", muted: "#707A8C", accent: "#FFCC66", danger: "#FF6666",
      selection: over("#1F2430", "#63759926"),
    },
    terminal: {
      background: "#1F2430", foreground: "#CCCAC2", cursor: "#FFCC66",
      selectionBackground: over("#1F2430", "#409FFF40"),
      ansi: ["#171B24", "#F28273", "#87D96C", "#FCCA60", "#6ACDFF", "#DDBBFF", "#93E2C8", "#C7C7C7",
        "#686868", "#F28779", "#D5FF80", "#FFCD66", "#73D0FF", "#DFBFFF", "#95E6CB", "#FFFFFF"],
    },
  }),
  // https://github.com/sdras/night-owl-vscode-theme (themes/Night Owl-color-theme.json)
  "night-owl": theme({
    label: "Night Owl", note: "Midnight blue for night coding",
    chrome: {
      background: "#011627", surface: "#0B2942", text: "#D6DEEB", muted: "#637777", accent: "#7E57C2", danger: "#EF5350",
      selection: over("#011627", "#234D708C"),
    },
    terminal: {
      background: "#011627", foreground: "#D6DEEB", cursor: "#80A4C2",
      selectionBackground: over("#011627", "#1B90DD4D"),
      ansi: ["#011627", "#EF5350", "#22DA6E", "#C5E478", "#82AAFF", "#C792EA", "#21C7A8", "#FFFFFF",
        "#575656", "#EF5350", "#22DA6E", "#FFEB95", "#82AAFF", "#C792EA", "#7FDBCA", "#FFFFFF"],
    },
  }),
  // https://github.com/drcmda/poimandres-theme (themes/poimandres-color-theme.json)
  poimandres: theme({
    label: "Poimandres", note: "Minimal slate with mint highlights",
    chrome: {
      background: "#1B1E28", surface: over("#1B1E28", "#30334080"), selection: "#303340",
      text: "#A6ACCD", muted: "#767C9D", accent: "#5DE4C7", danger: "#D0679D",
    },
    terminal: {
      background: "#1B1E28", foreground: "#A6ACCD", cursor: "#A6ACCD",
      selectionBackground: over("#1B1E28", "#717CB425"),
      ansi: ["#1B1E28", "#D0679D", "#5DE4C7", "#FFFAC2", "#89DDFF", "#F087BD", "#89DDFF", "#FFFFFF",
        "#A6ACCD", "#D0679D", "#5DE4C7", "#FFFAC2", "#ADD7FF", "#F087BD", "#ADD7FF", "#FFFFFF"],
    },
  }),
  // https://github.com/raunofreiberg/vesper (themes/Vesper-dark-color-theme.json; it ships no terminal
  // colours, so the ANSI set is https://github.com/mbadolato/iTerm2-Color-Schemes windowsterminal/Vesper.json)
  vesper: theme({
    label: "Vesper", note: "Near-black with a peach glow",
    chrome: {
      background: "#101010", surface: "#1C1C1C", selection: "#232323", text: "#FFFFFF",
      muted: over("#101010", "#8B8B8B94"), accent: "#FFC799", danger: "#FF8080",
    },
    terminal: {
      background: "#101010", foreground: "#FFFFFF", cursor: "#ACB1AB",
      selectionBackground: over("#101010", "#FFFFFF25"),
      ansi: ["#101010", "#F5A191", "#90B99F", "#E6B99D", "#ACA1CF", "#E29ECA", "#EA83A5", "#A0A0A0",
        "#7E7E7E", "#FF8080", "#99FFE4", "#FFC799", "#B9AEDA", "#ECAAD6", "#F591B2", "#FFFFFF"],
    },
  }),
  // https://github.com/jolaleye/horizon-theme-vscode (themes/horizon.json; its terminal set leaves black
  // and white out, so the ANSI set is https://github.com/mbadolato/iTerm2-Color-Schemes windowsterminal/Horizon.json)
  horizon: theme({
    label: "Horizon", note: "Warm sunset pinks on dark violet",
    chrome: {
      background: "#1C1E26", surface: "#232530", text: "#D5D8DA", accent: "#E95378", danger: "#F43E5C",
      selection: over("#1C1E26", "#2E303E80"), muted: over("#1C1E26", "#BBBBBB4D"),
    },
    terminal: {
      background: "#1C1E26", foreground: "#D5D8DA", cursor: "#6C6F93",
      selectionBackground: over("#1C1E26", "#6C6F934D"),
      ansi: ["#000000", "#E95678", "#29D398", "#FAB795", "#26BBD9", "#EE64AC", "#59E1E3", "#E5E5E5",
        "#666666", "#EC6A88", "#3FDAA4", "#FBC3A7", "#3FC4DE", "#F075B5", "#6BE4E6", "#E5E5E5"],
    },
  }),
  // https://github.com/wesbos/cobalt2-vscode (theme/cobalt2.json)
  cobalt2: theme({
    label: "Cobalt2", note: "Electric blue with signal yellow",
    chrome: { background: "#15232D", surface: "#193549", selection: "#1F4662", text: "#FFFFFF", muted: "#AAAAAA", accent: "#FFC600", danger: "#FF628C" },
    terminal: {
      background: "#122738", foreground: "#FFFFFF", cursor: "#FFC600", selectionBackground: "#0050A4",
      ansi: ["#000000", "#FF628C", "#3AD900", "#FFC600", "#0088FF", "#FB94FF", "#80FCFF", "#FFFFFF",
        "#0050A4", "#FF628C", "#3AD900", "#FFC600", "#0088FF", "#FB94FF", "#80FCFF", "#FFFFFF"],
    },
  }),
  // https://github.com/altercation/solarized (README: the palette and its terminal mapping)
  "solarized-dark": theme({
    label: "Solarized Dark", note: "Ethan Schoonover's precise teal-black",
    chrome: { background: "#002B36", surface: "#073642", text: "#93A1A1", muted: "#586E75", accent: "#268BD2", danger: "#DC322F" },
    terminal: {
      background: "#002B36", foreground: "#839496", cursor: "#839496", selectionBackground: "#073642",
      ansi: ["#073642", "#DC322F", "#859900", "#B58900", "#268BD2", "#D33682", "#2AA198", "#EEE8D5",
        "#002B36", "#CB4B16", "#586E75", "#657B83", "#839496", "#6C71C4", "#93A1A1", "#FDF6E3"],
    },
  }),
  // https://github.com/sainnhe/sonokai (autoload/sonokai.vim, default style; terminal colours from colors/sonokai.vim)
  sonokai: theme({
    label: "Sonokai", note: "Monokai, calmer and higher contrast",
    chrome: { background: "#222327", surface: "#33353F", selection: "#414550", text: "#E2E2E3", muted: "#7F8490", accent: "#76CCE0", danger: "#FC5D7C" },
    terminal: {
      background: "#2C2E34", foreground: "#E2E2E3", cursor: "#E2E2E3", selectionBackground: "#414550",
      ansi: ["#181819", "#FC5D7C", "#9ED072", "#E7C664", "#76CCE0", "#B39DF3", "#F39660", "#E2E2E3",
        "#7F8490", "#FC5D7C", "#9ED072", "#E7C664", "#76CCE0", "#B39DF3", "#F39660", "#E2E2E3"],
    },
  }),
  // https://github.com/bluz71/vim-moonfly-colors (lua/moonfly/init.lua)
  moonfly: theme({
    label: "Moonfly", note: "Charcoal black with vivid moonlit hues",
    chrome: { background: "#080808", surface: "#1C1C1C", selection: "#323437", text: "#C6C6C6", muted: "#949494", accent: "#80A0FF", danger: "#FF5D5D" },
    terminal: {
      background: "#080808", foreground: "#C6C6C6", cursor: "#9E9E9E", selectionBackground: "#323437",
      ansi: ["#323437", "#FF5D5D", "#8CC85F", "#E3C78A", "#80A0FF", "#CF87E8", "#79DAC8", "#C6C6C6",
        "#949494", "#FF5189", "#36C692", "#C6C684", "#74B2FF", "#AE81FF", "#85DC85", "#E4E4E4"],
    },
  }),
  // https://github.com/cocopon/iceberg.vim (colors/iceberg.vim, dark)
  iceberg: theme({
    label: "Iceberg", note: "Cool indigo, quiet and even",
    chrome: { background: "#0F1117", surface: "#1E2132", selection: "#272C42", text: "#C6C8D1", muted: "#6B7089", accent: "#84A0C6", danger: "#E27878" },
    terminal: {
      background: "#161821", foreground: "#C6C8D1", cursor: "#C6C8D1", selectionBackground: "#272C42",
      ansi: ["#1E2132", "#E27878", "#B4BE82", "#E2A478", "#84A0C6", "#A093C7", "#89B8C2", "#C6C8D1",
        "#6B7089", "#E98989", "#C0CA8E", "#E9B189", "#91ACD1", "#ADA0D3", "#95C4CE", "#D2D4DE"],
    },
  }),
  // https://github.com/kepano/flexoki (windows-terminal/flexoki-dark.json; chrome and selection:
  // vscode/Flexoki-Dark-color-theme.json)
  "flexoki-dark": theme({
    label: "Flexoki Dark", note: "Inky paper tones, warm and calm",
    chrome: { background: "#100F0F", surface: "#1C1B1A", selection: "#403E3C", text: "#CECDC3", muted: "#878580", accent: "#3AA99F", danger: "#D14D41" },
    terminal: {
      background: "#100F0F", foreground: "#E6E4D9", cursor: "#DAD8CE",
      selectionBackground: over("#100F0F", "#CECDC333"),
      ansi: ["#100F0F", "#AF3029", "#66800B", "#C19C00", "#205EA6", "#5E409D", "#24837B", "#F2F0E5",
        "#575653", "#D14D41", "#879A39", "#D0A215", "#4385BE", "#8B7EC8", "#3AA99F", "#FFFCF0"],
    },
  }),
  // https://github.com/savq/melange-nvim (term/ghostty/melange_dark; chrome: lua/melange/palettes/dark.lua)
  melange: theme({
    label: "Melange", note: "Warm cocoa with spice colours",
    chrome: { background: "#292522", surface: "#34302C", selection: "#403A36", text: "#ECE1D7", muted: "#C1A78E", accent: "#E49B5D", danger: "#D47766" },
    terminal: {
      background: "#292522", foreground: "#ECE1D7", cursor: "#ECE1D7",
      selectionBackground: "#403A36", selectionForeground: "#ECE1D7",
      ansi: ["#34302C", "#BD8183", "#78997A", "#E49B5D", "#7F91B2", "#B380B0", "#7B9695", "#C1A78E",
        "#867462", "#D47766", "#85B695", "#EBC06D", "#A3A9CE", "#CF9BC2", "#89B3B6", "#ECE1D7"],
    },
  }),
  // https://github.com/protesilaos/modus-themes (modus-themes.el: modus-themes-vivendi-palette)
  "modus-vivendi": theme({
    label: "Modus Vivendi", note: "Pure black, WCAG AAA contrast",
    chrome: { background: "#000000", surface: "#1E1E1E", selection: "#2F447F", text: "#FFFFFF", muted: "#989898", accent: "#00BCFF", danger: "#FF5F59" },
    terminal: {
      background: "#000000", foreground: "#FFFFFF", cursor: "#FFFFFF", selectionBackground: "#5A5A5A",
      ansi: ["#000000", "#FF5F59", "#44BC44", "#D0BC00", "#2FAFFF", "#FEACD0", "#00D3D0", "#A6A6A6",
        "#595959", "#FF6B55", "#00C06F", "#FEC43F", "#79A8FF", "#B6A0FF", "#6AE4B9", "#FFFFFF"],
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
  // https://github.com/zed-industries/zed (assets/themes/one/one.json, "One Light")
  "one-light": theme({
    label: "One Light", note: "Atom's light classic, as Zed ships it", light: true,
    chrome: { background: "#EBEBEC", surface: "#FAFAFA", selection: "#CACACA", text: "#242529", muted: "#58585A", accent: "#5C78E2", danger: "#D36151" },
    terminal: {
      background: "#FAFAFA", foreground: "#2A2C33", cursor: "#5C78E2",
      selectionBackground: over("#FAFAFA", "#5C78E23D"),
      ansi: ["#000000", "#DE3E35", "#3F953A", "#D2B67C", "#2F5AF3", "#950095", "#0997B3", "#BBBBBB",
        "#000000", "#DE3E35", "#3F953A", "#D2B67C", "#2F5AF3", "#A00095", "#0BBCD6", "#FFFFFF"],
    },
  }),
  // https://github.com/ayu-theme/vscode-ayu (ayu-light.json)
  "ayu-light": theme({
    label: "Ayu Light", note: "Ayu on bright paper with orange", light: true,
    chrome: {
      background: "#F8F9FA", surface: "#FCFCFC", text: "#5C6166", muted: "#828E9F", accent: "#F29718", danger: "#E65050",
      selection: over("#F8F9FA", "#6B7D8F24"),
    },
    terminal: {
      background: "#F8F9FA", foreground: "#5C6166", cursor: "#F29718",
      selectionBackground: over("#F8F9FA", "#035BD626"),
      ansi: ["#000000", "#F06B6C", "#6CBF43", "#E7A100", "#21A1E2", "#A176CB", "#4ABC96", "#C7C7C7",
        "#686868", "#F07171", "#86B300", "#EBA400", "#22A4E6", "#A37ACC", "#4CBF99", "#D1D1D1"],
    },
  }),
  // https://github.com/altercation/solarized (README: the palette and its terminal mapping)
  "solarized-light": theme({
    label: "Solarized Light", note: "Solarized on warm cream", light: true,
    chrome: { background: "#EEE8D5", surface: "#FDF6E3", text: "#586E75", muted: "#93A1A1", accent: "#268BD2", danger: "#DC322F" },
    terminal: {
      background: "#FDF6E3", foreground: "#657B83", cursor: "#657B83", selectionBackground: "#EEE8D5",
      ansi: ["#073642", "#DC322F", "#859900", "#B58900", "#268BD2", "#D33682", "#2AA198", "#EEE8D5",
        "#002B36", "#CB4B16", "#586E75", "#657B83", "#839496", "#6C71C4", "#93A1A1", "#FDF6E3"],
    },
  }),
  // https://github.com/EdenEast/nightfox.nvim (extra/dayfox/dayfox.ghostty; chrome: lua/nightfox/palette/dayfox.lua)
  dayfox: theme({
    label: "Dayfox", note: "Nightfox on sunlit linen", light: true,
    chrome: { background: "#E4DCD4", surface: "#F6F2EE", selection: "#E7D2BE", text: "#3D2B5A", muted: "#837A72", accent: "#2848A9", danger: "#A5222F" },
    terminal: {
      background: "#F6F2EE", foreground: "#3D2B5A", cursor: "#3D2B5A",
      selectionBackground: "#E7D2BE", selectionForeground: "#3D2B5A",
      ansi: ["#352C24", "#A5222F", "#396847", "#AC5402", "#2848A9", "#6E33CE", "#287980", "#F2E9E1",
        "#534C45", "#B3434E", "#577F63", "#B86E28", "#4863B6", "#8452D5", "#488D93", "#F4ECE6"],
    },
  }),
  // https://github.com/EdenEast/nightfox.nvim (extra/dawnfox/dawnfox.ghostty; chrome: lua/nightfox/palette/dawnfox.lua)
  dawnfox: theme({
    label: "Dawnfox", note: "Nightfox at dawn, rose and pine", light: true,
    chrome: { background: "#EBE5DF", surface: "#FAF4ED", selection: "#D0D8D8", text: "#575279", muted: "#9893A5", accent: "#286983", danger: "#B4637A" },
    terminal: {
      background: "#FAF4ED", foreground: "#575279", cursor: "#575279",
      selectionBackground: "#D0D8D8", selectionForeground: "#575279",
      ansi: ["#575279", "#B4637A", "#618774", "#EA9D34", "#286983", "#907AA9", "#56949F", "#E5E9F0",
        "#5F5695", "#C26D85", "#629F81", "#EEA846", "#2D81A3", "#9A80B9", "#5CA7B4", "#E6EBF3"],
    },
  }),
  // https://github.com/cocopon/iceberg.vim (colors/iceberg.vim, light)
  "iceberg-light": theme({
    label: "Iceberg Light", note: "Iceberg on frosted glass", light: true,
    chrome: { background: "#DCDFE7", surface: "#E8E9EC", selection: "#C9CDD7", text: "#33374C", muted: "#8389A3", accent: "#2D539E", danger: "#CC517A" },
    terminal: {
      background: "#E8E9EC", foreground: "#33374C", cursor: "#33374C", selectionBackground: "#C9CDD7",
      ansi: ["#DCDFE7", "#CC517A", "#668E3D", "#C57339", "#2D539E", "#7759B4", "#3F83A6", "#33374C",
        "#8389A3", "#CC3768", "#598030", "#B6662D", "#22478E", "#6845AD", "#327698", "#262A3F"],
    },
  }),
  // https://github.com/kepano/flexoki (windows-terminal/flexoki-light.json; chrome:
  // vscode/Flexoki-Light-color-theme.json)
  "flexoki-light": theme({
    label: "Flexoki Light", note: "Flexoki on its own paper", light: true,
    chrome: { background: "#F2F0E5", surface: "#FFFCF0", selection: "#CECDC3", text: "#100F0F", muted: "#6F6E69", accent: "#24837B", danger: "#AF3029" },
    terminal: {
      background: "#FFFCF0", foreground: "#100F0F", cursor: "#100F0F", selectionBackground: "#CECDC3",
      ansi: ["#100F0F", "#AF3029", "#66800B", "#C19C00", "#205EA6", "#5E409D", "#24837B", "#F2F0E5",
        "#575653", "#D14D41", "#879A39", "#D0A215", "#4385BE", "#8B7EC8", "#3AA99F", "#FFFCF0"],
    },
  }),
  // https://github.com/savq/melange-nvim (term/ghostty/melange_light; chrome: lua/melange/palettes/light.lua)
  "melange-light": theme({
    label: "Melange Light", note: "Melange on oat paper", light: true,
    chrome: { background: "#E9E1DB", surface: "#F1F1F1", selection: "#D9D3CE", text: "#54433A", muted: "#7D6658", accent: "#BC5C00", danger: "#BF0021" },
    terminal: {
      background: "#F1F1F1", foreground: "#54433A", cursor: "#54433A",
      selectionBackground: "#D9D3CE", selectionForeground: "#54433A",
      ansi: ["#E9E1DB", "#C77B8B", "#6E9B72", "#BC5C00", "#7892BD", "#BE79BB", "#739797", "#7D6658",
        "#A98A78", "#BF0021", "#3A684A", "#A06D00", "#465AA4", "#904180", "#3D6568", "#54433A"],
    },
  }),
  // https://github.com/protesilaos/modus-themes (modus-themes.el: modus-themes-operandi-palette)
  "modus-operandi": theme({
    label: "Modus Operandi", note: "Pure white, WCAG AAA contrast", light: true,
    chrome: { background: "#F2F2F2", surface: "#FFFFFF", selection: "#C0DEFF", text: "#000000", muted: "#595959", accent: "#0031A9", danger: "#A60000" },
    terminal: {
      background: "#FFFFFF", foreground: "#000000", cursor: "#000000", selectionBackground: "#BDBDBD",
      ansi: ["#000000", "#A60000", "#006800", "#6F5500", "#0031A9", "#721045", "#005E8B", "#A6A6A6",
        "#595959", "#972500", "#00663F", "#884900", "#3548CF", "#531AB6", "#005F5F", "#FFFFFF"],
    },
  }),
};

// Ids that earlier releases shipped, mapped to the nearest theme in the
// current list. A saved config keeps its id; it only resolves here.
// Ids that are shipped again (one-dark, night-owl, solarized-*, ...) left
// this list when they came back.
export const THEME_ALIASES = {
  "material-ocean": "tokyo-night",
  oxocarbon: "carbonfox",
  monokai: "dracula",
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

// An upstream colour with alpha, as it lands on `base`: `color` is #RRGGBBAA,
// or #RRGGBB with the alpha given separately.
function over(base, color, alpha = Number.parseInt(color.slice(7, 9), 16) / 255) {
  return mix(base, color.slice(0, 7), alpha);
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

// The ground nearest `candidate`, on the way to `endpoint`, on which every
// ink reaches `minimum`. `endpoint` must already satisfy that.
function readableGround(candidate, endpoint, inks, minimum = 4.5) {
  for (let step = 0; step <= 20; step += 1) {
    const value = mix(candidate, endpoint, step / 20);
    if (inks.every((ink) => contrast(ink, value) >= minimum)) return value;
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

// The workspace colours, taken from the theme's own ANSI hues so an open
// workspace's sidebar dot reads as part of the palette (workspace_views.js).
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
  // The raised and hover steps move toward the theme's own ink rather than
  // toward plain white or black, so a blue theme's hover stays blue instead
  // of turning the same grey in every theme.
  const raised = mix(surface, rawText, 0.05);
  const soft = mix(surface, rawText, 0.095);
  const contrastEndpoint = light ? "#000000" : "#FFFFFF";
  // Every text token is held to 4.5:1 on each surface it sits on. That
  // includes the raised one (secondary buttons such as Kill in a confirmation,
  // selected config rows) and the soft one (hovered buttons, tabs and sidebar
  // actions, the selected palette row, the active menu item).
  const surfaces = [background, surface, field, raised, soft];
  const text = readableColor(rawText, contrastEndpoint, surfaces);
  const textSoft = readableColor(mix(text, background, 0.16), text, surfaces);
  const muted = readableColor(
    normalizeHex(colors.muted, CUSTOM_THEME_DEFAULTS.muted),
    text,
    surfaces,
  );
  const darkAccentText = "#111318";
  const onAccent = contrast(accent, "#FFFFFF") >= contrast(accent, darkAccentText)
    ? "#FFFFFF"
    : darkAccentText;
  const danger = readableColor(rawDanger, contrastEndpoint, surfaces);
  // The accent as a text colour (kbd chips, active tabs, links). The raw
  // accent stays for fills, borders and dots, which owe no text contrast.
  // It also sits on its own tint: the active Settings tab, profile marks and
  // the file browser's git chip.
  const accentSoft = mix(background, accent, 0.17);
  // Light upstream palettes keep their ink soft (Kanagawa Lotus, Everforest
  // Light), so even the text colour can miss 4.5:1 on the tint; fall back to
  // the black or white end in that case.
  const accentGrounds = [...surfaces, accentSoft];
  let accentText = readableColor(accent, text, accentGrounds);
  if (!accentGrounds.every((ground) => contrast(accentText, ground) >= 4.5)) {
    accentText = readableColor(accent, contrastEndpoint, accentGrounds);
  }
  // .text-button's colour (Cancel, Open). A fixed green mix read 2.8:1 on
  // the light themes.
  const sage = readableColor(mix(muted, "#A7D5B3", 0.36), text, surfaces);
  const hue = (key) => normalizeHex(selected.xterm[key], accent);
  // The selected row (the shown workspace card, the active menu item, the
  // palette's selection, the active tab) wears the theme's own selection
  // colour, which is what makes two dark themes tell apart at a glance. It
  // moves toward the surface until every text token still reads 4.5:1 on
  // it; the text tokens themselves are never darkened for it. A selection
  // that is the surface again falls back to an accent tint.
  let selection = normalizeHex(colors.selection, normalizeHex(selected.xterm.selectionBackground, surface));
  if (contrast(selection, surface) < 1.08) selection = mix(surface, accent, light ? 0.16 : 0.22);
  const inks = [text, textSoft, muted, sage, danger, accentText];
  const active = readableGround(selection, surface, inks);
  const term = selected.xterm;
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
    "--surface-raised": raised,
    "--surface-soft": soft,
    "--surface-active": active,
    // semantic surfaces that used to be hardcoded graphite hexes
    "--well": background,
    "--card": mix(background, surface, 0.62),
    "--field": field,
    "--text": text,
    "--text-soft": textSoft,
    "--muted": muted,
    "--accent": accent,
    "--accent-soft": accentSoft,
    "--accent-hover": mix(accent, lift, 0.16),
    "--accent-press": mix(accent, light ? "#FFFFFF" : "#000000", 0.12),
    "--accent-border": mix(background, accent, 0.5),
    "--accent-ring": rgba(accent, 0.14),
    "--on-accent": onAccent,
    "--accent-text": accentText,
    "--sage": sage,
    "--danger": danger,
    "--danger-soft": rgba(danger, 0.1),
    "--success": readableColor(hue("green"), contrastEndpoint, surfaces),
    "--warning": readableColor(hue("yellow"), contrastEndpoint, surfaces),
    "--line": mix(surface, text, 0.09),
    "--line-strong": mix(surface, text, 0.16),
    "--line-hover": mix(surface, text, 0.3),
    "--shadow-color": shadowColor,
    "--scrim": scrim,
    // The terminal's own colours, for what frames it: the pane behind the
    // xterm canvas (its few pixels of gutter used to show the chrome surface
    // instead) and xterm's scrollbar rail and thumb.
    "--term-bg": normalizeHex(term.background, surface),
    "--term-fg": normalizeHex(term.foreground, text),
    "--term-scrollbar": normalizeHex(term.scrollbarSliderBackground, surface),
    "--term-scrollbar-hover": normalizeHex(term.scrollbarSliderHoverBackground, surface),
    "--term-scrollbar-active": normalizeHex(term.scrollbarSliderActiveBackground, surface),
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
  paintWindowFrame({
    caption: values["--bg"], text: values["--text"], border: values["--line-strong"], light,
  });
}

// The native title bar and border follow the theme too (app.py
// set_frame_colors, Windows 11). Only the top window has the pywebview
// bridge, and it may arrive after the first paint, so the latest colours
// wait for it.
let pendingFrame = null;
function paintWindowFrame(colors) {
  if (typeof window === "undefined" || window.top !== window) return;
  const send = () => globalThis.pywebview?.api?.set_frame_colors?.(colors)?.catch?.(() => {});
  if (globalThis.pywebview?.api?.set_frame_colors) { send(); return; }
  if (!pendingFrame) window.addEventListener("pywebviewready", () => pendingFrame?.(), { once: true });
  pendingFrame = send;
}
