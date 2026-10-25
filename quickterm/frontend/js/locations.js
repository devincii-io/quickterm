// Where a workspace lives (CONTRACTS 4.5): `host` null is this PC,
// "wsl:<distro>" a WSL distribution, anything else an SSH destination. This
// module is the one place in the frontend that reads it. Pure, tested in node.

export function locationKind(host) {
  if (!host) return "local";
  return /^wsl:/i.test(String(host)) ? "wsl" : "ssh";
}

export function wslDistro(host) {
  return locationKind(host) === "wsl" ? String(host).slice(4) : null;
}

// "This PC", "WSL: Ubuntu", or the SSH destination as written.
export function locationLabel(host) {
  const kind = locationKind(host);
  if (kind === "local") return "This PC";
  if (kind === "wsl") return `WSL: ${wslDistro(host)}`;
  return String(host);
}

// What a workspace head shows after its name: nothing for this PC.
export function locationTag(host) {
  const kind = locationKind(host);
  if (kind === "local") return "";
  return kind === "wsl" ? locationLabel(host) : `@${host}`;
}

// The folder with its location, for tooltips.
export function locationPath(host, path) {
  const kind = locationKind(host);
  if (kind === "local") return path || "";
  if (kind === "wsl") return `${locationLabel(host)} ${path || ""}`.trim();
  return `${host}:${path || ""}`;
}

// A folder in WSL or on an SSH host: absolute, `~` or `~/...`; no control
// characters.
export function remoteFolderProblem(path) {
  const text = String(path || "").trim();
  if (!text) return "Type the folder.";
  if (/[\u0000-\u001f\u007f]/.test(text)) return "The folder must not contain control characters.";
  if (!(text.startsWith("/") || text === "~" || text.startsWith("~/"))) return "Start the folder with / or ~/.";
  return null;
}

// An SSH destination as the backend accepts it: a ~/.ssh/config alias,
// [user@]host or ssh://[user@]host[:port].
export function sshDestinationProblem(text) {
  const value = String(text || "").trim();
  if (!value) return "Type the SSH host, like user@server or a Host from ~/.ssh/config.";
  if (value.length > 200) return "The SSH host is too long.";
  if (value.startsWith("-")) return "The SSH host must not start with a dash.";
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return "The SSH host must not contain spaces or control characters.";
  if (/^wsl:/i.test(value)) return "Pick the WSL distribution from the location list.";
  return null;
}

// `\\wsl.localhost\Ubuntu\home\me` (or `\\wsl$\...`) as {distro, path} with
// the POSIX path `/home/me`; null for any other path.
export function wslPathFromUnc(value) {
  const match = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)((?:[\\/][^\\/]*)*)$/i.exec(String(value || ""));
  if (!match) return null;
  const parts = match[2].split(/[\\/]+/).filter(Boolean);
  return { distro: match[1], path: `/${parts.join("/")}` };
}

// The other way, for the folder browser's start: `/home/me` in Ubuntu.
export function uncForWslPath(distro, path) {
  const parts = String(path || "").split("/").filter(Boolean);
  return [`\\\\wsl.localhost\\${distro}`, ...parts].join("\\");
}

// Two POSIX folders are the same with a trailing slash or without.
export function samePosixPath(a, b) {
  const key = (value) => String(value || "").trim().replace(/\/+$/, "") || "/";
  return Boolean(a) && Boolean(b) && key(a) === key(b);
}

// Whether an agent pane's agent still runs, from one /api/sessions item. A
// local or WSL agent counts while its shell has a child or hooks report a
// state. Over SSH the only process here is ssh, which never has one, so the
// hook state alone answers: the remote script reports the agent's start and
// its end.
export function agentPresent(session) {
  if (locationKind(session?.host) === "ssh") return Boolean(session.agent);
  return session?.busy === true || Boolean(session?.agent);
}
