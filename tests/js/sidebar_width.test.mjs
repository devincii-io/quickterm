import test from "node:test";
import assert from "node:assert/strict";

import {
  SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN,
  clampSidebarWidth, maxSidebarWidth,
} from "../../quickterm/frontend/js/launcher.js";

test("the sidebar cap is the smaller of the absolute cap and 40% of the window", () => {
  assert.equal(maxSidebarWidth(1920), SIDEBAR_WIDTH_MAX);
  assert.equal(maxSidebarWidth(1000), 400);
  // A window too narrow for even the minimum still owes the labels their room;
  // the cap can never fall below the floor, or the clamp would invert.
  assert.equal(maxSidebarWidth(320), SIDEBAR_WIDTH_MIN);
  assert.equal(maxSidebarWidth(0), SIDEBAR_WIDTH_MAX);
  assert.equal(maxSidebarWidth(undefined), SIDEBAR_WIDTH_MAX);
});

test("stored widths are clamped into the readable range", () => {
  assert.equal(clampSidebarWidth(300, 1920), 300);
  assert.equal(clampSidebarWidth(40, 1920), SIDEBAR_WIDTH_MIN);
  assert.equal(clampSidebarWidth(4000, 1920), SIDEBAR_WIDTH_MAX);
  // A width saved on a wide monitor must not eat a narrow window.
  assert.equal(clampSidebarWidth(440, 900), 360);
  assert.equal(clampSidebarWidth(244.6, 1920), 245);
});

test("unreadable storage falls back to the default width", () => {
  assert.equal(clampSidebarWidth(NaN, 1920), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampSidebarWidth("", 1920), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampSidebarWidth(undefined, 1920), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampSidebarWidth("320", 1920), 320);
});
