// Agent usage and resources: one quiet line at the bottom of the full
// sidebar, above the icons. QuickTerm has no status bar, so this is where
// the usage meter and resource view live: "✳ 32% · 4d" for Claude, "◎ 0%
// · 29d" for Codex, then the memory of every QuickTerm terminal. Each part
// opens a popover that follows the menu.js conventions (Escape and Tab close,
// a second press on the trigger closes, the keyboard is claimed in focus.js
// and handed back to the terminal).
//
// The model half (everything exported above `mountUsageFooter`) is pure and
// tested in tests/js/usage_footer.test.mjs.

import { authHeaders } from "./api.js";
import { claimFocus, releaseFocus } from "./focus.js";
import { closeMenu, menuPosition } from "./menu.js";
import { itemFor, patchList, setAttrs, setClass, setText } from "./render.js";

export const CLAUDE_GLYPH = "✳";
export const CODEX_GLYPH = "◎";
// The footer line: soon after boot, then once a minute while the sidebar is
// full and the window visible. Metrics cost a process walk per terminal, so
// only the open resources popover asks every 5 s.
export const FOOTER_REFRESH_MS = 60_000;
export const FOOTER_FIRST_MS = 1_500;
export const RESOURCES_REFRESH_MS = 5_000;

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

// "4d", "5h", "12m", "now": the largest whole unit left.
export function compactDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < MINUTE) return "now";
  if (seconds >= DAY) return `${Math.floor(seconds / DAY)}d`;
  if (seconds >= HOUR) return `${Math.floor(seconds / HOUR)}h`;
  return `${Math.floor(seconds / MINUTE)}m`;
}

// "4d 14h", "3h 20m", "12m", "now": two units for the popover.
export function longDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < MINUTE) return "now";
  const days = Math.floor(seconds / DAY);
  const hours = Math.floor((seconds % DAY) / HOUR);
  const minutes = Math.floor((seconds % HOUR) / MINUTE);
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

export function formatPercent(value) {
  return Number.isFinite(value) ? `${Math.round(Math.max(0, value))}%` : "";
}

// The window the footer names: the most used one; on a tie the first, which
// is the shorter window in both agents' order.
export function headlineWindow(windows) {
  let best = null;
  for (const window of windows || []) {
    if (!Number.isFinite(window?.used_percent)) continue;
    if (!best || window.used_percent > best.used_percent) best = window;
  }
  return best;
}

// "32% · 4d", or "32%" when the reset time is unknown. null without data.
export function agentSummary(entry, nowS) {
  const window = headlineWindow(entry?.windows);
  if (!window) return null;
  const percent = formatPercent(window.used_percent);
  if (!Number.isFinite(window.resets_at)) return percent;
  return `${percent} · ${compactDuration(window.resets_at - nowS)}`;
}

export function minutesLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const unit = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  if (minutes % 1440 === 0) return unit(minutes / 1440, "day");
  if (minutes % 60 === 0) return unit(minutes / 60, "hour");
  return unit(minutes, "minute");
}

const CLAUDE_WINDOW_LABELS = { five_hour: "5 hours", seven_day: "7 days" };

export function windowLabel(agent, window) {
  if (agent === "claude") return CLAUDE_WINDOW_LABELS[window.id] || window.id;
  return minutesLabel(window.window_minutes) || window.id;
}

export function resetsIn(resetsAt, nowS) {
  if (!Number.isFinite(resetsAt)) return null;
  const left = resetsAt - nowS;
  return left < MINUTE ? "resets now" : `resets in ${longDuration(left)}`;
}

export function updatedAgo(updatedAt, nowS) {
  if (!Number.isFinite(updatedAt)) return "";
  const age = nowS - updatedAt;
  return age < MINUTE ? "updated now" : `updated ${compactDuration(age)} ago`;
}

// "2.2 GB", "640 MB", "12 MB".
export function formatMemory(bytes) {
  if (!Number.isFinite(bytes)) return "";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.max(0, Math.round(mb))} MB`;
}

export function formatCpu(percent) {
  return Number.isFinite(percent) ? `${percent.toFixed(1)}%` : "-";
}

function measured(session) {
  const usage = session?.usage;
  return usage?.available && Number.isFinite(usage.working_set_bytes) ? usage : null;
}

// Memory and CPU summed over sessions; memory null when none was measured.
export function totals(sessions) {
  let memory = null;
  let cpu = null;
  for (const session of sessions || []) {
    const usage = measured(session);
    if (!usage) continue;
    memory = (memory || 0) + usage.working_set_bytes;
    if (Number.isFinite(usage.cpu_percent)) cpu = (cpu || 0) + usage.cpu_percent;
  }
  return { memory, cpu };
}

// The parts of the footer line, in order; empty means no line at all.
export function footerParts(usage, sessions, nowS) {
  const parts = [];
  const claude = agentSummary(usage?.claude, nowS);
  if (claude) parts.push({ kind: "claude", text: `${CLAUDE_GLYPH} ${claude}` });
  const codex = agentSummary(usage?.codex, nowS);
  if (codex) parts.push({ kind: "codex", text: `${CODEX_GLYPH} ${codex}` });
  const { memory } = totals(sessions);
  if (memory !== null) parts.push({ kind: "memory", text: formatMemory(memory) });
  return parts;
}

// The usage popover's rows: one block per agent that has data.
export function usageBlocks(usage, nowS) {
  const blocks = [];
  for (const [agent, title] of [["claude", "Claude Code"], ["codex", "Codex"]]) {
    const entry = usage?.[agent];
    const windows = (entry?.windows || []).filter((window) => Number.isFinite(window?.used_percent));
    if (!windows.length) continue;
    blocks.push({
      agent,
      title: agent === "codex" && entry.plan ? `${title} · ${entry.plan}` : title,
      updated: updatedAgo(entry.updated_at, nowS),
      windows: windows.map((window) => ({
        id: window.id,
        label: windowLabel(agent, window),
        percent: formatPercent(window.used_percent),
        fill: Math.min(100, Math.max(0, window.used_percent)),
        resets: resetsIn(window.resets_at, nowS) || "",
      })),
    });
  }
  return blocks;
}

// The resources popover: each open workspace, then its terminals, with the
// metrics of `sessions` (GET /api/sessions with metrics) joined by id.
export function resourceRows(groups, sessions) {
  const byId = new Map((sessions || []).map((session) => [session.id, session]));
  const rows = [];
  for (const group of groups || []) {
    if (!group.open) continue;
    const members = (group.sessions || []).map((entry) => entry.session || entry)
      .map((session) => byId.get(session.id) || session);
    const sum = totals(members);
    rows.push({ type: "group", key: `group:${group.key}`, label: group.label, memory: sum.memory, cpu: sum.cpu });
    for (const session of members) {
      const usage = measured(session);
      rows.push({
        type: "terminal",
        key: `session:${session.id}`,
        label: session.name || session.id,
        memory: usage ? usage.working_set_bytes : null,
        cpu: usage && Number.isFinite(usage.cpu_percent) ? usage.cpu_percent : null,
        session,
      });
    }
  }
  return rows;
}

// --- DOM ---------------------------------------------------------------------

function make(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

async function getJson(path) {
  const res = await fetch(path, { headers: { ...authHeaders() } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

const nowSeconds = () => Date.now() / 1000;

let openPopover = null;

// A popover under the menu.js rules, opened above the footer line.
function showPopover({ anchor, trigger, label, className, body, onClose }) {
  closeMenu("replaced");
  if (openPopover) openPopover.close("replaced");
  const root = make("div", `usage-popover ${className}`);
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", label);
  root.tabIndex = -1;
  root.append(body);
  let closed = false;

  const close = (reason = "close") => {
    if (closed) return;
    closed = true;
    if (openPopover?.root === root) openPopover = null;
    document.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("resize", onWindowChange);
    window.removeEventListener("blur", onWindowChange);
    const hadFocus = root.contains(document.activeElement);
    root.remove();
    releaseFocus("usage");
    trigger.setAttribute("aria-expanded", "false");
    onClose?.(reason, hadFocus);
  };
  const onOutside = (event) => {
    if (root.contains(event.target)) return;
    if (trigger.contains(event.target)) {
      // The click that follows would reopen it: the trigger checks this.
      trigger.dataset.toggledAt = String(Date.now());
      close("toggle");
      return;
    }
    close("outside");
  };
  const onWindowChange = () => close("blur");

  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      close("escape");
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const buttons = [...root.querySelectorAll("button")];
      if (!buttons.length) return;
      event.preventDefault();
      event.stopPropagation();
      const at = buttons.indexOf(document.activeElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = at < 0 ? (step > 0 ? 0 : buttons.length - 1) : (at + step + buttons.length) % buttons.length;
      buttons[next].focus();
    }
  });

  claimFocus("usage");
  root.style.visibility = "hidden";
  document.body.append(root);
  const place = () => {
    const anchorRect = anchor.getBoundingClientRect();
    const width = Math.max(240, Math.min(320, anchorRect.width));
    root.style.width = `${width}px`;
    const natural = root.getBoundingClientRect();
    const spot = menuPosition(anchorRect, { width, height: natural.height },
      { width: window.innerWidth, height: window.innerHeight });
    root.style.left = `${spot.left}px`;
    root.style.top = `${spot.top}px`;
    root.style.maxHeight = `${spot.maxHeight}px`;
    root.classList.toggle("above", spot.above);
  };
  place();
  root.style.visibility = "";
  trigger.setAttribute("aria-expanded", "true");
  document.addEventListener("pointerdown", onOutside, true);
  window.addEventListener("resize", onWindowChange);
  window.addEventListener("blur", onWindowChange);
  root.focus();
  openPopover = { root, close, place };
  return openPopover;
}

function justToggled(trigger) {
  const at = Number(trigger.dataset.toggledAt || 0);
  delete trigger.dataset.toggledAt;
  return Date.now() - at < 600;
}

function patchUsage(body, usage) {
  const blocks = usageBlocks(usage, nowSeconds());
  patchList(body, blocks.length ? blocks : [{ agent: "none" }], {
    key: (block) => block.agent,
    create: (block) => {
      const node = make("section", "usage-block");
      if (block.agent === "none") {
        node.append(make("p", "usage-empty", "No agent has reported its usage yet."));
        return node;
      }
      const head = make("div", "usage-block-head");
      head.append(make("span", "usage-block-title"), make("span", "usage-block-updated"));
      node.append(head, make("div", "usage-windows"));
      return node;
    },
    update: (node, block) => {
      if (block.agent === "none") return;
      setText(node.querySelector(".usage-block-title"), block.title);
      setText(node.querySelector(".usage-block-updated"), block.updated);
      patchList(node.querySelector(".usage-windows"), block.windows, {
        key: (window) => window.id,
        create: () => {
          const row = make("div", "usage-window");
          const line = make("div", "usage-window-line");
          line.append(make("span", "usage-window-label"), make("span", "usage-window-percent"));
          const bar = make("div", "usage-bar");
          bar.append(make("span", "usage-bar-fill"));
          row.append(line, bar, make("div", "usage-window-reset"));
          return row;
        },
        update: (row, window) => {
          setText(row.querySelector(".usage-window-label"), window.label);
          setText(row.querySelector(".usage-window-percent"), window.percent);
          row.querySelector(".usage-bar-fill").style.width = `${window.fill}%`;
          setClass(row, "high", window.fill >= 90);
          setText(row.querySelector(".usage-window-reset"), window.resets);
        },
      });
    },
  });
}

function patchResources(view, groups, sessions, activate) {
  const sum = totals(sessions);
  setText(view.total, sum.memory === null
    ? "No measurements yet"
    : `${formatMemory(sum.memory)} · ${formatCpu(sum.cpu)} CPU`);
  const rows = resourceRows(groups, sessions);
  view.empty.hidden = rows.length > 0;
  patchList(view.list, rows, {
    key: (row) => row.key,
    create: (row) => {
      const node = make(row.type === "group" ? "div" : "button", `usage-resource ${row.type}`);
      if (row.type === "terminal") {
        node.type = "button";
        node.addEventListener("click", () => {
          const current = itemFor(node);
          if (current?.session) activate(current.session);
        });
      }
      node.append(make("span", "usage-resource-name"), make("span", "usage-resource-memory"),
        make("span", "usage-resource-cpu"));
      return node;
    },
    update: (node, row) => {
      setText(node.querySelector(".usage-resource-name"), row.label);
      setText(node.querySelector(".usage-resource-memory"), formatMemory(row.memory) || "-");
      setText(node.querySelector(".usage-resource-cpu"), formatCpu(row.cpu));
      if (row.type === "terminal") setAttrs(node, { title: `Show ${row.label}` });
    },
  });
}

// Mounts the line into the sidebar `el` and keeps it current until `signal`
// aborts. `groups()` returns the sidebar's workspace groups (open ones carry
// `open: true`), `actions.activateTerminal(session)` shows and focuses a
// terminal, `mode()` is the sidebar mode, `handBack()` returns the keyboard to
// the terminal.
export function mountUsageFooter(el, { signal, groups = () => [], actions = {}, mode = () => "full", handBack = () => {} } = {}) {
  const activate = (session) => actions.activateTerminal?.(session);
  const line = make("div", "usage-footer");
  line.hidden = true;
  const agents = make("button", "usage-footer-part usage-footer-agents");
  const memory = make("button", "usage-footer-part usage-footer-memory");
  for (const button of [agents, memory]) {
    button.type = "button";
    button.hidden = true;
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
  }
  agents.title = "Agent usage limits";
  memory.title = "Memory and CPU of the terminals";
  line.append(agents, memory);
  el.append(line);

  let usage = null;
  let sessions = [];
  let popover = null;
  let resourceTimer = 0;

  const render = () => {
    const parts = footerParts(usage, sessions, nowSeconds());
    const agentText = parts.filter((part) => part.kind !== "memory").map((part) => part.text).join(" ");
    const memoryPart = parts.find((part) => part.kind === "memory");
    setText(agents, agentText);
    agents.hidden = !agentText;
    setText(memory, memoryPart ? memoryPart.text : "");
    memory.hidden = !memoryPart;
    line.hidden = parts.length === 0;
    setClass(line, "single", parts.length === 1);
  };

  const fetchUsage = () => getJson("/api/usage").then((next) => { usage = next; }).catch(() => {});
  const fetchSessions = () => getJson("/api/sessions").then((next) => {
    if (Array.isArray(next)) sessions = next;
  }).catch(() => {});

  const refresh = async () => {
    if (mode() !== "full") closePopover();
    if (document.hidden || mode() !== "full") return;
    await Promise.all([fetchUsage(), fetchSessions()]);
    render();
    popover?.update();
  };

  const closePopover = () => popover?.handle.close("close");

  const onPopoverClose = (reason, hadFocus) => {
    clearInterval(resourceTimer);
    resourceTimer = 0;
    popover = null;
    if (reason === "escape" && hadFocus) handBack();
  };

  const openUsage = () => {
    const body = make("div", "usage-popover-body");
    const handle = showPopover({
      anchor: line, trigger: agents, label: "Agent usage", className: "usage-limits", body,
      onClose: onPopoverClose,
    });
    popover = { handle, update: () => { patchUsage(body, usage); handle.place(); } };
    popover.update();
    fetchUsage().then(() => { if (popover?.handle === handle) { render(); popover.update(); } });
  };

  const openResources = () => {
    const body = make("div", "usage-popover-body");
    const total = make("div", "usage-resource-total");
    const head = make("div", "usage-resource head");
    head.append(make("span", "usage-resource-name", "Total"), total);
    const list = make("div", "usage-resource-list");
    const empty = make("p", "usage-empty", "No workspace is open.");
    body.append(head, list, empty);
    const view = { total, list, empty };
    const handle = showPopover({
      anchor: line, trigger: memory, label: "Terminal resources", className: "usage-resources", body,
      onClose: onPopoverClose,
    });
    const activateAndClose = (session) => {
      handle.close("run");
      activate(session);
    };
    popover = { handle, update: () => { patchResources(view, groups(), sessions, activateAndClose); handle.place(); } };
    popover.update();
    const poll = () => fetchSessions().then(() => {
      if (popover?.handle !== handle) return;
      render();
      popover.update();
    });
    poll();
    resourceTimer = setInterval(poll, RESOURCES_REFRESH_MS);
  };

  const wire = (button, open) => {
    button.addEventListener("click", () => {
      if (justToggled(button)) return;
      if (popover && button.getAttribute("aria-expanded") === "true") { closePopover(); return; }
      open();
    }, { signal });
  };
  wire(agents, openUsage);
  wire(memory, openResources);

  const first = setTimeout(refresh, FOOTER_FIRST_MS);
  const timer = setInterval(refresh, FOOTER_REFRESH_MS);
  const onVisible = () => { if (!document.hidden) refresh(); };
  document.addEventListener("visibilitychange", onVisible, { signal });
  signal?.addEventListener("abort", () => {
    clearTimeout(first);
    clearInterval(timer);
    closePopover();
    line.remove();
  });
  return { refresh, element: line };
}
