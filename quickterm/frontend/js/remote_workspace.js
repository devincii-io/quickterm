// Workspaces on an SSH host (CONTRACTS 4.3): which saved terminals can back
// one, which profiles make sense in one, what a new one is called, and the
// palette steps that create it. The pure helpers are tested under node.

// Only an SSH profile on the OpenSSH client can back a workspace.
export function sshHosts(profiles = []) {
  return (profiles || [])
    .filter((profile) => profile?.terminal_type === "ssh" && profile.ssh_client === "openssh" && profile.name)
    .map((profile) => ({
      name: profile.name,
      target: profile.ssh_host ? `${profile.ssh_user ? `${profile.ssh_user}@` : ""}${profile.ssh_host}` : "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
}

const WINDOWS_PROGRAM = /^[A-Za-z]:|\\|\.(exe|cmd|bat)$/i;
const POSIX_SHELLS = new Set(["bash", "zsh", "fish", "git-bash"]);

// Mirrors launch.remote_start: a POSIX shell profile with a start command,
// or a custom command whose program is no Windows path. Connections and the
// local shells stay out of a remote workspace's "+" menu.
export function remoteCapable(profile) {
  const type = profile?.terminal_type;
  if (POSIX_SHELLS.has(type)) return Boolean(String(profile.start_command || "").trim());
  if (type === "custom") {
    const program = String(profile.cmd || "").trim();
    return Boolean(program) && !WINDOWS_PROGRAM.test(program);
  }
  return false;
}

// Whether an agent pane's agent still runs, from one /api/sessions item. A
// local agent counts while its shell has a child or hooks report a state. On
// an SSH host the only process here is ssh, which never has one, so the hook
// state alone answers: the remote script reports the agent's start and its
// end.
export function agentPresent(session) {
  if (session?.host) return Boolean(session.agent);
  return session?.busy === true || Boolean(session?.agent);
}

// A folder on a host: absolute, `~` or `~/...`; no control characters.
export function remoteFolderProblem(path) {
  const text = String(path || "").trim();
  if (!text) return "Type the folder on the host.";
  if (/[\u0000-\u001f\u007f]/.test(text)) return "The folder must not contain control characters.";
  if (!(text.startsWith("/") || text === "~" || text.startsWith("~/"))) return "Start the folder with / or ~/.";
  return null;
}

// Named after the folder, like "workspace here"; a name already taken gets
// the host after it, then a number.
export function remoteWorkspaceName(path, host, taken = []) {
  const clean = (text) => String(text || "").replace(/[^A-Za-z0-9._ -]+/g, "-").replace(/^[.\-\s]+|[.\s]+$/g, "");
  const parts = String(path || "").split("/").filter((part) => part && part !== "~");
  const base = clean(parts[parts.length - 1]) || clean(host) || "remote";
  const used = new Set((taken || []).map((name) => String(name).toLowerCase()));
  const free = (name) => !used.has(name.toLowerCase()) && name.toLowerCase() !== "scratch";
  if (free(base)) return base;
  const withHost = `${base}-${clean(host) || "remote"}`;
  if (free(withHost)) return withHost;
  for (let n = 2; ; n++) if (free(`${withHost}-${n}`)) return `${withHost}-${n}`;
}

// Saves the workspace with its host and folder and an empty layout, then
// opens its view, whose restore starts the first remote terminal.
export async function createRemoteWorkspace({ api, host, path, openView, onWorkspacesChanged }) {
  const names = await api.listWorkspaces().catch(() => []);
  const name = remoteWorkspaceName(path, host, names);
  await api.putRemoteWorkspace(name, host, path.trim());
  await Promise.resolve(onWorkspacesChanged?.()).catch(() => {});
  await Promise.resolve(openView?.(name)).catch(() => null);
  return name;
}

// The palette's "new workspace on host…": the host from a list, then the
// folder typed in. A failed check shows what ssh said, and Enter on the same
// folder saves it anyway.
export function hostRows(palette, profiles) {
  const hosts = sshHosts(profiles);
  return hosts.map((host) => ({
    kind: "workspace", label: `new workspace on: ${host.name}`, hint: host.target,
    keepOpen: true, run: () => folderPrompt(palette, host.name),
  }));
}

function folderPrompt(palette, host) {
  palette._leaveSubModes();
  let unchecked = null;
  palette._promptMode(`Folder on ${host}, like /srv/app or ~/code/app, then Enter`, async (value) => {
    const prompt = palette.prompt;
    const say = (label, hint = "") => {
      palette.filtered = [{ kind: "workspace", label, hint, keepOpen: true, run: () => {} }];
      palette.sel = 0;
      palette._renderList();
    };
    const problem = remoteFolderProblem(value);
    if (problem) { say(problem); return; }
    const a = palette.app;
    if (unchecked !== value) {
      say(`checking ${value} on ${host}…`);
      const check = await a.checkRemoteFolder?.(host, value).catch((error) => ({ ok: false, message: error?.detail || "the check failed" }));
      if (!palette.open || palette.prompt !== prompt) return;
      if (check && !check.ok) {
        unchecked = value;
        say(check.message || `${value} was not found on ${host}`, "Enter saves it anyway · Esc closes");
        return;
      }
    }
    say(`creating the workspace on ${host}…`);
    try {
      await a.createRemoteWorkspace?.(host, value);
    } catch (error) {
      if (palette.open && palette.prompt === prompt) say(error?.detail || "The workspace could not be saved.", "Enter retries · Esc closes");
      return;
    }
    if (palette.open && palette.prompt === prompt) palette.close();
  }, { stayOpen: true });
}
