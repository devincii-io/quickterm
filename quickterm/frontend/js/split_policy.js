// Directory and launch-mode policy for split panes. Kept DOM-free so the
// behavior can be tested without a browser.

function targetType(choice) {
  return choice?.kind === "profile" ? choice.profile?.terminal_type : choice?.id;
}

export function splitDirectory(sourceCwd, sourceType, choice, windowsHost = false) {
  const type = targetType(choice);
  const configured = choice?.kind === "profile" ? (choice.profile?.cwd || null) : null;

  // Claude conversations are project identities. A split starts in that
  // profile's project instead of borrowing an unrelated shell directory.
  if (type === "claude-code") return configured;
  if (type === "ssh" || type === "sftp") return configured;
  if (!sourceCwd) return configured;

  // WSL accepts both Linux paths and Windows paths through `wsl --cd`.
  if (type === "wsl") return sourceCwd;
  // A Linux cwd signalled by WSL is meaningless to a native Windows shell.
  if (sourceType === "wsl" && !/^[A-Za-z]:[\\/]|^\\\\/.test(sourceCwd)) {
    return configured;
  }
  if (windowsHost && /^(?:\/|~)/.test(sourceCwd)) return configured;
  return sourceCwd;
}

export function normalClaudeSplitMode(profile) {
  // An agent-manager profile remains useful for one-click Open, but ordinary
  // split keys should create a normal project conversation. The agent view has
  // its own explicit split action.
  return profile?.terminal_type === "claude-code" && profile.claude_mode === "agents"
    ? "continue"
    : undefined;
}
