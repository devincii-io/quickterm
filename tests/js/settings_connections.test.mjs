import test from "node:test";
import assert from "node:assert/strict";
import {
  CONNECTION_CATALOG, connectionLabel, connectionProblems, connectionTarget, defaultSshClient, newConnection,
} from "../../quickterm/frontend/js/panel_connections.js";
import { setupNeeded } from "../../quickterm/frontend/js/setup.js";

const type = (id) => CONNECTION_CATALOG.find((item) => item.id === id);

test("setup covers terminal, device, container and desktop connection families", () => {
  for (const id of ["custom", "wsl", "claude-code", "codex", "ssh", "sftp", "serial", "telnet", "docker", "podman", "kubernetes", "rdp", "vnc"]) assert.ok(type(id), id);
});

test("the Add menu groups, in order, with both agents under Agents", () => {
  const groups = [...new Set(CONNECTION_CATALOG.map((item) => item.group))];
  assert.deepEqual(groups, ["Shells", "Agents", "Remote", "Devices", "Containers", "Desktop"]);
  assert.deepEqual(type("codex"), { id: "codex", label: "Codex", group: "Agents", cmd: "codex" });
  assert.equal(type("claude-code").group, "Agents");
});

test("connection setup preserves detected executable paths and avoids duplicate names", () => {
  const shell = type("powershell-core");
  const profile = newConnection(shell, { types: [{ id: shell.id, executable: "C:/Program Files/pwsh.exe" }] }, [{ name: "PowerShell 7" }]);
  assert.equal(profile.name, "PowerShell 7 2");
  assert.equal(profile.cmd, "C:/Program Files/pwsh.exe");
  assert.deepEqual(connectionProblems(profile, []), []);
  assert.ok(connectionProblems({ name: "SSH", terminal_type: "ssh", ssh_host: "" }, []).length);
});

test("a new agent starts a new conversation with no options", () => {
  for (const id of ["claude-code", "codex"]) {
    const profile = newConnection(type(id), { types: [] }, []);
    assert.equal(profile.agent_mode, "new", id);
    assert.deepEqual(profile.agent, {}, id);
    assert.equal(profile.terminal_type, id);
  }
  const codex = newConnection(type("codex"), { types: [{ id: "codex", executable: "C:/bin/codex.exe" }] }, []);
  assert.equal(codex.cmd, "C:/bin/codex.exe");
  assert.equal("claude_mode" in codex, false);
  assert.equal(connectionLabel(codex), "Codex · new conversation");
  assert.deepEqual(connectionProblems(codex, []), []);
});

test("a new ssh profile uses OpenSSH when it is installed, else PuTTY", () => {
  const both = { types: [{ id: "ssh", executable: "C:/putty/plink.exe", openssh: "C:/Windows/System32/OpenSSH/ssh.exe", putty: "C:/putty/plink.exe" }] };
  const putty = { types: [{ id: "ssh", executable: "C:/putty/plink.exe", openssh: null, putty: "C:/putty/plink.exe" }] };
  assert.equal(newConnection(type("ssh"), both, []).ssh_client, "openssh");
  assert.equal(newConnection(type("ssh"), putty, []).ssh_client, "putty");
  assert.equal(defaultSshClient({ types: [{ id: "ssh", executable: "plink.exe" }] }), "putty", "an older backend reports no openssh key");
  assert.equal(newConnection(type("sftp"), both, []).ssh_client, "openssh", "sftp follows the ssh entry");
  assert.equal(newConnection(type("powershell-core"), both, []).ssh_client, null);
});

test("an alias from ~/.ssh/config becomes an OpenSSH profile named after it", () => {
  const profiles = [{ name: "prod" }];
  const profile = newConnection(type("ssh"), { types: [] }, profiles, { name: "prod", ssh_host: "prod", ssh_client: "openssh" });
  assert.equal(profile.name, "prod 2");
  assert.equal(profile.ssh_host, "prod");
  assert.equal(profile.ssh_client, "openssh");
  assert.equal(connectionLabel(profile), "SSH · OpenSSH");
  assert.equal(connectionTarget(profile), "prod");
  assert.deepEqual(connectionProblems(profile, profiles), []);
});

test("ssh and agent problems are refused before the save", () => {
  const base = { name: "Box", terminal_type: "ssh", ssh_host: "box" };
  assert.deepEqual(connectionProblems({ ...base, ssh_proxy_jump: "jump" }, []), ["ProxyJump needs the OpenSSH client"]);
  assert.match(connectionProblems({ ...base, ssh_client: "openssh", ssh_key: "k.ppk" }, [])[0], /\.ppk/);
  assert.match(connectionProblems({ ...base, ssh_host: "-x" }, [])[0], /must not start with -/);
  const codex = { name: "Codex", terminal_type: "codex", agent: { bypass: "true", approval: "never" } };
  assert.deepEqual(connectionProblems(codex, []), ["bypass replaces approval and sandbox; clear them first"]);
});

test("the tour only opens automatically before setup has been completed", () => {
  assert.equal(setupNeeded([], { getItem: () => null }), true);
  assert.equal(setupNeeded([], { getItem: () => "1" }), false);
  assert.equal(setupNeeded([{ name: "Console" }], { getItem: () => null }), false);
});
