// The stage shows one workspace at a time. The others stay loaded, keep their
// box and are told they are hidden; no iframe is ever re-parented.
import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_STAGE_TEXT, SCRATCH_LABEL, VIEW_COLORS, WorkspaceViews, companionUrl, sidebarOrder, viewColorFor,
} from "../../quickterm/frontend/js/workspace_views.js";
import { claimFocus, releaseFocus } from "../../quickterm/frontend/js/focus.js";
import { installDom } from "./stage_dom.mjs";

test("a view has a distinct explicit identity and carries auth only in the fragment", () => {
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
  assert.equal(url.searchParams.get("workspace"), "");
  assert.equal(url.searchParams.get("cwd"), "C:\\Work & Play");
  assert.equal(url.searchParams.get("first"), "1");
  assert.equal(url.searchParams.get("scratch"), "scratch-view-view-12345678");
  const plain = new URL(companionUrl("/", null, "view-12345678", "token", { first: false }), "http://localhost");
  assert.equal(plain.searchParams.has("first"), false);
});

test("a workspace keeps its own colour across opens and restarts", () => {
  assert.equal(viewColorFor("alpha"), viewColorFor("alpha"));
  assert.ok(VIEW_COLORS.includes(viewColorFor("anything at all")));
});

test("next and previous walk the sidebar's order: names first, scratch last", () => {
  assert.deepEqual(sidebarOrder(["scratch-view-abcdefgh", "web", "Api", "app10", "app9"]),
    ["Api", "app9", "app10", "web", "scratch-view-abcdefgh"]);
});

function makeViews(options = {}) {
  const errors = [];
  const views = new WorkspaceViews({ error: (message) => errors.push(message), ...options });
  return { views, errors };
}

const shown = (views) => views.views().filter((view) => view.el.classList.contains("shown"));

test("an empty stage says how to get back in and offers the scratch workspace", () => {
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

test("opening shows that workspace alone; the others stay loaded, hidden and inert", async () => {
  const { moves } = installDom();
  const { views } = makeViews();
  const api = await views.open("api");
  assert.equal(views.appFor(api), api.frame.contentWindow.quicktermView.app);
  assert.equal(views.active, api);
  assert.equal(views.empty.hidden, true);
  const docs = await views.open("docs", { cwd: "/ignored-for-named" });
  assert.equal(views.active, docs, "a newly opened workspace is the shown one");
  assert.deepEqual(shown(views), [docs]);
  assert.equal(api.el.inert, true, "a hidden view takes no input");
  assert.equal(docs.el.inert, false);
  assert.equal(api.el.parentNode, views.stage, "the hidden view stays in the stage");
  assert.equal(await views.open("api"), api, "an open workspace is shown, not opened twice");
  assert.deepEqual(shown(views), [api]);
  assert.equal(docs.el.inert, true);
  assert.deepEqual(moves, [], "no view was re-parented");
});

test("list names each view's workspace, label, colour, whether it is shown and its window", async () => {
  installDom();
  const { views } = makeViews();
  const api = await views.open("api");
  const scratch = await views.open(null, { first: true });
  assert.equal(scratch.frame.src.includes("first=1"), true);
  assert.deepEqual(views.list(), [
    { workspace: "api", label: "api", color: viewColorFor("api"), active: false, window: api.frame.contentWindow },
    {
      workspace: `scratch-view-${scratch.id}`, label: SCRATCH_LABEL, color: viewColorFor(SCRATCH_LABEL), active: true,
      window: scratch.frame.contentWindow,
    },
  ]);
  assert.equal(SCRATCH_LABEL, "scratch");
  assert.equal(window.quicktermChrome.scratchLabels.get(`scratch-view-${scratch.id}`), "scratch");
});

test("a window has one scratch view; Explorer's folder starts a terminal in it", async () => {
  const { launches, claims } = installDom();
  const { views } = makeViews();
  const scratch = await views.open(null, { cwd: "C:\\first" });
  assert.equal(new URL(scratch.frame.src, "http://localhost").searchParams.get("cwd"), "C:\\first",
    "a new scratch view starts its first terminal there itself");
  await views.open("api");
  assert.equal(await views.open(null), scratch, "the scratch view is shown again, not opened twice");
  assert.equal(views.active, scratch);
  assert.equal(await views.open(null, { cwd: "C:\\second" }), scratch);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(launches, [[`scratch-view-${scratch.id}`, { cwd: "C:\\second" }]]);
  assert.deepEqual(claims, [null, "api"], "one claim per view");
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
  assert.ok(await opening, "the scratch view opened after the close");
  assert.equal((await docs).workspace, "docs");
  assert.deepEqual(views.list().map((item) => item.label), ["scratch", "docs"]);
  assert.deepEqual(errors, []);
});

test("a view is found by a session its pane holds, and showing it focuses that pane", async () => {
  installDom();
  const { views } = makeViews();
  const api = await views.open("api");
  const docs = await views.open("docs");
  api.frame.attached.push("s-1");
  assert.equal(views.viewForSession("s-1"), api);
  assert.equal(views.viewForSession("s-2"), null);
  assert.equal(views.focusSession("s-1"), true);
  assert.equal(views.active, api);
  assert.equal(views.focusWorkspace("docs"), true);
  assert.equal(views.active, docs);
  assert.equal(views.focusWorkspace("gone"), false);
});

test("closing the shown view shows the one shown before it, then the empty stage", async () => {
  const { closed, moves } = installDom();
  const { views } = makeViews();
  const api = await views.open("api");
  const docs = await views.open("docs");
  const web = await views.open("web");
  views.focusView(api);
  views.focusView(web);
  assert.equal(await views.close(web), true);
  assert.deepEqual(closed, ["web"], "the view saved, retained and released through its own document");
  assert.equal(web.el.parentNode, null);
  assert.equal(views.active, api, "the most recently shown remaining one, not the last opened");
  assert.deepEqual(shown(views), [api]);
  assert.equal(await views.close(docs), true, "closing a hidden view leaves the shown one alone");
  assert.equal(views.active, api);
  assert.equal(await views.close(api), true, "the last view closes like any other");
  assert.deepEqual(views.views(), []);
  assert.equal(views.active, null);
  assert.equal(views.empty.hidden, false);
  assert.equal(await views.whenReady(api), false, "a closed view is never ready again");
  assert.deepEqual(moves, []);
});

test("a closed scratch view gives its label back", async () => {
  installDom();
  const { views } = makeViews();
  const scratch = await views.open(null);
  await views.close(scratch);
  assert.equal(window.quicktermChrome.scratchLabels.has(scratch.workspace), false);
});

test("a view that says it is ready learns whether it is shown and takes the keyboard it waited for", async () => {
  const { refreshes } = installDom();
  const { views } = makeViews();
  const api = await views.open("api");
  const docs = await views.open("docs");
  const suspended = new Map();
  const focused = [];
  for (const view of [api, docs]) {
    view.frame.contentWindow.quicktermView.suspend = (value) => suspended.set(view.workspace, value);
    view.frame.contentWindow.focus = () => focused.push(view.workspace);
  }
  assert.equal(views.pendingFocus, docs, "the keyboard waits for the new document");
  views.ready(api.frame.contentWindow);
  assert.equal(suspended.get("api"), true, "a hidden view is suspended");
  assert.deepEqual(focused, []);
  const before = refreshes.length;
  views.ready(docs.frame.contentWindow);
  assert.ok(refreshes.length > before, "the sidebar hears about it");
  assert.equal(views.pendingFocus, null);
  assert.deepEqual(focused, ["docs"]);
  assert.equal(suspended.get("docs"), false);
});

test("a shell overlay keeps the keyboard: focusView only shows and waits", async () => {
  installDom();
  const { views } = makeViews();
  const api = await views.open("api");
  const docs = await views.open("docs");
  views.ready(api.frame.contentWindow);
  const focused = [];
  for (const view of [api, docs]) view.frame.contentWindow.focus = () => focused.push(view.workspace);
  claimFocus("panel");
  try {
    views.ready(docs.frame.contentWindow);
    views.focusView(api);
    assert.deepEqual(focused, [], "no contentWindow.focus() under an overlay");
    assert.equal(views.active, api, "it is shown all the same");
    assert.equal(views.pendingFocus, api);
  } finally {
    releaseFocus("panel");
  }
  views.focusView(views.active);
  assert.deepEqual(focused, ["api"]);
  assert.equal(views.pendingFocus, null);
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

test("switching tells the views it hides and shows, once per change", async () => {
  installDom();
  const { views } = makeViews();
  const api = await views.open("api");
  const docs = await views.open("docs");
  const said = { api: [], docs: [] };
  for (const view of [api, docs]) {
    view.frame.contentWindow.quicktermView.setHidden = (value) => said[view.workspace].push(value);
    views.ready(view.frame.contentWindow);
  }
  assert.deepEqual(said, { api: [true], docs: [false] }, "a ready view learns its state once");
  views.focusView(api);
  assert.deepEqual(said, { api: [true, false], docs: [false, true] });
  views.focusView(api);
  assert.deepEqual(said, { api: [true, false], docs: [false, true] }, "an unchanged state is not repeated");
});

test("next and previous workspace wrap around the open ones in sidebar order", async () => {
  installDom();
  const { views } = makeViews();
  const scratch = await views.open(null);
  const web = await views.open("web");
  const api = await views.open("api");
  assert.equal(views.cycle(1), true);
  assert.equal(views.active, web);
  assert.equal(views.cycle(1), true);
  assert.equal(views.active, scratch, "scratch comes last");
  assert.equal(views.cycle(1), true);
  assert.equal(views.active, api, "and the walk wraps");
  assert.equal(views.cycle(-1), true);
  assert.equal(views.active, scratch);
  await views.close(api);
  await views.close(web);
  assert.equal(views.cycle(1), false, "one open workspace has nowhere to go");
});

test("a boot releases the views a previous page left registered under this window", async () => {
  const { calls } = installDom({
    windows: [
      { id: "old-1", parent: "shell-1" },
      { id: "other", parent: "shell-2" },
      { id: "shell-1", parent: null },
    ],
  });
  const { views } = makeViews({ parentId: () => "shell-1" });
  await views.releaseLeftovers();
  assert.deepEqual(calls, ["GET /api/windows", "DELETE /api/windows/old-1"]);
});
