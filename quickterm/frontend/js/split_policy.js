// Directory and launch-mode policy for split panes. Kept DOM-free so the
// behavior can be tested without a browser.

import { agentModeOf, isAgentType } from "./agent_profile.js";

function targetType(choice) {
  return choice?.kind === "profile" ? choice.profile?.terminal_type : choice?.id;
}

export function splitDirectory(sourceCwd, sourceType, choice, windowsHost = false) {
  const type = targetType(choice);
  // Agents and remote clients use the workspace root, not a shell's cd.
  if (isAgentType(type) || ["ssh", "sftp", "telnet", "serial", "docker", "podman", "kubernetes"].includes(type)) {
    return null;
  }
  if (!sourceCwd) return null;

  // WSL accepts both Linux paths and Windows paths through `wsl --cd`.
  if (type === "wsl") return sourceCwd;
  // A Linux cwd signalled by WSL is meaningless to a native Windows shell.
  if (sourceType === "wsl" && !/^[A-Za-z]:[\\/]|^\\\\/.test(sourceCwd)) {
    return null;
  }
  if (windowsHost && /^(?:\/|~)/.test(sourceCwd)) return null;
  return sourceCwd;
}

export function normalAgentSplitMode(profile) {
  // An agent-manager profile remains useful for one-click Open, but ordinary
  // split keys should create a normal project conversation. The agent view has
  // its own explicit split action.
  return isAgentType(profile?.terminal_type) && agentModeOf(profile) === "agents"
    ? "continue"
    : undefined;
}

export const normalClaudeSplitMode = normalAgentSplitMode;
