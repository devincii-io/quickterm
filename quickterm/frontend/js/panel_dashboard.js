// The dashboard is built once and patched afterwards.
//
// It reloads itself every 5 s (panels.js owns the timer). It used to answer
// that by emptying the panel body and rebuilding every node, which made the
// panel unusable: a half-typed workspace name, an armed "Overwrite?", an open
// folder editor and the folder picker's own captured <input> were all thrown
// away mid-interaction. See render.js for the full story.
//
// So there are two phases, and they are strictly separated:
//
//   buildDashboard()  creates the skeleton and wires every event listener. It
//                     runs when the panel first shows the dashboard, and again
//                     only if another view has taken over the panel body.
//   applyDashboard()  writes fresh data into that skeleton. It runs on every
//                     refresh and must never replace a node the user can be
//                     inside.
//
// Because listeners are wired once, they must not close over the data they
// were built from. They read itemFor(node) (rows) or view.* (singletons), both
// of which the apply phase keeps current.

import * as api from "./api.js";
import { icon } from "./icons.js";
import {
  countPanes, folderPickerControl, formatBytes, formatUptime, layoutSessionIds, make,
  shortPath,
} from "./panel_shared.js";
import { itemFor, markEditing, patchList, setAttrs, setClass, setText } from "./render.js";

// Sessions nobody claims are grouped under this label, which is also the signal
// to the move/kill calls that there is no owning workspace to name.
const UNASSIGNED = "Unassigned";

// The four hero tiles. Labels are fixed, so only the numbers are ever written.
const STAT_TILES = [
  ["workspaces", "workspaces"],
  ["current", "this workspace"],
  ["live", "all live"],
  ["memory", "host RAM"],
];

// Ceiling on the refresh lock a folder picker holds. The lock is a courtesy
// now that a refresh is non-destructive, so a picker that never reports back
// must not be able to pin the dashboard stale for the rest of the session.
const PICKER_HOLD_CEILING_MS = 60000;

// Per-node references, so the apply phase never has to query the DOM.
const cardParts = new WeakMap();
const usageParts = new WeakMap();
const rowParts = new WeakMap();
const groupParts = new WeakMap();
const profileParts = new WeakMap();

function padded(value) {
  return String(value).padStart(2, "0");
}

// The shared folder picker disables its Browse button for as long as the
// directory chooser is up, and a disabled button drops focus to <body>. That
// is exactly why the old "pause while something in the panel has focus" guard
// let the refresh run straight through a folder choice. Focus cannot answer
// the question, so say it outright: take the lock on the way in and drop it
// when Browse comes back.
function holdRefreshWhilePicking(panel, field) {
  const browse = field.querySelector("button");
  if (!browse || typeof MutationObserver !== "function") return;
  // Capture, because the picker stops the click from bubbling.
  field.addEventListener("click", (event) => {
    if (event.target !== browse && !browse.contains(event.target)) return;
    const release = panel.holdDashboardRefresh();
    const ceiling = setTimeout(release, PICKER_HOLD_CEILING_MS);
    const observer = new MutationObserver(() => {
      if (browse.disabled) return; // the chooser is still up
      clearTimeout(ceiling);
      observer.disconnect();
      release();
    });
    observer.observe(browse, { attributes: true, attributeFilter: ["disabled"] });
  }, true);
}

async function collect() {
  const [names, sessions] = await Promise.all([
    api.listWorkspaces().catch(() => null),
    api.getSessions().catch(() => null),
  ]);
  if (names == null) return { workspaces: null, sessions };
  const workspaces = await Promise.all(names.map(async (name) => ({
    name,
    data: await api.getWorkspace(name).catch(() => null),
  })));
  return { workspaces, sessions };
}

export async function renderDashboard() {
  const mounted = () => this._dash && this._dash.root.parentNode === this.bodyEl;
  this._dashLoading = true;
  if (!mounted()) {
    this._dash = null;
    this.bodyEl.textContent = "";
    this.bodyEl.append(make("div", "panel-loading", "Collecting your workspace…"));
  }
  let data;
  try {
    data = await collect();
  } finally {
    this._dashLoading = false;
  }
  if (this.open !== "dashboard") return;
  if (!mounted()) {
    // Either the first open, or Settings/Help owned the body while the data
    // was in flight. Nothing here is worth preserving, so build fresh.
    this.bodyEl.textContent = "";
    this._dash = buildDashboard.call(this);
    this.bodyEl.append(this._dash.root);
  }
  applyDashboard.call(this, this._dash, data);
}

function buildDashboard() {
  const panel = this;
  const root = make("div", "dashboard");
  // ctx carries the per-refresh facts a row needs but does not own (which
  // workspace is current, which sessions this window holds). The apply phase
  // replaces it; the specs below read it when they run, never before.
  const view = { root, ctx: {}, workspaces: null, sessions: null };

  // Hero -------------------------------------------------------------------
  const hero = make("div", "dashboard-hero");
  const heroCopy = make("div", "hero-copy");
  view.heroTitle = make("h2", "hero-title");
  view.heroText = make("p", "hero-text");
  heroCopy.append(make("span", "hero-kicker", "Workspace overview"), view.heroTitle, view.heroText);
  const stats = make("div", "dashboard-stats");
  view.stats = {};
  for (const [id, label] of STAT_TILES) {
    const tile = make("div", "dashboard-stat");
    const value = make("strong");
    tile.append(value, make("span", "", label));
    stats.append(tile);
    view.stats[id] = value;
  }
  hero.append(heroCopy, stats);
  root.append(hero);

  // Terminal usage ---------------------------------------------------------
  const usageSection = make("section", "dashboard-section usage-section");
  const usageHeading = panel._sectionHeading(
    "Terminal usage",
    "Live host process-tree working set and sampled CPU. Figures are local estimates, not billing or enforcement data.",
  );
  view.killAll = panel._button("Kill all terminals…", "secondary-button danger-text");
  view.killAll.addEventListener("click", () => {
    const count = view.ctx.live.length;
    const warning = `Stop ${count} live terminal${count === 1 ? "" : "s"} across all workspaces? Attached panes will close and unsaved shell work will be lost.`;
    panel._confirmNear(view.killAll, warning, "Kill all", async () => {
      const result = await panel.app.killAllSessions();
      if (panel.open === "dashboard") panel._dashboard();
      // "Remove only verified kills": a terminal the backend could not stop is
      // still running, so it stays on screen and the confirmation says so.
      if (result.failed) {
        throw new Error(`${result.failed} terminal${result.failed === 1 ? "" : "s"} could not be stopped and remain visible.`);
      }
    });
  });
  usageHeading.append(view.killAll);
  view.usageRows = make("div", "usage-rows");
  view.usageEmpty = make("p", "detached-empty", "No live terminals to measure.");
  const usageTable = make("div", "usage-table");
  usageTable.append(view.usageRows, view.usageEmpty);
  usageSection.append(usageHeading, usageTable);
  root.append(usageSection);

  view.usageSpec = {
    key: (session) => session.id,
    create: () => createUsageRow(),
    update: (node, session) => updateUsageRow(node, session, view.ctx),
  };

  // Workspaces -------------------------------------------------------------
  const wsSection = make("section", "dashboard-section workspace-section");
  const wsHeading = panel._sectionHeading(
    "Workspaces",
    "A workspace is a folder plus the terminals you arranged in it.",
  );
  const saveForm = make("div", "save-workspace-form");
  const saveInput = panel._textInput("", "Name this workspace");
  // A workspace is a folder, so naming one asks for the folder in the same
  // breath. Pre-filled with wherever the live layout already points, and never
  // with the scratch root: suggestedWorkspaceFolder() offers the focused pane's
  // real directory instead.
  //
  // These two inputs are created exactly once for the lifetime of the open
  // panel. They are the nodes the folder picker captures before it awaits the
  // chooser, so replacing them is what made picking a folder do nothing.
  const suggested = panel.app.suggestedWorkspaceFolder ? panel.app.suggestedWorkspaceFolder() : null;
  const folderInput = panel._textInput(suggested || "", "Folder for this workspace");
  const folderField = folderPickerControl(folderInput, { label: "Choose the workspace folder" });
  holdRefreshWhilePicking(panel, folderField);
  const saveButton = panel._button("Save current", "primary-button");
  const saveNote = make("p", "save-workspace-note");
  let confirmOverwrite = null; // name armed for a second "really overwrite" click
  const resetSaveForm = () => {
    confirmOverwrite = null;
    saveButton.textContent = "Save current";
    saveNote.textContent = "";
  };
  const save = async () => {
    const name = saveInput.value.trim();
    const problem = panel.app.validateWorkspaceName
      ? panel.app.validateWorkspaceName(name)
      : (name ? null : "Give the workspace a name.");
    if (problem) {
      saveNote.textContent = problem;
      saveInput.focus();
      return;
    }
    // Overwriting a different existing workspace loses its layout, so ask once.
    // The name list is read here rather than captured when the form was built,
    // because the form outlives every refresh now.
    const current = panel.app.currentWorkspace && panel.app.currentWorkspace();
    const existing = new Set((view.workspaces || []).map((workspace) => workspace.name));
    if (existing.has(name) && name !== current && confirmOverwrite !== name) {
      confirmOverwrite = name;
      saveButton.textContent = "Overwrite?";
      saveNote.textContent = `“${name}” already exists. Save again to replace it.`;
      return;
    }
    saveButton.disabled = true;
    const failure = await panel.app.saveWorkspace(name, folderInput.value);
    saveButton.disabled = false;
    if (failure) {
      saveNote.textContent = failure;
      saveInput.focus();
      return;
    }
    // The form used to be wiped by the rebuild that followed a save. It
    // survives now, so clear it deliberately.
    saveInput.value = "";
    resetSaveForm();
    if (panel.open === "dashboard") panel._dashboard();
  };
  saveButton.addEventListener("click", save);
  saveInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") save();
  });
  saveInput.addEventListener("input", resetSaveForm);
  saveForm.append(saveInput, folderField, saveButton);
  wsHeading.append(saveForm, saveNote);

  view.grid = make("div", "workspace-grid");
  view.gridEmpty = make("div", "workspace-empty-card");
  view.gridEmpty.append(
    make("h3", "", "Your first workspace starts here"),
    make("p", "", "Arrange your terminals, give the layout a name, then save it above."),
  );
  wsSection.append(wsHeading, view.grid, view.gridEmpty);
  root.append(wsSection);

  view.cardSpec = {
    key: (workspace) => workspace.name,
    create: (workspace, index) => createWorkspaceCard(panel, index),
    update: (card, workspace, index) => updateWorkspaceCard(panel, card, workspace, index),
  };

  // Detached sessions ------------------------------------------------------
  const detachedSection = make("section", "dashboard-section detached-section");
  const detachedHeading = panel._sectionHeading("Detached sessions", idleTimeoutCopy(panel));
  view.detachedNote = detachedHeading.querySelector(".section-subtitle");
  const groupHost = make("div", "detached-groups");
  view.currentGroup = make("section", "detached-group current");
  view.currentGroupTitle = make("h3");
  view.currentGroupRows = make("div", "detached-group-rows");
  view.currentGroup.append(view.currentGroupTitle, view.currentGroupRows);
  view.otherGroups = make("details", "other-workspace-sessions");
  view.otherSummary = make("summary");
  view.otherGroupList = make("div", "other-group-list");
  view.otherGroups.append(view.otherSummary, view.otherGroupList);
  view.detachedEmpty = make("p", "detached-empty",
    "Nothing is detached. Alt+D puts a terminal here without stopping it.");
  groupHost.append(view.currentGroup, view.otherGroups, view.detachedEmpty);
  detachedSection.append(detachedHeading, groupHost);
  root.append(detachedSection);

  view.rowSpec = {
    key: (entry) => entry.session.id,
    create: () => createSessionRow(panel),
    update: (row, entry) => updateSessionRow(row, entry),
  };
  view.groupSpec = {
    key: (group) => group.name,
    create: () => createSessionGroup(),
    update: (section, group) => {
      const parts = groupParts.get(section);
      setText(parts.heading, group.name);
      patchList(parts.rows, group.sessions, view.rowSpec);
    },
  };

  // Quick launch -----------------------------------------------------------
  const lower = make("div", "dashboard-lower");
  const profileCard = make("section", "dashboard-list-card");
  profileCard.append(panel._sectionHeading("Quick launch", "Your terminal profiles"));
  view.profileList = make("div", "quick-profile-list");
  view.profileEmpty = make("p", "quiet-empty",
    "No personal terminals yet. Create one in Settings; system shells are always available in the launcher.");
  profileCard.append(view.profileList, view.profileEmpty);
  lower.append(profileCard);
  root.append(lower);

  view.profileSpec = {
    key: (profile) => profile.name,
    create: () => createProfileRow(panel),
    update: (row, profile) => {
      const parts = profileParts.get(row);
      setText(parts.mark, (profile.name || "> ").slice(0, 2).toUpperCase());
      setText(parts.name, profile.name);
      setText(parts.detail, panel._terminalLabel(profile));
    },
  };

  return view;
}

function idleTimeoutCopy(panel) {
  const seconds = panel.app.idleTimeoutSeconds ?? 300;
  if (seconds <= 0) return "Untouched background shells are never expired automatically.";
  return `Untouched background shells expire after ${Math.max(1, Math.round(seconds / 60))} quiet minutes; used or busy sessions are kept.`;
}

function applyDashboard(view, data) {
  const panel = this;
  // A failed fetch keeps the last good picture instead of blanking the panel.
  // Five seconds with no answer is a blip, not an empty machine, and wiping
  // the grid for it is the destructive behaviour this rewrite exists to stop.
  if (data.workspaces) view.workspaces = data.workspaces;
  if (data.sessions) view.sessions = data.sessions;
  const workspaces = view.workspaces || [];
  const sessions = view.sessions || [];

  const live = sessions.filter((session) => session.alive);
  const owned = new Set(panel.app.ownedSessionIds ? panel.app.ownedSessionIds() : []);
  const currentName = (panel.app.currentWorkspace && panel.app.currentWorkspace()) || "scratch";
  view.ctx = { live, owned, currentName };

  // Hero
  const currentFolder = panel.app.workspacePath ? panel.app.workspacePath() : null;
  const folderMissing = Boolean(currentFolder) && panel.app.workspacePathExists
    && panel.app.workspacePathExists() === false;
  setText(view.heroTitle, panel.app.currentWorkspace() || "Scratch");
  setText(view.heroText, currentFolder
    ? `Every terminal here opens in ${currentFolder}${folderMissing ? ", but that folder is missing" : ""}.`
    : "Open layouts, reattach background terminals, or clean up sessions from one place.");
  setClass(view.heroText, "warning", folderMissing);

  const measuredMemory = live.reduce((sum, session) =>
    sum + (session.usage?.available ? session.usage.working_set_bytes || 0 : 0), 0);
  setText(view.stats.workspaces, padded(workspaces.length));
  setText(view.stats.current, padded(live.filter((session) => owned.has(session.id)).length));
  setText(view.stats.live, padded(live.length));
  setText(view.stats.memory, padded(formatBytes(measuredMemory)));

  // Terminal usage
  view.killAll.hidden = live.length === 0;
  view.usageEmpty.hidden = live.length > 0;
  patchList(view.usageRows, live, view.usageSpec);

  // Workspaces
  view.gridEmpty.hidden = workspaces.length > 0;
  patchList(view.grid, workspaces, view.cardSpec);

  // Detached sessions
  setText(view.detachedNote, idleTimeoutCopy(panel));
  const groups = detachedGroups(panel, workspaces, sessions, currentName);
  const currentGroup = groups.find((group) => group.name === currentName);
  view.currentGroup.hidden = !currentGroup;
  setText(view.currentGroupTitle, currentName === "scratch" ? "Scratch" : currentName);
  patchList(view.currentGroupRows, currentGroup ? currentGroup.sessions : [], view.rowSpec);
  const otherGroups = groups.filter((group) => group !== currentGroup);
  view.otherGroups.hidden = otherGroups.length === 0;
  const otherCount = otherGroups.reduce((sum, group) => sum + group.sessions.length, 0);
  setText(view.otherSummary, `Other workspaces · ${otherCount} · explicit move required`);
  patchList(view.otherGroupList, otherGroups, view.groupSpec);
  view.detachedEmpty.hidden = groups.length > 0;

  // Quick launch
  view.profileEmpty.hidden = panel.app.profiles.length > 0;
  patchList(view.profileList, panel.app.profiles.slice(0, 6), view.profileSpec);
}

// Which live sessions are detached, and which workspace claims each of them.
// A session belongs to exactly one group, so the group's facts travel with the
// row as { session, workspaceName, isCurrent } and the row's listeners read
// them back from itemFor().
function detachedGroups(panel, workspaces, sessions, currentName) {
  const attachedHere = new Set(panel.app.attachedSessionIds ? panel.app.attachedSessionIds() : []);
  const liveById = new Map(sessions.filter((session) => session.alive).map((session) => [session.id, session]));
  const claimed = new Set();
  const groups = [];
  const entries = (ids, workspaceName, isCurrent) => [...ids]
    .map((sid) => liveById.get(sid))
    .filter((session) => session && !(session.attachments > 0))
    .map((session) => ({ session, workspaceName, isCurrent }));

  for (const workspace of workspaces) {
    if (!workspace.data) continue;
    const layoutIds = layoutSessionIds(workspace.data.layout);
    const owned = new Set(workspace.data.session_ids || []);
    for (const sid of layoutIds) owned.add(sid);
    if (workspace.name === currentName && panel.app.ownedSessionIds) {
      for (const sid of panel.app.ownedSessionIds()) owned.add(sid);
    }
    for (const sid of owned) claimed.add(sid);
    const detached = entries(
      [...owned].filter((sid) => !layoutIds.has(sid) && !attachedHere.has(sid)),
      workspace.name,
      workspace.name === currentName,
    );
    if (detached.length) groups.push({ name: workspace.name, sessions: detached });
  }
  if (!workspaces.some((workspace) => workspace.name === currentName) && panel.app.ownedSessionIds) {
    const owned = new Set(panel.app.ownedSessionIds());
    for (const sid of owned) claimed.add(sid);
    const detached = entries(
      [...owned].filter((sid) => !attachedHere.has(sid)),
      currentName,
      true,
    );
    if (detached.length) groups.push({ name: currentName, sessions: detached });
  }
  const unassigned = sessions
    .filter((session) => session.alive && !(session.attachments > 0) && !claimed.has(session.id))
    .map((session) => ({ session, workspaceName: UNASSIGNED, isCurrent: false }));
  if (unassigned.length) groups.push({ name: UNASSIGNED, sessions: unassigned });
  return groups;
}

function createUsageRow() {
  const row = make("div", "usage-row");
  const identity = make("div", "usage-identity");
  const name = make("strong");
  const scope = make("small");
  identity.append(name, scope);
  const values = make("div", "usage-values");
  const metrics = {};
  for (const [id, label] of [["ram", "RAM"], ["cpu", "CPU"], ["processes", "processes"], ["uptime", "uptime"]]) {
    const cell = make("span", "usage-value");
    const value = make("strong");
    cell.append(value, make("small", "", label));
    values.append(cell);
    metrics[id] = value;
  }
  row.append(identity, values);
  usageParts.set(row, { name, scope, metrics });
  return row;
}

function updateUsageRow(row, session, ctx) {
  const parts = usageParts.get(row);
  const usage = session.usage || {};
  setText(parts.name, session.name || session.id);
  const ownership = ctx.owned.has(session.id)
    ? "this workspace"
    : session.workspace ? `workspace ${session.workspace}` : "unassigned";
  // A WSL session's Linux side lives in the distro's VM, so the host figures
  // describe only part of it. Say so rather than under-reporting silently.
  setText(parts.scope, usage.scope === "host-process-tree-partial-wsl"
    ? "host side only · WSL workload excluded"
    : `${ownership} · ${session.activity?.background_output_bytes > 0 ? "new background output" : (session.attachments > 0 ? "open" : "background")} · ${session.profile || "terminal"}`);
  const cpu = usage.cpu_percent == null ? "Sampling…" : `${usage.cpu_percent.toFixed(1)}%`;
  setText(parts.metrics.ram, usage.available ? formatBytes(usage.working_set_bytes) : "Unavailable");
  setText(parts.metrics.cpu, usage.available ? cpu : "Unavailable");
  setText(parts.metrics.processes, String(usage.process_count || 0));
  setText(parts.metrics.uptime, formatUptime(usage.uptime_seconds));
}

function createWorkspaceCard(panel, index) {
  const card = make("article", "workspace-card");
  card.style.setProperty("--card-index", index);

  const top = make("div", "workspace-card-top");
  const logo = make("img", "workspace-card-logo");
  logo.alt = "";
  logo.hidden = true;
  const title = make("h3", "workspace-card-title");
  const badge = make("span", "workspace-badge");
  top.append(logo, title, badge);

  const folderLine = make("p", "workspace-card-folder");
  const preview = panel._layoutPreview(null);

  const actions = make("div", "workspace-card-actions");
  const load = panel._button("Open workspace", "card-open-button");
  load.addEventListener("click", () => {
    panel.close();
    panel.app.loadWorkspace(itemFor(card).name);
  });
  const editFolder = panel._button("Folder", "text-button compact");
  editFolder.title = "Choose the folder every terminal in this workspace opens in";
  editFolder.addEventListener("click", (event) => {
    event.stopPropagation();
    openFolderEditor(panel, card, editFolder);
  });
  const remove = panel._button("", "text-button danger-text");
  remove.append(icon("trash", 13), make("span", "", "Delete"));
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    const name = itemFor(card).name;
    panel._confirmNear(remove, `Delete workspace “${name}” and stop its detached sessions?`, "Delete", async () => {
      const deleted = panel.app.deleteWorkspace
        ? await panel.app.deleteWorkspace(name)
        : await api.deleteWorkspace(name).then(() => true).catch(() => false);
      if (!deleted) throw new Error("Workspace could not be deleted.");
      await panel._leave(card);
      if (panel.open === "dashboard") panel._dashboard();
    });
  });
  actions.append(load, editFolder, remove);

  card.append(top, folderLine, preview, actions);
  card.addEventListener("dblclick", () => load.click());
  cardParts.set(card, { logo, title, badge, folderLine, preview, actions, layout: undefined });
  return card;
}

function updateWorkspaceCard(panel, card, workspace, index) {
  const parts = cardParts.get(card);
  card.style.setProperty("--card-index", index);
  const layout = workspace.data && workspace.data.layout;
  const isCurrent = Boolean(panel.app.currentWorkspace)
    && panel.app.currentWorkspace() === workspace.name;
  setClass(card, "current", isCurrent);

  const panes = countPanes(layout);
  setText(parts.badge, isCurrent ? "Open now" : `${panes} pane${panes === 1 ? "" : "s"}`);
  setText(parts.title, workspace.name);

  const logo = workspace.data && workspace.data.logo;
  if (logo) {
    setAttrs(parts.logo, { src: api.assetUrl(logo) });
    parts.logo.hidden = false;
  } else {
    parts.logo.hidden = true;
  }

  const folder = workspace.data && workspace.data.path;
  const missing = Boolean(folder) && workspace.data.path_exists === false;
  setClass(parts.folderLine, "warning", missing);
  setText(parts.folderLine, folder
    ? (missing ? `${shortPath(folder)} · folder missing` : shortPath(folder))
    : workspace.name === "scratch"
      ? "Disposable · gone when the app quits"
      : "No folder yet · terminals open in your home folder");
  setAttrs(parts.folderLine, { title: folder || false });

  // The preview is a pure function of the layout tree and holds nothing
  // focusable, so it is rebuilt only when that tree actually changed.
  const signature = JSON.stringify(layout ?? null);
  if (parts.layout !== signature) {
    parts.layout = signature;
    const next = panel._layoutPreview(layout);
    card.replaceChild(next, parts.preview);
    parts.preview = next;
  }
}

// Editing in place: no modal, no navigation, and Escape puts the row back
// exactly as it was. The card is marked as being edited for as long as the
// editor is open, so the 5 s refresh leaves this row completely alone.
function openFolderEditor(panel, card, editFolder) {
  if (card.querySelector(".workspace-folder-editor")) return;
  const workspace = itemFor(card);
  const editor = make("div", "workspace-folder-editor");
  const input = panel._textInput((workspace.data && workspace.data.path) || "", "Folder for this workspace");
  const control = folderPickerControl(input, { label: `Choose the folder for ${workspace.name}` });
  holdRefreshWhilePicking(panel, control);
  const apply = panel._button("Save", "secondary-button compact");
  const cancel = panel._button("Cancel", "text-button compact");
  const dismiss = () => {
    editor.remove();
    markEditing(card, false);
    editFolder.disabled = false;
    editFolder.focus();
  };
  apply.addEventListener("click", async () => {
    apply.disabled = true;
    const saved = await panel.app.setWorkspaceFolder(workspace.name, input.value);
    apply.disabled = false;
    if (!saved) return;
    dismiss();
    if (panel.open === "dashboard") panel._dashboard();
  });
  cancel.addEventListener("click", dismiss);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") apply.click();
    else if (event.key === "Escape") { event.stopPropagation(); dismiss(); }
  });
  editor.append(control, apply, cancel);
  editFolder.disabled = true;
  markEditing(card, true);
  card.append(editor);
  input.focus();
}

function createSessionGroup() {
  const section = make("section", "detached-group");
  const heading = make("h3");
  const rows = make("div", "detached-group-rows");
  section.append(heading, rows);
  groupParts.set(section, { heading, rows });
  return section;
}

function createSessionRow(panel) {
  const row = make("div", "detached-session-row");
  const copy = make("div", "detached-session-copy");
  const name = make("strong");
  const detail = make("small");
  copy.append(name, detail);
  const actions = make("div", "detached-session-actions");
  const attach = panel._button("Attach", "secondary-button compact");
  attach.addEventListener("click", async () => {
    const { session, workspaceName, isCurrent } = itemFor(row);
    panel.close();
    // Moving a session between workspaces is never implicit: the button in a
    // foreign group says so, and only that button moves it.
    if (isCurrent) panel.app.attachSession(session);
    else await panel.app.moveSessionHere(session, workspaceName === UNASSIGNED ? null : workspaceName);
  });
  const kill = panel._button("Kill", "text-button danger-text");
  kill.addEventListener("click", () => {
    const { session, workspaceName } = itemFor(row);
    panel._confirmNear(kill, `Stop terminal “${session.name || session.id}”?`, "Kill", async () => {
      const stopped = await panel.app.killWorkspaceSession(
        session, workspaceName === UNASSIGNED ? null : workspaceName,
      );
      if (!stopped) throw new Error("Terminal could not be stopped.");
      if (panel.open === "dashboard") panel._dashboard();
    });
  });
  actions.append(attach, kill);
  row.append(copy, actions);
  rowParts.set(row, { name, detail, attach });
  return row;
}

function updateSessionRow(row, entry) {
  const parts = rowParts.get(row);
  const { session, isCurrent } = entry;
  setText(parts.name, session.name || session.id);
  const unreadBytes = session.activity?.background_output_bytes || 0;
  const activity = unreadBytes > 0
    ? `New output ${formatBytes(unreadBytes)} · ${formatUptime(session.activity?.background_output_age_seconds || 0)} ago`
    : `Quiet ${formatUptime(session.activity?.idle_seconds || 0)} · ${session.id}`;
  setText(parts.detail, `${session.profile || "terminal"} · ${activity}`);
  setText(parts.attach, isCurrent ? "Attach" : "Move here & attach");
}

function createProfileRow(panel) {
  const row = make("button", "quick-profile");
  row.type = "button";
  const mark = make("span", "profile-mark");
  const copy = make("span", "quick-profile-copy");
  const name = make("strong");
  const detail = make("small");
  copy.append(name, detail);
  const arrow = make("span", "profile-arrow");
  arrow.append(icon("arrow-up-right", 13));
  row.append(mark, copy, arrow);
  row.addEventListener("click", () => {
    panel.close();
    panel.app.runProfile(itemFor(row));
  });
  profileParts.set(row, { mark, name, detail });
  return row;
}
