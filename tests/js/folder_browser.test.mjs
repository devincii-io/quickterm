import test from "node:test";
import assert from "node:assert/strict";

import { folderBrowserAction } from "../../quickterm/frontend/js/folder_browser.js";

const WHERE = ["path", "row", "other"];

test("Escape always cancels and Ctrl+Enter always takes the folder you are in", () => {
  // "Use this folder" must work for the folder you are inside, not only for a
  // child you clicked, so its shortcut cannot depend on where focus sits.
  for (const where of WHERE) {
    assert.equal(folderBrowserAction("Escape", { where }), "cancel");
    assert.equal(folderBrowserAction("Enter", { ctrl: true, where }), "use");
    assert.equal(folderBrowserAction("Enter", { ctrl: false, where }), {
      path: "go", row: "descend", other: null,
    }[where]);
  }
});

test("the path bar keeps its editing keys, the list gets navigation keys", () => {
  // Left/Right and Backspace mean "move the caret" and "delete" while typing a
  // path; they only become navigation once focus is on a folder row.
  for (const key of ["ArrowLeft", "ArrowRight", "Backspace", "Home", "End"]) {
    assert.equal(folderBrowserAction(key, { where: "path" }), null);
    assert.equal(folderBrowserAction(key, { where: "other" }), null);
  }
  assert.equal(folderBrowserAction("ArrowRight", { where: "row" }), "descend");
  assert.equal(folderBrowserAction("ArrowLeft", { where: "row" }), "parent");
  assert.equal(folderBrowserAction("Backspace", { where: "row" }), "parent");
  assert.equal(folderBrowserAction("Home", { where: "row" }), "first");
  assert.equal(folderBrowserAction("End", { where: "row" }), "last");
});

test("Enter on a footer button is left to the button", () => {
  // Cancel and "Use this folder" are ordinary buttons. Claiming Enter for the
  // list would make them unreachable from the keyboard.
  assert.equal(folderBrowserAction("Enter", { where: "other" }), null);
  assert.equal(folderBrowserAction(" ", { where: "other" }), null);
});

test("arrows move the selection from anywhere, including the path bar", () => {
  // ArrowDown steps out of the path bar into the list, so the whole modal is
  // reachable from the caret without pressing Tab.
  for (const where of WHERE) {
    assert.equal(folderBrowserAction("ArrowDown", { where }), "down");
    assert.equal(folderBrowserAction("ArrowUp", { where }), "up");
  }
});

test("unclaimed keys are left alone so typing and Tab still work", () => {
  for (const key of ["a", "Tab", "PageDown", "F5", " "]) {
    for (const where of WHERE) {
      assert.equal(folderBrowserAction(key, { where }), null);
    }
  }
  // Called with no options at all: the defaults must not invent an action.
  assert.equal(folderBrowserAction("x"), null);
  assert.equal(folderBrowserAction("Enter"), null);
});
