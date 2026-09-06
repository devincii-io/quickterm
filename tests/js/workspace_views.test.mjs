import test from "node:test";
import assert from "node:assert/strict";
import { companionUrl, clampViewRatio } from "../../quickterm/frontend/js/workspace_views.js";

test("a companion has a distinct explicit identity and carries auth only in the fragment", () => {
  const url = new URL(companionUrl("/", "API & UI", "side-123", "secret/+"), "http://localhost");
  assert.equal(url.searchParams.get("workspace"), "API & UI");
  assert.equal(url.searchParams.get("window"), "side-123");
  assert.equal(url.searchParams.get("embedded"), "1");
  assert.equal(url.searchParams.has("primary"), false);
  assert.equal(url.search.includes("secret"), false);
  assert.equal(decodeURIComponent(url.hash.slice(3)), "secret/+");
});

test("resizing always leaves usable space for both workspaces", () => {
  assert.equal(clampViewRatio(-30), 25);
  assert.equal(clampViewRatio(150), 75);
  assert.equal(clampViewRatio(62), 62);
  assert.equal(clampViewRatio(NaN), 50);
});
