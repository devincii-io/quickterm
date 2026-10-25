// "New workspace…" (CONTRACTS 4.5): the dialog's model. A location, a folder
// there and a name; a folder that already is a workspace's opens that one,
// and a taken name is refused before anything is saved.

import test from "node:test";
import assert from "node:assert/strict";

import { folderBase, folderWorkspaceName } from "../../quickterm/frontend/js/here.js";
import {
  OTHER_SSH, THIS_PC, browseStart, browsedFolder, canBrowse, createLocationWorkspace, createRequest, hostFor,
  nameTaken, normalizeLocations, suggestName, workspaceAt,
} from "../../quickterm/frontend/js/new_workspace.js";
import { validateWorkspaceName } from "../../quickterm/frontend/js/workspace_actions.js";

const WSL = { id: "wsl:Ubuntu", kind: "wsl", label: "WSL: Ubuntu", detail: null, browse: "\\\\wsl.localhost\\Ubuntu\\home" };
const DEVBOX = { id: "devbox", kind: "ssh", label: "devbox", detail: "me@10.0.0.5", browse: null };

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

test("the name is prefilled from the folder at every location, free of the taken ones", () => {
  assert.equal(suggestName(null, "C:\\Code\\Acme", ["acme"]), "Acme 2");
  assert.equal(suggestName("wsl:Ubuntu", "/home/me/api", []), "api");
  assert.equal(suggestName("devbox", "/srv/web/", ["web"]), "web 2");
  // A folder named only ~ gives the machine's name.
  assert.equal(suggestName("wsl:Ubuntu", "~", []), "Ubuntu");
  assert.equal(suggestName("ssh://deploy@box.example:2222", "~/", []), "box.example");
  assert.equal(suggestName("me@devbox", "/", []), "devbox");
  assert.equal(suggestName("devbox", "", []), "", "no folder, no name yet");
  for (const [host, folder] of [["wsl:Ubuntu", "~"], ["devbox", "/srv/kündigung"], [null, "C:\\"]]) {
    assert.equal(validateWorkspaceName(suggestName(host, folder, [])), null, folder);
  }
});

test("the location menu is This PC first, then WSL and SSH as the backend lists them", () => {
  const rows = normalizeLocations({ locations: [
    { id: null, kind: "local", label: "This PC" },
    WSL, DEVBOX,
    { id: "devbox", kind: "ssh", label: "devbox again" },
    { id: "", kind: "ssh", label: "nameless" },
    { id: "x", kind: "telnet", label: "not a location" },
  ] });
  assert.deepEqual(rows.map((row) => row.label), ["This PC", "WSL: Ubuntu", "devbox"]);
  assert.equal(rows[0], THIS_PC);
  assert.equal(rows[2].detail, "me@10.0.0.5");
  assert.deepEqual(normalizeLocations(null), [THIS_PC], "an unreadable answer still offers This PC");
});

test("a location row maps to the workspace's host", () => {
  assert.equal(hostFor(THIS_PC), null);
  assert.equal(hostFor(WSL), "wsl:Ubuntu");
  assert.equal(hostFor(DEVBOX), "devbox");
  assert.equal(hostFor(OTHER_SSH, "  me@10.0.0.9 "), "me@10.0.0.9");
  assert.equal(canBrowse(THIS_PC) && canBrowse(WSL), true);
  assert.equal(canBrowse(DEVBOX) || canBrowse(OTHER_SSH), false, "an SSH folder is typed");
});

test("Browse starts where it makes sense and a WSL share path becomes the POSIX folder", () => {
  assert.equal(browseStart(THIS_PC, "", "C:\\Code\\Acme"), "C:\\Code\\Acme");
  assert.equal(browseStart(THIS_PC, "D:\\x", "C:\\Code"), "D:\\x");
  assert.equal(browseStart(WSL, ""), "\\\\wsl.localhost\\Ubuntu\\home");
  assert.equal(browseStart(WSL, "/srv/app"), "\\\\wsl.localhost\\Ubuntu\\srv\\app");
  assert.equal(browseStart(DEVBOX, "/srv"), null);
  assert.deepEqual(browsedFolder(WSL, "\\\\wsl.localhost\\Ubuntu\\home\\me\\api"), { path: "/home/me/api" });
  assert.deepEqual(browsedFolder(WSL, "\\\\wsl$\\ubuntu\\srv"), { path: "/srv" });
  assert.match(browsedFolder(WSL, "C:\\Code").problem, /inside WSL: Ubuntu/);
  assert.match(browsedFolder(WSL, "\\\\wsl.localhost\\Debian\\home").problem, /inside WSL: Ubuntu/);
  assert.deepEqual(browsedFolder(THIS_PC, "C:\\Code"), { path: "C:\\Code" });
  assert.deepEqual(browsedFolder(WSL, null), { path: null }, "a cancelled browser changes nothing");
});

test("Create says the first problem, field by field", () => {
  assert.deepEqual(createRequest({ location: THIS_PC, folder: "C:\\Code\\Acme", name: "Acme" }),
    { host: null, kind: "local", path: "C:\\Code\\Acme", name: "Acme" });
  assert.deepEqual(createRequest({ location: WSL, folder: " ~/api ", name: " api " }),
    { host: "wsl:Ubuntu", kind: "wsl", path: "~/api", name: "api" });
  assert.equal(createRequest({ location: THIS_PC, folder: "", name: "x" }).field, "folder");
  assert.equal(createRequest({ location: DEVBOX, folder: "srv/app", name: "x" }).field, "folder");
  assert.equal(createRequest({ location: DEVBOX, folder: "/srv/app", name: "scratch" }).field, "name");
  assert.equal(createRequest({ location: OTHER_SSH, typedHost: "", folder: "/srv", name: "x" }).field, "host");
  assert.equal(createRequest({ location: OTHER_SSH, typedHost: "-oProxyCommand=x", folder: "/srv", name: "x" }).field, "host");
  assert.equal(createRequest({ location: OTHER_SSH, typedHost: "a b", folder: "/srv", name: "x" }).field, "host");
  assert.equal(createRequest({ location: OTHER_SSH, typedHost: "ssh://me@box:2222", folder: "/srv", name: "srv" }).host,
    "ssh://me@box:2222");
});

test("a folder that already is a workspace's is found at its own location only", () => {
  const folders = new Map([
    ["web", { path: "C:\\Code\\Web", host: null }],
    ["api", { path: "/home/me/api", host: "wsl:Ubuntu" }],
    ["srv", { path: "/srv/web", host: "devbox" }],
  ]);
  assert.equal(workspaceAt(null, "c:/code/web/", folders), "web");
  assert.equal(workspaceAt(null, "/srv/web", folders), null, "a folder on a host is not on this disk");
  assert.equal(workspaceAt("wsl:Ubuntu", "/home/me/api/", folders), "api");
  assert.equal(workspaceAt("wsl:Debian", "/home/me/api", folders), null, "another distribution");
  assert.equal(workspaceAt("devbox", "/srv/web", folders), "srv");
  assert.equal(workspaceAt("devbox", "/SRV/web", folders), null, "POSIX folders keep their case");
  assert.equal(workspaceAt("otherbox", "/srv/web", folders), null);
  assert.equal(workspaceAt("wsl:Ubuntu", "/srv/web", folders), null, "same path, other location");
});

test("creating checks the list, saves host and folder with an empty layout, then opens the view", async () => {
  const calls = [];
  const api = {
    listWorkspaces: async () => ["acme"],
    putLocationWorkspace: async (...args) => { calls.push(["put", ...args]); },
  };
  const made = await createLocationWorkspace({
    api, host: "wsl:Ubuntu", path: "/home/me/api", name: "api", folders: new Map(),
    onWorkspacesChanged: () => calls.push(["changed"]),
    openView: (opened) => calls.push(["open", opened]),
  });
  assert.deepEqual(made, { name: "api", existing: false });
  assert.deepEqual(calls, [["put", "api", "wsl:Ubuntu", "/home/me/api"], ["changed"], ["open", "api"]]);
});

test("a taken name is refused before anything is saved, ignoring case", async () => {
  let saved = false;
  const api = { listWorkspaces: async () => ["Acme"], putLocationWorkspace: async () => { saved = true; } };
  await assert.rejects(
    createLocationWorkspace({ api, host: null, path: "D:\\work\\acme", name: "acme", folders: new Map(), openView: () => {} }),
    (error) => /exists already/.test(error.detail),
  );
  assert.equal(saved, false);
  assert.equal(nameTaken("ACME", ["acme"]), true);
  assert.equal(nameTaken("acme 2", ["acme"]), false);
});

test("choosing an existing workspace's folder opens that workspace and saves nothing", async () => {
  const opened = [];
  const api = { listWorkspaces: async () => { throw new Error("not asked"); }, putLocationWorkspace: async () => { throw new Error("not saved"); } };
  const made = await createLocationWorkspace({
    api, host: "devbox", path: "/srv/web/", name: "anything",
    folders: new Map([["srv", { path: "/srv/web", host: "devbox" }]]),
    openView: (view) => opened.push(view),
  });
  assert.deepEqual(made, { name: "srv", existing: true });
  assert.deepEqual(opened, ["srv"]);
});

test("a list that cannot be read stops the save instead of overwriting a namesake", async () => {
  let saved = false;
  const api = {
    listWorkspaces: async () => { throw Object.assign(new Error("down"), { detail: "backend restarting" }); },
    putLocationWorkspace: async () => { saved = true; },
  };
  await assert.rejects(
    createLocationWorkspace({ api, host: null, path: "D:\\work\\acme", name: "acme", folders: new Map(), openView: () => {} }),
    /down/,
  );
  assert.equal(saved, false);
});
