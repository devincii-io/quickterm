// The primary window's open workspaces outlive a restart: which ones were
// open, in the order they were opened, and which one was shown. The 4.2
// tiling record is read once for its leaves and removed. The pure half is
// tested directly; the restore runs against the DOM stand-in, which fails a
// test if any element is ever moved, because a moved iframe reloads.
import test from "node:test";
import assert from "node:assert/strict";

import {
  LEGACY_ARRANGEMENT_KEY, OPEN_VIEWS_KEY, WorkspaceViews, describeOpenViews, migrateArrangement, openViewsStore,
  parseOpenViews, readStoredViews, restoreFailureMessage, restorePlan,
} from "../../quickterm/frontend/js/workspace_views.js";
import { installDom, memoryStore } from "./stage_dom.mjs";

function split(dir, a, b, ratio = 0.5) { return { type: "split", dir, ratio, children: [a, b] }; }
function pane(payload) { return { type: "pane", pane: payload }; }
const W = (workspace, window) => ({ workspace, ...(window ? { window } : {}) });

test("the record names the open workspaces in opening order, scratch as an empty name", () => {
  const api = { name: "api" };
  const scratch = { name: "scratch-view-0123456789ab" };
  const docs = { name: "docs" };
  const nameOf = (view) => view.name;
  assert.deepEqual(describeOpenViews([api, scratch, docs], scratch, nameOf), {
    version: 1, open: ["api", "", "docs"], shown: "",
  });
  assert.deepEqual(describeOpenViews([], null, nameOf), { version: 1, open: [], shown: null });
  assert.equal(OPEN_VIEWS_KEY, "quickterm.openViews.v1");
  assert.equal(LEGACY_ARRANGEMENT_KEY, "quickterm.workspaceViews");
});

test("a stored record is checked before anything opens", () => {
  assert.deepEqual(parseOpenViews('{"version":1,"open":["api","","api"],"shown":"api"}'),
    { open: ["api", ""], shown: "api" }, "a name twice opens once");
  assert.deepEqual(parseOpenViews({ version: 1, open: ["api"], shown: "gone" }), { open: ["api"], shown: null });
  assert.equal(parseOpenViews("not json"), null);
  assert.equal(parseOpenViews({ version: 2, open: [] }), null);
  assert.equal(parseOpenViews({ version: 1, open: "api" }), null);
  assert.equal(parseOpenViews({ version: 1, open: ["api", 7] }), null);
  assert.equal(parseOpenViews({ version: 1, open: [" "] }), null);
  assert.equal(parseOpenViews({ version: 1, open: Array.from({ length: 17 }, (_, i) => `w${i}`) }), null);
});

test("a 4.2 tiling record becomes its leaves in tree order, the active leaf shown", () => {
  const record = {
    version: 2,
    tree: split("h", split("v", pane(W("api", "w-1")), pane(W("scratch-view-0123456789ab"))), pane(W("docs")), 0.6),
    active: W("docs", "w-3"),
    zoomed: W("api"),
  };
  assert.deepEqual(migrateArrangement(JSON.stringify(record)), { open: ["api", "", "docs"], shown: "docs" });
  assert.deepEqual(migrateArrangement({ version: 2, tree: null, active: null }), { open: [], shown: null });
  assert.equal(migrateArrangement("{"), null);
  assert.equal(migrateArrangement({ version: 3, tree: null }), null);
});

test("a 3.x record's primary leaf becomes the workspace it remembered", () => {
  const record = { version: 1, tree: split("h", pane({ primary: true }), pane(W("api"))), active: null };
  assert.deepEqual(migrateArrangement(record, { rememberedWorkspace: "main" }), { open: ["main", "api"], shown: "main" });
  assert.deepEqual(migrateArrangement(record), { open: ["api"], shown: null }, "no remembered workspace drops the leaf");
});

test("a workspace that no longer exists stays away and is named; scratch always comes back", () => {
  const plan = restorePlan({ open: ["api", "gone", ""], shown: "gone" }, { exists: (name) => name !== "gone" });
  assert.deepEqual(plan, { open: ["api", ""], shown: null, skipped: [{ workspace: "gone", reason: "missing" }] });
  assert.equal(restorePlan(null), null);
});

test("the current key wins, the tiling record is read once and removed either way", () => {
  const both = memoryStore({ current: '{"version":1,"open":["api"],"shown":"api"}', legacy: '{"version":2,"tree":null}' });
  assert.deepEqual(readStoredViews(both), { record: { open: ["api"], shown: "api" }, stored: true });
  assert.equal(both.legacy, null);
  const legacy = memoryStore({ legacy: JSON.stringify({ version: 2, tree: pane(W("docs")), active: W("docs") }) });
  assert.deepEqual(readStoredViews(legacy), { record: { open: ["docs"], shown: "docs" }, stored: true });
  assert.equal(legacy.dropped, 1);
  assert.deepEqual(readStoredViews(memoryStore()), { record: null, stored: false });
});

test("storage that throws never reaches the stage", () => {
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("quota"); }, removeItem() { throw new Error("denied"); } };
  const store = openViewsStore(broken);
  assert.equal(store.load(), null);
  assert.equal(store.loadLegacy(), null);
  assert.doesNotThrow(() => store.save("{}"));
  assert.doesNotThrow(() => store.dropLegacy());
  const map = new Map();
  const working = openViewsStore({
    getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: (key) => map.delete(key),
  });
  working.save("x");
  assert.equal(map.get("quickterm.openViews.v1"), "x");
});

test("nothing coming back is said once; one missing among several is not", () => {
  assert.equal(restoreFailureMessage(["api"], ["gone"]), null);
  assert.equal(restoreFailureMessage([], []), null);
  assert.match(restoreFailureMessage([], ["gone"]), /^"gone" did not come back: it is/);
  assert.match(restoreFailureMessage([], ["gone", "api"]), /^"gone", "api" did not come back: they are/);
});

function makeViews(store) {
  const errors = [];
  const views = new WorkspaceViews({ error: (message) => errors.push(message), store });
  return { views, errors };
}

test("the stored workspaces open again, claim by claim, and the shown one is shown", async () => {
  const { moves, claims } = installDom({ refused: new Set(["taken"]) });
  const store = memoryStore({ current: JSON.stringify({ version: 1, open: ["api", "taken", "", "docs"], shown: "docs" }) });
  const { views, errors } = makeViews(store);
  assert.equal(store.saves.length, 0, "a boot that has not restored yet writes nothing");

  const result = await views.restoreSaved({ exists: () => true });
  assert.deepEqual(claims, ["api", "taken", null, "docs"], "every view is claimed through the registry, in order");
  assert.deepEqual(result, { restored: ["api", "", "docs"], failed: ["taken"], stored: true });
  assert.deepEqual(errors, [], "one refused claim among several is not worth a word");
  assert.equal(views.active?.workspace, "docs");
  assert.equal(views.pendingFocus, views.active, "the shown view takes the keyboard once it has loaded");
  for (const view of views.views()) assert.equal(view.el.parentNode, views.stage);
  assert.deepEqual(moves, [], "no view or iframe was ever re-parented");
  assert.deepEqual(JSON.parse(store.current), { version: 1, open: ["api", "", "docs"], shown: "docs" });

  // Every open, close and switch is written.
  await views.open("web");
  assert.deepEqual(JSON.parse(store.current).shown, "web");
  views.focusView(views.viewForWorkspace("api"));
  assert.deepEqual(JSON.parse(store.current), { version: 1, open: ["api", "", "docs", "web"], shown: "api" });
  await views.close(views.viewForWorkspace("api"));
  assert.deepEqual(JSON.parse(store.current), { version: 1, open: ["", "docs", "web"], shown: "web" });
});

test("a first boot after the upgrade restores the tiling's leaves and removes it", async () => {
  installDom();
  const legacy = JSON.stringify({ version: 2, tree: split("h", pane(W("main")), pane(W("api"))), active: W("api"), zoomed: null });
  const store = memoryStore({ legacy });
  const { views } = makeViews(store);
  const result = await views.restoreSaved();
  assert.deepEqual(result, { restored: ["main", "api"], failed: [], stored: true });
  assert.equal(views.active?.workspace, "api");
  assert.equal(store.legacy, null, "read once");
  assert.deepEqual(JSON.parse(store.current), { version: 1, open: ["main", "api"], shown: "api" });
});

test("nothing coming back is said once, and the store keeps an empty record", async () => {
  installDom({ refused: new Set(["api"]) });
  const store = memoryStore({ current: JSON.stringify({ version: 1, open: ["api", "gone"], shown: null }) });
  const { views, errors } = makeViews(store);
  const result = await views.restoreSaved({ exists: (name) => name !== "gone" });
  assert.deepEqual(result, { restored: [], failed: ["api"], stored: true });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"gone", "api"/);
  assert.equal(views.views().length, 0);
  assert.equal(views.empty.hidden, false, "the empty stage shows its way back in");
  assert.deepEqual(JSON.parse(store.current), { version: 1, open: [], shown: null });
});

test("a reload brings the split back with its widths and the column that had the keyboard", async () => {
  const { moves } = installDom();
  const record = { version: 1, open: ["api", "", "docs"], shown: "docs", split: ["docs", "api"], widths: [0.3, 0.7] };
  const store = memoryStore({ current: JSON.stringify(record) });
  const { views } = makeViews(store);
  await views.restoreSaved();
  assert.deepEqual(views.shown.map((view) => view.workspace), ["docs", "api"]);
  assert.equal(views.active?.workspace, "docs");
  assert.deepEqual(views.fractions, [0.3, 0.7]);
  assert.equal(views.pendingFocus, views.active);
  assert.deepEqual(JSON.parse(store.current), record);
  assert.deepEqual(moves, []);
});

test("a split whose columns did not all come back keeps the rest at equal widths", async () => {
  installDom({ refused: new Set(["web"]) });
  const record = { version: 1, open: ["api", "web", "docs"], shown: "web", split: ["api", "web", "docs"], widths: [0.2, 0.2, 0.6] };
  const { views } = makeViews(memoryStore({ current: JSON.stringify(record) }));
  await views.restoreSaved();
  assert.deepEqual(views.shown.map((view) => view.workspace), ["api", "docs"]);
  assert.equal(views.active?.workspace, "api", "the active column stayed away; the first one takes the keyboard");
  assert.deepEqual(views.fractions, [0.5, 0.5]);
});

test("nothing stored is neither stored nor migrated, and a window without a store never restores", async () => {
  const { claims } = installDom();
  const store = memoryStore();
  const { views } = makeViews(store);
  assert.deepEqual(await views.restoreSaved(), { restored: [], failed: [], stored: false });
  assert.equal(JSON.parse(store.current).version, 1, "from now on the window has a record");
  const { views: second } = makeViews(null);
  assert.equal(await second.restoreSaved(), null);
  assert.deepEqual(claims, []);
});
