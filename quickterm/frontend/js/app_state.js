// The state that the modules composed in main.js share. Anything a single
// module needs stays private to that module; this object holds only what
// several of them read or write, so one place shows what a workspace switch
// touches. Modules read it at call time (`state.currentWorkspace`), never
// copy a field, because most fields are replaced wholesale: a switch assigns
// a new workspaceSessionIds, a config save a new cfg.

export function createAppState({
  cfg, profiles, snippets, workspaceNames, terminalInventory, windowIsPrimary,
}) {
  return {
    // The config as last read, and the lists that come with it.
    cfg,
    profiles,
    snippets,
    workspaceNames,
    terminalInventory,

    // This window's identity in the registry, and the workspace it is allowed
    // to own (window_registry.js is the only writer).
    windowId: null,
    claimedWorkspace: null,
    registryAvailable: true,
    // Exactly one live window is primary, and the registry promotes the oldest
    // survivor when it closes, so this is read back from the registry rather than
    // trusted from the launch URL for the rest of the run.
    windowIsPrimary,

    // null is a never-adopted scratch layout; "scratch" is the adopted one.
    currentWorkspace: null,
    workspaceLogo: null,
    // A workspace is a folder: this is the root every session it owns starts in.
    // null means "no folder chosen": the backend falls back to the profile's own
    // directory and finally the home folder.
    workspacePath: null,
    workspacePathExists: true,
    // Scratch is disposable, so its terminals start in a disposable folder
    // instead of the user's home directory. Re-read whenever settings are saved,
    // because scratch_dir is configurable.
    scratchRoot: cfg.scratch_dir || null,
    // What this layout owns: a named workspace's terminals, and separately a
    // never-adopted scratch's, which are the ones leaving scratch cleans up.
    scratchSessionIds: new Set(),
    workspaceSessionIds: new Set(),
    // Every saved workspace's folder, so the sidebar can tell whether the
    // folder the focused terminal is in already belongs to a workspace. Filled
    // off the boot path and refreshed whenever the list or a folder changes.
    workspaceRoots: new Map(),

    // True while the layout is being replaced (boot's restore, a workspace
    // switch, a view closing): nothing autosaves, adopts scratch or opens a
    // folder handoff in between.
    transitioning: true,
    // The document is leaving; nothing autosaves after this.
    exiting: false,

    // Whatever the launcher's "New terminal" dropdown currently shows is what
    // splits and fresh panes open.
    selectedTerminal: null,
    // launcher.js's handle on the sidebar, replaced on every rebuild.
    launcherView: null,
  };
}
