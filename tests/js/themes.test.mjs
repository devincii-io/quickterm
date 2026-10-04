// The built-in themes: complete, readable, every retired id still resolving,
// and the app.css :root block identical to what the default theme computes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CHROME_KEYS, CUSTOM_THEME, DEFAULT_THEME, REQUIRED_XTERM_KEYS, TERMINAL_THEMES, THEME_ALIASES,
  chromeTokens, contrast, getTheme, resolveThemeId, themeGroups,
} from "../../quickterm/frontend/js/themes.js";

const HEX = /^#[0-9A-F]{6}$/i;
const HUES = ["red", "green", "yellow", "blue", "magenta", "cyan"];

// Normal ANSI colours that sit under 3:1 on their own background, upstream
// and on purpose. QuickTerm ships the upstream values unchanged, so each entry
// names why the theme accepts it rather than "fixing" its palette.
const LOW_CONTRAST_HUES = {
  // Latte reuses the Mocha hue set at its own lightness; its yellow and pink
  // are pastels meant for accents on paper, not for long runs of text.
  "catppuccin-latte": ["green", "yellow", "magenta"],
  // Dawn keeps gold and rose as soft highlights; pine and love carry text.
  "rose-pine-dawn": ["yellow", "cyan"],
  // Gruvbox's normal row is the "neutral" set shared by both modes; the
  // bright row is the readable one on dark, the faded one on light.
  "gruvbox-dark": ["red"],
  "gruvbox-light": ["green", "yellow", "cyan"],
  // Everforest light is a deliberately low-contrast, warm palette.
  "everforest-light": ["green", "yellow", "magenta", "cyan"],
};

for (const [id, theme] of Object.entries(TERMINAL_THEMES)) {
  test(`${id} defines every required key as hex`, () => {
    assert.equal(typeof theme.label, "string");
    assert.equal(typeof theme.note, "string");
    assert.equal(typeof theme.light, "boolean");
    for (const key of REQUIRED_XTERM_KEYS) assert.match(theme.xterm[key] || "", HEX, `${id} xterm.${key}`);
    if (theme.xterm.selectionForeground) assert.match(theme.xterm.selectionForeground, HEX);
    for (const key of CHROME_KEYS) assert.match(theme.chrome[key] || "", HEX, `${id} chrome.${key}`);
    assert.equal(theme.chrome.light, theme.light);
  });

  test(`${id} is readable`, () => {
    const { background, foreground } = theme.xterm;
    const floor = theme.light ? 4.5 : 7;
    assert.ok(contrast(foreground, background) >= floor,
      `${id} foreground ${contrast(foreground, background).toFixed(2)}:1 < ${floor}:1`);
    const { text, surface } = theme.chrome;
    assert.ok(contrast(text, surface) >= 4.5, `${id} chrome text ${contrast(text, surface).toFixed(2)}:1`);
    const low = HUES.filter((key) => contrast(theme.xterm[key], background) < 3);
    assert.deepEqual(low, LOW_CONTRAST_HUES[id] || [], `${id} hues under 3:1`);
  });

  test(`${id} mode matches its background`, () => {
    const paper = contrast(theme.xterm.background, "#000000") > contrast(theme.xterm.background, "#FFFFFF");
    assert.equal(theme.light, paper);
  });
}

test("the exceptions list names only shipped themes", () => {
  for (const id of Object.keys(LOW_CONTRAST_HUES)) assert.ok(TERMINAL_THEMES[id], id);
});

test("the set is curated: about twenty themes, at least five of them light", () => {
  const [[, dark], [, light]] = themeGroups();
  assert.ok(dark.length + light.length >= 16 && dark.length + light.length <= 20);
  assert.ok(light.length >= 5);
  assert.equal(dark[0], DEFAULT_THEME);
});

test("every alias resolves to a shipped theme and never shadows one", () => {
  for (const [old, current] of Object.entries(THEME_ALIASES)) {
    assert.equal(TERMINAL_THEMES[old], undefined, `${old} is still shipped`);
    assert.ok(TERMINAL_THEMES[current], `${old} -> ${current}`);
    assert.equal(resolveThemeId(old), current);
    assert.equal(getTheme(old), TERMINAL_THEMES[current]);
  }
});

test("graphite stays valid and unknown ids fall back to the default", () => {
  assert.equal(DEFAULT_THEME, "graphite");
  assert.equal(getTheme("graphite"), TERMINAL_THEMES.graphite);
  assert.equal(getTheme("no-such-theme"), TERMINAL_THEMES[DEFAULT_THEME]);
  assert.equal(getTheme(undefined), TERMINAL_THEMES[DEFAULT_THEME]);
  assert.equal(resolveThemeId(CUSTOM_THEME), CUSTOM_THEME);
});

test("a custom theme derives every required terminal key", () => {
  const custom = getTheme(CUSTOM_THEME, { background: "#FAFAFA", surface: "#FFFFFF", text: "#202020" });
  assert.equal(custom.light, true);
  for (const key of REQUIRED_XTERM_KEYS) assert.match(custom.xterm[key], HEX, key);
  assert.equal(chromeTokens(CUSTOM_THEME, { background: "#FAFAFA", surface: "#FFFFFF" }).light, true);
});

test("light themes get light-mode tokens", () => {
  for (const [id, theme] of Object.entries(TERMINAL_THEMES)) {
    const { light, values } = chromeTokens(id);
    assert.equal(light, theme.light, id);
    for (const index of [1, 2, 3, 4, 5, 6]) {
      assert.ok(contrast(values[`--view-${index}`], values["--bg"]) >= 3, `${id} --view-${index}`);
    }
    for (const key of ["--text", "--muted", "--danger", "--success", "--warning"]) {
      assert.ok(contrast(values[key], values["--surface"]) >= 4.5, `${id} ${key}`);
    }
  }
});

// The pre-boot copy: the first :root block of app.css declares every token
// applyChromeTheme() writes, with exactly the value it writes for the default.
test("app.css :root equals the computed default", () => {
  const css = readFileSync(new URL("../../quickterm/frontend/css/app.css", import.meta.url), "utf8");
  const start = css.indexOf(":root {");
  const block = css.slice(start, css.indexOf("\n}", start)).replace(/\/\*[\s\S]*?\*\//g, "");
  const declared = Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
    .map(([, name, value]) => [name, value.trim()]));
  const normal = (value) => value.toLowerCase().replace(/\s+/g, " ");
  const { light, values } = chromeTokens(DEFAULT_THEME);
  assert.equal(light, false);
  for (const [name, value] of Object.entries(values)) {
    assert.ok(name in declared, `${name} missing from :root`);
    assert.equal(normal(declared[name]), normal(value), name);
  }
});
