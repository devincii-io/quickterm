// Starting a workspace's "Start with" list in a view (CONTRACTS 4.5 wave 2):
// each item in its own pane, in order, the next one taking half of the last
// along its longer side (dwindle), as Alt+N places a pane. A view that opens
// with nothing to attach runs it in place of its one plain shell; "Run setup"
// runs it again next to what is open.

import { isAgentType } from "./agent_profile.js";
import { launchOptions } from "./launch_options.js";
import { plainShellType, serializableSpec } from "./spawner.js";
import { startupItems, startupKindLabel, startupRequest } from "./workspace_setup.js";

export function createStartupRunner({
  api, state, layout, ownSession, spawnWorkspaceTag, contextCwd, spawnDefaultInto,
  scheduleWorkspaceSave, refreshStatusSoon, showError,
}) {
  async function spawnItemInto(pane, item) {
    if (!pane.beginSpawn()) return null;
    const request = startupRequest(item, { workspace: spawnWorkspaceTag(), cwd: contextCwd(null) });
    const agent = isAgentType(item.kind);
    try {
      const info = await api.createSession(request);
      pane.profileName = agent ? item.kind : null;
      pane.terminalType = agent ? item.kind : plainShellType(state.workspaceHost, request.shell ?? state.cfg?.shell);
      // Saved with the layout: an agent's mode, a shell's own shell and
      // command. A restart in this session repeats the whole item, its
      // variables and agent options included.
      pane.launchSpec = !agent && (request.shell || request.command)
        ? serializableSpec({ shell: request.shell, command: request.command, name: request.name })
        : null;
      pane.launchOptions = agent ? launchOptions({ agentMode: request.agent_mode }) : null;
      pane.setLaunchCwd(info.cwd || request.cwd || null);
      pane.attach(info);
      pane.restartWith = () => spawnItemInto(pane, item);
      pane.spawnedFresh = true;
      ownSession(info.id);
      scheduleWorkspaceSave();
      refreshStatusSoon();
      return info;
    } catch (error) {
      pane.endSpawn();
      pane.showNotice(`[${error?.detail || `${startupKindLabel(item.kind)} did not start`}]`);
      return null;
    }
  }

  // `first` is the pane the first item goes into; without one the first item
  // takes the focused pane when it can be replaced, else half of it.
  async function runStartup(items, { first = null } = {}) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
      if (first) return Boolean(await spawnDefaultInto(first));
      return false;
    }
    let pane = first;
    if (!pane) {
      pane = layout.focused || layout.init();
      if (!pane.canReplace) pane = layout.splitPane(pane, layout.autoDir(pane));
    }
    let started = 0;
    for (const [index, item] of list.entries()) {
      if (index > 0) pane = layout.splitPane(pane, layout.autoDir(pane));
      if (!pane) {
        const left = list.length - index;
        showError(`No room for ${left} more setup terminal${left === 1 ? "" : "s"}. Make the window larger and run setup again.`);
        break;
      }
      layout.focusPane(pane);
      if (await spawnItemInto(pane, item)) started += 1;
    }
    return started > 0;
  }

  // "Run setup" for this view's workspace: the saved list, read fresh.
  async function runSetup() {
    const name = state.currentWorkspace;
    if (!name) {
      showError("Scratch has no setup. Open a workspace to run its setup.");
      return false;
    }
    let saved;
    try {
      saved = await api.getWorkspace(name);
    } catch (error) {
      showError(error?.detail || `Workspace "${name}" could not be read.`);
      return false;
    }
    const items = startupItems(saved?.startup);
    if (!items.length) {
      showError(`"${name}" starts with nothing yet. Add terminals under Start with in its Workspace settings.`);
      return false;
    }
    return runStartup(items);
  }

  return { runStartup, runSetup, spawnItemInto };
}
