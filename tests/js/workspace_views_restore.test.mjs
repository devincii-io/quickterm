// The tiled workspace views outlive a restart: the arrangement is stored as
// a split tree of {primary} and {workspace} leaves, pruned of what cannot
// come back, and rebuilt around the primary in one step. The pure half is
// tested directly; the rebuild runs against a small DOM stand-in that fails
// the test if any element is ever moved, because a moved iframe reloads.
import test from "node:test";
import assert from "node:assert/strict";

import {
  VIEW_ARRANGEMENT_KEY, WorkspaceViews, describeArrangement, parseArrangement,
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
  const primary = { primary: true, name: "main" };
  const api = { primary: false, name: "api" };
  const docs = { primary: false, name: "docs" };
  const root = split("h", pane(primary), split("v", pane(api), pane(docs), 0.3), 0.6);
  root.divider = { element: true };
  const arrangement = describeArrangement({ root, nameOf: (view) => view.name, active: api, zoomed: null });
  assert.deepEqual(JSON.parse(JSON.stringify(arrangement)), {
    version: 1,
    tree: split("h", pane(P), split("v", pane(W("api")), pane(W("docs")), 0.3), 0.6),
    active: W("api"),
    zoomed: null,
  });
  // The primary is a position: its own workspace name is not stored.
  assert.equal(JSON.stringify(arrangement).includes("main"), false);
  // Alone, the primary is what every boot shows anyway.
  assert.equal(describeArrangement({ root: pane(primary), nameOf: () => "x" }), null);
});

test("a stored arrangement is checked all the way down", () => {
  const good = { version: 1, tree: split("v", pane(W("api")), pane(P), 0.02), active: W("api"), zoomed: W("api") };
  const parsed = parseArrangement(JSON.stringify(good));
  assert.equal(shape(parsed.tree), "v15(api,P)", "a ratio outside the clamp is pulled back in");
  assert.deepEqual(parsed.active, W("api"));
  assert.deepEqual(parsed.zoomed, W("api"));

  for (const bad of [
    "not json",
    null,
    42,
    { version: 2, tree: good.tree },
    { version: 1, tree: split("h", pane(W("a")), pane(W("b"))) },
    { version: 1, tree: split("h", pane(P), pane(P)) },
    { version: 1, tree: split("x", pane(P), pane(W("a"))) },
    { version: 1, tree: { type: "split", dir: "h", ratio: 0.5, children: [pane(P)] } },
    { version: 1, tree: split("h", pane(P), pane(W(""))) },
    { version: 1, tree: split("h", pane(P), pane({ workspace: 7 })) },
  ]) {
    assert.equal(parseArrangement(typeof bad === "string" ? bad : JSON.stringify(bad)), null, JSON.stringify(bad));
  }
  const unknownActive = parseArrangement({ version: 1, tree: split("h", pane(P), pane(W("a"))), active: "api" });
  assert.deepEqual(unknownActive.active, P, "an unreadable active view falls back to the primary");
  assert.equal(unknownActive.zoomed, null);
});

test("scratch, missing, duplicate and primary-held views are pruned and their splits collapse", () => {
  const stored = {
    version: 1,
    tree: split("h",
      split("v", pane(P), pane(W("scratch")), 0.4),
      split("v", pane(W("api")), split("h", pane(W("gone")), pane(W("api")), 0.7), 0.35),
      0.6),
    active: W("gone"),
    zoomed: W("scratch"),
  };
  const plan = restorePlan(stored, { exists: (name) => name !== "gone", primaryName: "main" });
  assert.equal(shape(plan.tree), "h60(P,api)");
  assert.deepEqual(plan.skipped, [
    { workspace: "scratch", reason: "scratch" },
    { workspace: "gone", reason: "missing" },
    { workspace: "api", reason: "duplicate" },
  ]);
  assert.deepEqual(plan.active, P);
  assert.equal(plan.zoomed, null);

  const held = restorePlan({ version: 1, tree: split("h", pane(P), pane(W("main"))), active: W("main") },
    { primaryName: "main" });
  assert.equal(shape(held.tree), "P");
  assert.deepEqual(held.skipped, [{ workspace: "main", reason: "primary" }]);
  assert.equal(restorePlan("garbage"), null);
});

test("the store survives a storage that throws", () => {
  const memory = new Map();
  const storage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, value),
    removeItem: (key) => memory.delete(key),
  };
  const store = viewArrangementStore(storage);
  store.save('{"version":1}');
  assert.equal(memory.get(VIEW_ARRANGEMENT_KEY), '{"version":1}');
  assert.equal(store.load(), '{"version":1}');
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
  const app = new Element("div");
  globalThis.document = {
    createElement: (tag) => new Element(tag),
    getElementById: (id) => (id === "app" ? app : null),
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

function makeViews(store, primaryName = "main") {
  const errors = [];
  const views = new WorkspaceViews({
    current: () => primaryName,
    focus() {},
    fit() {},
    error: (message) => errors.push(message),
    store,
  });
  return { views, errors };
}

test("the stored tree is rebuilt in place, claim by claim, without moving an element", async () => {
  const { moves } = installDom();
  const claims = stubRegistry(new Set(["taken"]));
  const stored = JSON.stringify({
    version: 1,
    tree: split("h", split("v", pane(W("api")), pane(P), 0.3), split("v", pane(W("taken")), pane(W("docs")), 0.7), 0.6),
    active: W("docs"),
    zoomed: W("api"),
  });
  const store = memoryStore(stored);
  const { views, errors } = makeViews(store);
  assert.equal(store.saves.length, 0, "a boot that has not restored yet writes nothing");

  const result = await views.restoreSaved({ exists: () => true });
  assert.deepEqual(claims, ["api", "taken", "docs"], "every view is claimed through the registry, in tree order");
  assert.deepEqual(result, { restored: ["api", "docs"], failed: ["taken"] });
  assert.deepEqual(errors, [], "one refused claim among several is not worth a word");

  assert.equal(shape(mapNames(views.root)), "h60(v30(api,P),docs)");
  assert.equal(views.zoomed?.label, "api");
  assert.equal(views.active?.label, "docs");
  assert.equal(views.pendingFocus?.label, "docs", "the active view takes the keyboard once it has loaded");
  for (const view of views.views()) {
    if (view.primary) continue;
    assert.equal(view.frame.src.includes(`window=${view.id}`), true);
    assert.equal(view.el.parentNode, views.stage);
  }
  assert.deepEqual(moves.filter((node) => node !== document.getElementById("app")), [],
    "no view or iframe was ever re-parented");

  // Restored, the store follows the arrangement as it is now.
  const saved = JSON.parse(store.text);
  assert.equal(shape(saved.tree), "h60(v30(api,P),docs)");
  // Each view is stored with the registry id it holds now.
  assert.deepEqual(saved.active, { workspace: "docs", window: "side-2" });
  assert.deepEqual(saved.zoomed, { workspace: "api", window: "side-1" });
});

test("nothing coming back is said once, and the store then forgets the old tree", async () => {
  installDom();
  stubRegistry(new Set(["api"]));
  const store = memoryStore(JSON.stringify({
    version: 1, tree: split("h", pane(P), split("h", pane(W("api")), pane(W("gone")))), active: P, zoomed: null,
  }));
  const { views, errors } = makeViews(store);
  const result = await views.restoreSaved({ exists: (name) => name !== "gone" });
  assert.deepEqual(result, { restored: [], failed: ["api"] });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"gone", "api"/);
  assert.equal(views.views().length, 1);
  assert.equal(store.text, null, "a lone primary leaves nothing stored");
});

test("scratch views stay away silently, and a window without a store never restores", async () => {
  installDom();
  const claims = stubRegistry();
  const store = memoryStore(JSON.stringify({
    version: 1, tree: split("h", pane(P), pane(W("scratch"))), active: W("scratch"), zoomed: null,
  }));
  const { views, errors } = makeViews(store);
  await views.restoreSaved();
  assert.deepEqual(claims, []);
  assert.deepEqual(errors, []);

  const { views: second } = makeViews(null);
  assert.equal(await second.restoreSaved(), null);
  assert.deepEqual(claims, []);
});

function mapNames(node) {
  if (node.type === "pane") return pane(node.pane.primary ? P : W(node.pane.label));
  return split(node.dir, mapNames(node.children[0]), mapNames(node.children[1]), node.ratio);
}

test("leaves of a rebuilt tree are the live view objects", async () => {
  installDom();
  stubRegistry();
  const store = memoryStore(JSON.stringify({
    version: 1, tree: split("v", pane(W("api")), pane(P), 0.5), active: P, zoomed: null,
  }));
  const { views } = makeViews(store);
  await views.restoreSaved();
  const live = leaves(views.root);
  assert.equal(live.length, 2);
  assert.equal(live[1], views.primary);
  assert.equal(live[0].label, "api");
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
    version: 1,
    tree: split("h", pane(P), pane({ workspace: "api", window: "old-7" })),
    active: P,
    zoomed: null,
  }));
  const { views } = makeViews(store);
  const result = await views.restoreSaved();

  assert.deepEqual(result, { restored: ["api"], failed: [] });
  assert.deepEqual(calls, ["DELETE /api/windows/old-7", "POST /api/windows"], "released before it is claimed again");
  const saved = JSON.parse(store.text);
  assert.deepEqual(saved.tree.children[1].pane, { workspace: "api", window: "new-1" }, "the new id is what the next restore releases");
});

test("a stored window id is kept only when it is a short string", () => {
  const tree = (pane_) => ({ version: 1, tree: split("h", pane(P), pane(pane_)), active: P });
  assert.deepEqual(parseArrangement(tree({ workspace: "a", window: "w-1" })).tree.children[1].pane, { workspace: "a", window: "w-1" });
  assert.deepEqual(parseArrangement(tree({ workspace: "a", window: 7 })).tree.children[1].pane, { workspace: "a" });
  assert.deepEqual(parseArrangement(tree({ workspace: "a", window: "x".repeat(65) })).tree.children[1].pane, { workspace: "a" });
});
