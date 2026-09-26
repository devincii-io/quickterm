// Starting terminals: which shell a new pane gets, which folder it starts in,
// and every way a pane is filled (run, split, restart, resume, attach,
// elevate). The spec helpers at the top are pure and tested in node.

import { SCRATCH_WS } from "./boot_context.js";
import { launchOptions, repeatLaunchOptions } from "./launch_options.js";
import { normalClaudeSplitMode, splitDirectory } from "./split_policy.js";

// With no personal profiles, fall back to the first available system shell.
export function defaultSystemSpec(terminalInventory) {
  const types = (terminalInventory && terminalInventory.types) || [];
  const usable = types.find((type) => type.executable && type.available !== false
    && !["custom", "claude-code", "ssh", "sftp"].includes(type.id));
  if (!usable) return null;
  const args = usable.id === "powershell-core" || usable.id === "windows-powershell"
    ? ["-NoLogo"]
    : usable.id === "wsl" ? ["--cd", "~"] : [];
  return { cmd: usable.executable, args, name: usable.label, terminalType: usable.id };
}

export function serializableSpec(spec) {
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

export function commandTerminalType(spec) {
  if (spec.terminal_type || spec.terminalType) return spec.terminal_type || spec.terminalType;
  const command = String(spec.cmd || "").toLowerCase();
  if (/(^|[\\/])wsl(?:\.exe)?$/.test(command)) return "wsl";
  if (/(^|[\\/])psftp(?:\.exe)?$/.test(command)) return "sftp";
  if (/(^|[\\/])plink(?:\.exe)?$/.test(command)) return "ssh";
  return null;
}

export function claudeProfileForPane(profiles, pane) {
  const profile = profiles.find((item) => item.name === pane.profileName) || null;
  if (!profile) return null;
  if (profile.terminal_type === "claude-code") return profile;
  const hint = [profile.name, profile.cmd, profile.start_command, pane.title]
    .filter(Boolean).join(" ");
  const mentionsClaude = /\bclaude(?:\.cmd|\.exe)?\b/i.test(hint);
  const directClaude = /(^|[\\/])claude(?:\.cmd|\.exe)?$/i.test(profile.cmd || "");
  const resumableShell = [
    "powershell-core", "windows-powershell", "command-prompt", "wsl", "bash", "zsh", "fish",
  ].includes(profile.terminal_type);
  return mentionsClaude && (directClaude || resumableShell) ? profile : null;
}

export function createSpawner({
  api, state, layout, ownSession, scheduleWorkspaceSave, refreshStatusSoon, showError,
}) {
  // An empty default_profile is Settings' explicit "System default shell"
  // choice, not "unset". Falling through to profiles[0] made that option a
  // no-op and handed every new pane the first personal profile instead.
  function defaultProfile() {
    if (state.cfg.default_profile === "") return null;
    return state.profiles.find((profile) => profile.name === state.cfg.default_profile)
      || state.profiles[0]
      || null;
  }

  // Where a new terminal should start when the caller has no directory of its
  // own. Inside a named workspace the answer is "let the backend resolve the
  // workspace folder"; in scratch it is the disposable scratch folder; a
  // profile pinned to a fixed folder always keeps it.
  // Profiles carry no folder, so there is nothing here to defer to: an
  // explicit directory wins, scratch supplies its own throwaway root, and a
  // named workspace is resolved by the backend from its stored path.
  function contextCwd(explicit) {
    if (explicit) return explicit;
    if (!state.currentWorkspace || state.currentWorkspace === SCRATCH_WS) return state.scratchRoot || null;
    return null;
  }

  function profileByName(name) {
    return state.profiles.find((profile) => profile.name === name) || null;
  }

  function profileTerminalType(name) {
    return state.profiles.find((profile) => profile.name === name)?.terminal_type || null;
  }

  // Tag new sessions with their named workspace. Scratch remains untagged
  // because it is disposable and may be promoted under a different name.
  function spawnWorkspaceTag() {
    return state.currentWorkspace && state.currentWorkspace !== SCRATCH_WS ? state.currentWorkspace : undefined;
  }

  // `options` left out means "the way this pane was started": a workspace
  // restore and a restart call it like that and get the saved Claude mode,
  // start command or args back. A fresh launch passes its own, `{}` for none,
  // so a new terminal in a replaceable pane never inherits the old launch.
  async function spawnInto(pane, profileName, cwd, options) {
    const launch = repeatLaunchOptions(pane, profileName, options, profileTerminalType(profileName));
    if (!pane.beginSpawn()) return null;
    try {
      const info = await api.createSession({
        profile: profileName,
        cwd: cwd || undefined,
        workspace: spawnWorkspaceTag(),
        ...(launch.startCommand !== undefined ? { start_command: launch.startCommand } : {}),
        ...(launch.claudeMode !== undefined ? { claude_mode: launch.claudeMode } : {}),
        ...(launch.args !== undefined ? { args: launch.args } : {}),
      });
      pane.profileName = profileName;
      pane.terminalType = profileTerminalType(profileName);
      pane.launchSpec = null;
      pane.launchOptions = launchOptions(launch);
      // The backend resolves the workspace folder, so its answer, not the
      // hint we sent, is what this pane actually opened in.
      pane.setLaunchCwd(info.cwd || cwd || profileByName(profileName)?.cwd || null);
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
    if (!pane.beginSpawn()) return null;
    const launchSpec = serializableSpec(spec);
    try {
      // workspace tags the request only (not the persisted launchSpec).
      const info = await api.createSession({ ...launchSpec, workspace: spawnWorkspaceTag() });
      pane.profileName = null;
      pane.terminalType = commandTerminalType(launchSpec);
      pane.setLaunchCwd(info.cwd || launchSpec.cwd);
      pane.launchSpec = launchSpec;
      pane.launchOptions = null;
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

  function spawnDefaultInto(pane, cwdOverride) {
    if (state.selectedTerminal) {
      if (state.selectedTerminal.kind === "profile") {
        return spawnInto(pane, state.selectedTerminal.profile.name, contextCwd(cwdOverride), {});
      }
      return spawnSpecInto(pane, {
        cmd: state.selectedTerminal.cmd,
        args: state.selectedTerminal.args || [],
        cwd: contextCwd(cwdOverride),
        name: state.selectedTerminal.label,
        terminalType: state.selectedTerminal.id,
      });
    }
    const profile = defaultProfile();
    if (profile) return spawnInto(pane, profile.name, contextCwd(cwdOverride), {});
    const system = defaultSystemSpec(state.terminalInventory);
    if (system) return spawnSpecInto(pane, { ...system, cwd: contextCwd(cwdOverride) });
    pane.showNotice("[no shell found, add one in settings]");
    return Promise.resolve(null);
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
    if (state.selectedTerminal) {
      const cwd = splitCwd(source, state.selectedTerminal);
      if (state.selectedTerminal.kind === "profile") {
        const profile = state.selectedTerminal.profile;
        const claudeMode = normalClaudeSplitMode(profile);
        return spawnInto(pane, profile.name, contextCwd(cwd), { claudeMode });
      }
      return spawnSpecInto(pane, {
        cmd: state.selectedTerminal.cmd,
        args: state.selectedTerminal.args || [],
        cwd,
        name: state.selectedTerminal.label,
        terminalType: state.selectedTerminal.id,
      });
    }
    const profile = defaultProfile();
    if (profile) {
      const choice = { kind: "profile", profile };
      return spawnInto(pane, profile.name, contextCwd(splitCwd(source, choice)), {
        claudeMode: normalClaudeSplitMode(profile),
      });
    }
    const system = defaultSystemSpec(state.terminalInventory);
    if (!system) return spawnDefaultInto(pane);
    const choice = { kind: "system", id: system.terminalType, ...system };
    return spawnSpecInto(pane, { ...system, cwd: contextCwd(splitCwd(source, choice)) });
  }

  async function runProfile(profile) {
    let pane = layout.focused || layout.init();
    if (!pane.canReplace) pane = layout.splitPane(pane, layout.autoDir(pane));
    if (!pane) return;
    layout.focusPane(pane);
    await spawnInto(pane, profile.name, contextCwd(null), {});
  }

  async function runClaudeMode(profile, claudeMode) {
    let pane = layout.focused || layout.init();
    if (!pane.canReplace) pane = layout.splitPane(pane, layout.autoDir(pane));
    if (!pane) return;
    layout.focusPane(pane);
    await spawnInto(pane, profile.name, contextCwd(null), { claudeMode });
  }

  async function splitClaudeAgentView(profile) {
    const source = layout.focused || layout.init();
    const pane = layout.splitPane(source, layout.autoDir(source));
    if (!pane) return null;
    layout.focusPane(pane);
    return spawnInto(pane, profile.name, contextCwd(null), { claudeMode: "agents" });
  }

  async function runSystemTerminal(system) {
    let pane = layout.focused || layout.init();
    if (!pane.canReplace) pane = layout.splitPane(pane, layout.autoDir(pane));
    if (!pane) return;
    layout.focusPane(pane);
    await spawnSpecInto(pane, {
      cmd: system.cmd,
      args: system.args || [],
      name: system.label,
      terminalType: system.id,
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
    pane.attach(info);
    ownSession(info.id);
    scheduleWorkspaceSave();
    refreshStatusSoon();
    return true;
  }

  // No options: spawnInto repeats the pane's own launch options.
  async function restartSavedPane(pane) {
    if (pane.profileName) return spawnInto(pane, pane.profileName, pane.cwd);
    if (pane.launchSpec) return spawnSpecInto(pane, pane.launchSpec);
    return spawnDefaultInto(pane, pane.cwd);
  }

  async function resumeClaudePane(pane, mode = "continue") {
    const profile = claudeProfileForPane(state.profiles, pane);
    if (!profile) return null;
    // Explicit recovery only: continue the latest project conversation or let
    // Claude present its own native picker. Neither path impersonates the old PTY.
    if (profile.terminal_type === "claude-code") {
      return spawnInto(pane, profile.name, pane.cwd, { claudeMode: mode });
    }
    const flag = mode === "resume" ? "--resume" : "--continue";
    const directClaude = /(^|[\\/])claude(?:\.cmd|\.exe)?$/i.test(profile.cmd || "");
    if (directClaude) {
      return spawnInto(pane, profile.name, pane.cwd, {
        args: [...(profile.args || []), flag],
      });
    }
    return spawnInto(pane, profile.name, pane.cwd, { startCommand: `claude ${flag}` });
  }

  return {
    defaultProfile,
    contextCwd,
    profileByName,
    profileTerminalType,
    spawnWorkspaceTag,
    spawnInto,
    spawnSpecInto,
    spawnDefaultInto,
    spawnSplitInto,
    runProfile,
    runClaudeMode,
    splitClaudeAgentView,
    runSystemTerminal,
    elevateProfile,
    elevateSystemTerminal,
    attachSession,
    restartSavedPane,
    resumeClaudePane,
  };
}
