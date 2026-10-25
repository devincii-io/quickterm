// The workspace board without a DOM: which column each saved workspace sits
// in, what its card says, and what the search keeps. panel_dashboard.js draws
// it and patches it every refresh.
//
// The column is derived, never set (CONTRACTS 4.5 wave 2): GET /api/board
// names each workspace's status and the reason for it. A workspace the
// answer does not name (just created, or the board could not be read) is
// Idle until the next poll says otherwise.

import { isScratchWorkspace, workspaceLabel } from "./boot_context.js";
import {
  activitySeconds, attentionText, byText, folderName, relativeTime, runningSubagents, sessionState, subagentLabel,
} from "./sidebar_model.js";

export const BOARD_COLUMNS = Object.freeze([
  Object.freeze({ id: "needs-you", label: "Needs you", meaning: "An agent asks, or a terminal rang" }),
  Object.freeze({ id: "working", label: "Working", meaning: "An agent is busy" }),
  Object.freeze({ id: "in-review", label: "In review", meaning: "The branch has an open pull request" }),
  Object.freeze({ id: "changes", label: "Changes", meaning: "Uncommitted or unpushed work" }),
  Object.freeze({ id: "done", label: "Done", meaning: "The pull request was merged" }),
  Object.freeze({ id: "idle", label: "Idle", meaning: "Nothing running, nothing to ship" }),
]);
export const BOARD_STATUSES = BOARD_COLUMNS.map((column) => column.id);
export const DEFAULT_STATUS = "idle";

const AGENT_GLYPHS = { claude: "✳", codex: "◎" };

// `board` is the answer's `workspaces` object.
export function statusOf(name, board) {
  const value = board?.[name]?.status;
  return BOARD_STATUSES.includes(value) ? value : DEFAULT_STATUS;
}

export function reasonOf(name, board) {
  const value = board?.[name]?.reason;
  return typeof value === "string" ? value.trim() : "";
}

export function columnLabel(status) {
  return BOARD_COLUMNS.find((column) => column.id === status)?.label || "Idle";
}

// The repository a card names: the workspace folder. Nothing outside a
// repository.
export function repoName(git, path) {
  if (!git) return "";
  return folderName(path);
}

export function branchName(git) {
  if (!git) return "";
  return git.branch || (git.head ? `@${git.head}` : "");
}

// One line per live terminal: its state dot, the agent's mark, its name and
// how long ago it last did anything; an agent's running subagents hang under
// it as in the sidebar.
export function cardLines(sessions = [], attached = {}) {
  return (sessions || [])
    .filter((session) => session?.id && session.alive !== false)
    .map((session) => {
      const kind = session.agent?.kind || null;
      return {
        id: session.id,
        state: sessionState(session, Boolean(attached?.[session.id])).key,
        glyph: AGENT_GLYPHS[kind] || "",
        label: session.name || String(session.id).slice(0, 8),
        age: relativeTime(activitySeconds(session)),
        subagents: runningSubagents(session.agent).map((sub) => ({ id: String(sub.id), label: subagentLabel(sub) })),
      };
    })
    .sort((a, b) => byText(a.label, b.label) || byText(a.id, b.id));
}

// `workspaces`: [{name, path, git, host}]; `owners`: session id -> workspace
// name; `board`: GET /api/board's `workspaces`. Scratch is disposable and
// never a card.
export function boardCards(workspaces = [], { sessions = [], owners = {}, attached = {}, board = {} } = {}) {
  const bySpace = new Map();
  for (const session of sessions || []) {
    const owner = owners?.[session?.id] ?? session?.workspace ?? null;
    if (!owner) continue;
    if (!bySpace.has(owner)) bySpace.set(owner, []);
    bySpace.get(owner).push(session);
  }
  return (workspaces || [])
    .filter((entry) => entry?.name && !isScratchWorkspace(entry.name))
    .map(({ name, path = null, git = null, host = null }) => {
      // The board's own git facts name a branch the folder scan may not
      // have yet (a remote workspace before its first check).
      const boardGit = board?.[name]?.git || null;
      return {
        name,
        path,
        host: host || null,
        status: statusOf(name, board),
        reason: reasonOf(name, board),
        repo: repoName(git || boardGit, path),
        branch: branchName(git) || branchName(boardGit),
        worktree: git?.worktree ? (git.main_path ? `worktree of ${git.main_path}` : "a git worktree") : null,
        lines: cardLines(bySpace.get(name), attached),
      };
    })
    .sort((a, b) => byText(a.name, b.name));
}

// Every word of the query must appear in the name, the repo, the branch or
// the reason.
export function matchesSearch(card, query) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [card?.name, card?.repo, card?.branch, card?.reason].filter(Boolean).join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

// The six columns in the contract's order, cards by name inside each, so a
// card only moves when its status does.
export function boardColumns(cards = [], query = "") {
  const shown = (cards || []).filter((card) => matchesSearch(card, query));
  return BOARD_COLUMNS.map(({ id, label, meaning }) => {
    const inColumn = shown.filter((card) => (BOARD_STATUSES.includes(card.status) ? card.status : DEFAULT_STATUS) === id);
    return { id, label, meaning, cards: inColumn, count: inColumn.length };
  });
}

// ---------- the Agents tab ----------
//
// One card per agent session, in the column the backend's `agent.board`
// names (CONTRACTS 4.3, round 2). The columns are where the agents are, not
// a status anyone sets, so there is no drag here.

export const AGENT_COLUMNS = Object.freeze([
  Object.freeze({ id: "needs-you", label: "Needs you" }),
  Object.freeze({ id: "working", label: "Working" }),
  Object.freeze({ id: "done", label: "Done" }),
  Object.freeze({ id: "idle", label: "Idle" }),
]);
const AGENT_COLUMN_IDS = AGENT_COLUMNS.map((column) => column.id);
// The backend's rule, for a payload without `board`: quiet this long is idle.
export const AGENT_IDLE_AFTER_S = 30 * 60;
const AGENT_LABELS = { claude: "Claude Code", codex: "Codex" };

function eventAge(agent) {
  for (const value of [agent?.event_age_seconds, agent?.age_seconds]) {
    const seconds = Number(value);
    if (value != null && Number.isFinite(seconds)) return Math.max(0, seconds);
  }
  return null;
}

// Which column a session's agent sits in; null for a terminal without one.
// A terminal that rang or asked through its own output needs you too.
export function agentColumn(session) {
  const agent = session?.agent;
  if (!agent || session.alive === false) return null;
  if (session.attention) return "needs-you";
  if (AGENT_COLUMN_IDS.includes(agent.board)) return agent.board;
  const subs = Array.isArray(agent.subagents) ? agent.subagents : [];
  if (agent.state === "waiting" || subs.some((sub) => sub?.waiting)) return "needs-you";
  const age = eventAge(agent);
  if (age != null && age >= AGENT_IDLE_AFTER_S) return "idle";
  if (agent.state === "working") return "working";
  if (agent.state === "done" || agent.state === "failed") return "done";
  return "idle";
}

// The quiet line a card shows where the answer would be, while there is none.
function agentNote(session, column) {
  const agent = session.agent;
  if (column === "needs-you") {
    if (agent.state !== "waiting" && (agent.subagents || []).some((sub) => sub?.waiting)) {
      return "a subagent asks for permission";
    }
    return session.attention ? attentionText(session.attention) : "waiting for you";
  }
  if (agent.state === "working") return agent.tool ? `running ${agent.tool}` : "working";
  if (agent.state === "failed") return "failed";
  return "";
}

// `workspaces`: [{name, path, git}] for the branch; `owners`: session id ->
// workspace name, the sidebar's answer.
export function agentCards(sessions = [], { workspaces = [], owners = {} } = {}) {
  const gitOf = new Map((workspaces || []).map((entry) => [entry?.name, entry?.git || null]));
  return (sessions || [])
    .filter((session) => session?.id && agentColumn(session))
    .map((session) => {
      const agent = session.agent;
      const column = agentColumn(session);
      const owner = owners?.[session.id] ?? session.workspace ?? null;
      const age = eventAge(agent);
      return {
        id: session.id,
        session,
        column,
        state: agent.state,
        dot: sessionState(session, false).key,
        glyph: AGENT_GLYPHS[agent.kind] || "",
        agent: AGENT_LABELS[agent.kind] || "Agent",
        label: session.name || AGENT_LABELS[agent.kind] || String(session.id).slice(0, 8),
        prompt: agent.last_prompt || agent.prompt || "",
        answer: agent.last_answer || agent.message || "",
        note: agentNote(session, column),
        workspace: owner ? workspaceLabel(owner) : "",
        branch: owner ? branchName(gitOf.get(owner)) : "",
        age: relativeTime(age),
        ageSeconds: age ?? Number.POSITIVE_INFINITY,
        subagents: runningSubagents(agent).map((sub) => ({
          id: String(sub.id), label: subagentLabel(sub), waiting: Boolean(sub.waiting),
        })),
      };
    })
    // The latest event first; the name keeps equal ages still.
    .sort((a, b) => a.ageSeconds - b.ageSeconds || byText(a.label, b.label) || byText(a.id, b.id));
}

// Every word of the query must appear somewhere on the card.
export function matchesAgentSearch(card, query) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [
    card?.label, card?.agent, card?.prompt, card?.answer, card?.note, card?.workspace, card?.branch,
    ...(card?.subagents || []).map((sub) => sub.label),
  ].filter(Boolean).join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

// The four columns with their cards. Idle is counted while hidden, so the
// toggle can say how many it would show.
export function agentColumns(cards = [], query = "", { showIdle = false } = {}) {
  const shown = (cards || []).filter((card) => matchesAgentSearch(card, query));
  return AGENT_COLUMNS.map(({ id, label }) => {
    const inColumn = shown.filter((card) => card.column === id);
    return { id, label, cards: inColumn, count: inColumn.length, hidden: id === "idle" && !showIdle };
  });
}

// "3 subagents" for the folded line; "" when there are none.
export function subagentSummary(subagents = []) {
  const count = (subagents || []).length;
  if (!count) return "";
  const waiting = subagents.filter((sub) => sub.waiting).length;
  const base = `${count} subagent${count === 1 ? "" : "s"}`;
  return waiting ? `${base}, ${waiting} waiting` : base;
}
