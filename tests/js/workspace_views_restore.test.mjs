// The tiled workspace views outlive a restart: the arrangement is stored as
// a split tree of {workspace} leaves, pruned of what cannot come back, and
// rebuilt in one step. There is no primary view any more; a 3.x record with
// one migrates. The pure half is tested directly; the rebuild runs against a
// small DOM stand-in that fails the test if any element is ever moved,
// because a moved iframe reloads.
import test from "node:test";
import assert from "node:assert/strict";

import {
  VIEW_ARRANGEMENT_KEY, VIEW_ARRANGEMENT_VERSION, WorkspaceViews, describeArrangement, parseArrangement,
  restoreFailureMessage, restorePlan, viewArrangementStore,
} from "../../quickterm/frontend/js/workspace_views.js";
import { leaves } from "../../quickterm/frontend/js/split_tree.js";

function split(dir, a, b, ratio = 0.5) { return { type: "split", dir, ratio, children: [a, b] }; }
function pane(payload) { return { type: "pane", pane: payload }; }
const P = { primary: true };
const W = (workspace) => ({ workspace });

function shape(node) {
  if (!node) return "-";
  if (node.type === "pane") return node.pane.primary ? "P" : node.pane.workspace;
  return `${node.dir}${Math.round(node.ratio * 100)}(${shape(node.children[0])},${shape(node.children[1])})`;
}

test("an arrangement is the view tree reduced to what brings each view back", () => {
  const main = { name: "main" };
  const api = { name: "api", id: "w-2" };
  const docs = { name: "docs" };
  const root = split("h", pane(main), split("v", pane(api), pane(docs), 0.3), 0.6);
  root.divider = { element: true };
  const arrangement = describeArrangement({ root, nameOf: (view) => view.name, active: api, zoomed: null });
  assert.deepEqual(JSON.parse(JSON.stringify(arrangement)), {
    version: 2,
    tree: split("h", pane(W("main")), split("v", pane({ workspace: "api", window: "w-2" }), pane(W("docs")), 0.3), 0.6),
    active: { workspace: "api", window: "w-2" },
    zoomed: null,
  });
  assert.equal(VIEW_ARRANGEMENT_VERSION, 2);
  // A lone view comes back too: no view is what a boot shows by itself.
  assert.equal(shape(describeArrangement({ root: pane(main), nameOf: (view) => view.name }).tree), "main");
  // With nothing open the record is empty, not missing: it says this window
  // was already migrated.
  assert.deepEqual(describeArrangement({ root: null, nameOf: () => "x" }), {
    version: 2, tree: null, active: null, zoomed: null,
  });
});

test("a stored arrangement is checked all the way down", () => {
  const good = { version: 2, tree: split("v", pane(W("api")), pane(W("docs")), 0.02), active: W("api"), zoomed: W("api") };
  const parsed = parseArrangement(JSON.stringify(good));
  assert.equal(shape(parsed.tree), "v15(api,docs)", "a ratio outside the clamp is pulled back in");
  assert.deepEqual(parsed.active, W("api"));
  assert.deepEqual(parsed.zoomed, W("api"));
  assert.equal(parsed.migrated, false);
  // Version 2 may hold no tree at all, and a single view.
  assert.equal(parseArrangement({ version: 2, tree: null }).tree, null);
  assert.equal(shape(parseArrangement({ version: 2, tree: pane(W("api")) }).tree), "api");
  // Any number of views, none of them special: no exactly-one-primary rule.
  assert.equal(shape(parseArrangement({ version: 2, tree: split("h", pane(W("a")), pane(W("b"))) }).tree), "h50(a,b)");

  for (const bad of [
    "not json",
    null,
    42,
    { version: 3, tree: good.tree },
    { version: 2, tree: split("h", pane(P), pane(W("a"))) },
    { version: 2, tree: split("x", pane(W("b")), pane(W("a"))) },
    { version: 2, tree: { type: "split", dir: "h", ratio: 0.5, children: [pane(W("a"))] } },
    { version: 2, tree: split("h", pane(W("b")), pane(W(""))) },
    { version: 2, tree: split("h", pane(W("b")), pane({ workspace: 7 })) },
    { version: 2 },
  ]) {
    assert.equal(parseArrangement(typeof bad === "string" ? bad : JSON.stringify(bad)), null, JSON.stringify(bad));
  }
  const unknownActive = parseArrangement({ version: 2, tree: split("h", pane(W("b")), pane(W("a"))), active: "api" });
  assert.equal(unknownActive.active, null, "an unreadable active view is no active view");
  assert.equal(unknownActive.zoomed, null);
});

test("a version 1 primary becomes the workspace it remembered", () => {
  const stored = {
    version: 1,
    tree: split("h", pane(P), split("v", pane(W("api")), pane(W("docs")), 0.3), 0.6),
    active: P,
    zoomed: W("api"),
  };
  const parsed = parseArrangement(JSON.stringify(stored), { rememberedWorkspace: "main" });
  assert.equal(parsed.migrated, true);
  assert.equal(parsed.version, 2);
  assert.equal(shape(parsed.tree), "h60(main,v30(api,docs))");
  assert.deepEqual(parsed.active, W("main"));
  assert.deepEqual(parsed.zoomed, W("api"));
  // A 3.x record without an active view meant the primary.
  assert.deepEqual(parseArrangement({ ...stored, active: undefined }, { rememberedWorkspace: "main" }).active, W("main"));
  // The 3.x rule still decides whether a version 1 record was valid.
  assert.equal(parseArrangement({ version: 1, tree: split("h", pane(W("a")), pane(W("b"))) }), null);
  assert.equal(parseArrangement({ version: 1, tree: split("h", pane(P), pane(P)) }), null);
});

test("a version 1 primary on scratch, or remembering nothing, is dropped", () => {
  const stored = { version: 1, tree: split("h", pane(P), pane(W("api")), 0.7), active: P, zoomed: P };
  for (const rememberedWorkspace of [null, "", undefined]) {
    const parsed = parseArrangement(stored, { rememberedWorkspace });
    assert.equal(shape(parsed.tree), "api", String(rememberedWorkspace));
    assert.equal(parsed.active, null);
    assert.equal(parsed.zoomed, null);
  }
  // Remembered on scratch: the plan drops it with the scratch views.
  const plan = restorePlan(stored, { rememberedWorkspace: "scratch" });
  assert.equal(shape(plan.tree), "api");
  assert.deepEqual(plan.skipped, [{ workspace: "scratch", reason: "scratch" }]);
  // Remembered but deleted since: dropped as missing.
  const gone = restorePlan(stored, { rememberedWorkspace: "old", exists: (name) => name !== "old" });
  assert.equal(shape(gone.tree), "api");
  assert.deepEqual(gone.skipped, [{ workspace: "old", reason: "missing" }]);
  assert.equal(gone.migrated, true);
});

test("scratch, missing and duplicate views are pruned and their splits collapse", () => {
  const stored = {
    version: 2,
    tree: split("h",
      split("v", pane(W("main")), pane(W("scratch")), 0.4),
      split("v", pane(W("api")), split("h", pane(W("gone")), pane(W("api")), 0.7), 0.35),
      0.6),
    active: W("gone"),
    zoomed: W("scratch"),
  };
  const plan = restorePlan(stored, { exists: (name) => name !== "gone" });
  assert.equal(shape(plan.tree), "h60(main,api)");
  assert.deepEqual(plan.skipped, [
    { workspace: "scratch", reason: "scratch" },
    { workspace: "gone", reason: "missing" },
    { workspace: "api", reason: "duplicate" },
  ]);
  assert.equal(plan.active, null);
  assert.equal(plan.zoomed, null);
  assert.equal(plan.migrated, false);
  assert.equal(restorePlan("garbage"), null);
  // Everything pruned leaves an empty plan, not a missing one.
  const empty = restorePlan({ version: 2, tree: pane(W("scratch-view-0123456789ab")) });
  assert.equal(empty.tree, null);
});

test("the store survives a storage that throws", () => {
  const memory = new Map();
  const storage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, value),
    removeItem: (key) => memory.delete(key),
  };
  const store = viewArrangementStore(storage);
  store.save('{"version":2}');
  assert.equal(memory.get(VIEW_ARRANGEMENT_KEY), '{"version":2}');
  assert.equal(store.load(), '{"version":2}');
  store.save(null);
  assert.equal(memory.has(VIEW_ARRANGEMENT_KEY), false);

  const broken = viewArrangementStore({
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("quota"); },
    removeItem() { throw new Error("denied"); },
  });
  assert.equal(broken.load(), null);
  assert.doesNotThrow(() => broken.save("x"));
  assert.doesNotThrow(() => broken.save(null));
});

test("generated scratch identities are pruned instead of restoring their display labels", () => {
  const stored = { version: 2, tree: split("h", pane(W("main")), pane(W("scratch-view-0123456789ab"))), active: W("scratch-view-0123456789ab") };
  const plan = restorePlan(stored, { exists: () => true });
  assert.equal(shape(plan.tree), "main");
  assert.deepEqual(plan.skipped, [{ workspace: "scratch-view-0123456789ab", reason: "scratch" }]);
});

test("a failed restore speaks only when nothing came back", () => {
  assert.equal(restoreFailureMessage(["api"], ["docs"]), null);
  assert.equal(restoreFailureMessage([], []), null);
  assert.match(restoreFailureMessage([], ["docs"]), /"docs" did not come back/);
  assert.match(restoreFailureMessage([], ["a", "b"]), /views of "a", "b" did not come back/);
});

// ---- the rebuild, against a DOM stand-in ----

function installDom() {
  const moves = [];
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.style = { setProperty() {} };
      const classes = new Set();
      this.classList = {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        toggle: (name, on) => {
          const wanted = on === undefined ? !classes.has(name) : Boolean(on);
          if (wanted) classes.add(name); else classes.delete(name);
          return wanted;
        },
        contains: (name) => classes.has(name),
      };
      this.attributes = {};
      this.hidden = false;
      this.offsetWidth = 0;
    }
    set className(value) { String(value).split(/\s+/).filter(Boolean).forEach((name) => this.classList.add(name)); }
    append(...nodes) {
      for (const node of nodes) {
        if (node.parentNode) moves.push(node);
        node.parentNode = this;
        this.children.push(node);
      }
    }
    before(node) { node.parentNode = this.parentNode || { stub: true }; }
    replaceChildren(...nodes) { this.children.forEach((node) => { node.parentNode = null; }); this.children = []; this.append(...nodes); }
    remove() {
      if (this.parentNode?.children) this.parentNode.children = this.parentNode.children.filter((n) => n !== this);
      this.parentNode = null;
    }
    get isConnected() { return Boolean(this.parentNode); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener() {}
    getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 }; }
    querySelectorAll(selector) {
      const wanted = selector.replace(/^\./, "");
      return this.children.filter((node) => node.classList.contains(wanted));
    }
  }
  const shell = new Element("div");
  globalThis.document = {
    createElement: (tag) => new Element(tag),
    createElementNS: (_, tag) => new Element(tag),
    getElementById: () => null,
    querySelector: (selector) => (selector === "#app > .workspace-shell" ? shell : null),
  };
  globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: true }) };
  globalThis.location = { pathname: "/" };
  globalThis.requestAnimationFrame = () => 0;
  return { moves };
}

function stubRegistry(refused = new Set()) {
  const claims = [];
  let next = 1;
  globalThis.fetch = async (path, options) => {
    const body = JSON.parse(options.body || "{}");
    claims.push(body.workspace);
    if (refused.has(body.workspace)) {
      return { ok: false, status: 409, json: async () => ({ detail: "claimed" }), headers: { get: () => "application/json" } };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ id: `side-${next++}`, workspace: body.workspace }),
      headers: { get: () => "application/json" },
    };
  };
  return claims;
}

function memoryStore(text) {
  const store = { text, saves: [] };
  store.load = () => store.text;
  store.save = (value) => { store.text = value; store.saves.push(value); };
  return store;
}

function makeViews(store) {
  const errors = [];
  const views = new WorkspaceViews({ fit() {}, error: (message) => errors.push(message), store });
  return { views, errors };
}

function mapNames(node) {
  if (node.type === "pane") return pane(W(node.pane.label));
  return split(node.dir, mapNames(node.children[0]), mapNames(node.children[1]), node.ratio);
}

test("the stored tree is rebuilt in place, claim by claim, without moving an element", async () => {
  const { moves } = installDom();
  const claims = stubRegistry(new Set(["taken"]));
  const stored = JSON.stringify({
    version: 2,
    tree: split("h", split("v", pane(W("api")), pane(W("main")), 0.3), split("v", pane(W("taken")), pane(W("docs")), 0.7), 0.6),
    active: W("docs"),
    zoomed: W("api"),
  });
  const store = memoryStore(stored);
  const { views, errors } = makeViews(store);
  assert.equal(store.saves.length, 0, "a boot that has not restored yet writes nothing");
  assert.equal(views.views().length, 0, "the shell starts with no view");

  const result = await views.restoreSaved({ exists: () => true });
  assert.deepEqual(claims, ["api", "main", "taken", "docs"], "every view is claimed through the registry, in tree order");
  assert.deepEqual(result, { restored: ["api", "main", "docs"], failed: ["taken"], stored: true });
  assert.deepEqual(errors, [], "one refused claim among several is not worth a word");

  assert.equal(shape(mapNames(views.root)), "h60(v30(api,main),docs)");
  assert.equal(views.zoomed?.label, "api");
  assert.equal(views.active?.label, "docs");
  assert.equal(views.pendingFocus?.label, "docs", "the active view takes the keyboard once it has loaded");
  for (const view of views.views()) {
    assert.equal(view.frame.src.includes(`window=${view.id}`), true);
    assert.equal(view.el.parentNode, views.stage);
    assert.ok(view.closeButton, "every view has a close button");
  }
  assert.deepEqual(moves, [], "no view or iframe was ever re-parented");

  // Restored, the store follows the arrangement as it is now.
  const saved = JSON.parse(store.text);
  assert.equal(saved.version, 2);
  assert.equal(shape(saved.tree), "h60(v30(api,main),docs)");
  // Each view is stored with the registry id it holds now.
  assert.deepEqual(saved.active, { workspace: "docs", window: "side-3" });
  assert.deepEqual(saved.zoomed, { workspace: "api", window: "side-1" });
});

test("a version 1 record is restored around the workspace its primary remembered", async () => {
  installDom();
  const claims = stubRegistry();
  const store = memoryStore(JSON.stringify({
    version: 1, tree: split("h", pane(P), pane(W("api")), 0.6), active: P, zoomed: null,
  }));
  const { views } = makeViews(store);
  const result = await views.restoreSaved({ rememberedWorkspace: "main" });
  assert.deepEqual(claims, ["main", "api"]);
  assert.deepEqual(result, { restored: ["main", "api"], failed: [], stored: false }, "a migrated record is not a stored one");
  assert.equal(views.active?.label, "main");
  const saved = JSON.parse(store.text);
  assert.equal(saved.version, 2, "the next boot reads version 2");
  assert.equal(shape(saved.tree), "h60(main,api)");
});

test("nothing coming back is said once, and the store keeps an empty record", async () => {
  installDom();
  stubRegistry(new Set(["api"]));
  const store = memoryStore(JSON.stringify({
    version: 2, tree: split("h", pane(W("scratch")), split("h", pane(W("api")), pane(W("gone")))), active: null, zoomed: null,
  }));
  const { views, errors } = makeViews(store);
  const result = await views.restoreSaved({ exists: (name) => name !== "gone" });
  assert.deepEqual(result, { restored: [], failed: ["api"], stored: true });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"gone", "api"/);
  assert.equal(views.views().length, 0);
  assert.equal(views.empty.hidden, false, "the empty stage shows its way back in");
  assert.deepEqual(JSON.parse(store.text), { version: 2, tree: null, active: null, zoomed: null });
});

test("scratch views stay away silently, and a window without a store never restores", async () => {
  installDom();
  const claims = stubRegistry();
  const store = memoryStore(JSON.stringify({
    version: 2, tree: split("h", pane(W("scratch-view-0123456789ab")), pane(W("scratch"))), active: null, zoomed: null,
  }));
  const { views, errors } = makeViews(store);
  const result = await views.restoreSaved();
  assert.deepEqual(claims, []);
  assert.deepEqual(errors, []);
  assert.equal(result.stored, true);

  const { views: second } = makeViews(null);
  assert.equal(await second.restoreSaved(), null);
  assert.deepEqual(claims, []);
});

test("nothing stored at all is neither stored nor migrated", async () => {
  installDom();
  stubRegistry();
  const store = memoryStore(null);
  const { views } = makeViews(store);
  assert.deepEqual(await views.restoreSaved(), { restored: [], failed: [], stored: false });
  assert.equal(JSON.parse(store.text).version, 2, "from now on the window is migrated");
});

test("leaves of a rebuilt tree are the live view objects", async () => {
  installDom();
  stubRegistry();
  const store = memoryStore(JSON.stringify({
    version: 2, tree: split("v", pane(W("api")), pane(W("main")), 0.5), active: null, zoomed: null,
  }));
  const { views } = makeViews(store);
  await views.restoreSaved();
  const live = leaves(views.root);
  assert.equal(live.length, 2);
  assert.deepEqual(live.map((view) => view.label), ["api", "main"]);
  assert.equal(views.active, live[0], "with no stored active view the first one is active");
});

test("a restore releases the claim the previous page's view still holds", async () => {
  // A reload used to bring nothing back: the old iframe's claim outlives it
  // for the registry TTL, so the new claim was refused as taken.
  installDom();
  const calls = [];
  let next = 1;
  globalThis.fetch = async (path, options) => {
    calls.push(`${options.method} ${path}`);
    if (options.method === "DELETE") return { ok: true, status: 204, json: async () => ({}), headers: { get: () => "" } };
    const body = JSON.parse(options.body || "{}");
    return {
      ok: true, status: 200,
      json: async () => ({ id: `new-${next++}`, workspace: body.workspace }),
      headers: { get: () => "application/json" },
    };
  };
  const store = memoryStore(JSON.stringify({
    version: 2,
    tree: pane({ workspace: "api", window: "old-7" }),
    active: null,
    zoomed: null,
  }));
  const { views } = makeViews(store);
  const result = await views.restoreSaved();

  assert.deepEqual(result, { restored: ["api"], failed: [], stored: true });
  assert.deepEqual(calls, ["DELETE /api/windows/old-7", "POST /api/windows"], "released before it is claimed again");
  const saved = JSON.parse(store.text);
  assert.deepEqual(saved.tree.pane, { workspace: "api", window: "new-1" }, "the new id is what the next restore releases");
});

test("a stored window id is kept only when it is a short string", () => {
  const tree = (pane_) => ({ version: 2, tree: split("h", pane(W("b")), pane(pane_)), active: null });
  assert.deepEqual(parseArrangement(tree({ workspace: "a", window: "w-1" })).tree.children[1].pane, { workspace: "a", window: "w-1" });
  assert.deepEqual(parseArrangement(tree({ workspace: "a", window: 7 })).tree.children[1].pane, { workspace: "a" });
  assert.deepEqual(parseArrangement(tree({ workspace: "a", window: "x".repeat(65) })).tree.children[1].pane, { workspace: "a" });
});
