import test from "node:test";
import assert from "node:assert/strict";
import { CONNECTION_CATALOG, connectionProblems, newConnection } from "../../quickterm/frontend/js/panel_connections.js";
import { setupNeeded } from "../../quickterm/frontend/js/setup.js";

test("setup covers terminal, device, container and desktop connection families", () => {
  for (const id of ["custom", "wsl", "claude-code", "ssh", "sftp", "serial", "telnet", "docker", "podman", "kubernetes", "rdp", "vnc"]) assert.ok(CONNECTION_CATALOG.some((type) => type.id === id));
});

test("connection setup preserves detected executable paths and avoids duplicate names", () => {
  const type = CONNECTION_CATALOG.find((item) => item.id === "powershell-core");
  const profile = newConnection(type, { types: [{ id: type.id, executable: "C:/Program Files/pwsh.exe" }] }, [{ name: "PowerShell 7" }]);
  assert.equal(profile.name, "PowerShell 7 2");
  assert.equal(profile.cmd, "C:/Program Files/pwsh.exe");
  assert.deepEqual(connectionProblems(profile, []), []);
  assert.ok(connectionProblems({ name: "SSH", terminal_type: "ssh", ssh_host: "" }, []).length);
});

test("the tour only opens automatically before setup has been completed", () => {
  assert.equal(setupNeeded([], { getItem: () => null }), true);
  assert.equal(setupNeeded([], { getItem: () => "1" }), false);
  assert.equal(setupNeeded([{ name: "Console" }], { getItem: () => null }), false);
});
