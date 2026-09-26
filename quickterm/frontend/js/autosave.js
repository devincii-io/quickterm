// The layout autosave: debounced on every pane change, one save in flight at
// a time, a failed save retried, and the sidebar's save dot kept in step. It
// never saves while a workspace switch is under way or the window is leaving.

export function createAutosave({ state, layout, workspace, ownedSessionIds, setWorkspaceSaveState }) {
  let workspaceSaveTimer = null;
  let workspaceRetryTimer = null;
  let workspaceStatusTimer = null;
  let workspaceSaveInFlight = false;
  let workspaceSavePending = false;

  async function persistCurrentWorkspace() {
    if (state.exiting || !state.currentWorkspace || state.transitioning || !layout.root) return true;
    clearTimeout(workspaceSaveTimer);
    clearTimeout(workspaceRetryTimer);
    workspaceRetryTimer = null;
    if (workspaceSaveInFlight) {
      workspaceSavePending = true;
      return true;
    }
    workspaceSaveInFlight = true;
    workspaceSavePending = false;
    const targetWorkspace = state.currentWorkspace;
    setWorkspaceSaveState("saving");
    let saved = false;
    try {
      await workspace.save(
        targetWorkspace,
        layout.serialize(),
        state.workspaceLogo,
        [...ownedSessionIds()],
        state.workspacePath,
      );
      saved = true;
      if (state.currentWorkspace === targetWorkspace) {
        setWorkspaceSaveState("saved");
        clearTimeout(workspaceStatusTimer);
        workspaceStatusTimer = setTimeout(() => setWorkspaceSaveState(""), 1400);
      }
    } catch (_) {
      if (state.currentWorkspace === targetWorkspace) {
        workspaceSavePending = true;
        setWorkspaceSaveState("save failed · retrying", "error");
        workspaceRetryTimer = setTimeout(() => {
          workspaceRetryTimer = null;
          persistCurrentWorkspace();
        }, 2000);
      }
    } finally {
      workspaceSaveInFlight = false;
      if (saved && workspaceSavePending && state.currentWorkspace === targetWorkspace) {
        setTimeout(() => persistCurrentWorkspace(), 0);
      }
    }
    return saved;
  }

  function scheduleWorkspaceSave() {
    if (state.exiting || !state.currentWorkspace || state.transitioning) return;
    clearTimeout(workspaceSaveTimer);
    clearTimeout(workspaceRetryTimer);
    workspaceRetryTimer = null;
    workspaceSavePending = true;
    workspaceSaveTimer = setTimeout(() => persistCurrentWorkspace(), 300);
  }

  function cancelWorkspaceSave() {
    clearTimeout(workspaceSaveTimer);
  }

  function cancelWorkspaceRetry() {
    clearTimeout(workspaceRetryTimer);
  }

  return { persistCurrentWorkspace, scheduleWorkspaceSave, cancelWorkspaceSave, cancelWorkspaceRetry };
}
