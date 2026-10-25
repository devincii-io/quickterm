// Where a workspace lives (CONTRACTS 4.5): this PC, a WSL distribution or an
// SSH destination, read from `host` in one place.

import test from "node:test";
import assert from "node:assert/strict";

import {
  agentPresent, locationKind, locationLabel, locationPath, locationTag, remoteFolderProblem, samePosixPath,
  sshDestinationProblem, uncForWslPath, wslDistro, wslPathFromUnc,
} from "../../quickterm/frontend/js/locations.js";
import { gitPaths, remoteNames, sidebarModel } from "../../quickterm/frontend/js/sidebar.js";

test("host names the location: null this PC, wsl:<d> WSL, anything else SSH", () => {
  assert.equal(locationKind(null), "local");
  assert.equal(locationKind(""), "local");
  assert.equal(locationKind("wsl:Ubuntu-22.04"), "wsl");
  assert.equal(wslDistro("wsl:Ubuntu-22.04"), "Ubuntu-22.04");
  assert.equal(wslDistro("devbox"), null);
  for (const host of ["devbox", "me@10.0.0.5", "ssh://me@box:2222"]) assert.equal(locationKind(host), "ssh", host);
});

test("a workspace head shows WSL: <d> where an SSH one shows @<host>", () => {
  assert.equal(locationTag(null), "");
  assert.equal(locationTag("wsl:Ubuntu"), "WSL: Ubuntu");
  assert.equal(locationTag("devbox"), "@devbox");
  assert.equal(locationLabel(null), "This PC");
  assert.equal(locationLabel("me@box"), "me@box");
  assert.equal(locationPath(null, "C:\\a"), "C:\\a");
  assert.equal(locationPath("wsl:Ubuntu", "/srv"), "WSL: Ubuntu /srv");
  assert.equal(locationPath("devbox", "/srv"), "devbox:/srv");
});

test("a WSL share path becomes the POSIX folder, and back", () => {
  assert.deepEqual(wslPathFromUnc("\\\\wsl.localhost\\Ubuntu\\home\\me\\api"), { distro: "Ubuntu", path: "/home/me/api" });
  assert.deepEqual(wslPathFromUnc("\\\\wsl$\\Ubuntu\\srv\\"), { distro: "Ubuntu", path: "/srv" });
  assert.deepEqual(wslPathFromUnc("\\\\WSL.LOCALHOST\\Debian"), { distro: "Debian", path: "/" });
  assert.deepEqual(wslPathFromUnc("//wsl.localhost/Ubuntu/a b/c"), { distro: "Ubuntu", path: "/a b/c" });
  for (const other of ["C:\\Code", "\\\\server\\share\\x", "\\\\wsl.localhost\\", "", null, "/home/me"]) {
    assert.equal(wslPathFromUnc(other), null, String(other));
  }
  assert.equal(uncForWslPath("Ubuntu", "/home/me"), "\\\\wsl.localhost\\Ubuntu\\home\\me");
  assert.equal(uncForWslPath("Ubuntu", "/"), "\\\\wsl.localhost\\Ubuntu");
  assert.deepEqual(wslPathFromUnc(uncForWslPath("Ubuntu", "/srv/app")), { distro: "Ubuntu", path: "/srv/app" });
});

test("folders in WSL and over SSH are absolute or under ~", () => {
  assert.equal(remoteFolderProblem("/srv/app"), null);
  assert.equal(remoteFolderProblem("~"), null);
  assert.equal(remoteFolderProblem("~/code"), null);
  assert.match(remoteFolderProblem("srv/app"), /Start the folder with/);
  assert.match(remoteFolderProblem(""), /Type the folder/);
  assert.match(remoteFolderProblem("/a\nb"), /control characters/);
  assert.equal(samePosixPath("/srv/app/", "/srv/app"), true);
  assert.equal(samePosixPath("/", "//"), true);
  assert.equal(samePosixPath("/Srv", "/srv"), false);
});

test("an SSH destination is refused where the backend would refuse it", () => {
  for (const ok of ["devbox", "me@10.0.0.5", "ssh://me@box:2222", "[::1]"]) assert.equal(sshDestinationProblem(ok), null, ok);
  assert.match(sshDestinationProblem(""), /Type the SSH host/);
  assert.match(sshDestinationProblem("-oProxyCommand=x"), /dash/);
  assert.match(sshDestinationProblem("me@box ls"), /spaces/);
  assert.match(sshDestinationProblem("box\u0007"), /control/);
  assert.match(sshDestinationProblem("x".repeat(201)), /too long/);
  assert.match(sshDestinationProblem("wsl:Ubuntu"), /location list/);
});

test("an SSH agent is present only while its hooks report a state; WSL and local count the shell's child", () => {
  const agent = { kind: "codex", state: "idle" };
  assert.equal(agentPresent({ host: "prod", busy: true, agent: null }), false);
  assert.equal(agentPresent({ host: "prod", busy: false, agent }), true);
  assert.equal(agentPresent({ host: "wsl:Ubuntu", busy: true, agent: null }), true);
  assert.equal(agentPresent({ host: null, busy: true, agent: null }), true);
  assert.equal(agentPresent({ busy: false, agent: null }), false);
});

test("WSL and SSH folders are not read from this disk; their git comes with the record", () => {
  const folders = new Map([
    ["local", { path: "C:\\src\\local", pathExists: true, host: null }],
    ["api", { path: "/srv/api", pathExists: true, host: "prod", git: { branch: "main", head: null } }],
    ["linux", { path: "/home/me/x", pathExists: true, host: "wsl:Ubuntu", git: { branch: "dev", head: null } }],
  ]);
  assert.deepEqual(gitPaths(folders), ["C:\\src\\local"]);
  assert.deepEqual(remoteNames(folders), ["api", "linux"]);
  const model = sidebarModel({
    state: { workspaceNames: ["local", "api", "linux"], cfg: {} },
    folders,
    git: new Map([["C:\\src\\local", { branch: "dev" }], ["/srv/api", { branch: "wrong" }]]),
  });
  const api = model.workspaces.find((entry) => entry.name === "api");
  assert.equal(api.host, "prod");
  assert.equal(api.git.branch, "main");
  assert.equal(model.workspaces.find((entry) => entry.name === "linux").host, "wsl:Ubuntu");
  assert.equal(model.workspaces.find((entry) => entry.name === "local").git.branch, "dev");
  assert.equal("profiles" in model, false);
});
