// Side by side workspaces (4.7), the pure half: which views are columns, in
// what order, which has the keyboard, how wide they are, and the split the
// open-views record keeps.
import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_COLUMNS, MIN_COLUMN_PX, addColumn, describeSplit, dragFractions, equalFractions, focusColumn, gridTemplate,
  keepSplit, normalizeFractions, parseSplit, removeColumn, showAlone, stepColumn, toggleColumn,
} from "../../quickterm/frontend/js/stage_columns.js";
import { parseOpenViews, restorePlan } from "../../quickterm/frontend/js/open_views.js";

const near = (actual, expected) => actual.forEach((value, at) => assert.ok(Math.abs(value - expected[at]) < 1e-9, `${actual}`));

test("a column joins on the right with the keyboard; one already there just takes it", () => {
  let state = showAlone("a");
  state = addColumn(state, "b");
  assert.deepEqual(state, { shown: ["a", "b"], active: "b" });
  state = addColumn(state, "c");
  assert.deepEqual(state, { shown: ["a", "b", "c"], active: "c" });
  assert.deepEqual(addColumn(state, "a"), { shown: ["a", "b", "c"], active: "a" });
  assert.deepEqual(addColumn({ shown: [], active: null }, "a"), { shown: ["a"], active: "a" });
});

test("past four the oldest column leaves, never the one with the keyboard", () => {
  assert.equal(MAX_COLUMNS, 4);
  const four = { shown: ["a", "b", "c", "d"], active: "a" };
  assert.deepEqual(addColumn(four, "e"), { shown: ["a", "c", "d", "e"], active: "e" });
  assert.deepEqual(addColumn({ ...four, active: "c" }, "e"), { shown: ["b", "c", "d", "e"], active: "e" });
});

test("a column leaves; the keyboard goes to its left neighbour, the last column stays", () => {
  const three = { shown: ["a", "b", "c"], active: "b" };
  assert.deepEqual(removeColumn(three, "c"), { shown: ["a", "b"], active: "b" });
  assert.deepEqual(removeColumn(three, "b"), { shown: ["a", "c"], active: "a" });
  assert.deepEqual(removeColumn({ ...three, active: "a" }, "a"), { shown: ["b", "c"], active: "b" });
  assert.deepEqual(removeColumn(showAlone("a"), "a"), { shown: ["a"], active: "a" });
  assert.deepEqual(removeColumn(three, "z"), three);
});

test("Ctrl+click toggles: a column leaves, anything else joins", () => {
  const two = { shown: ["a", "b"], active: "a" };
  assert.deepEqual(toggleColumn(two, "b"), { shown: ["a"], active: "a" });
  assert.deepEqual(toggleColumn(two, "c"), { shown: ["a", "b", "c"], active: "c" });
  assert.deepEqual(toggleColumn(showAlone("a"), "a"), { shown: ["a"], active: "a" }, "the only one stays");
});

test("focusing a column keeps the split; any other view is shown alone", () => {
  const two = { shown: ["a", "b"], active: "a" };
  assert.deepEqual(focusColumn(two, "b"), { shown: ["a", "b"], active: "b" });
  assert.deepEqual(focusColumn(two, "c"), { shown: ["c"], active: "c" });
});

test("stepping walks the columns left and right without wrapping", () => {
  const three = { shown: ["a", "b", "c"], active: "b" };
  assert.equal(stepColumn(three, -1), "a");
  assert.equal(stepColumn(three, 1), "c");
  assert.equal(stepColumn({ ...three, active: "c" }, 1), null);
  assert.equal(stepColumn({ ...three, active: "a" }, -1), null);
  assert.equal(stepColumn(showAlone("a"), 1), null);
});

test("widths are fractions that sum to one, equal when they cannot be trusted", () => {
  near(equalFractions(3), [1 / 3, 1 / 3, 1 / 3]);
  assert.deepEqual(equalFractions(0), [1]);
  near(normalizeFractions([2, 1, 1], 3), [0.5, 0.25, 0.25]);
  near(normalizeFractions([1, 1], 3), equalFractions(3));
  near(normalizeFractions([1, -1], 2), [0.5, 0.5]);
  near(normalizeFractions([1, "x"], 2), [0.5, 0.5]);
  near(normalizeFractions([1, Number.NaN], 2), [0.5, 0.5]);
  near(normalizeFractions(null, 2), [0.5, 0.5]);
});

test("a gutter drag moves only its two columns and stops at the minimum width", () => {
  assert.equal(MIN_COLUMN_PX, 320);
  near(dragFractions([0.5, 0.5], 0, 100, 1000), [0.6, 0.4]);
  near(dragFractions([1 / 3, 1 / 3, 1 / 3], 1, -1000, 1500), [1 / 3, 320 / 1500, 1 - 1 / 3 - 320 / 1500]);
  near(dragFractions([0.5, 0.5], 0, 900, 1000), [0.68, 0.32]);
  // Too narrow for two minimums: the pair can only split evenly.
  near(dragFractions([0.5, 0.5], 0, 200, 500), [0.5, 0.5]);
  near(dragFractions([0.5, 0.5], 1, 100, 1000), [0.5, 0.5], "no gutter after the last column");
  near(dragFractions([0.5, 0.5], 0, 100, 0), [0.5, 0.5]);
});

test("the grid template puts a 1px gutter track between two columns", () => {
  assert.equal(gridTemplate([1]), "minmax(0, 100fr)");
  assert.equal(gridTemplate([0.5, 0.25, 0.25]), "minmax(0, 50fr) 1px minmax(0, 25fr) 1px minmax(0, 25fr)");
  assert.equal(gridTemplate([]), "minmax(0, 100fr)");
});

test("the stored split is read with junk tolerance", () => {
  const open = ["api", "", "docs", "web", "ops"];
  assert.deepEqual(parseSplit(["api", "docs"], [0.7, 0.3], open), { names: ["api", "docs"], widths: [0.7, 0.3] });
  assert.deepEqual(parseSplit(["api", "", "api", 7, "gone", " "], [1, 1, 1, 1, 1, 1], open),
    { names: ["api", ""], widths: [0.5, 0.5] }, "bad names are skipped and the widths no longer fit");
  assert.deepEqual(parseSplit(["api", "docs", "web", "ops", ""], null, open).names, ["api", "docs", "web", "ops"]);
  assert.deepEqual(parseSplit(["api", "docs"], [0.5], open).widths, [0.5, 0.5]);
  assert.deepEqual(parseSplit(["api", "docs"], "wide", open).widths, [0.5, 0.5]);
  assert.equal(parseSplit(["api"], [1], open), null, "one column is no split");
  assert.equal(parseSplit("api,docs", null, open), null);
  assert.equal(parseSplit(undefined, undefined, open), null);
});

test("a record with a broken split still opens its workspaces", () => {
  const record = { version: 1, open: ["api", "docs"], shown: "docs", split: ["api", "docs"], widths: [3, 1] };
  assert.deepEqual(parseOpenViews(JSON.stringify(record)),
    { open: ["api", "docs"], shown: "docs", split: { names: ["api", "docs"], widths: [0.75, 0.25] } });
  assert.deepEqual(parseOpenViews({ ...record, split: { api: 1 } }), { open: ["api", "docs"], shown: "docs" });
  assert.deepEqual(parseOpenViews({ ...record, split: ["api", null] }), { open: ["api", "docs"], shown: "docs" });
});

test("the split is written with two or more columns and loses what does not come back", () => {
  assert.equal(describeSplit(["a"], [1], (view) => view), null);
  assert.deepEqual(describeSplit(["a", "b"], [2 / 3, 1 / 3], (view) => view.toUpperCase()),
    { split: ["A", "B"], widths: [0.667, 0.333] });
  const split = { names: ["api", "docs", "web"], widths: [0.5, 0.25, 0.25] };
  assert.deepEqual(keepSplit(split, ["api", "web"]), { names: ["api", "web"], widths: [2 / 3, 1 / 3] });
  assert.equal(keepSplit(split, ["api"]), null);
  const plan = restorePlan({ open: ["api", "gone", "docs"], shown: "api", split: { names: ["api", "gone", "docs"], widths: [0.4, 0.2, 0.4] } },
    { exists: (name) => name !== "gone" });
  assert.deepEqual(plan.split, { names: ["api", "docs"], widths: [0.5, 0.5] });
});
