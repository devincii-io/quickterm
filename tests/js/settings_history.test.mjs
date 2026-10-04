import test from "node:test";
import assert from "node:assert/strict";

import { historySummary, historyTime } from "../../quickterm/frontend/js/panel_settings_about.js";

test("settings history rows say what restoring would change", () => {
  assert.equal(historySummary({ summary: "theme, profiles" }), "changes theme, profiles");
  assert.equal(historySummary({ summary: "" }), "no difference");
  assert.equal(historyTime("not a date"), "not a date");
  assert.notEqual(historyTime("2026-09-26T10:32:00Z"), "2026-09-26T10:32:00Z");
});
