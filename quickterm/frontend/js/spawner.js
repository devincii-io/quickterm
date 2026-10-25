// Starting terminals: which shell a new pane gets, which folder it starts in,
// and every way a pane is filled (run, split, restart, resume, attach,
// elevate). The spec helpers at the top are pure and tested in node.

import { SCRATCH_WS } from "./boot_context.js";
import { AGENT_TYPES, agentProfile, isAgentType } from "./agent_profile.js";
import { launchOptions, repeatLaunchOptions } from "./launch_options.js";
import { shellTerminalType, shellValueLabel } from "./shell_choice.js";
import { locationKind } from "./locations.js";
import { splitDirectory } from "./split_policy.js";
import { insidePath, samePath } from "./here.js";

// What a pane remembers about how it was started without a profile: a
// command line, or a shell named by its config value (`{shell, name}`), which
// the backend resolves again on every start.
export function serializableSpec(spec) {
  if (typeof spec.shell === "string" && !spec.cmd) {
    const out = { shell: spec.shell, name: spec.name || shellValueLabel(spec.shell) };
    if (spec.cwd) out.cwd = spec.cwd;
    // A Start with shell's one-line command (never its variables: the layout
    // is saved as plain text, the workspace's setup sealed).
    if (typeof spec.command === "string" && spec.command) out.command = spec.command;
    out.terminal_type = shellTerminalType(spec.shell);
    return out;
  }
  if (typeof spec.command === "string" && spec.command && !spec.cmd) {
    // The same in the configured shell, which the backend resolves per start.
    const out = { command: spec.command, name: spec.name || "Shell" };
    if (spec.cwd) out.cwd = spec.cwd;
    return out;
  }
  const out = {
    cmd: spec.cmd,
    args: [...(spec.args || [])],
    cwd: spec.cwd || null,
    env: { ...(spec.env || {}) },
    name: spec.name || spec.label || spec.cmd,
  };
  if (spec.terminalType || spec.terminal_type) {
    out.terminal_type = spec.terminalType || spec.terminal_type;
  }
  return out;
}

// The pane type of a plain shell: in a WSL or SSH workspace the location's
// own shell (WSL panes map dropped Windows paths, remote ones refuse them),
// on this PC the shell it was started with or the configured one.
export function plainShellType(host, shell) {
  const where = locationKind(host);
  if (where !== "local") return where;
  return shellTerminalType(shell ?? "");
}

export function commandTerminalType(spec) {
  if (spec.terminal_type || spec.terminalType) return spec.terminal_type || spec.terminalType;
  const command = String(spec.cmd || "").toLowerCase();
  if (/(^|[\\/])wsl(?:\.exe)?$/.test(command)) return "wsl";
  if (/(^|[\\/])psftp(?:\.exe)?$/.test(command)) return "sftp";
  if (/(^|[\\/])plink(?:\.exe)?$/.test(command)) return "ssh";
  return null;
}

// A 4.2 layout saved the built-in "Claude · continue" choices as a raw
// command. Since 4.3 they start through the agent settings, inside the shell,
// with hooks; this reads the kind and mode back out of such a spec.
const LEGACY_MODES = {
  "claude-code": [[["--continue"], "continue"], [["--resume"], "resume"], [[], "new"]],
  codex: [[["resume", "--last"], "continue"], [["resume"], "resume"], [[], "new"]],
};

export function legacyAgentSpec(spec) {
  const kind = spec?.terminal_type || spec?.terminalType;
  if (!isAgentType(kind) || !spec.cmd) return null;
  const args = spec.args || [];
  const found = LEGACY_MODES[kind].find(([words]) => words.length === args.length
    && words.every((word, index) => word === args[index]));
  return found ? { kind, mode: found[1] } : null;
}

// Alt+N and the "+" open where the focused terminal is, as long as that is
// still inside the workspace folder; anywhere else (a `cd` out of the
// project, a WSL path, a folder never reported) means the workspace folder.
// Paths compare as here.js compares them.
export function sameFolderCwd(paneCwd, root) {
  return samePath(paneCwd, root) || insidePath(paneCwd, root) ? paneCwd : null;
}

// The agent (Claude Code or Codex) that can pick a dead pane's conversation
// up again. `profiles` are the agents (allProfiles()).
export function claudeProfileForPane(profiles, pane) {
  const profile = profiles.find((item) => item.name === pane.profileName) || null;
  if (profile) return isAgentType(profile.terminal_type) ? profile : null;
  return agentForLostProfile(profiles, pane);
}

// A pane whose profile is gone: 4.3 turned the agent profiles into settings
// and 4.5 removed saved terminals, so a layout may still name "Claude New".
// Its pane type, else a profile name or title naming the agent, picks it.
function agentForLostProfile(profiles, pane) {
  const hint = [pane.profileName, pane.title].filter(Boolean).join(" ");
  const kind = isAgentType(pane.terminalType) ? pane.terminalType
    : /\bcodex\b/i.test(hint) ? "codex"
      : /\bclaude\b/i.test(hint) ? "claude-code" : null;
  return kind ? profiles.find((item) => item.name === kind && isAgentType(item.terminal_type)) || null : null;
}

export function createSpawner({
  api, state, layout, ownSession, scheduleWorkspaceSave, refreshStatusSoon, refreshInventory, showError,
}) {
  // The only profiles left (4.5): Claude Code and Codex from the agent
  // settings, under their kind as the name ("claude-code"), which is how a
  // request names them.
  function allProfiles() {
    return AGENT_TYPES.map((kind) => agentProfile(kind, state.cfg?.agents?.[kind]));
  }

  // Where a new terminal should start when the caller has no directory of its
  // own. Named workspaces use their stored root; scratch uses its disposable root.
  // Profiles carry no folder, so there is nothing here to defer to: an
  // explicit directory wins, scratch supplies its own throwaway root, and a
  // named workspace is resolved by the backend from its stored path.
  function contextCwd(explicit) {
    if (explicit) return explicit;
    if (!state.currentWorkspace || state.currentWorkspace === SCRATCH_WS) return state.scratchRoot || null;
    return null;
  }

  function profileByName(name) {
    return allProfiles().find((profile) => profile.name === name) || null;
  }

  function profileTerminalType(name) {
    return profileByName(name)?.terminal_type || null;
  }

  // Tag new sessions with their named workspace. Scratch remains untagged
  // because it is disposable and may be promoted under a different name.
  function spawnWorkspaceTag() {
    return state.currentWorkspace && state.currentWorkspace !== SCRATCH_WS ? state.currentWorkspace : undefined;
  }

  // `options` left out means "the way this pane was started": a workspace
  // restore and a restart call it like that and get the saved agent mode and
  // session, start command or args back. A fresh launch passes its own, `{}` for none,
  // so a new terminal in a replaceable pane never inherits the old launch.
  async function spawnInto(pane, profileName, cwd, options) {
    if (!profileByName(profileName)) {
      // A pane saved with a profile that is gone (4.3 removed the shell and
      // agent profiles, 4.5 every saved terminal) still opens: in the shell,
      // saying why.
      const info = await spawnShellInto(pane, cwd, null);
      if (info) pane.flashNotice?.(`[profile "${profileName}" no longer exists · started the shell]`, 5000);
      return info;
    }
    const launch = repeatLaunchOptions(pane, profileName, options, profileTerminalType(profileName));
    if (!pane.beginSpawn()) return null;
    try {
      const info = await api.createSession({
        profile: profileName,
        cwd: cwd || undefined,
        workspace: spawnWorkspaceTag(),
        ...(launch.agentMode !== undefined ? { agent_mode: launch.agentMode } : {}),
        ...(launch.agentSession !== undefined ? { agent_session: launch.agentSession } : {}),
        ...(launch.args !== undefined ? { args: launch.args } : {}),
      });
      pane.profileName = profileName;
      pane.terminalType = profileTerminalType(profileName);
      pane.launchSpec = null;
      pane.launchOptions = launchOptions(launch);
      pane.restartWith = null;
      // The backend resolves the workspace folder, so its answer, not the
      // hint we sent, is what this pane actually opened in.
      pane.setLaunchCwd(info.cwd || cwd || null);
      pane.attach(info);
      pane.spawnedFresh = true;
      ownSession(info.id);
      scheduleWorkspaceSave();
      refreshStatusSoon();
      return info;
    } catch (error) {
      pane.endSpawn();
      pane.showNotice(`[${error.detail || `spawn failed: ${profileName}`}]`);
      return null;
    }
  }

  async function spawnSpecInto(pane, spec) {
    const legacy = legacyAgentSpec(spec);
    if (legacy) return spawnInto(pane, legacy.kind, spec.cwd || null, { agentMode: legacy.mode });
    if (typeof spec.shell === "string" && !spec.cmd) {
      return spawnShellInto(pane, spec.cwd || null, spec.shell, spec.command || null);
    }
    if (!pane.beginSpawn()) return null;
    const launchSpec = serializableSpec(spec);
    try {
      // workspace tags the request only (not the persisted launchSpec).
      const info = await api.createSession({ ...launchSpec, workspace: spawnWorkspaceTag() });
      pane.profileName = null;
      // A command with no program runs in the configured shell.
      pane.terminalType = commandTerminalType(launchSpec)
        ?? (launchSpec.command ? plainShellType(state.workspaceHost, state.cfg?.shell) : null);
      pane.setLaunchCwd(info.cwd || launchSpec.cwd);
      pane.launchSpec = launchSpec;
      pane.launchOptions = null;
      pane.restartWith = null;
      pane.attach(info);
      pane.spawnedFresh = true;
      ownSession(info.id);
      scheduleWorkspaceSave();
      refreshStatusSoon();
      return info;
    } catch (error) {
      pane.endSpawn();
      pane.showNotice(`[${error.detail || `spawn failed: ${launchSpec.name}`}]`);
      return null;
    }
  }

  // A shell with no profile. `shell` null is the configured one, resolved by
  // the backend on every start, so a restart follows a changed setting; a
  // named one (a "+" menu row) is remembered on the pane.
  async function spawnShellInto(pane, cwd, shell = null, command = null) {
    if (!pane.beginSpawn()) return null;
    const named = typeof shell === "string";
    try {
      const info = await api.createSession({
        cwd: cwd || undefined,
        workspace: spawnWorkspaceTag(),
        ...(named ? { shell } : {}),
        ...(command ? { command } : {}),
      });
      pane.profileName = null;
      pane.terminalType = plainShellType(state.workspaceHost, named ? shell : state.cfg?.shell);
      pane.setLaunchCwd(info.cwd || cwd || null);
      pane.launchSpec = named ? serializableSpec({ shell, command }) : null;
      pane.launchOptions = null;
      pane.restartWith = null;
      pane.attach(info);
      pane.spawnedFresh = true;
      ownSession(info.id);
      scheduleWorkspaceSave();
      refreshStatusSoon();
      return info;
    } catch (error) {
      pane.endSpawn();
      pane.showNotice(`[${error.detail || "the shell did not start"}]`);
      return null;
    }
  }

  // A new terminal with no profile (Alt+N, "+", a folder handed in from
  // Explorer or `quickterm new`): the configured shell, or the one the
  // sidebar's "+" was last pointed at.
  function spawnDefaultInto(pane, cwdOverride, shell = null) {
    return spawnShellInto(pane, contextCwd(cwdOverride), shell);
  }

  function splitCwd(source, choice) {
    return splitDirectory(
      source?.bestKnownCwd?.() || null,
      source?.terminalType || null,
      choice,
      /Windows/i.test(navigator.userAgent),
    );
  }

  function spawnSplitInto(pane, source) {
    const choice = { kind: "system", id: shellTerminalType(state.cfg?.shell ?? "") };
    return spawnShellInto(pane, contextCwd(splitCwd(source, choice)), null);
  }

  async function runProfile(profile) {
    let pane = layout.focused || layout.init();
    if (!pane.canReplace) pane = layout.splitPane(pane, layout.autoDir(pane));
    if (!pane) return;
    layout.focusPane(pane);
    await spawnInto(pane, profile.name, contextCwd(null), {});
  }

  async function runWithOptions(profile, options, cwd = null) {
    let pane = layout.focused || layout.init();
    if (!pane.canReplace) pane = layout.splitPane(pane, layout.autoDir(pane));
    if (!pane) return null;
    layout.focusPane(pane);
    return spawnInto(pane, profile.name, contextCwd(cwd), options);
  }

  // The folder whose agent conversations this view lists and resumes. A
  // named workspace answers null: the backend resolves its folder by name,
  // for the list and for the spawn alike. Scratch uses the folder the view
  // was opened on ("Open QuickTerm here"), else its throwaway root.
  function agentSessionFolder() {
    if (state.currentWorkspace && state.currentWorkspace !== SCRATCH_WS) return null;
    return state.scratchCwd || state.scratchRoot || null;
  }

  function runAgentMode(profile, agentMode) {
    return runWithOptions(profile, { agentMode });
  }

  // A session picked from QuickTerm's own list (GET /api/agent-sessions).
  // Codex can also fork it into a new session; Claude only resumes. Either
  // finds the conversation only in the folder it was listed for.
  function resumeAgentSession(profile, sessionId, { fork = false } = {}) {
    const agentMode = fork && profile.terminal_type === "codex" ? "fork" : "resume";
    return runWithOptions(profile, { agentMode, agentSession: sessionId }, agentSessionFolder());
  }

  async function splitAgentView(profile) {
    const source = layout.focused || layout.init();
    const pane = layout.splitPane(source, layout.autoDir(source));
    if (!pane) return null;
    layout.focusPane(pane);
    return spawnInto(pane, profile.name, contextCwd(null), { agentMode: "agents" });
  }

  async function runSystemTerminal(system) {
    let pane = layout.focused || layout.init();
    if (!pane.canReplace) pane = layout.splitPane(pane, layout.autoDir(pane));
    if (!pane) return;
    layout.focusPane(pane);
    // A "+" menu shell row: {kind: "shell", shell: "<config value>"}.
    if (typeof system.shell === "string") {
      await spawnShellInto(pane, contextCwd(null), system.shell);
      return;
    }
    await spawnSpecInto(pane, {
      cmd: system.cmd,
      args: system.args || [],
      name: system.label,
      terminalType: system.id,
    });
  }

  // Installing a missing shell (PowerShell 7 through winget) runs in an
  // ordinary terminal, so the agreement prompt and the UAC request stay the
  // user's to answer. Once it exits the shells are scanned again, past the
  // server's cache, and the new one shows up in the menu.
  async function runInstaller(install) {
    if (!install.cmd) {
      return api.openTarget(install.url).catch(() => showError(`could not open ${install.url}`));
    }
    let pane = layout.focused || layout.init();
    if (!pane.canReplace) pane = layout.splitPane(pane, layout.autoDir(pane));
    if (!pane) return;
    layout.focusPane(pane);
    pane.onceExited(() => {
      refreshInventory({ fresh: true }).then((inventory) => {
        const ready = (inventory.types || []).some((type) =>
          type.id === install.id && type.executable && type.available !== false);
        if (ready) pane.flashNotice(`[${install.label} installed · it is in the new-terminal menu]`, 5000);
      }).catch(() => {});
    });
    await spawnSpecInto(pane, {
      cmd: install.cmd,
      args: install.args || [],
      name: `Install ${install.label}`,
    });
  }

  // Elevation opens a separate Administrator window, so nothing in this window
  // changes on success and every failure mode (non-Windows, unknown profile,
  // declined UAC) used to land in an empty catch. Always say what happened.
  function elevate(spec, label) {
    const notify = (text) => {
      if (layout.focused) layout.focused.flashNotice(`[${text}]`);
      else showError(text);
    };
    return api.elevateTerminal(spec).then(
      () => { notify(`administrator terminal opening · ${label}`); return true; },
      (error) => {
        showError(error?.detail || `could not start an administrator terminal (${label})`);
        return false;
      },
    );
  }

  function elevateProfile(profile) {
    return elevate(
      { profile: profile.name, workspace: spawnWorkspaceTag() },
      profile.name,
    );
  }

  function elevateSystemTerminal(system) {
    if (typeof system.shell === "string") {
      return elevate({
        shell: system.shell, cwd: contextCwd(null) || undefined, workspace: spawnWorkspaceTag(),
      }, system.label || shellValueLabel(system.shell));
    }
    return elevate({
      cmd: system.cmd,
      args: system.args || [],
      name: system.label,
      cwd: contextCwd(null) || undefined,
      workspace: spawnWorkspaceTag(),
    }, system.label);
  }

  function attachSession(info) {
    // Session cards can become stale between a dashboard refresh and a click.
    // Never create a pane for an API record already known to have exited.
    if (!info || !info.id || info.alive === false) {
      refreshStatusSoon();
      return false;
    }
    const targetOwner = state.currentWorkspace || null;
    if (info.workspace && info.workspace !== targetOwner) {
      showError(`That terminal belongs to workspace "${info.workspace}". Use "Move here & attach".`);
      return false;
    }
    let pane = layout.focused || layout.init();
    if (!pane.canReplace) pane = layout.splitPane(pane, layout.autoDir(pane));
    if (!pane) return;
    layout.focusPane(pane);
    pane.terminalType = info.profile ? profileTerminalType(info.profile) : pane.terminalType;
    // An attached terminal was started elsewhere; whatever launch this pane
    // held before is not how it was started. Only its profile, if it has one,
    // says how to start it again; a restart must never fall back to the
    // sidebar's current choice.
    pane.profileName = info.profile || null;
    pane.launchSpec = null;
    pane.launchOptions = null;
    pane.restartWith = null;
    pane.attach(info);
    ownSession(info.id);
    scheduleWorkspaceSave();
    refreshStatusSoon();
    return true;
  }

  // No options: spawnInto repeats the pane's own launch options.
  async function restartSavedPane(pane) {
    // A Start with item started in this session repeats itself in full.
    if (typeof pane.restartWith === "function") return pane.restartWith();
    if (pane.profileName) return spawnInto(pane, pane.profileName, pane.cwd);
    if (pane.launchSpec) return spawnSpecInto(pane, pane.launchSpec);
    return spawnDefaultInto(pane, pane.cwd);
  }

  async function resumeClaudePane(pane, mode = "continue") {
    const profile = claudeProfileForPane(allProfiles(), pane);
    if (!profile) return null;
    // Explicit recovery only: continue the latest project conversation or let
    // the agent present its own native picker. Neither path impersonates the
    // old PTY. Both agent types accept "continue" and "resume".
    return spawnInto(pane, profile.name, pane.cwd, { agentMode: mode });
  }

  return {
    allProfiles,
    spawnShellInto,
    contextCwd,
    profileByName,
    profileTerminalType,
    spawnWorkspaceTag,
    spawnInto,
    spawnSpecInto,
    spawnDefaultInto,
    spawnSplitInto,
    runProfile,
    runAgentMode,
    resumeAgentSession,
    agentSessionFolder,
    splitAgentView,
    runClaudeMode: runAgentMode,
    splitClaudeAgentView: splitAgentView,
    runSystemTerminal,
    runInstaller,
    elevateProfile,
    elevateSystemTerminal,
    attachSession,
    restartSavedPane,
    resumeClaudePane,
  };
}
