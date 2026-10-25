// Workspaces on an SSH host (CONTRACTS 4.3): the host list, the remote "+"
// menu, the name a new one gets, the folder check flow in the palette, and
// the sidebar's git bookkeeping for remote folders.
import test from "node:test";
import assert from "node:assert/strict";

import {
  agentPresent, createRemoteWorkspace, remoteCapable, remoteFolderProblem, remoteWorkspaceName, sshHosts,
} from "../../quickterm/frontend/js/remote_workspace.js";
import { defaultShellRow, newTerminalMenu } from "../../quickterm/frontend/js/sidebar_model.js";
import { gitPaths, remoteNames, sidebarModel } from "../../quickterm/frontend/js/sidebar.js";
import { newTerminalRows } from "../../quickterm/frontend/js/palette_items.js";
import { Palette } from "../../quickterm/frontend/js/palette.js";

const profiles = [
  { name: "prod", terminal_type: "ssh", ssh_client: "openssh", ssh_host: "prod.example", ssh_user: "dev" },
  { name: "old", terminal_type: "ssh", ssh_client: null, ssh_host: "old.example" },
  { name: "Devbox", terminal_type: "ssh", ssh_client: "openssh", ssh_host: "10.0.0.5" },
  { name: "dev server", terminal_type: "bash", cmd: "bash", start_command: "npm run dev" },
  { name: "htop", terminal_type: "custom", cmd: "htop" },
  { name: "tool", terminal_type: "custom", cmd: "C:\\Tools\\tool.exe" },
  { name: "ps dev", terminal_type: "powershell-core", cmd: "pwsh.exe", start_command: "npm run dev" },
  { name: "db", terminal_type: "docker", cmd: "docker" },
];
const agents = [{ name: "claude-code", label: "Claude Code" }, { name: "codex", label: "Codex" }];

test("only OpenSSH profiles can back a workspace, by name", () => {
  assert.deepEqual(sshHosts(profiles), [
    { name: "Devbox", target: "10.0.0.5" },
    { name: "prod", target: "dev@prod.example" },
  ]);
});

test("a remote workspace's + menu: the remote shell, the agents and remote-capable profiles", () => {
  const menu = newTerminalMenu({ profiles, agents, host: "prod", inventory: { shells: [{ value: "cmd", label: "Command Prompt" }] } });
  const labels = menu.filter((row) => row.kind !== "separator").map((row) => row.label);
  assert.deepEqual(labels, ["Shell on prod", "Claude Code", "Codex", "dev server", "htop", "Terminal settings…"]);
  assert.equal(defaultShellRow(menu).kind, "remote-shell");
  assert.ok(!labels.includes("Command Prompt"));
  // A local workspace keeps every profile and the local shells.
  const local = newTerminalMenu({ profiles, agents, inventory: { shells: [{ value: "cmd", label: "Command Prompt" }] }, shell: "cmd" });
  assert.equal(defaultShellRow(local).value, "cmd");
  assert.ok(local.some((row) => row.label === "ps dev"));
});

test("remote-capable profiles mirror the backend's rule", () => {
  const capable = profiles.filter(remoteCapable).map((profile) => profile.name);
  assert.deepEqual(capable, ["dev server", "htop"]);
  assert.equal(remoteCapable({ terminal_type: "zsh", start_command: "" }), false);
});

test("the palette's remote shell row starts the workspace's terminal", () => {
  let started = 0;
  const rows = newTerminalRows({ newTerminalMenu: () => newTerminalMenu({ host: "prod" }), newTerminal: () => { started += 1; } });
  assert.equal(rows[0].label, "new terminal: Shell on prod");
  rows[0].run();
  assert.equal(started, 1);
});

test("a remote agent is present only while its hooks report a state", () => {
  const agent = { kind: "codex", state: "idle" };
  assert.equal(agentPresent({ host: "prod", busy: true, agent: null }), false);
  assert.equal(agentPresent({ host: "prod", busy: false, agent }), true);
  // Locally a child process of the shell still counts.
  assert.equal(agentPresent({ host: null, busy: true, agent: null }), true);
  assert.equal(agentPresent({ busy: false, agent: null }), false);
});

test("folders on a host are absolute or under ~", () => {
  assert.equal(remoteFolderProblem("/srv/app"), null);
  assert.equal(remoteFolderProblem("~/code"), null);
  assert.equal(remoteFolderProblem("~"), null);
  assert.match(remoteFolderProblem("code/app"), /Start the folder/);
  assert.match(remoteFolderProblem("/a\nb"), /control/);
  assert.match(remoteFolderProblem(""), /Type the folder/);
});

test("a new remote workspace is named after its folder, then its host", () => {
  assert.equal(remoteWorkspaceName("/srv/api", "prod", []), "api");
  assert.equal(remoteWorkspaceName("/srv/api/", "prod", ["API"]), "api-prod");
  assert.equal(remoteWorkspaceName("/srv/api", "prod", ["api", "api-prod"]), "api-prod-2");
  assert.equal(remoteWorkspaceName("~", "prod", []), "prod");
  assert.equal(remoteWorkspaceName("/srv/scratch", "prod", []), "scratch-prod");
  assert.equal(remoteWorkspaceName("/srv/my app (1)", "prod", []), "my app -1-");
});

test("creating saves host and folder, then opens the view", async () => {
  const calls = [];
  const api = {
    listWorkspaces: async () => ["api"],
    putRemoteWorkspace: async (...args) => { calls.push(["put", ...args]); },
  };
  const name = await createRemoteWorkspace({
    api, host: "prod", path: " /srv/api ",
    onWorkspacesChanged: () => calls.push(["changed"]),
    openView: (opened) => calls.push(["open", opened]),
  });
  assert.equal(name, "api-prod");
  assert.deepEqual(calls, [["put", "api-prod", "prod", "/srv/api"], ["changed"], ["open", "api-prod"]]);
});

function fakePalette(app) {
  const palette = Object.create(Palette.prototype);
  Object.assign(palette, {
    app, open: true, items: [], filtered: [], sel: 0, prompt: null, hostMode: false,
    foreignMode: false, windowMode: false, searchMode: false, killMode: false, killTarget: null,
    foreignSessions: [], requestId: 1,
    late: { names: [], details: new Map(), attach: [], agentSessions: [] },
    input: { value: "", placeholder: "", focus() {}, setAttribute() {}, removeAttribute() {} },
    overlay: { hidden: false },
    listEl: { textContent: "" },
    _renderList() {},
    focusInput() {},
    close() { this.open = false; },
  });
  return palette;
}
const press = (key) => ({ key, preventDefault() {}, stopPropagation() {} });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the palette asks for the host, checks the folder, and saves on a second Enter", async () => {
  const created = [];
  let found = false;
  const palette = fakePalette({
    profiles,
    checkRemoteFolder: async (host, path) => (found ? { ok: true, message: "" } : { ok: false, message: `${path} is not a folder on ${host}` }),
    createRemoteWorkspace: async (host, path) => { created.push([host, path]); },
  });
  palette.remoteWorkspaceMode();
  assert.equal(palette.hostMode, true);
  assert.deepEqual(palette.filtered.map((row) => row.label), ["new workspace on: Devbox", "new workspace on: prod", "back to commands"]);
  palette.filtered[1].run();
  assert.ok(palette.prompt);
  palette.input.value = "/srv/new";
  palette._key(press("Enter"));
  await settle();
  assert.equal(palette.filtered[0].label, "/srv/new is not a folder on prod");
  assert.deepEqual(created, []);
  // The same folder again: saved anyway.
  palette._key(press("Enter"));
  await settle();
  assert.deepEqual(created, [["prod", "/srv/new"]]);
  assert.equal(palette.open, false);
});

test("a found folder saves on the first Enter; a relative one is refused", async () => {
  const created = [];
  const palette = fakePalette({
    profiles,
    checkRemoteFolder: async () => ({ ok: true, message: "" }),
    createRemoteWorkspace: async (host, path) => { created.push([host, path]); },
  });
  palette.remoteWorkspaceMode();
  palette.filtered[0].run();
  palette.input.value = "srv/x";
  palette._key(press("Enter"));
  await settle();
  assert.match(palette.filtered[0].label, /Start the folder/);
  palette.input.value = "~/code";
  palette._key(press("Enter"));
  await settle();
  assert.deepEqual(created, [["Devbox", "~/code"]]);
});

test("without an OpenSSH profile the palette says where to add one", () => {
  const palette = fakePalette({ profiles: [] });
  palette.remoteWorkspaceMode();
  assert.match(palette.input.placeholder, /No SSH terminal uses OpenSSH/);
  assert.equal(palette.filtered[0].label, "terminals and connections");
});

test("the palette lists the remote workspace command", () => {
  const items = Palette.prototype._staticItems.call({ app: { profiles: [], snippets: [] } });
  assert.ok(items.some((item) => item.label === "new workspace on host…"));
});

test("remote folders are not read from this disk; their git comes with the record", () => {
  const folders = new Map([
    ["local", { path: "C:\\src\\local", pathExists: true, host: null }],
    ["api", { path: "/srv/api", pathExists: true, host: "prod", git: { branch: "main", head: null } }],
  ]);
  assert.deepEqual(gitPaths(folders), ["C:\\src\\local"]);
  assert.deepEqual(remoteNames(folders), ["api"]);
  const model = sidebarModel({
    state: { profiles: [], workspaceNames: ["local", "api"], cfg: {} },
    folders,
    git: new Map([["C:\\src\\local", { branch: "dev" }], ["/srv/api", { branch: "wrong" }]]),
  });
  const api = model.workspaces.find((entry) => entry.name === "api");
  assert.equal(api.host, "prod");
  assert.equal(api.git.branch, "main");
  assert.equal(model.workspaces.find((entry) => entry.name === "local").git.branch, "dev");
});
