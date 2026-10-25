// The Settings/Dashboard sheet: who gets Escape while a menu opened from
// the sheet is up, and which settings the palette can reach.
import test from "node:test";
import assert from "node:assert/strict";

import { Panels, sheetKeyRoute } from "../../quickterm/frontend/js/panels.js";

test("an open menu takes Escape and Tab from the sheet", () => {
  assert.equal(sheetKeyRoute("Escape", { menuOpen: true, inMenu: true }), "menu");
  assert.equal(sheetKeyRoute("Tab", { menuOpen: true, inMenu: true }), "menu");
  // Focus has left the menu: the sheet closes the menu, and only the menu.
  assert.equal(sheetKeyRoute("Escape", { menuOpen: true, inMenu: false }), "close-menu");
  assert.equal(sheetKeyRoute("Escape", { menuOpen: false, inMenu: false }), "sheet");
  assert.equal(sheetKeyRoute("Tab", { menuOpen: false, inMenu: false }), "sheet");
  assert.equal(sheetKeyRoute("a", { menuOpen: true, inMenu: false }), "none");
});

test("a recording shortcut field keeps Escape and Tab from the sheet", () => {
  // Escape cancels the capture and must not close the sheet behind it.
  for (const key of ["Escape", "Tab"]) {
    assert.equal(sheetKeyRoute(key, { menuOpen: false, inMenu: false, capturing: true }), "none");
    assert.equal(sheetKeyRoute(key, { menuOpen: true, inMenu: false, capturing: true }), "none");
    assert.equal(sheetKeyRoute(key, { menuOpen: false, inMenu: false, capturing: true, confirming: true, searchActive: true }), "none");
  }
});

test("Escape undoes the nearest thing first: menu, confirmation, search, then the sheet", () => {
  const all = { menuOpen: true, inMenu: false, confirming: true, searchActive: true };
  assert.equal(sheetKeyRoute("Escape", all), "close-menu");
  assert.equal(sheetKeyRoute("Escape", { ...all, menuOpen: false }), "confirm");
  assert.equal(sheetKeyRoute("Escape", { ...all, menuOpen: false, confirming: false }), "search");
  assert.equal(sheetKeyRoute("Escape", { menuOpen: false, inMenu: false }), "sheet");
  // Tab is not Escape: a filled search box does not keep focus in it.
  assert.equal(sheetKeyRoute("Tab", { menuOpen: false, inMenu: false, searchActive: true }), "sheet");
});

test("the palette sees every settings field as an entry", () => {
  const entries = Panels.prototype.settingEntries.call({});
  assert.ok(entries.length > 20);
  assert.ok(entries.every((entry) => entry.id && entry.label && entry.tab));
  assert.ok(entries.some((entry) => entry.id === "overlay.enabled" && entry.tab === "window"));
});
