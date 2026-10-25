// The update card model: what the card and the footer pill say per state,
// the percentage, when the card polls, and Later per version.
import test from "node:test";
import assert from "node:assert/strict";

import {
  IDLE_STATUS, aboutLine, cardModel, cardVisible, downloadPercent, formatBytes, pillText, shouldPoll,
} from "../../quickterm/frontend/js/update_card.js";

const NOTES = "https://github.com/devincii-io/quickterm/releases/tag/v4.3.1";
const status = (state, extra = {}) => ({
  ...IDLE_STATUS, state, version: "4.3.1", notes_url: NOTES, ...extra,
});
const ids = (model) => model.actions.map((action) => action.id);

test("idle has no card and no pill", () => {
  assert.equal(cardModel(IDLE_STATUS), null);
  assert.equal(cardModel(null), null);
  assert.equal(pillText(IDLE_STATUS), null);
  assert.equal(cardVisible(IDLE_STATUS, null), false);
});

test("downloading: title, line, notes link, bar, percentage and the minimize button", () => {
  const model = cardModel(status("downloading", { received: 30, total: 100 }));
  assert.equal(model.title, "Downloading update");
  assert.equal(model.text, "QuickTerm v4.3.1 is downloading.");
  assert.equal(model.notes, true);
  assert.equal(model.progress, 30);
  assert.equal(model.progressText, "Downloading… 30%");
  assert.equal(model.minimize, true);
  assert.deepEqual(model.actions, []);
});

test("downloading with an unknown total shows the size so far and an open bar", () => {
  const model = cardModel(status("downloading", { received: 5 * 1024 * 1024 + 300 * 1024, total: null }));
  assert.equal(model.progress, null);
  assert.equal(model.progressText, "Downloading… 5.3 MB");
  assert.equal(pillText(status("downloading", { received: 10, total: null })), "…");
});

test("verifying keeps the download card at a full bar", () => {
  const model = cardModel(status("verifying", { received: 100, total: 100 }));
  assert.equal(model.title, "Downloading update");
  assert.equal(model.progress, 100);
  assert.equal(model.progressText, "Verifying…");
});

test("ready offers Install now first, then Later", () => {
  const model = cardModel(status("ready", { received: 100, total: 100 }));
  assert.equal(model.title, "Update ready");
  assert.equal(model.text, "QuickTerm v4.3.1 is ready to install. Your terminals keep running.");
  assert.equal(model.notes, true);
  assert.equal(model.progress, undefined);
  assert.deepEqual(ids(model), ["install", "later"]);
  assert.equal(model.actions[0].label, "Install now");
  assert.equal(model.actions[0].primary, true);
  assert.equal(model.minimize, false);
});

test("available offers Download and Later", () => {
  const model = cardModel(status("available"));
  assert.equal(model.title, "Update available");
  assert.equal(model.text, "QuickTerm v4.3.1 is available.");
  assert.deepEqual(ids(model), ["download", "later"]);
  assert.equal(model.actions[0].label, "Download");
});

test("failed shows the error on one line with Retry and Later", () => {
  const model = cardModel(status("failed", { error: "installer failed\nchecksum verification" }));
  assert.equal(model.title, "Update failed");
  assert.equal(model.text, "installer failed checksum verification");
  assert.deepEqual(ids(model), ["retry", "later"]);
  assert.equal(model.notes, false);
  assert.equal(cardModel(status("failed", { error: null })).text, "The download did not finish.");
});

test("installed says restart, with Restart now only when the backend can start it", () => {
  const model = cardModel(status("installed", { can_restart: true }));
  assert.equal(model.title, "Update installed");
  assert.equal(model.text, "QuickTerm v4.3.1 is installed. Restart QuickTerm to use it.");
  assert.deepEqual(ids(model), ["restart"]);
  assert.equal(model.actions[0].label, "Restart now");
  assert.equal(model.minimize, true);
  assert.deepEqual(ids(cardModel(status("installed", { can_restart: false }))), []);
  assert.ok(!ids(model).includes("install"));
  assert.equal(pillText(status("installed")), "up");
  assert.equal(shouldPoll(status("installed")), false);
  assert.equal(aboutLine(status("installed")), "QuickTerm v4.3.1 is installed. Restart QuickTerm to use it.");
});

test("the release notes link needs a notes URL", () => {
  assert.equal(cardModel(status("ready", { notes_url: null })).notes, false);
});

test("percent is whole, clamped, and 100 only when everything arrived", () => {
  assert.equal(downloadPercent({ received: 0, total: 200 }), 0);
  assert.equal(downloadPercent({ received: 61, total: 200 }), 30);
  assert.equal(downloadPercent({ received: 199, total: 200 }), 99);
  assert.equal(downloadPercent({ received: 200, total: 200 }), 100);
  assert.equal(downloadPercent({ received: 250, total: 200 }), 100);
  assert.equal(downloadPercent({ received: 10, total: 0 }), null);
  assert.equal(downloadPercent({ received: 10, total: null }), null);
});

test("sizes read as B, KB and MB", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
});

test("the pill shows the percentage while downloading and up when ready", () => {
  assert.equal(pillText(status("downloading", { received: 30, total: 100 })), "30%");
  assert.equal(pillText(status("ready")), "up");
  assert.equal(pillText(status("available")), "up");
  assert.equal(pillText(status("failed")), "!");
  assert.equal(pillText(status("installing")), "…");
});

test("polls only while downloading or verifying", () => {
  assert.equal(shouldPoll(status("downloading")), true);
  assert.equal(shouldPoll(status("verifying")), true);
  for (const state of ["idle", "available", "ready", "installing", "failed"]) {
    assert.equal(shouldPoll(status(state)), false, state);
  }
});

test("Later and minimize hide the card for that version only", () => {
  const ready = status("ready");
  assert.equal(cardVisible(ready, null), true);
  assert.equal(cardVisible(ready, "4.3.1"), false);
  assert.equal(cardVisible(status("downloading", { received: 1, total: 2 }), "4.3.1"), false);
  assert.equal(cardVisible({ ...ready, version: "4.3.2" }, "4.3.1"), true);
  // The pill stays while the card is hidden.
  assert.equal(pillText(ready), "up");
});

test("About says the same state in words", () => {
  assert.equal(aboutLine(status("downloading", { received: 45, total: 100 })), "QuickTerm v4.3.1 is downloading (45%).");
  assert.equal(aboutLine(status("ready")), "QuickTerm v4.3.1 is ready to install. Your terminals keep running.");
  assert.equal(aboutLine(status("failed", { error: "offline" })), "The update failed: offline");
  assert.equal(aboutLine(IDLE_STATUS), "");
});

test("no card text uses an em dash", () => {
  const emDash = String.fromCharCode(0x2014);
  for (const state of ["downloading", "verifying", "ready", "available", "installing", "installed", "failed"]) {
    const model = cardModel(status(state, { error: "x", received: 1, total: 2 }));
    for (const value of [model.title, model.text, model.progressText, ...model.actions.map((a) => a.label)]) {
      assert.ok(!value.includes(emDash), `${state}: ${value}`);
    }
  }
});
