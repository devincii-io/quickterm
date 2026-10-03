// The palette's rows that come from the app's live state (workspaces, running
// terminals, settings, configs, agents), the prefix filter, and the fuzzy
// score. Pure: every builder reads a fake app object in node tests, and app
// members are called with optional chaining because the shell and the views
// fill the app object in from different modules.

import { AGENT_MODES, agentLabel, agentModeOf, agentTypeOf, modeLabel } from "./agent_profile.js";
import { isScratchWorkspace, workspaceLabel } from "./boot_context.js";

export function fuzzyScore(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  let last = -2;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      streak = i === last + 1 ? streak + 1 : 1;
      score += 1 + streak * 2;
      if (i === 0 || t[i - 1] === " " || t[i - 1] === ":") score += 3;
      last = i;
      qi++;
    }
  }
  return qi === q.length ? score : -1;
}

const PREFIXES = { ">": "action", "@": "place", "#": "setting", "!": "snippet" };

export const PREFIX_HINT = "> actions  @ workspaces, terminals  # settings  ! snippets";

// `>` actions, `@` workspaces and terminals, `#` settings and configs, `!`
// snippets. A prefix alone lists that kind.
export function parsePrefix(query) {
  const text = String(query || "").trimStart();
  const kind = PREFIXES[text[0]] || null;
  return { kind, text: (kind ? text.slice(1) : text).trim() };
}

const GROUP_BY_KIND = {
  workspace: "place", session: "place",
  setting: "setting", config: "setting",
  snippet: "snippet",
};

// Which prefix lists a row. A row may name its group outright; otherwise its
// kind decides, and everything that does something is an action.
export function rowGroup(item) {
  return item?.group || GROUP_BY_KIND[item?.kind] || "action";
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function viewName(view) {
  return typeof view === "string" ? view : view?.workspace ?? null;
}

// `names` are the saved workspaces (GET /api/workspaces), `details` their
// stored records by name, so a row can show its folder once that arrives.
export function workspaceRows(app, names = [], details = new Map()) {
  const open = list(app?.openWorkspaces?.());
  const openNames = new Set(open.map(viewName).filter(Boolean));
  const rows = [];
  for (const name of list(names)) {
    if (isScratchWorkspace(name)) continue;
    const saved = details.get(name);
    const folder = saved?.path
      ? (saved.path_exists === false ? `${saved.path} (missing)` : saved.path)
      : "";
    rows.push({
      kind: "workspace",
      label: `open workspace: ${name}`,
      hint: [openNames.has(name) ? "open" : "", folder].filter(Boolean).join(" · "),
      run: () => app?.openWorkspace?.(name),
    });
  }
  for (const view of open) {
    const name = viewName(view);
    if (!name) continue;
    const label = (typeof view === "object" && view.label) || workspaceLabel(name);
    rows.push({
      kind: "workspace",
      label: `close workspace view: ${label}`,
      hint: "saves it; its terminals keep running",
      run: () => app?.closeWorkspaceView?.(name),
    });
  }
  rows.push({
    kind: "workspace",
    label: "new scratch view",
    hint: "a disposable layout beside the others",
    run: () => app?.newScratchView?.(),
  });
  return rows;
}

function terminalName(entry) {
  return entry?.session?.name || entry?.session?.id || "terminal";
}

function terminalState(entry) {
  const session = entry?.session || {};
  if (session.attention) return "needs you";
  if (session.alive === false) return "finished";
  if (entry?.attachedIn) return "open";
  if (session.busy === true) return "busy";
  return "background";
}

function terminalPlace(entry) {
  if (entry?.label) return entry.label;
  return entry?.workspace ? workspaceLabel(entry.workspace) : "Unassigned";
}

// Every terminal the backend lists, across all views and workspaces.
export function terminalRows(app) {
  return list(app?.liveTerminals?.()).filter((entry) => entry?.session?.id).map((entry) => ({
    kind: "terminal",
    group: "place",
    label: `go to terminal: ${terminalName(entry)}`,
    hint: `${terminalPlace(entry)} · ${terminalState(entry)}`,
    search: `go to terminal: ${terminalName(entry)} ${terminalPlace(entry)}`,
    run: () => app?.activateTerminal?.(entry.session),
  }));
}

export function settingRows(app) {
  return list(app?.settingEntries?.()).filter((entry) => entry?.id && entry?.label).map((entry) => ({
    kind: "setting",
    label: `setting: ${entry.label}`,
    hint: entry.hint || entry.tab || "",
    search: [`setting: ${entry.label}`, entry.tab, entry.hint, ...list(entry.keywords)].filter(Boolean).join(" "),
    run: () => app?.openSetting?.(entry.id),
  }));
}

export function configRows(app) {
  const terminals = list(app?.profiles).map((profile) => ({
    kind: "config",
    label: `edit terminal: ${profile.name}`,
    hint: profile.description || profile.terminal_type || profile.cmd || "",
    run: () => app?.editTerminalConfig?.(profile.name),
  }));
  const snippets = list(app?.snippets).map((snippet) => ({
    kind: "config",
    label: `edit snippet: ${snippet.name}`,
    hint: snippet.description || "",
    run: () => app?.editSnippet?.(snippet.name),
  }));
  return [...terminals, ...snippets];
}

// One row per launch mode the agent type has, plus the split that opens its
// agent manager beside the focused pane. The profile's own mode leads, so
// typing its name and Enter does what the Open button does.
export function agentRows(profile, app) {
  const type = agentTypeOf(profile);
  if (!type) return [];
  const agent = agentLabel(type);
  const project = app?.workspacePath?.() || "workspace folder";
  const own = agentModeOf(profile);
  const modes = [...AGENT_MODES[type]].sort((a, b) => (b === own) - (a === own));
  return [
    ...modes.map((mode) => ({
      kind: "agent",
      label: `${agent} ${modeLabel(mode)}: ${profile.name}`,
      hint: project,
      run: () => (app?.runAgentMode ?? app?.runClaudeMode)?.(profile, mode),
    })),
    {
      kind: "agent",
      label: `split agent view: ${profile.name}`,
      hint: `${agent} agent manager beside this pane`,
      run: () => (app?.splitAgentView ?? app?.splitClaudeAgentView)?.(profile),
    },
  ];
}

// "resume Claude session: <title>" rows from GET /api/agent-sessions.
export function agentSessionRows(profile, sessions, app) {
  const type = agentTypeOf(profile);
  if (!type) return [];
  const agent = agentLabel(type);
  return list(sessions).filter((session) => session?.id).map((session) => ({
    kind: "agent",
    label: `resume ${agent} session: ${session.title || session.id}`,
    hint: [profile.name, session.updated_at ? String(session.updated_at).slice(0, 16).replace("T", " ") : ""]
      .filter(Boolean).join(" · "),
    run: () => app?.resumeAgentSession?.(profile, session.id),
  }));
}

// The kill sub-mode's list. The palette adds what choosing a row does: a
// confirmation, never the kill itself.
export function killRows(app) {
  return list(app?.liveTerminals?.())
    .filter((entry) => entry?.session?.id && entry.session.alive !== false)
    .map((entry) => ({
      kind: "kill",
      label: `kill ${terminalName(entry)}…`,
      hint: `${terminalPlace(entry)} · ${terminalState(entry)}`,
      terminal: entry,
    }));
}

export function killName(entry) {
  return terminalName(entry);
}
