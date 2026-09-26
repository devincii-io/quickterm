// Which terminals the current layout owns. A named (or adopted) workspace
// keeps its set in state.workspaceSessionIds; a never-adopted scratch keeps
// its own in state.scratchSessionIds, so leaving it knows what to clean up.

import { sessionIdsInLayout } from "./layout_sessions.js";

export function createSessionOwnership({ state, layout }) {
  function ownSession(id) {
    if (!id) return;
    if (state.currentWorkspace) state.workspaceSessionIds.add(id);
    else state.scratchSessionIds.add(id);
  }

  function forgetSession(id) {
    state.workspaceSessionIds.delete(id);
    state.scratchSessionIds.delete(id);
  }

  function ownedSessionIds() {
    const ids = new Set(state.currentWorkspace ? state.workspaceSessionIds : state.scratchSessionIds);
    sessionIdsInLayout(layout.serialize(), ids);
    return ids;
  }

  function attachedSessionIds() {
    return layout.panes()
      .filter((pane) => pane.session && pane.state === "attached")
      .map((pane) => pane.session.id);
  }

  return { ownSession, forgetSession, ownedSessionIds, attachedSessionIds };
}
