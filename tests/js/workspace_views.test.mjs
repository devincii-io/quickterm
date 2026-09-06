import test from "node:test";
import assert from "node:assert/strict";
import {
  VIEW_COLORS, VIEW_MIN_PX, clampViewRatio, companionUrl, pickViewColor, ratioBounds,
} from "../../quickterm/frontend/js/workspace_views.js";

test("a companion has a distinct explicit identity and carries auth only in the fragment", () => {
  const url = new URL(companionUrl("/", "API & UI", "side-123", "secret/+"), "http://localhost");
  assert.equal(url.searchParams.get("workspace"), "API & UI");
  assert.equal(url.searchParams.get("window"), "side-123");
  assert.equal(url.searchParams.get("embedded"), "1");
  assert.equal(url.searchParams.has("primary"), false);
  assert.equal(url.search.includes("secret"), false);
  assert.equal(decodeURIComponent(url.hash.slice(3)), "secret/+");
});

test("resizing always leaves usable space for both sides of a split", () => {
  assert.equal(clampViewRatio(-30), 15);
  assert.equal(clampViewRatio(150), 85);
  assert.equal(clampViewRatio(62), 62);
  assert.equal(clampViewRatio(NaN), 50);
});

test("a divider drag never squeezes a view under its pixel floor while there is room", () => {
  const wide = ratioBounds(1600);
  assert.equal(wide.min, 0.15, "on a wide split the percent clamp is the tighter one");
  assert.equal(wide.max, 0.85);
  const narrow = ratioBounds(800);
  assert.equal(narrow.min, VIEW_MIN_PX / 800);
  assert.equal(narrow.max, 1 - VIEW_MIN_PX / 800);
  // Too small for two floors: fall back to the percent clamp rather than a
  // min above the max.
  const tiny = ratioBounds(200);
  assert.equal(tiny.min, 0.15);
  assert.equal(tiny.max, 0.85);
});

test("every open view gets its own colour before any colour repeats", () => {
  assert.equal(pickViewColor([]), VIEW_COLORS[0]);
  assert.equal(pickViewColor([VIEW_COLORS[0]]), VIEW_COLORS[1]);
  assert.equal(pickViewColor([VIEW_COLORS[0], VIEW_COLORS[2]]), VIEW_COLORS[1], "a closed view's colour is reused");
  assert.equal(pickViewColor(VIEW_COLORS), VIEW_COLORS[0]);
});
