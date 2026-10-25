// A DOM stand-in for the stage tests (workspace_views*.test.mjs): elements
// that record every re-parenting (a moved iframe reloads, so a test fails on
// any), iframes whose document "boots" the moment their src is set, and a
// window registry behind fetch.

export function installDom({ refused = new Set(), windows = [] } = {}) {
  const moves = [];
  const closed = [];
  const launches = [];
  const claims = [];
  const calls = [];
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
      this.inert = false;
      this.listeners = {};
    }
    set className(value) { String(value).split(/\s+/).filter(Boolean).forEach((name) => this.classList.add(name)); }
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
          app: {
            attachedSessionIds: () => attached,
            refocusTerm() {},
            focusSession() {},
            startLaunch: async (launch) => { launches.push([name, launch]); return true; },
          },
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
    remove() {
      if (this.parentNode?.children) this.parentNode.children = this.parentNode.children.filter((n) => n !== this);
      this.parentNode = null;
    }
    get isConnected() { return Boolean(this.parentNode); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  }
  const shell = new Element("div");
  globalThis.document = {
    createElement: (tag) => new Element(tag),
    getElementById: () => null,
    querySelector: (selector) => (selector === "#app > .workspace-shell" ? shell : null),
  };
  const refreshes = [];
  globalThis.window = {
    addEventListener() {},
    quicktermChrome: { scratchLabels: new Map(), refreshSoon: () => refreshes.push(1) },
  };
  globalThis.location = { pathname: "/" };
  let next = 1;
  const json = (status, body) => ({
    ok: status < 400, status, json: async () => body, headers: { get: () => "application/json" },
  });
  globalThis.fetch = async (path, options = {}) => {
    calls.push(`${options.method || "GET"} ${path}`);
    if (options.method === "DELETE") return json(200, {});
    if (!options.method || options.method === "GET") return json(200, { windows });
    const body = JSON.parse(options.body || "{}");
    claims.push(body.workspace);
    if (refused.has(body.workspace)) return json(409, { detail: "claimed" });
    return json(200, { id: `view-${String(next++).padStart(8, "0")}`, workspace: body.workspace });
  };
  return { moves, closed, refreshes, launches, claims, calls };
}

export function memoryStore({ current = null, legacy = null } = {}) {
  const store = { current, legacy, saves: [], dropped: 0 };
  store.load = () => store.current;
  store.loadLegacy = () => store.legacy;
  store.dropLegacy = () => { store.legacy = null; store.dropped += 1; };
  store.save = (value) => { store.current = value; store.saves.push(value); };
  return store;
}
