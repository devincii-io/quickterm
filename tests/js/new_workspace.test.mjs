// "New workspace…" and "workspace here": a folder becomes a workspace named
// after it, and a folder that already is one opens that one.

import test from "node:test";
import assert from "node:assert/strict";

import { folderBase, folderWorkspaceName } from "../../quickterm/frontend/js/here.js";
import { createFolderWorkspace, workspaceForFolder } from "../../quickterm/frontend/js/new_workspace.js";
import { validateWorkspaceName } from "../../quickterm/frontend/js/workspace_actions.js";

test("the name is the folder's own, case kept", () => {
  assert.equal(folderBase("C:\\Code\\Acme\\"), "Acme");
  assert.equal(folderBase("/srv/app"), "app");
  assert.equal(folderBase("C:\\"), "C");
  assert.equal(folderWorkspaceName("C:\\Code\\Acme", []), "Acme");
});

test("a taken or reserved name gets a number; an unusable one is cleaned", () => {
  assert.equal(folderWorkspaceName("D:\\other\\acme", ["Acme"]), "acme 2");
  assert.equal(folderWorkspaceName("D:\\x\\acme", ["acme", "acme 2"]), "acme 3");
  assert.equal(folderWorkspaceName("C:\\tmp\\scratch", []), "scratch 2");
  assert.equal(folderWorkspaceName("C:\\Users\\me\\.config", []), "config");
  assert.equal(folderWorkspaceName("C:\\Projekte\\Kündigung", []), "K-ndigung");
  assert.equal(folderWorkspaceName("C:\\x\\...", []), "workspace");
  for (const folder of ["C:\\Code\\Acme", "C:\\Users\\me\\.config", "C:\\Projekte\\Kündigung", "C:\\x\\...", "C:\\"]) {
    assert.equal(validateWorkspaceName(folderWorkspaceName(folder, [])), null, folder);
  }
});

test("a folder that already is a local workspace's is found by path, not by name", () => {
  const folders = new Map([
    ["web", { path: "C:\\Code\\Web", host: null }],
    ["remote", { path: "/srv/web", host: "prod" }],
  ]);
  assert.equal(workspaceForFolder("c:/code/web/", folders), "web");
  assert.equal(workspaceForFolder("/srv/web", folders), null, "a folder on a host is not on this disk");
  assert.equal(workspaceForFolder("C:\\Code\\Api", folders), null);
});

test("creating saves the folder with an empty layout, then opens the view", async () => {
  const calls = [];
  const api = {
    listWorkspaces: async () => ["acme"],
    putWorkspace: async (...args) => { calls.push(["put", ...args]); },
  };
  const name = await createFolderWorkspace({
    api, folder: "D:\\work\\acme", folders: new Map(),
    onWorkspacesChanged: () => calls.push(["changed"]),
    openView: (opened) => calls.push(["open", opened]),
  });
  assert.equal(name, "acme 2");
  assert.deepEqual(calls, [["put", "acme 2", null, null, [], "D:\\work\\acme"], ["changed"], ["open", "acme 2"]]);
});

test("choosing an existing workspace's folder opens that workspace and saves nothing", async () => {
  const opened = [];
  const api = { listWorkspaces: async () => { throw new Error("not asked"); }, putWorkspace: async () => { throw new Error("not saved"); } };
  const name = await createFolderWorkspace({
    api, folder: "C:\\Code\\Web", folders: new Map([["web", { path: "C:\\Code\\Web" }]]),
    openView: (view) => opened.push(view),
  });
  assert.equal(name, "web");
  assert.deepEqual(opened, ["web"]);
});

test("a list that cannot be read stops the save instead of overwriting a namesake", async () => {
  let saved = false;
  const api = {
    listWorkspaces: async () => { throw Object.assign(new Error("down"), { detail: "backend restarting" }); },
    putWorkspace: async () => { saved = true; },
  };
  await assert.rejects(
    createFolderWorkspace({ api, folder: "D:\\work\\acme", folders: new Map(), openView: () => {} }),
    /down/,
  );
  assert.equal(saved, false);
});
