import test from "node:test";
import assert from "node:assert/strict";
import { CONNECTION_CATALOG, connectionProblems, newConnection } from "../../quickterm/frontend/js/panel_connections.js";
import { terminalChoices, groupSessionsByWorkspace } from "../../quickterm/frontend/js/launcher.js";
import { companionUrl, nextScratchLabel } from "../../quickterm/frontend/js/workspace_views.js";
import { setupNeeded } from "../../quickterm/frontend/js/setup.js";
import { Palette } from "../../quickterm/frontend/js/palette.js";

test("setup covers terminal, device, container and desktop connection families", () => {
  for (const id of ["custom", "wsl", "claude-code", "ssh", "sftp", "serial", "telnet", "docker", "podman", "kubernetes", "rdp", "vnc"]) assert.ok(CONNECTION_CATALOG.some((type) => type.id === id));
});

test("the configured launcher exposes only saved terminal configurations", () => {
  const local = { name: "Console", cmd: "cmd.exe", terminal_type: "command-prompt" };
  const desktop = { name: "Desktop", cmd: "", terminal_type: "rdp", connection: { host: "server" } };
  const inventory = { types: [{ id: "claude-code", executable: "claude", available: true }, { id: "wsl", executable: "wsl.exe", available: true }] };
  assert.deepEqual(terminalChoices({ configuredOnly: true, profiles: [], inventory }), []);
  assert.deepEqual(terminalChoices({ configuredOnly: true, profiles: [local, desktop], inventory }).map((item) => item.label), ["Console"]);
});

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
  assert.equal(items.find((item) => item.label === "claude continue: Assistant").hint, "C:/project");
});

test("connection setup preserves detected executable paths and avoids duplicate names", () => {
  const type = CONNECTION_CATALOG.find((item) => item.id === "powershell-core");
  const profile = newConnection(type, { types: [{ id: type.id, executable: "C:/Program Files/pwsh.exe" }] }, [{ name: "PowerShell 7" }]);
  assert.equal(profile.name, "PowerShell 7 2");
  assert.equal(profile.cmd, "C:/Program Files/pwsh.exe");
  assert.deepEqual(connectionProblems(profile, []), []);
  assert.ok(connectionProblems({ name: "SSH", terminal_type: "ssh", ssh_host: "" }, []).length);
});

test("scratch views get distinct identities and labels without replacing another layout", () => {
  const url = new URL(companionUrl("/", null, "view-12345678", "token"), "http://localhost");
  assert.equal(url.searchParams.get("workspace"), "");
  assert.equal(url.searchParams.get("scratch"), "scratch-view-view-12345678");
  assert.equal(nextScratchLabel(["scratch 1", "scratch 3"]), "scratch 2");
});

test("a terminal shown in another workspace remains in its group and counts as open", () => {
  const groups = groupSessionsByWorkspace([{ id: "other", alive: true, workspace: "Operations" }], { currentWorkspace: "Project", visibleIds: ["other"] });
  const group = groups.find((item) => item.name === "Operations");
  assert.equal(group.sessions[0].isHere, false);
  assert.equal(group.sessions[0].state.key, "open");
});

test("the tour only opens automatically before setup has been completed", () => {
  assert.equal(setupNeeded([], { getItem: () => null }), true);
  assert.equal(setupNeeded([], { getItem: () => "1" }), false);
  assert.equal(setupNeeded([{ name: "Console" }], { getItem: () => null }), false);
});
