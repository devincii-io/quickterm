import test from "node:test";
import assert from "node:assert/strict";
import { Palette } from "../../quickterm/frontend/js/palette.js";
import { rowGroup } from "../../quickterm/frontend/js/palette_items.js";

const SESSION = "0199a6f2-1c2d-7e3f-8a9b-0c1d2e3f4a5b";

// The palette without its DOM: the list renders nowhere and the input is a
// plain object, which is all the row logic and the key handling touch.
function fakePalette(app) {
  const palette = Object.create(Palette.prototype);
  Object.assign(palette, {
    app, open: true, items: [], filtered: [], sel: 0, prompt: null,
    foreignMode: false, windowMode: false, searchMode: false,
    killMode: false, killTarget: null, killPending: false,
    foreignSessions: [], requestId: 1,
    late: { names: [], details: new Map(), attach: [], agentSessions: [] },
    input: { value: "", placeholder: "", focus() {}, setAttribute() {}, removeAttribute() {} },
    overlay: { hidden: false },
    listEl: { textContent: "" },
    _renderList() {},
    focusInput() {},
  });
  return palette;
}

const press = (key) => ({ key, preventDefault() {}, stopPropagation() {} });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the palette distinguishes external windows and uses the workspace folder", () => {
  const app = {
    profiles: [
      { name: "Remote", terminal_type: "rdp", connection: { host: "server" } },
      { name: "Assistant", terminal_type: "claude-code", cmd: "claude", cwd: "obsolete" },
    ],
    snippets: [], workspacePath: () => "C:/project",
  };
  const items = Palette.prototype._staticItems.call({ app });
  assert.equal(items.find((item) => item.label === "open window: Remote").kind, "window");
  assert.equal(items.find((item) => item.label === "open terminal: Assistant").kind, "terminal");
  assert.equal(items.find((item) => item.label === "Claude continue latest: Assistant").hint, "C:/project");
  assert.ok(items.some((item) => item.label === "split agent view: Assistant"));
});

test("workspaces are opened from enumerated rows, never loaded in place", () => {
  const calls = [];
  const palette = fakePalette({
    profiles: [], snippets: [],
    openWorkspace: (name) => calls.push(name),
    openWorkspaces: () => [{ workspace: "web", label: "web" }],
  });
  palette.late.names = ["api", "web"];
  palette._compose();
  const labels = palette.items.map((item) => item.label);
  assert.ok(!labels.some((label) => /load workspace|show workspace beside/.test(label)));
  assert.ok(labels.includes("open workspace: api"));
  assert.ok(labels.includes("close workspace view: web"));
  assert.ok(labels.includes("new scratch view"));
  assert.ok(labels.includes("move terminal here…"));
  assert.ok(labels.includes("new window…"));
  palette.input.value = "open workspace: api";
  palette._refilter();
  palette._key(press("Enter"));
  assert.deepEqual(calls, ["api"]);
  assert.equal(palette.open, false);
});

test("a prefix narrows the list to one kind and a bare prefix lists it", () => {
  const palette = fakePalette({
    profiles: [{ name: "Codex", terminal_type: "codex" }],
    snippets: [{ name: "deploy", text: "make deploy\r" }],
    liveTerminals: () => [{ session: { id: "s1", name: "build", alive: true }, workspace: "api", label: "api" }],
    settingEntries: () => [{ id: "font_size", label: "Font size", tab: "general", keywords: "font size zoom px" }],
  });
  palette.late.names = ["api"];
  palette._compose();
  const visible = (query) => {
    palette.input.value = query;
    palette._refilter();
    return palette.filtered;
  };
  assert.deepEqual(visible("#").map((item) => item.label),
    ["setting: Font size", "edit terminal: Codex", "edit snippet: deploy"]);
  assert.deepEqual(visible("!").map((item) => item.label), ["snippet: deploy"]);
  const places = visible("@");
  assert.ok(places.length > 0 && places.every((item) => rowGroup(item) === "place"));
  assert.ok(places.some((item) => item.label === "go to terminal: build"));
  assert.ok(places.some((item) => item.label === "open workspace: api"));
  const actions = visible(">");
  assert.ok(actions.every((item) => rowGroup(item) === "action"));
  assert.ok(actions.some((item) => item.label === "Codex fork a session: Codex"));
  assert.deepEqual(visible("#zoom").map((item) => item.label), ["setting: Font size"]);
  // Settings and configs stay out of the bare list but are found by typing.
  assert.ok(!visible("").some((item) => item.kind === "setting" || item.kind === "config"));
  assert.ok(visible("font size").some((item) => item.label === "setting: Font size"));
});

test("kill terminal is a keyboard path: pick, then Enter on the pre-selected kill", async () => {
  const killed = [];
  const build = { id: "s1", name: "build", alive: true };
  const palette = fakePalette({
    profiles: [], snippets: [],
    liveTerminals: () => [
      { session: build, workspace: "api", label: "api" },
      { session: { id: "s2", name: "old", alive: false }, workspace: null },
    ],
    killTerminal: async (session) => { killed.push(session); },
  });
  palette._compose();
  palette.input.value = "kill terminal";
  palette._refilter();
  assert.equal(palette.filtered[palette.sel].label, "kill terminal…");
  palette._key(press("Enter"));
  assert.equal(palette.killMode, true);
  assert.equal(palette.filtered[palette.sel].label, "kill build…");
  assert.ok(!palette.filtered.some((item) => item.label.includes("old")));
  palette._key(press("Enter"));
  assert.equal(palette.killTarget.session, build);
  assert.equal(palette.filtered[palette.sel].label, "kill build");
  assert.match(palette.input.placeholder, /Enter kills, Esc goes back/);
  palette._key(press("Enter"));
  await settle();
  assert.deepEqual(killed, [build]);
  assert.equal(palette.open, false);
});

test("a failed kill keeps the confirmation and says why", async () => {
  let attempts = 0;
  const build = { id: "s1", name: "build", alive: true };
  const palette = fakePalette({
    profiles: [], snippets: [],
    liveTerminals: () => [{ session: build, workspace: "api", label: "api" }],
    killTerminal: async () => {
      attempts += 1;
      throw Object.assign(new Error("500"), { status: 500, detail: "terminal process could not be stopped" });
    },
  });
  palette._killMode();
  palette._key(press("Enter"));
  palette._key(press("Enter"));
  await settle();
  assert.equal(attempts, 1);
  assert.equal(palette.open, true);
  assert.match(palette.input.placeholder, /terminal process could not be stopped/);
  assert.equal(palette.filtered[palette.sel].label, "kill build");
  // Enter retries; Escape goes back to the list, not out of the palette.
  palette._key(press("Enter"));
  await settle();
  assert.equal(attempts, 2);
  palette._key(press("Escape"));
  assert.equal(palette.killMode, true);
  assert.equal(palette.killTarget, null);
  assert.equal(palette.filtered[palette.sel].label, "kill build…");
});

test("resume rows arrive late for the first agent profile of each type", async (t) => {
  const urls = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => {
    urls.push(url);
    const sessions = url.includes("type=codex")
      ? [{ id: SESSION, title: "Port the parser", updated_at: "2026-10-03T08:00:00Z", cwd: "C:\\src" }]
      : [];
    return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ sessions }) };
  };
  const resumed = [];
  const codex = { name: "Codex", terminal_type: "codex" };
  const palette = fakePalette({
    profiles: [codex, { name: "Codex 2", terminal_type: "codex" }, { name: "Claude", terminal_type: "claude-code" }],
    snippets: [],
    currentWorkspace: () => "api",
    resumeAgentSession: (profile, id) => resumed.push([profile, id]),
  });
  palette._compose();
  await palette._fillAgentSessions(palette.requestId);
  assert.equal(urls.length, 2);
  assert.ok(urls.some((url) => url.startsWith("/api/agent-sessions?") && url.includes("type=codex") && url.includes("workspace=api")));
  const row = palette.items.find((item) => item.label === "resume Codex session: Port the parser");
  assert.ok(row);
  row.run();
  assert.deepEqual(resumed, [[codex, SESSION]]);

  // An answer for a palette that has moved on is dropped.
  palette.late.agentSessions = [];
  palette._compose();
  const stale = palette.requestId;
  palette.requestId += 1;
  await palette._fillAgentSessions(stale);
  assert.ok(!palette.items.some((item) => item.label.startsWith("resume Codex session")));
});
