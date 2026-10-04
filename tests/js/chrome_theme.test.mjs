// The chrome palette applyChromeTheme derives from each terminal theme: every
// text token is readable on every surface it is drawn on, and the pre-boot
// :root block in app.css matches what it computes for graphite.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const props = {};
globalThis.document = {
  documentElement: { style: { setProperty: (key, value) => { props[key] = value; } }, dataset: {} },
};
const { TERMINAL_THEMES, applyChromeTheme } = await import("../../quickterm/frontend/js/themes.js");

function luminance(hex) {
  const value = hex.replace("#", "");
  return [0, 2, 4]
    .map((i) => parseInt(value.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
}

function ratio(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

function palette(id) {
  for (const key of Object.keys(props)) delete props[key];
  applyChromeTheme(id);
  return { ...props };
}

test("every text token is 4.5:1 on every panel surface, in every theme", () => {
  const failures = [];
  for (const id of Object.keys(TERMINAL_THEMES)) {
    const tokens = palette(id);
    for (const fg of ["--text", "--text-soft", "--muted", "--sage", "--danger", "--accent-text"]) {
      for (const bg of ["--bg", "--surface", "--field", "--surface-raised"]) {
        const measured = ratio(tokens[fg], tokens[bg]);
        if (measured < 4.5) failures.push(`${id} ${fg} on ${bg}: ${measured.toFixed(2)}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("the pre-boot :root colours are what graphite computes", () => {
  const tokens = palette("graphite");
  const css = readFileSync(new URL("../../quickterm/frontend/css/app.css", import.meta.url), "utf8");
  const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
  for (const key of ["--bg", "--surface", "--text", "--accent", "--danger"]) {
    const match = root.match(new RegExp(`${key}: (#[0-9a-f]{6});`, "i"));
    assert.ok(match, `${key} is a literal in :root`);
    assert.equal(match[1].toLowerCase(), tokens[key].toLowerCase(), key);
  }
  // Graphite's accent already reads as text, so the token is the accent.
  assert.equal(tokens["--accent-text"], tokens["--accent"]);
  assert.match(root, /--accent-text: var\(--accent\);/);
});
