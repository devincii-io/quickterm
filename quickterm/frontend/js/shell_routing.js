// Where a sidebar row's click and kill go. The shell owns no terminal, so
// every gesture on a row lands in the view that holds the terminal, or in the
// view that owns it, and only falls back to the shell when no view of this
// window has anything to do with it. The decisions are pure functions and
// the gestures take every dependency as an argument, so each branch is
// unit-tested without a browser.
//
// `attached` and `owned` map a session id to the workspace of the view that
// has a pane on it or claims it in memory; `openWorkspaces` lists the
// workspaces shown in this window.

import { isScratchWorkspace } from "./boot_context.js";

// The record attachSession is handed for a finished row. It refuses an
// exited record on purpose (a stale card must not open a dead pane), but a
// finished row is an explicit request to read one: the pane attaches, the
// server serves the ring replay-only, and that replay acknowledges it.
export function finishedAttachRecord(session) {
  const { alive: _alive, ...rest } = session || {};
  return rest;
}

// The workspace a session belongs to, as far as this window knows: a view
// holding it wins, then a view's in-memory claim, then the backend's tag.
export function sessionOwner(session, { attached = {}, owned = {} } = {}) {
  const id = session?.id;
  return attached[id] ?? owned[id] ?? session?.workspace ?? null;
}

// What a click on a row does:
//   focus             a view has a pane on it: focus that pane
//   attach            its workspace is open: attach it in that view
//   open-then-focus   its named workspace is closed: open the view, whose
//                     restore attaches it, then focus it there
//   adopt             nobody owns it: attach it into the active view
//   adopt-new-scratch nobody owns it and no view is open: open a scratch first
// A scratch owner whose view is closed has nothing to reopen (a scratch view
// is never restored), so its terminal is adopted like an unassigned one.
// `finished` asks for the replay-only attach of an exited row.
export function rowAction(session, { attached = {}, owned = {}, openWorkspaces = [], activeWorkspace = null } = {}) {
  const id = session?.id;
  const finished = session?.alive === false;
  if (attached[id]) return { kind: "focus", workspace: attached[id], finished };
  const owner = owned[id] ?? session?.workspace ?? null;
  if (owner && openWorkspaces.includes(owner)) return { kind: "attach", workspace: owner, finished };
  if (owner && !isScratchWorkspace(owner)) return { kind: "open-then-focus", workspace: owner, finished };
  if (activeWorkspace) return { kind: "adopt", workspace: activeWorkspace, finished };
  return { kind: "adopt-new-scratch", workspace: null, finished };
}

// Where a kill goes, so the view that holds or owns the terminal drops it
// from its own memory before its next autosave writes it back:
//   view-pane   a view has a pane on it
//   view-owner  its owning workspace is open in a view
//   shell       neither: the shell kills it and edits the saved workspaces
export function killRoute(session, { attached = {}, owned = {}, openWorkspaces = [] } = {}) {
  const id = session?.id;
  if (attached[id]) return { kind: "view-pane", workspace: attached[id] };
  const owner = owned[id] ?? session?.workspace ?? null;
  if (owner && openWorkspaces.includes(owner)) return { kind: "view-owner", workspace: owner };
  return { kind: "shell", workspace: owner };
}

// The row gestures on top of those decisions. `views` is the shell's
// WorkspaceViews; `context()` answers {attached, owned, openWorkspaces,
// activeWorkspace} for this moment. Kill and detach throw the api error
// unchanged ({status, detail}) on a real failure and resolve on a 404, so
// the sidebar's confirmation can show it and keep the row.
export function createTerminalRouting({
  api, views, context, removeSessionsFromSavedWorkspaces, markSeen = () => {}, refreshSoon = () => {},
  forgetSession = () => {}, publishKilled = () => {},
}) {
  // A view restored at boot, or opened a moment ago, may still be booting:
  // its app exists only once its document is ready, so every gesture waits
  // for that instead of finding no app and doing nothing.
  const readyApp = async (view) => {
    if (!view) return null;
    if (views.whenReady && !(await views.whenReady(view))) return null;
    return views.appFor(view);
  };
  const appOf = (workspace) => readyApp(views.viewForWorkspace(workspace));

  async function activeApp() {
    const view = views.active || await views.open(null);
    if (!view) return null;
    views.focusView(view);
    return readyApp(view);
  }

  async function activateTerminal(session) {
    if (!session?.id) return false;
    markSeen(session.id);
    const ctx = context();
    const route = rowAction(session, ctx);
    const record = route.finished ? finishedAttachRecord(session) : session;
    if (route.kind === "focus") return views.focusSession(session.id);
    if (route.kind === "attach") {
      views.focusWorkspace(route.workspace);
      return Boolean(await (await appOf(route.workspace))?.attachSession(record));
    }
    if (route.kind === "open-then-focus") {
      const view = await views.open(route.workspace);
      const app = view ? await readyApp(view) : null;
      if (!app) return false;
      // The restore attaches every terminal its layout holds; one the
      // workspace only owns is attached here.
      if ((app.attachedSessionIds?.() || []).includes(session.id)) return views.focusSession(session.id);
      return Boolean(await app.attachSession(record));
    }
    const app = await activeApp();
    if (!app) return false;
    // A terminal a closed scratch view still owns is taken out of that
    // view's saved file first, or its workspace tag refuses the attach.
    const owner = sessionOwner(session, ctx);
    if (owner && !route.finished) return Boolean(await app.moveSessionHere(session, owner));
    return Boolean(await app.attachSession(record));
  }

  async function killTerminal(session) {
    if (!session?.id) return false;
    const route = killRoute(session, context());
    const app = route.kind === "shell" ? null : await appOf(route.workspace);
    if (app?.killSessionById) {
      await app.killSessionById(session.id);
    } else {
      try {
        await api.killSession(session.id);
      } catch (error) {
        if (error?.status !== 404) throw error;
      }
      await removeSessionsFromSavedWorkspaces(new Set([session.id]));
    }
    forgetSession(session.id);
    refreshSoon();
    return true;
  }

  // Kill-all belongs to the window, not to the view that happens to be
  // active. Only the ids the backend verified as stopped go anywhere: the
  // sidebar forgets their rows at once, every view of this window closes its
  // panes on them and drops them from its ownership (so no autosave writes
  // them back), and the saved workspaces no view shows are edited on disk.
  // A terminal that could not be stopped stays everywhere.
  // Verified kills leave every view of this window: each closes its panes on
  // them and forgets them, so no autosave writes them back. Also what another
  // native window's kill-all asks of this one (`publishKilled`).
  async function dropKilledEverywhere(killed) {
    for (const id of killed) forgetSession(id);
    await Promise.all((views.views?.() || []).map(async (view) => {
      try {
        await (await readyApp(view))?.dropKilledSessions?.(killed);
      } catch (_) {
        // A view closing meanwhile has nothing left to drop.
      }
    }));
  }

  async function killAllSessions() {
    const result = await api.killAllSessions();
    const killed = new Set(result?.killed_ids || []);
    if (killed.size) {
      // The other windows' views hold panes on these too.
      publishKilled([...killed]);
      await dropKilledEverywhere(killed);
      await removeSessionsFromSavedWorkspaces(killed);
    }
    refreshSoon();
    return { killed: result?.killed || 0, failed: (result?.failed_ids || []).length };
  }

  async function detachTerminal(session) {
    if (!session?.id) return false;
    const { attached = {} } = context();
    const app = attached[session.id] ? await appOf(attached[session.id]) : null;
    if (!app?.detachSessionById) return false;
    await app.detachSessionById(session.id);
    refreshSoon();
    return true;
  }

  // Into the active view: the view that has it lets go first (retain, close
  // its pane, forget it and save), then the active view takes it over.
  async function moveTerminalHere(session) {
    if (!session?.id) return false;
    const ctx = context();
    const from = sessionOwner(session, ctx);
    const target = views.active || await views.open(null);
    const targetApp = await readyApp(target);
    if (!targetApp) return false;
    const here = views.workspaceOf(target);
    if (from && from === here) return activateTerminal(session);
    const fromView = from ? views.viewForWorkspace(from) : null;
    if (fromView && fromView !== target) {
      await (await readyApp(fromView))?.detachSessionById(session.id, { forget: true });
    }
    views.focusView(target);
    const moved = await targetApp.moveSessionHere(session, fromView ? null : from);
    refreshSoon();
    return Boolean(moved);
  }

  return { activateTerminal, killTerminal, killAllSessions, dropKilledEverywhere, detachTerminal, moveTerminalHere };
}
