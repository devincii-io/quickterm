// The palette's rows that come from the app's live state (workspaces, running
// terminals, settings, configs, agents), the prefix filter, and the fuzzy
// score. Pure: every builder reads a fake app object in node tests, and app
// members are called with optional chaining because the shell and the views
// fill the app object in from different modules.

import { AGENT_MODES, agentLabel, agentModeOf, agentTypeOf, modeLabel } from "./agent_profile.js";
import { isScratchWorkspace, workspaceLabel } from "./boot_context.js";
import { configuredShell, resumeCommand } from "./resume_command.js";

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

// SETTINGS_INDEX and Panels.settingEntries() write keywords as one
// space-separated string; an array is accepted too.
function keywordList(value) {
  return Array.isArray(value) ? value : String(value || "").split(/\s+/).filter(Boolean);
}

function viewName(view) {
  return typeof view === "string" ? view : view?.workspace ?? null;
}

// `names` are the saved workspaces (GET /api/workspaces), `details` their
// stored records by name, so a row can show its folder once that arrives.
export function workspaceRows(app, names = [], details = new Map()) {
  const open = list(app?.openWorkspaces?.());
  const openNames = new Set(open.map(viewName).filter(Boolean));
  const shownName = viewName(open.find((view) => view?.active)) || null;
  const rows = [];
  // Same order as the sidebar: by name, ignoring case, numbers as numbers.
  const sorted = [...list(names)].sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true }));
  for (const name of sorted) {
    if (isScratchWorkspace(name)) continue;
    const saved = details.get(name);
    const folder = saved?.path
      ? (saved.path_exists === false ? `${saved.path} (missing)` : saved.path)
      : "";
    rows.push({
      kind: "workspace",
      label: `open workspace: ${name}`,
      hint: [name === shownName ? "shown" : openNames.has(name) ? "open" : "", folder].filter(Boolean).join(" · "),
      run: () => app?.openWorkspace?.(name),
    });
  }
  for (const view of open) {
    const name = viewName(view);
    if (!name) continue;
    const label = (typeof view === "object" && view.label) || workspaceLabel(name);
    rows.push({
      kind: "workspace",
      label: `close workspace: ${label}`,
      hint: "saves it; its terminals keep running",
      run: () => app?.closeWorkspaceView?.(name),
    });
  }
  // The stage shows one workspace; these walk the open ones in sidebar order.
  if (open.length > 1) {
    rows.push(
      { kind: "workspace", label: "next workspace", hint: "the next open one in the sidebar · Alt+PgDn", run: () => app?.cycleWorkspace?.(1) },
      { kind: "workspace", label: "previous workspace", hint: "the previous open one in the sidebar · Alt+PgUp", run: () => app?.cycleWorkspace?.(-1) },
    );
  }
  rows.push({
    kind: "workspace",
    label: "open scratch",
    hint: "this window's disposable workspace",
    run: () => app?.newScratchView?.(),
  });
  return rows;
}

function terminalName(entry) {
  return entry?.session?.name || entry?.session?.id || "terminal";
}

function agentStateOf(entry) {
  return entry?.session?.agent?.state || null;
}

function terminalState(entry) {
  const session = entry?.session || {};
  const agent = agentStateOf(entry);
  if (session.attention || agent === "waiting") return "needs you";
  if (session.alive === false) return "finished";
  if (agent === "done" || agent === "failed" || agent === "working") return agent;
  if (entry?.attachedIn) return "open";
  if (session.busy === true && !session.agent) return "busy";
  return "background";
}

// The `@` list puts what wants you first: waiting or ringing terminals, then
// finished agent turns, then working ones, then everything else in its usual
// order. The sidebar's order never changes; only this list ranks.
export function placeRank(item) {
  const entry = item?.terminal;
  if (!entry) return 3;
  const state = terminalState(entry);
  if (state === "needs you") return 0;
  if (state === "done" || state === "failed") return 1;
  if (state === "working" || state === "busy") return 2;
  return 3;
}

// Sort scored rows `{item, i, score}`. With nothing typed the rank leads; once
// something is typed the match leads and the rank breaks ties.
export function placeOrder(query) {
  return (x, y) => (query ? y.score - x.score : 0)
    || placeRank(x.item) - placeRank(y.item)
    || y.score - x.score
    || x.i - y.i;
}

function terminalPlace(entry) {
  if (entry?.label) return entry.label;
  return entry?.workspace ? workspaceLabel(entry.workspace) : "Unassigned";
}

function idTail(entry) {
  return String(entry?.session?.id || "").slice(-6);
}

// Rows that would read the same (two cmd terminals in alpha) get the id's
// tail in the hint, so the list never shows two identical lines.
function disambiguate(rows) {
  const seen = new Map();
  for (const row of rows) {
    const key = `${row.label}\u0000${row.hint}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  return rows.map((row) => (seen.get(`${row.label}\u0000${row.hint}`) > 1
    ? { ...row, hint: `${row.hint} · ${idTail(row.terminal)}` }
    : row));
}

// The text a terminal row matches: its name, where it is, its state and its
// id, so typing a workspace name or an id finds it, not only the name.
function terminalSearch(label, entry) {
  return [label, terminalPlace(entry), terminalState(entry), entry?.session?.id].filter(Boolean).join(" ");
}

// Every terminal the backend lists, across all views and workspaces.
export function terminalRows(app) {
  return disambiguate(list(app?.liveTerminals?.()).filter((entry) => entry?.session?.id).map((entry) => ({
    kind: "terminal",
    group: "place",
    label: `go to terminal: ${terminalName(entry)}`,
    hint: `${terminalPlace(entry)} · ${terminalState(entry)}`,
    search: terminalSearch(`go to terminal: ${terminalName(entry)}`, entry),
    terminal: entry,
    run: () => app?.activateTerminal?.(entry.session),
  })));
}

export function settingRows(app) {
  return list(app?.settingEntries?.()).filter((entry) => entry?.id && entry?.label).map((entry) => ({
    kind: "setting",
    label: `setting: ${entry.label}`,
    hint: entry.hint || entry.tab || "",
    search: [`setting: ${entry.label}`, entry.tab, entry.hint, ...keywordList(entry.keywords)].filter(Boolean).join(" "),
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

// The "+" menu's entries as palette rows (CONTRACTS 4.3): every shell, then
// Claude Code and Codex with their modes. Saved profiles have their own
// "open terminal" rows, and Terminal settings is the "terminals and
// connections" action, so neither repeats here.
export function newTerminalRows(app) {
  const rows = [];
  for (const row of app?.newTerminalMenu?.() || []) {
    if (row.kind === "remote-shell") {
      rows.push({ kind: "terminal", label: `new terminal: ${row.label}`, hint: "Alt+N", run: () => app?.newTerminal?.() });
    } else if (row.kind === "shell") {
      rows.push({
        kind: "terminal",
        label: `new terminal: ${row.label}`,
        hint: row.isDefault ? "the default shell · Alt+N" : "shell",
        run: () => app?.runSystemTerminal?.({ kind: "shell", shell: row.value, label: row.label }),
      });
    } else if (row.kind === "agent") {
      rows.push({
        kind: "terminal",
        label: `new terminal: ${row.label}`,
        hint: "in the shell, from Settings > Agents",
        run: () => app?.runProfile?.(row.profile),
      });
      rows.push(...agentRows(row.profile, app));
    }
  }
  return rows;
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
  // The agents from Settings are one each, so their name adds nothing.
  const suffix = profile.builtin ? "" : `: ${profile.name}`;
  return [
    ...modes.map((mode) => ({
      kind: "agent",
      label: `${agent} ${modeLabel(mode)}${suffix}`,
      hint: project,
      run: () => (app?.runAgentMode ?? app?.runClaudeMode)?.(profile, mode),
    })),
    {
      kind: "agent",
      label: `split agent view${suffix || `: ${agent}`}`,
      hint: `${agent} agent manager beside this pane`,
      run: () => (app?.splitAgentView ?? app?.splitClaudeAgentView)?.(profile),
    },
  ];
}

// Which folder's agent conversations the resume rows list. A named workspace
// is asked for by name, so the backend resolves its folder exactly as a spawn
// does. A scratch view (or no view at all) has no saved folder worth naming,
// so it is asked for by the folder a resume would start in there: the view's
// own answer, else the scratch root. null when there is no folder at all.
export function agentSessionTarget(app) {
  const workspace = app?.currentWorkspace?.() || null;
  if (workspace && !isScratchWorkspace(workspace)) return { workspace };
  const cwd = app?.agentSessionFolder?.() || app?.scratchRoot?.() || null;
  return cwd ? { cwd } : null;
}

// "resume Claude session: <title>" rows from GET /api/agent-sessions.
// Shift+Enter (`secondary`) copies the command that resumes it instead, for
// a terminal somewhere else; `copy(text)` writes the clipboard.
export function agentSessionRows(profile, sessions, app, copy = null) {
  const type = agentTypeOf(profile);
  if (!type) return [];
  const agent = agentLabel(type);
  const shell = copy ? configuredShell(app) : null;
  return list(sessions).filter((session) => session?.id).map((session) => {
    const command = copy ? resumeCommand({ kind: type, id: session.id, folder: session.cwd, shell }) : null;
    return {
      kind: "agent",
      label: `resume ${agent} session: ${session.title || session.id}`,
      // The id's tail keeps two conversations with the same first prompt apart.
      hint: [
        profile.name,
        session.updated_at ? String(session.updated_at).slice(0, 16).replace("T", " ") : "",
        String(session.id).slice(-6),
        command && copy ? "Shift+Enter copies" : "",
      ].filter(Boolean).join(" · "),
      search: `resume ${agent} session: ${session.title || ""} ${session.id}`,
      run: () => app?.resumeAgentSession?.(profile, session.id),
      ...(command && copy ? { secondary: () => copy(command) } : {}),
    };
  });
}

// "copy resume command: <terminal>" for every running agent whose hooks
// named its conversation. Listed once something is typed, like the other
// rows nobody needs every day.
export function resumeCopyRows(app, copy) {
  const shell = configuredShell(app);
  return disambiguate(list(app?.liveTerminals?.())
    .filter((entry) => entry?.session?.agent?.conversation_id)
    .map((entry) => {
      const agent = entry.session.agent;
      const command = resumeCommand({ kind: agent.kind, id: agent.conversation_id, folder: agent.cwd, shell });
      return command && {
        kind: "action",
        quiet: true,
        label: `copy resume command: ${terminalName(entry)}`,
        hint: command,
        search: `copy resume command: ${terminalName(entry)} ${terminalPlace(entry)} ${agent.conversation_id}`,
        terminal: entry,
        run: () => copy(command),
      };
    })
    .filter(Boolean));
}

// The kill sub-mode's list. The palette adds what choosing a row does: a
// confirmation, never the kill itself.
export function killRows(app) {
  return disambiguate(list(app?.liveTerminals?.())
    .filter((entry) => entry?.session?.id && entry.session.alive !== false)
    .map((entry) => ({
      kind: "kill",
      label: `kill ${terminalName(entry)}…`,
      hint: `${terminalPlace(entry)} · ${terminalState(entry)}`,
      search: terminalSearch(`kill ${terminalName(entry)}…`, entry),
      terminal: entry,
    })));
}

export function killName(entry) {
  return terminalName(entry);
}
