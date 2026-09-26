import test from "node:test";
import assert from "node:assert/strict";

// main.js is the composition root and cannot be imported here (it boots on
// import and pulls in xterm through layout.js). Every module it composes can,
// and importing them all is what catches a module that fails at load time.
const JS = "../../quickterm/frontend/js/";
const MODULES = {
  "app_state.js": ["createAppState"],
  "autosave.js": ["createAutosave"],
  "boot_context.js": [
    "SCRATCH_WS", "embedded", "storedWorkspace", "storedScratchActive", "rememberWorkspace",
    "captureToken", "captureOpenDir", "captureWindowIdentity", "rememberedWindowId",
    "rememberWindowId", "loadInventoryCache", "saveInventoryCache",
  ],
  "config_sync.js": ["createConfigSync"],
  "feedback.js": ["setWorkspaceSaveState", "showError", "clearError"],
  "fonts.js": ["DEFAULT_FONT", "clampFont", "createFontSize"],
  "here.js": ["pathKey", "samePath", "insidePath", "baseName", "createHere"],
  "launch_loop.js": ["createLaunchLoop"],
  "layout_sessions.js": ["sessionIdsInLayout", "removeSessionFromLayout", "layoutWith"],
  "lifecycle.js": ["createLifecycle"],
  "pane_commands.js": ["createPaneCommands"],
  "scratch.js": ["discardScratchWarning", "createScratch"],
  "session_ownership.js": ["createSessionOwnership"],
  "sidebar.js": ["createSidebar"],
  "terminal_actions.js": ["createTerminalActions", "resultLabel"],
  "spawner.js": [
    "defaultSystemSpec", "serializableSpec", "commandTerminalType", "claudeProfileForPane", "createSpawner",
  ],
  "updates.js": ["watchUpdates"],
  "window_registry.js": ["createWindowRegistry"],
  "workspace_actions.js": ["validateWorkspaceName", "createWorkspaceActions"],
  "workspace_switch.js": ["createWorkspaceSwitch"],
};

const load = (name) => import(JS + name);

test("every module main.js composes loads outside a browser and exports its names", async () => {
  for (const [name, exports] of Object.entries(MODULES)) {
    const module = await load(name);
    for (const exported of exports) {
      assert.ok(exported in module, `${name} exports ${exported}`);
    }
  }
});

test("a factory builds without touching its dependencies", async () => {
  // Composition in main.js is synchronous and hands several factories arrows
  // to modules built after them; a factory that called a dependency while
  // being built would hit one of those before it exists.
  const trap = new Proxy({}, {
    get(_, key) {
      if (key === "then") return undefined;
      return () => { throw new Error(`called ${String(key)} while building`); };
    },
  });
  const { createAppState } = await load("app_state.js");
  const state = createAppState({
    cfg: { font_size: 14 }, profiles: [], snippets: [], workspaceNames: [],
    terminalInventory: null, windowIsPrimary: true,
  });
  const layout = { panes: () => [], serialize: () => null };
  const factories = [
    ["autosave.js", "createAutosave"], ["config_sync.js", "createConfigSync"], ["here.js", "createHere"],
    ["launch_loop.js", "createLaunchLoop"], ["lifecycle.js", "createLifecycle"],
    ["pane_commands.js", "createPaneCommands"], ["scratch.js", "createScratch"],
    ["session_ownership.js", "createSessionOwnership"], ["sidebar.js", "createSidebar"],
    ["spawner.js", "createSpawner"], ["window_registry.js", "createWindowRegistry"],
    ["workspace_actions.js", "createWorkspaceActions"], ["workspace_switch.js", "createWorkspaceSwitch"],
    ["fonts.js", "createFontSize"], ["terminal_actions.js", "createTerminalActions"],
  ];
  for (const [file, name] of factories) {
    const factory = (await load(file))[name];
    const deps = new Proxy({ state, layout }, {
      get(target, key) { return key in target ? target[key] : trap[key]; },
    });
    const built = factory(deps);
    assert.equal(typeof built, "object", `${name} returns its functions`);
  }
});

test("the shared state starts as a transitioning, unowned scratch", async () => {
  const { createAppState } = await load("app_state.js");
  const state = createAppState({
    cfg: { scratch_dir: "/tmp/qt" }, profiles: [{ name: "a" }], snippets: [], workspaceNames: ["w"],
    terminalInventory: { types: [] }, windowIsPrimary: false,
  });
  assert.equal(state.currentWorkspace, null);
  assert.equal(state.transitioning, true);
  assert.equal(state.exiting, false);
  assert.equal(state.scratchRoot, "/tmp/qt");
  assert.equal(state.windowIsPrimary, false);
  assert.equal(state.registryAvailable, true);
  assert.ok(state.scratchSessionIds instanceof Set);
  assert.ok(state.workspaceSessionIds instanceof Set);
  assert.ok(state.workspaceRoots instanceof Map);
});

test("the launch URL decides which window this is and what it opens", async () => {
  const { captureWindowIdentity, embedded } = await load("boot_context.js");
  assert.equal(embedded, false);
  const previous = globalThis.location;
  try {
    globalThis.location = { search: "?window=w2&primary=1" };
    assert.deepEqual(captureWindowIdentity(), { id: "w2", primary: true, workspace: undefined });
    // A secondary shell window without a workspace was asked for scratch.
    globalThis.location = { search: "?window=w3" };
    assert.deepEqual(captureWindowIdentity(), { id: "w3", primary: false, workspace: null });
    // The browser fallback says scratch with an explicit empty value.
    globalThis.location = { search: "?workspace=" };
    assert.deepEqual(captureWindowIdentity(), { id: null, primary: false, workspace: null });
    globalThis.location = { search: "?workspace=Alpha" };
    assert.equal(captureWindowIdentity().workspace, "Alpha");
  } finally {
    globalThis.location = previous;
  }
});

test("saved layouts are read and edited without a layout manager", async () => {
  const { sessionIdsInLayout, removeSessionFromLayout, layoutWith } = await load("layout_sessions.js");
  const tree = {
    type: "split", dir: "h", children: [
      { type: "pane", session_id: "a" },
      { type: "split", dir: "v", children: [{ type: "pane", session_id: "b" }, { type: "pane" }] },
    ],
  };
  assert.deepEqual([...sessionIdsInLayout(tree)], ["a", "b"]);
  assert.deepEqual([...sessionIdsInLayout(null)], []);
  assert.equal(removeSessionFromLayout(tree, "b"), true);
  assert.equal(removeSessionFromLayout(tree, "b"), false);
  assert.deepEqual([...sessionIdsInLayout(tree)], ["a"]);

  const leaf = { type: "pane", session_id: "c" };
  assert.deepEqual(layoutWith(null, null), { type: "pane" });
  assert.equal(layoutWith(null, leaf), leaf);
  assert.deepEqual(layoutWith(tree, leaf), { type: "split", dir: "h", ratio: 0.5, children: [tree, leaf] });
});

test("folders compare the way the file system does", async () => {
  const { pathKey, samePath, insidePath, baseName } = await load("here.js");
  assert.equal(pathKey("C:\\Work\\Proj\\"), "c:/work/proj");
  assert.equal(pathKey("/home/Me/"), "/home/Me");
  assert.equal(samePath("C:\\Work", "c:/work/"), true);
  // POSIX paths stay case-sensitive.
  assert.equal(samePath("/home/me", "/home/Me"), false);
  assert.equal(samePath(null, null), false);
  assert.equal(insidePath("C:\\Work\\Proj\\src", "c:/work/proj"), true);
  assert.equal(insidePath("C:\\Work\\Projects", "c:/work/proj"), false);
  assert.equal(baseName("C:\\Work\\Proj\\"), "proj");
  assert.equal(baseName("/"), "");
});

test("spawn specs are derived without any window state", async () => {
  const { defaultSystemSpec, serializableSpec, commandTerminalType, claudeProfileForPane } =
    await load("spawner.js");
  const inventory = {
    types: [
      { id: "claude-code", executable: "claude.exe" },
      { id: "cmd", executable: "cmd.exe", available: false, label: "cmd" },
      { id: "windows-powershell", executable: "powershell.exe", label: "Windows PowerShell" },
    ],
  };
  assert.deepEqual(defaultSystemSpec(inventory), {
    cmd: "powershell.exe", args: ["-NoLogo"], name: "Windows PowerShell", terminalType: "windows-powershell",
  });
  assert.equal(defaultSystemSpec(null), null);
  assert.deepEqual(defaultSystemSpec({ types: [{ id: "wsl", executable: "wsl.exe", label: "WSL" }] }).args,
    ["--cd", "~"]);
  // default_profile may name a system shell; it wins over the first one, and
  // Git Bash starts as a login shell, as from the menu.
  const withBash = { types: [...inventory.types, { id: "git-bash", executable: "bash.exe", label: "Git Bash" }] };
  assert.deepEqual(defaultSystemSpec(withBash, "git-bash"), {
    cmd: "bash.exe", args: ["-l"], name: "Git Bash", terminalType: "git-bash",
  });
  assert.equal(defaultSystemSpec(withBash, "cmd").terminalType, "windows-powershell");  // unavailable

  const spec = { cmd: "bash", args: ["-l"], label: "Bash", terminalType: "bash", extra: 1 };
  const out = serializableSpec(spec);
  assert.deepEqual(out, { cmd: "bash", args: ["-l"], cwd: null, env: {}, name: "Bash", terminal_type: "bash" });
  out.args.push("x");
  assert.deepEqual(spec.args, ["-l"]);

  assert.equal(commandTerminalType({ cmd: "C:\\Windows\\System32\\wsl.exe" }), "wsl");
  assert.equal(commandTerminalType({ cmd: "plink" }), "ssh");
  assert.equal(commandTerminalType({ cmd: "psftp.exe" }), "sftp");
  assert.equal(commandTerminalType({ cmd: "bash", terminal_type: "bash" }), "bash");
  assert.equal(commandTerminalType({ cmd: "bash" }), null);

  const profiles = [
    { name: "Claude", terminal_type: "claude-code" },
    { name: "Shell", terminal_type: "bash", cmd: "bash" },
    { name: "Direct", cmd: "C:\\bin\\claude.cmd" },
  ];
  assert.equal(claudeProfileForPane(profiles, { profileName: "Claude" }).name, "Claude");
  assert.equal(claudeProfileForPane(profiles, { profileName: "Shell" }), null);
  // A resumable shell counts once its title shows it was running claude.
  assert.equal(claudeProfileForPane(profiles, { profileName: "Shell", title: "claude" }).name, "Shell");
  assert.equal(claudeProfileForPane(profiles, { profileName: "Direct" }).name, "Direct");
  assert.equal(claudeProfileForPane(profiles, { profileName: "missing" }), null);
});

test("workspace names that the backend would mangle or delete are refused", async () => {
  const { validateWorkspaceName } = await load("workspace_actions.js");
  assert.equal(validateWorkspaceName("  My project_2.0 "), null);
  assert.match(validateWorkspaceName(""), /Give the workspace a name/);
  assert.match(validateWorkspaceName(".hidden"), /dot are reserved/);
  assert.match(validateWorkspaceName("Scratch"), /reserved for the disposable workspace/);
  assert.match(validateWorkspaceName("a/b"), /Use letters, digits/);
  assert.match(validateWorkspaceName("trailing."), /Use letters, digits/);
});

test("the discard warning names the terminals and says why they matter", async () => {
  const { discardScratchWarning } = await load("scratch.js");
  const one = discardScratchWarning([{ name: "build", busy: true }]);
  assert.match(one, /stop 1 terminal \(build\)\?/);
  assert.match(one, /1 of them is still running something\.$/);
  const many = discardScratchWarning([
    { name: "a", busy: false }, { name: "b", busy: false }, { name: "c", busy: false }, { name: "d", busy: false },
  ]);
  assert.match(many, /stop 4 terminals \(a, b, c and 1 more\)\?/);
  assert.match(many, /You have typed in them\.$/);
});

test("font sizes stay in the readable range", async () => {
  const { clampFont, DEFAULT_FONT } = await load("fonts.js");
  assert.equal(clampFont(undefined), DEFAULT_FONT);
  assert.equal(clampFont(3), 9);
  assert.equal(clampFont(99), 30);
  assert.equal(clampFont(15.6), 16);
});

async function scratchHarness({ sessions, current = null }) {
  const { createAppState } = await load("app_state.js");
  const { createScratch } = await load("scratch.js");
  const state = createAppState({
    cfg: {}, profiles: [], snippets: [], workspaceNames: [], terminalInventory: null, windowIsPrimary: true,
  });
  state.currentWorkspace = current;
  const calls = { cleanup: [], deleted: [] };
  const api = {
    getSessions: async () => {
      if (sessions === null) throw new Error("offline");
      return sessions;
    },
    cleanupSessions: async (ids) => { calls.cleanup.push(ids); },
    deleteWorkspace: async (name) => { calls.deleted.push(name); },
  };
  const scratch = createScratch({ api, state, layout: {} });
  return { state, scratch, calls };
}

test("leaving scratch stops only terminals that are provably idle and untouched", async () => {
  const { state, scratch, calls } = await scratchHarness({
    sessions: [
      { id: "idle", busy: false, touched: false },
      { id: "busy", busy: true, touched: false },
      { id: "used", busy: false, touched: true },
      { id: "unknown-busy", touched: false },
    ],
  });
  for (const id of ["idle", "busy", "used", "unknown-busy", "gone"]) state.scratchSessionIds.add(id);
  await scratch.discardScratch();
  assert.deepEqual(calls.cleanup, [["idle"]]);
  assert.equal(state.scratchSessionIds.size, 0);
});

test("leaving scratch with no answer from the backend stops nothing", async () => {
  const { state, scratch, calls } = await scratchHarness({ sessions: null });
  state.scratchSessionIds.add("a");
  await scratch.discardScratch();
  assert.deepEqual(calls.cleanup, []);
});

test("a confirmed replacement stops every scratch terminal and drops the adopted file", async () => {
  const { state, scratch, calls } = await scratchHarness({ sessions: [], current: "scratch" });
  state.scratchSessionIds.add("a");
  state.workspaceSessionIds.add("b");
  await scratch.discardScratch({ force: true });
  assert.deepEqual(calls.deleted, ["scratch"]);
  assert.deepEqual(calls.cleanup, [["a", "b"]]);
  assert.equal(state.workspaceSessionIds.size, 0);
});

async function registryHarness(api) {
  const { createAppState } = await load("app_state.js");
  const { createWindowRegistry } = await load("window_registry.js");
  const state = createAppState({
    cfg: {}, profiles: [], snippets: [], workspaceNames: [], terminalInventory: null, windowIsPrimary: true,
  });
  const errors = [];
  const registry = createWindowRegistry({
    api, state, identity: { id: "w1", primary: true }, showError: (text) => errors.push(text),
  });
  return { state, registry, errors };
}

test("a claim is held only when the registry granted it", async () => {
  const conflict = Object.assign(new Error("409"), {
    status: 409, payload: { owner: { id: "w2", workspace: "Alpha", title: "Other" } },
  });
  const { state, registry } = await registryHarness({
    registerWindow: async () => ({ id: "w1", primary: false }),
    claimWindowWorkspace: async (id, name) => {
      if (name === "Alpha") throw conflict;
      if (name === "Down") throw Object.assign(new Error("500"), { status: 500 });
    },
    releaseWindowWorkspace: async () => {},
    listWindows: async () => [],
  });
  assert.equal(await registry.acquireWindowId(), "w1");
  assert.equal(state.windowIsPrimary, false);
  assert.equal(await registry.claimWorkspaceFor("Beta"), null);
  assert.equal(state.claimedWorkspace, "Beta");
  assert.match(await registry.claimWorkspaceFor("Alpha"), /Alpha. is already open in/);
  assert.equal(state.claimedWorkspace, null);
  // A registry that cannot answer lets the user carry on but never fakes a claim.
  assert.equal(await registry.claimWorkspaceFor("Down"), null);
  assert.equal(state.claimedWorkspace, null);
  assert.equal(state.registryAvailable, false);
  assert.equal(await registry.claimWorkspaceFor(null), null);
});

test("without a registry id nothing is claimed and nothing is asked", async () => {
  const { state, registry } = await registryHarness({
    registerWindow: async () => { throw new Error("no registry"); },
  });
  assert.equal(await registry.acquireWindowId(), null);
  assert.equal(state.registryAvailable, false);
  assert.equal(await registry.claimWorkspaceFor("Beta"), null);
  assert.equal(state.claimedWorkspace, null);
});

test("ownership follows the layout the window is on", async () => {
  const { createAppState } = await load("app_state.js");
  const { createSessionOwnership } = await load("session_ownership.js");
  const state = createAppState({
    cfg: {}, profiles: [], snippets: [], workspaceNames: [], terminalInventory: null, windowIsPrimary: true,
  });
  const layout = {
    serialize: () => ({ type: "pane", session_id: "in-layout" }),
    panes: () => [
      { session: { id: "p1" }, state: "attached" },
      { session: { id: "p2" }, state: "unavailable" },
      { session: null, state: "attached" },
    ],
  };
  const own = createSessionOwnership({ state, layout });
  own.ownSession("s1");
  assert.deepEqual([...state.scratchSessionIds], ["s1"]);
  state.currentWorkspace = "Alpha";
  own.ownSession("w1");
  assert.deepEqual([...state.workspaceSessionIds], ["w1"]);
  assert.deepEqual([...own.ownedSessionIds()].sort(), ["in-layout", "w1"]);
  own.forgetSession("w1");
  own.forgetSession("s1");
  assert.equal(state.workspaceSessionIds.size + state.scratchSessionIds.size, 0);
  assert.deepEqual(own.attachedSessionIds(), ["p1"]);
});

test("autosave waits out a switch and never saves an unnamed scratch", async () => {
  const { createAppState } = await load("app_state.js");
  const { createAutosave } = await load("autosave.js");
  const state = createAppState({
    cfg: {}, profiles: [], snippets: [], workspaceNames: [], terminalInventory: null, windowIsPrimary: true,
  });
  const saves = [];
  const autosave = createAutosave({
    state,
    layout: { root: {}, serialize: () => ({ type: "pane" }) },
    workspace: { save: async (...args) => { saves.push(args); } },
    ownedSessionIds: () => new Set(["a"]),
    setWorkspaceSaveState: () => {},
  });
  assert.equal(await autosave.persistCurrentWorkspace(), true);
  state.transitioning = false;
  assert.equal(await autosave.persistCurrentWorkspace(), true);
  assert.equal(saves.length, 0);
  state.currentWorkspace = "Alpha";
  state.workspacePath = "C:\\alpha";
  assert.equal(await autosave.persistCurrentWorkspace(), true);
  assert.deepEqual(saves, [["Alpha", { type: "pane" }, null, ["a"], "C:\\alpha"]]);
  autosave.cancelWorkspaceSave();
  autosave.cancelWorkspaceRetry();
});
