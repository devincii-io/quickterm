import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_STAGE_TEXT, VIEW_COLORS, VIEW_MIN_PX, WorkspaceViews, clampViewRatio, companionUrl, nextScratchLabel,
  pickViewColor, ratioBounds, viewColorFor,
} from "../../quickterm/frontend/js/workspace_views.js";

test("a companion has a distinct explicit identity and carries auth only in the fragment", () => {
  const url = new URL(companionUrl("/", "API & UI", "side-123", "secret/+"), "http://localhost");
  assert.equal(url.searchParams.get("workspace"), "API & UI");
  assert.equal(url.searchParams.get("window"), "side-123");
  assert.equal(url.searchParams.get("embedded"), "1");
  assert.equal(url.searchParams.has("primary"), false);
  assert.equal(url.searchParams.has("cwd"), false);
  assert.equal(url.searchParams.has("first"), false);
  assert.equal(url.search.includes("secret"), false);
  assert.equal(decodeURIComponent(url.hash.slice(3)), "secret/+");
});

test("a scratch view carries the Explorer folder and the first-view mark in its query", () => {
  const url = new URL(companionUrl("/", null, "view-12345678", "token", { cwd: "C:\\Work & Play", first: true }),
    "http://localhost");
  assert.equal(url.searchParams.get("cwd"), "C:\\Work & Play");
  assert.equal(url.searchParams.get("first"), "1");
  assert.equal(url.searchParams.get("scratch"), "scratch-view-view-12345678");
  const plain = new URL(companionUrl("/", null, "view-12345678", "token", { first: false }), "http://localhost");
  assert.equal(plain.searchParams.has("first"), false);
});

test("resizing always leaves usable space for both sides of a split", () => {
  assert.equal(clampViewRatio(-30), 15);
  assert.equal(clampViewRatio(150), 85);
  assert.equal(clampViewRatio(62), 62);
  assert.equal(clampViewRatio(NaN), 50);
});

test("a divider drag never squeezes a view under its pixel floor while there is room", () => {
  const wide = ratioBounds(1600);
  assert.equal(wide.min, 0.15, "on a wide split the percent clamp is the tighter one");
  assert.equal(wide.max, 0.85);
  const narrow = ratioBounds(800);
  assert.equal(narrow.min, VIEW_MIN_PX / 800);
  assert.equal(narrow.max, 1 - VIEW_MIN_PX / 800);
  // Too small for two floors: fall back to the percent clamp rather than a
  // min above the max.
  const tiny = ratioBounds(200);
  assert.equal(tiny.min, 0.15);
  assert.equal(tiny.max, 0.85);
});

test("every open view gets its own colour before any colour repeats", () => {
  assert.equal(pickViewColor([]), VIEW_COLORS[0]);
  assert.equal(pickViewColor([VIEW_COLORS[0]]), VIEW_COLORS[1]);
  assert.equal(pickViewColor([VIEW_COLORS[0], VIEW_COLORS[2]]), VIEW_COLORS[1], "a closed view's colour is reused");
  assert.equal(pickViewColor(VIEW_COLORS), VIEW_COLORS[0]);
});

test("a workspace keeps its own colour across opens and restarts", () => {
  // The same name lands on the same colour whatever opened before it.
  const alpha = viewColorFor("alpha");
  assert.equal(pickViewColor([], "alpha"), alpha);
  assert.equal(pickViewColor([viewColorFor("beta")].filter((color) => color !== alpha), "alpha"), alpha);
  assert.equal(viewColorFor("alpha"), alpha);
  // Only an open view already showing that colour moves it.
  assert.notEqual(pickViewColor([alpha], "alpha"), alpha);
  assert.ok(VIEW_COLORS.includes(viewColorFor("anything at all")));
});

test("scratch views get distinct identities and labels without replacing another layout", () => {
  const url = new URL(companionUrl("/", null, "view-12345678", "token"), "http://localhost");
  assert.equal(url.searchParams.get("workspace"), "");
  assert.equal(url.searchParams.get("scratch"), "scratch-view-view-12345678");
  assert.equal(nextScratchLabel(["scratch 1", "scratch 3"]), "scratch 2");
});

// ---- the view manager, against a DOM stand-in whose iframes boot at once ----

function installDom() {
  const moves = [];
  const closed = [];
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
      this.listeners = {};
    }
    set className(value) { String(value).split(/\s+/).filter(Boolean).forEach((name) => this.classList.add(name)); }
    // An iframe's document "boots" the moment its src is set.
    set src(value) {
      this._src = value;
      const params = new URL(value, "http://localhost").searchParams;
      const name = params.get("workspace") || params.get("scratch");
      const attached = [];
      this.contentWindow = {
        focus() {},
        quicktermView: {
          workspace: () => name,
          suspend() {},
          close: async () => { closed.push(name); return true; },
          app: { attachedSessionIds: () => attached, refocusTerm() {}, focusSession() {} },
        },
      };
      this.attached = attached;
    }
    get src() { return this._src; }
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
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
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
  const refreshes = [];
  globalThis.window = {
    addEventListener() {},
    matchMedia: () => ({ matches: true }),
    quicktermChrome: { scratchLabels: new Map(), refreshSoon: () => refreshes.push(1) },
  };
  globalThis.location = { pathname: "/" };
  globalThis.requestAnimationFrame = () => 0;
  let next = 1;
  globalThis.fetch = async (path, options) => {
    const body = JSON.parse(options.body || "{}");
    return {
      ok: true, status: 200,
      json: async () => ({ id: `view-${String(next++).padStart(8, "0")}`, workspace: body.workspace }),
      headers: { get: () => "application/json" },
    };
  };
  return { moves, closed, refreshes };
}

function makeViews() {
  const errors = [];
  const views = new WorkspaceViews({ fit() {}, error: (message) => errors.push(message) });
  return { views, errors };
}

test("an empty stage says how to get back in and offers a new scratch view", () => {
  installDom();
  const { views } = makeViews();
  assert.equal(views.views().length, 0);
  assert.equal(views.active, null);
  assert.equal(views.empty.hidden, false);
  assert.equal(views.empty.children[0].textContent, EMPTY_STAGE_TEXT);
  assert.equal(EMPTY_STAGE_TEXT, "No workspace open. Open one from the sidebar.");
  assert.equal(views.empty.children[1].textContent, "New scratch");
  assert.equal(views.stage.classList.contains("empty"), true);
});

test("open resolves with the view once its document is up and focuses one already shown", async () => {
  const { moves } = installDom();
  const { views } = makeViews();
  const api = await views.open("api");
  assert.equal(api.label, "api");
  assert.equal(views.appFor(api), api.frame.contentWindow.quicktermView.app);
  assert.equal(views.active, api, "the first view is the active one");
  assert.equal(views.empty.hidden, true);
  const docs = await views.open("docs", { cwd: "/ignored-for-named" });
  assert.equal(views.root.type === "split" && views.root.dir, "h", "a wide view is split side by side");
  assert.equal(await views.open("api"), api, "a shown workspace is focused, not opened twice");
  assert.equal(views.active, api);
  assert.equal(views.viewForWorkspace("docs"), docs);
  assert.deepEqual(moves, [], "no view was re-parented");
});

test("list names each view's workspace, label, colour, focus and window", async () => {
  installDom();
  const { views } = makeViews();
  const api = await views.open("api");
  const scratch = await views.open(null, { first: true });
  assert.equal(scratch.frame.src.includes("first=1"), true);
  views.activate(scratch);
  assert.deepEqual(views.list(), [
    { workspace: "api", label: "api", color: viewColorFor("api"), active: false, window: api.frame.contentWindow },
    {
      workspace: `scratch-view-${scratch.id}`, label: "scratch 1", color: pickViewColor([viewColorFor("api")]), active: true,
      window: scratch.frame.contentWindow,
    },
  ]);
  assert.equal(window.quicktermChrome.scratchLabels.get(`scratch-view-${scratch.id}`), "scratch 1");
});

test("an open asked for while a close is running waits for it instead of being dropped", async () => {
  installDom();
  const { views, errors } = makeViews();
  const api = await views.open("api");
  let finish;
  api.frame.contentWindow.quicktermView.close = () => new Promise((resolve) => { finish = resolve; });
  const closing = views.close(api);
  const opening = views.open(null);
  const docs = views.open("docs");
  await Promise.resolve();
  finish(true);
  assert.equal(await closing, true);
  const scratch = await opening;
  assert.ok(scratch, "the scratch view opened after the close");
  assert.equal((await docs).workspace, "docs");
  assert.deepEqual(views.names(), ["scratch 1", "docs"]);
  assert.deepEqual(errors, []);
});

test("a scratch label never takes a saved workspace's name, and only names scratch views", async () => {
  installDom();
  const errors = [];
  const views = new WorkspaceViews({ fit() {}, error: (message) => errors.push(message), reservedNames: () => ["scratch 1"] });
  const scratch = await views.open(null);
  assert.equal(views.nameOf(scratch), "scratch 2");
  assert.equal(views.scratchViewLabelled("scratch 2"), scratch);
  const named = await views.open("work");
  assert.equal(views.scratchViewLabelled("work"), null, "a workspace is found by name, not label");
  assert.equal(views.viewForWorkspace("work"), named);
});

test("a view is found by a session its pane holds", async () => {
  installDom();
  const { views } = makeViews();
  await views.open("api");
  const docs = await views.open("docs");
  docs.frame.attached.push("s-1");
  assert.equal(views.viewForSession("s-1"), docs);
  assert.equal(views.viewForSession("s-2"), null);
  assert.equal(views.focusSession("s-1"), true);
  assert.equal(views.active, docs);
});

test("any view closes, the last one too, and the stage is empty again", async () => {
  const { closed, moves } = installDom();
  const { views } = makeViews();
  const api = await views.open("api");
  const docs = await views.open("docs");
  views.activate(docs);
  assert.equal(await views.close(docs), true);
  assert.deepEqual(closed, ["docs"], "the view saved, retained and released through its own document");
  assert.deepEqual(views.views(), [api]);
  assert.equal(views.active, api, "the view that inherits the space inherits the keyboard");
  assert.equal(await views.close(api), true, "the last view closes like any other");
  assert.deepEqual(views.views(), []);
  assert.equal(views.root, null);
  assert.equal(views.active, null);
  assert.equal(views.empty.hidden, false);
  assert.equal(await views.whenReady(api), false, "a closed view is never ready again");
  assert.deepEqual(moves, []);
});

test("a view that says it is ready learns whether it is active and takes the keyboard it waited for", async () => {
  const { refreshes } = installDom();
  const { views } = makeViews();
  const api = await views.open("api");
  const docs = await views.open("docs");
  const suspended = new Map();
  const focused = [];
  for (const view of [api, docs]) {
    view.frame.contentWindow.quicktermView.suspend = (value) => suspended.set(view.label, value);
    view.frame.contentWindow.focus = () => focused.push(view.label);
  }
  assert.equal(views.active, api, "the keyboard stays put until the new document can take it");
  assert.equal(views.pendingFocus, docs);
  views.ready(api.frame.contentWindow);
  assert.equal(suspended.get("api"), false);
  assert.deepEqual(focused, []);
  const before = refreshes.length;
  views.ready(docs.frame.contentWindow);
  assert.ok(refreshes.length > before, "the sidebar hears about it");
  assert.equal(views.pendingFocus, null);
  assert.equal(views.active, docs);
  assert.deepEqual(focused, ["docs"]);
  assert.equal(suspended.get("api"), true, "the view it left is suspended");
  assert.equal(suspended.get("docs"), false);
});

test("a view whose document refuses to close stays open", async () => {
  installDom();
  const { views, errors } = makeViews();
  const api = await views.open("api");
  api.frame.contentWindow.quicktermView.close = async () => false;
  assert.equal(await views.close(api), false);
  assert.deepEqual(views.views(), [api]);
  assert.match(errors[0], /switching/);
});
