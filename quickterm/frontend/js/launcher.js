import { icon } from "./icons.js";
import { toggleMenu } from "./menu.js";
import { connectionLabel, connectionTarget } from "./panel_connections.js";
import { workspaceLabel } from "./boot_context.js";
import { itemFor, markEditing, patchList, setAttrs, setClass, setText } from "./render.js";
import { claimFocus, releaseFocus } from "./focus.js";
import { confirmNear } from "./confirm_popover.js";
import {
  SIDEBAR_MODES, nextSidebarMode, SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MIN, maxSidebarWidth,
  clampSidebarWidth, isWideSidebar, sessionFolder, sessionTooltip, sidebarGroups, groupSummary,
  folderName, terminalChoices, canLaunch, choiceKey, loadMode, saveMode, loadWidth, saveWidth,
  loadClosedGroups, saveClosedGroups, foldId, visibleGroups, loadView, saveView, normalizeView,
  isDefaultView, SIDEBAR_VIEW_DEFAULTS,
} from "./sidebar_model.js";

// The pure half lives in sidebar_model.js; its public names stay importable
// from here.
export {
  SIDEBAR_MODES, nextSidebarMode, SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX,
  maxSidebarWidth, clampSidebarWidth, SIDEBAR_WIDE_AT, isWideSidebar, UNASSIGNED_GROUP, sessionState,
  sessionFolder, attentionText, isListedSession, sessionSummary, sessionTooltip, sidebarGroups,
  groupSummary, terminalChoices, canLaunch,
} from "./sidebar_model.js";

// The sidebar is the whole chrome. Three modes, one hotkey (Alt+Shift+S)
// cycles them, and the choice is remembered per machine:
//   full    one list: new terminal, every workspace with its terminals, icons
//   rail    30px of dots, so the state of every terminal is still in view
//   hidden  nothing at all; a small floating "+" sits at the terminal's top
//           left corner

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconButton(className, iconName, title, onClick) {
  const button = make("button", className);
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.append(icon(iconName, 14));
  if (onClick) button.addEventListener("click", onClick);
  return button;
}

function setLabel(button, title) {
  setAttrs(button, { title, "aria-label": title });
}


// The floating "+" that stands in for the sidebar while it is hidden. It is
// static in index.html and pinned by CSS at the top left; it does not move.
function wireFloat(actions, signal, showSidebar) {
  const float = document.getElementById("float-launch");
  if (!float) return { show() {}, hide() {} };
  const open = float.querySelector(".float-new");
  const reveal = float.querySelector(".float-show");
  open?.addEventListener("click", () => actions.newTerminal?.(), { signal });
  open?.addEventListener("contextmenu", (event) => { event.preventDefault(); showSidebar(); }, { signal });
  reveal?.addEventListener("click", showSidebar, { signal });
  return {
    show() { float.hidden = false; },
    hide() { float.hidden = true; },
  };
}

// A click synthesised by Enter or Space has no pointer behind it.
function fromKeyboard(event) {
  return event?.detail === 0;
}

export function initLauncher(el, { actions = {}, chrome = [], elevated = false } = {}) {
  if (el._launcherAbort) el._launcherAbort.abort();
  const abort = new AbortController();
  const signal = abort.signal;
  el._launcherAbort = abort;
  el.textContent = "";
  el.classList.add("sidebar");

  let model = {
    profiles: [], inventory: null, defaultProfile: null, selectedTerminal: null, logoUrl: null,
    workspaces: [], views: [], sessions: [], attached: {}, owned: {}, here: null,
  };

  // Hand the keyboard back to the terminal once a choice is made, or the next
  // keystroke lands on the control that was just used instead of the shell.
  // Menus and confirmations claim the keyboard in focus.js while open and
  // release it before this runs.
  const handBack = () => requestAnimationFrame(() => actions.handBack?.());

  // Mode -------------------------------------------------------------------
  let mode = loadMode();
  const float = wireFloat(actions, signal, () => setMode("full"));
  const applyMode = () => {
    document.body.classList.toggle("sidebar-collapsed", mode === "rail");
    document.body.classList.toggle("sidebar-hidden", mode === "hidden");
    el.setAttribute("aria-hidden", String(mode === "hidden"));
    if (mode === "hidden") float.show(); else float.hide();
    saveMode(mode);
    actions.sidebarResized?.();
  };
  let describeCollapse = () => {};
  const setMode = (next) => {
    if (!SIDEBAR_MODES.includes(next) || next === mode) return;
    mode = next;
    applyMode();
    describeCollapse();
    handBack();
  };

  // New terminal -----------------------------------------------------------
  // One button that opens whatever is selected, and a chevron beside it that
  // opens the list of choices as a menu (menu.js). Built once; the choices are
  // recomputed when profiles, inventory or the selection change.
  const launch = make("div", "sidebar-launch");
  let menuChoices = [];
  let choices = [];
  let selected = null;

  const open = make("button", "sidebar-new");
  open.type = "button";
  const openLabel = make("span", "sidebar-label");
  open.append(icon("plus", 15), openLabel);
  const describeOpen = () => {
    setText(openLabel, selected ? selected.label : "Set up terminal");
    open.title = selected
      ? `New ${selected.label} (Alt+N) · ${selected.detail}`
      : "No shell was found on this computer";
    open.disabled = !selected && !actions.setup;
  };
  open.addEventListener("click", () => {
    if (!selected) { actions.setup?.(); return; }
    const launched = selected.kind === "profile"
      ? actions.runProfile?.(selected.profile)
      : actions.runSystem?.(selected);
    Promise.resolve(launched).finally(handBack);
  }, { signal });

  const pick = iconButton("sidebar-terminal-pick", "chevron-down", "Choose what a new terminal runs");
  pick.setAttribute("aria-haspopup", "menu");
  pick.setAttribute("aria-expanded", "false");
  const select = (choice) => {
    selected = choice;
    // Kept here as well, so a later profiles update cannot restore the old pick
    // before the shell has echoed the new one.
    model = { ...model, selectedTerminal: choice };
    if (choice) actions.selectTerminal?.(choice);
    describeOpen();
  };
  const openTerminalMenu = () => {
    if (!menuChoices.length) { actions.setup?.(); return; }
    const items = [];
    let group = null;
    for (const choice of menuChoices) {
      if (choice.group !== group) {
        group = choice.group;
        items.push({ heading: group });
      }
      items.push({
        label: choice.label,
        detail: choice.detail,
        icon: canLaunch(choice) ? undefined : "plus",
        selected: choice.key === choiceKey(selected),
        run: () => (canLaunch(choice) ? select(choice) : actions.install?.(choice)),
      });
    }
    items.push({ separator: true }, { label: "Manage terminals and connections", icon: "settings", run: () => actions.setup?.() });
    toggleMenu({ anchor: launch, trigger: pick, items, label: "Terminal for new panes", onClose: handBack });
  };
  pick.addEventListener("click", openTerminalMenu, { signal });
  // Right-clicking "+" is the fast way to the same list.
  open.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openTerminalMenu();
  }, { signal });
  launch.append(open, pick);
  launch.append(iconButton("sidebar-setup", "settings", "Manage terminals and connections", () => actions.setup?.()));
  if (!elevated) {
    // Elevation spawns a separate process, so success is invisible here and a
    // declined UAC prompt is indistinguishable from a dead button. Hold the
    // button while the request is in flight and let the shell report the outcome.
    const admin = iconButton("sidebar-admin", "shield", "New administrator terminal", () => {
      if (!selected || admin.disabled) return;
      admin.disabled = true;
      const request = selected.kind === "profile"
        ? actions.elevateProfile?.(selected.profile)
        : actions.elevateSystem?.(selected);
      Promise.resolve(request).finally(() => { admin.disabled = false; });
    });
    launch.append(admin);
  }
  el.append(launch);

  const patchLaunch = () => {
    // The configured launcher lists saved terminals only (setup adds them); a
    // model can opt back into the raw inventory with configuredOnly: false.
    menuChoices = terminalChoices({ ...model, configuredOnly: model.configuredOnly ?? true });
    choices = menuChoices.filter(canLaunch);
    const wanted = choiceKey(model.selectedTerminal) || choiceKey(selected);
    let next = choices.find((choice) => choice.key === wanted);
    if (!next && model.defaultProfile) {
      // A profile name, or a system shell id ("git-bash"; "wsl" is its first
      // distribution). A profile of the same name wins.
      next = choices.find((choice) => choice.key === `profile:${model.defaultProfile}`)
        || choices.find((choice) => choice.kind === "system" && choice.id === model.defaultProfile);
    }
    next ||= choices[0] || null;
    pick.disabled = !menuChoices.length;
    if (next && choiceKey(next) !== choiceKey(model.selectedTerminal)) select(next);
    else { selected = next; describeOpen(); }
  };

  // Workspaces -------------------------------------------------------------
  const section = make("div", "sidebar-section");
  const add = iconButton("sidebar-section-add", "plus", "New scratch view, workspace here, or a new window");
  add.setAttribute("aria-haspopup", "menu");
  add.setAttribute("aria-expanded", "false");
  add.addEventListener("click", () => {
    const here = model.here;
    toggleMenu({
      anchor: section,
      trigger: add,
      label: "Workspaces",
      items: [
        { label: "New scratch view", icon: "plus", detail: "a fresh disposable layout", run: () => actions.newScratch?.() },
        here ? {
          label: `Workspace here: ${here.name}`, icon: "folder", detail: folderName(here.folder), title: hereTitle(here),
          run: () => actions.workspaceHere?.(),
        } : null,
        { label: "Open in new window…", icon: "new-window", run: () => actions.newWindow?.() },
      ],
      onClose: (reason) => { if (reason !== "run") handBack(); },
    });
  }, { signal });
  // Search hands over to the palette, already narrowed to workspaces and
  // terminals: one finder, not a second one squeezed into the sidebar.
  const search = iconButton("sidebar-section-add sidebar-section-search", "search",
    "Find a workspace or terminal (Alt+K, then @)", () => actions.search?.());
  // The view menu: what the list shows and how. Per window, like the mode.
  let view = loadView();
  const viewButton = iconButton("sidebar-section-add sidebar-section-view", "filter", "View options");
  viewButton.setAttribute("aria-haspopup", "menu");
  viewButton.setAttribute("aria-expanded", "false");
  const paintViewButton = () => {
    const custom = !isDefaultView(view);
    setClass(viewButton, "custom", custom);
    setLabel(viewButton, custom ? "View options (changed)" : "View options");
  };
  const setView = (patch) => {
    view = normalizeView({ ...view, ...patch });
    saveView(view);
    paintViewButton();
    patchGroups();
  };
  viewButton.addEventListener("click", () => {
    const choose = (label, detail, selected, patch) => ({ label, detail, selected, run: () => setView(patch) });
    toggleMenu({
      anchor: section,
      trigger: viewButton,
      label: "View options",
      align: "end",
      items: [
        { heading: "Show" },
        choose("Empty workspaces", "no terminals, not open", view.empty, { empty: !view.empty }),
        choose("Finished terminals", "kept for their last output", view.finished, { finished: !view.finished }),
        { heading: "Group by" },
        choose("Workspace", "", view.group === "workspace", { group: "workspace" }),
        choose("Nothing", "one list of terminals", view.group === "none", { group: "none" }),
        { heading: "Sort by" },
        choose("Name", "rows stay where they are", view.sort === "name", { sort: "name" }),
        choose("Recent activity", "busy and new output first", view.sort === "activity", { sort: "activity" }),
        { separator: true },
        {
          label: "Reset view", icon: "x", disabled: isDefaultView(view),
          run: () => setView({ ...SIDEBAR_VIEW_DEFAULTS }),
        },
      ],
      onClose: (reason) => { if (reason !== "run") handBack(); },
    });
  }, { signal });
  paintViewButton();
  section.append(make("span", "sidebar-section-label", "Workspaces"), search, viewButton, add);
  el.append(section);

  // The active workspace's second line: its folder, the "workspace here"
  // offer, Explorer and VS Code, and the save dot. One node, moved under
  // whichever group head is active, so #sb-save is always the same element.
  const activeLine = make("div", "sidebar-active-line");
  const folderLine = make("small", "sidebar-folder");
  const hereButton = make("button", "sidebar-here");
  hereButton.type = "button";
  hereButton.hidden = true;
  const hereText = make("span", "sidebar-label");
  hereButton.append(icon("plus", 11), hereText);
  hereButton.addEventListener("click", () => {
    actions.workspaceHere?.();
    handBack();
  }, { signal });
  const tools = make("div", "sidebar-folder-tools");
  const openIn = (app, iconName, label) => {
    const button = iconButton("sidebar-folder-open", iconName, label, () => {
      actions.openFolder?.(app);
      handBack();
    });
    button.dataset.app = app;
    return button;
  };
  // The folder is resolved by the shell at click time, so it is where the
  // focused terminal is right now (a `cd` counts), else the workspace folder.
  tools.append(
    openIn("explorer", "folder", "Open the focused terminal's folder in Explorer (Alt+Shift+E)"),
    openIn("vscode", "code", "Open the focused terminal's folder in VS Code (Alt+Shift+C)"),
  );
  const save = make("span", "sidebar-save");
  save.id = "sb-save";
  save.setAttribute("role", "status");
  save.setAttribute("aria-live", "polite");
  activeLine.append(folderLine, hereButton, tools, save);
  // Where the line waits while no view is open, so #sb-save stays in the DOM.
  const parking = make("div", "sidebar-parking");
  parking.hidden = true;
  parking.append(activeLine);

  const hereLabel = (here) => (here.action === "open" ? `open ${here.name}` : `workspace here: ${here.name}`);
  function hereTitle(here) {
    return here.action === "open"
      ? `${here.folder} is the folder of workspace ${here.name}. Open it and take this terminal along.`
      : `Make ${here.folder} a workspace named ${here.name} and move this terminal into it`;
  }
  // The offer to make the focused terminal's folder a workspace. The shell
  // patches it on every focus and folder change.
  const patchHere = () => {
    const here = model.here || null;
    hereButton.hidden = !here;
    if (!here) return;
    setText(hereText, hereLabel(here));
    setLabel(hereButton, hereTitle(here));
  };
  const patchActiveLine = (group) => {
    const path = group?.path || "";
    const folder = folderName(path);
    // Scratch says where its terminals start, so the line is never blank.
    const fallback = group?.kind === "workspace" ? "no folder" : group?.kind === "scratch" ? "scratch folder" : "";
    setText(folderLine, folder || fallback);
    // "acme / acme" says nothing twice.
    folderLine.hidden = !folderLine.textContent
      || folder.toLowerCase() === String(group?.label || "").toLowerCase();
    setClass(folderLine, "warning", group?.pathExists === false);
    folderLine.title = !path
      ? (group?.kind === "scratch"
        ? "Scratch terminals start in QuickTerm's disposable scratch folder."
        : "This workspace has no folder. Terminals open in your home folder.")
      : group.pathExists === false ? `${path} (missing)` : path;
  };

  // Terminals --------------------------------------------------------------
  const sessionList = make("div", "sidebar-sessions");
  const groupList = make("div", "sidebar-groups");
  const emptyNote = make("div", "sidebar-empty", "no workspaces and no terminals");
  emptyNote.hidden = true;
  // Hidden workspaces stay one click away: this line turns them back on.
  const hiddenNote = make("button", "sidebar-hidden-note");
  hiddenNote.type = "button";
  hiddenNote.hidden = true;
  hiddenNote.addEventListener("click", () => setView({ empty: true }), { signal });
  sessionList.append(groupList, emptyNote, hiddenNote);
  el.append(sessionList, parking);

  const closedGroups = loadClosedGroups();
  const parts = new WeakMap();
  // Open confirmations by what they are about (`session:<id>`, `group:<key>`),
  // so one whose row has gone, or moved to another group, can be closed on the
  // next update.
  const confirms = new Map();

  const groupOf = (node) => itemFor(node.closest(".session-group"));

  const openConfirm = (key, holder, trigger, options) => {
    confirms.get(key)?.handle.close("replaced");
    holder.classList.add("armed");
    const handle = confirmNear(trigger, {
      owner: "sidebar-confirm",
      ...options,
      onClose: (reason) => {
        if (confirms.get(key)?.handle === handle) confirms.delete(key);
        holder.classList.remove("armed");
        // Blur: the keyboard already went where the person clicked.
        // Replaced: a newer bar holds it, and a deferred hand-back would
        // pull it out of that bar.
        if (reason !== "blur" && reason !== "replaced") handBack();
      },
    });
    confirms.set(key, { handle, trigger });
    return handle;
  };

  const killConfirm = (entry, keyboard) => {
    const item = itemFor(entry);
    if (!item?.session || item.session.alive === false) return;
    const { kill, row } = parts.get(entry);
    const name = item.session.name || item.session.id;
    // In rail mode the row's actions are display:none, and a trigger without
    // a box drops the confirmation in the corner and closes it on the first
    // scroll as "gone". The row itself is the visible trigger then.
    const trigger = kill.getClientRects().length ? kill : row;
    openConfirm(`session:${item.session.id}`, entry, trigger, {
      message: `Kill ${name}? This stops its whole process tree.`,
      confirmLabel: "Kill",
      keyboard,
      acceptsAltW: true,
      // Read at confirm time: the row may have been patched since it opened.
      action: () => actions.killTerminal?.(itemFor(entry)?.session || item.session),
    });
  };

  const detach = (entry) => {
    const session = itemFor(entry)?.session;
    if (!session) return;
    Promise.resolve(actions.detachTerminal?.(session)).finally(handBack);
  };

  // Double-click or F2 renames in place. The input claims the keyboard, and the
  // row is marked as being edited, so the 10 s poll leaves it alone.
  const startRename = (entry) => {
    const { row, name } = parts.get(entry);
    const session = itemFor(entry)?.session;
    if (!session || row.querySelector("input")) return;
    const input = make("input", "session-rename");
    input.value = session.name || "";
    input.spellcheck = false;
    input.setAttribute("aria-label", "Terminal name");
    markEditing(entry, true);
    claimFocus("sidebar-rename");
    name.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = (keep) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      input.replaceWith(name);
      markEditing(entry, false);
      releaseFocus("sidebar-rename");
      const current = itemFor(entry)?.session || session;
      if (keep && value && value !== current.name) {
        setText(name, value);
        actions.renameTerminal?.(current, value);
      }
      handBack();
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") commit(true);
      else if (event.key === "Escape") commit(false);
    });
    input.addEventListener("blur", () => commit(true));
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("dblclick", (event) => event.stopPropagation());
  };

  const activeView = () => (model.views || []).find((view) => view.active) || null;

  const rowMenu = (entry, keyboard) => {
    const item = itemFor(entry);
    if (!item?.session) return;
    const { session, attachedIn } = item;
    const group = groupOf(entry);
    const target = activeView();
    const owner = group?.name || null;
    const items = [
      { label: "Open", icon: "arrow-up-right", run: () => actions.activateTerminal?.(itemFor(entry)?.session || session) },
    ];
    if (target && session.alive !== false && owner !== target.workspace) {
      items.push({
        label: `Move to ${target.label || workspaceLabel(target.workspace)}`, icon: "workspaces",
        run: () => Promise.resolve(actions.moveTerminalHere?.(itemFor(entry)?.session || session)).finally(handBack),
      });
    }
    if (attachedIn) items.push({ label: "Detach", icon: "unplug", hint: "keeps running", run: () => detach(entry) });
    items.push({ label: "Rename", hint: "F2", run: () => startRename(entry) });
    if (session.alive !== false) {
      items.push({ separator: true }, { label: "Kill…", icon: "stop", danger: true, hint: "Del", run: () => killConfirm(entry, keyboard) });
    }
    const { row } = parts.get(entry);
    toggleMenu({
      anchor: row,
      trigger: row,
      items,
      label: `Terminal ${session.name || session.id}`,
      onClose: (reason) => { if (reason !== "run") handBack(); },
    });
  };

  const createRow = () => {
    const entry = make("div", "session-entry");
    const row = make("button", "session-row");
    row.type = "button";
    const dot = make("span", "session-state");
    const name = make("span", "session-name");
    const chip = make("span", "session-chip");
    const where = make("small", "session-where");
    row.append(dot, name, chip, where);
    const tray = make("div", "session-actions");
    const detachButton = iconButton("session-action session-detach", "unplug", "Detach", () => detach(entry));
    const kill = iconButton("session-action session-kill danger", "stop", "Kill", (event) => killConfirm(entry, fromKeyboard(event)));
    tray.append(detachButton, kill);
    entry.append(row, tray);
    parts.set(entry, { row, name, chip, where, detach: detachButton, kill });

    row.addEventListener("click", () => {
      const session = itemFor(entry)?.session;
      if (session) actions.activateTerminal?.(session);
    });
    row.addEventListener("dblclick", (event) => {
      event.preventDefault();
      startRename(entry);
    });
    let keyboardMenuAt = 0;
    row.addEventListener("keydown", (event) => {
      if (event.target !== row) return;
      if (event.key === "F2") {
        event.preventDefault();
        startRename(entry);
      } else if (event.key === "Delete") {
        event.preventDefault();
        killConfirm(entry, true);
      } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
        event.preventDefault();
        keyboardMenuAt = Date.now();
        rowMenu(entry, true);
      }
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      // The ContextMenu key raises this event too, after its keydown did the work.
      if (Date.now() - keyboardMenuAt < 400) return;
      rowMenu(entry, false);
    });
    return entry;
  };

  // `group` is passed in rather than read from the DOM: a new row is updated
  // before patchList inserts it.
  const updateRow = (entry, item, group) => {
    const { session, state, attachedIn, finished } = item;
    const { row, name, chip, where, detach: detachButton, kill } = parts.get(entry);
    const label = session.name || String(session.id).slice(0, 8);
    setClass(entry, "needs-you", state.key === "attention");
    row.className = [
      "session-row",
      `state-${state.key}`,
      attachedIn ? "attached" : "detached",
      state.key === "unread" ? "unread" : "",
      finished ? "finished" : "",
    ].filter(Boolean).join(" ");
    setText(name, label);
    let title = sessionTooltip(session, item.owner || group?.label || "");
    const profile = (model.profiles || []).find((each) => each.name === session.profile);
    if (profile) {
      title += `\n${connectionLabel(profile)}: ${connectionTarget(profile)}`;
      row.dataset.connectionType = profile.terminal_type || "custom";
    } else {
      delete row.dataset.connectionType;
    }
    setAttrs(row, { title });
    // The folder is the fact that tells one project's shell from another's, so
    // it gets its own line as soon as the sidebar is wide enough to hold it.
    const folder = folderName(sessionFolder(session));
    const flat = group?.kind === "flat";
    // "qt · qt" says nothing twice: the folder joins only when it differs.
    const sameName = String(item.owner || "").toLowerCase() === folder.toLowerCase();
    const whereText = flat ? [item.owner, sameName ? "" : folder].filter(Boolean).join(" · ") : folder;
    setText(where, whereText);
    where.hidden = !whereText;
    setClass(where, "always", flat);
    // Chips only for the states worth interrupting for: a plain background
    // shell is a hollow dot, or the list turns into a wall of badges.
    const chipped = ["attention", "unread", "busy", "elsewhere"].includes(state.key);
    chip.hidden = !chipped;
    chip.className = chipped ? `session-chip chip-${state.key}` : "session-chip";
    setText(chip, chipped ? (state.key === "unread" ? "new" : state.label) : "");
    detachButton.hidden = !attachedIn;
    setLabel(detachButton, `Detach ${label}: keeps running`);
    kill.hidden = finished;
    setLabel(kill, `Kill ${label}…`);
  };

  const toggleFold = (node, wantClosed) => {
    const group = itemFor(node);
    if (!group?.sessions.length) return;
    const id = foldId(group);
    const closed = wantClosed ?? !closedGroups.has(id);
    if (closed === closedGroups.has(id)) return;
    if (closed) closedGroups.add(id); else closedGroups.delete(id);
    saveClosedGroups(closedGroups);
    // A DOM toggle, not a re-render: rebuilding the group would drop the
    // keyboard out of the very control that was just pressed.
    updateGroup(node, group);
  };

  const groupMenu = (node, keyboard) => {
    const group = itemFor(node);
    if (!group?.name) return;
    const { kebab, headline } = parts.get(node);
    const items = [];
    if (group.kind === "workspace") {
      items.push({ label: "Open in new window", icon: "new-window", run: () => actions.openWorkspaceInWindow?.(group.name) });
    }
    items.push({ label: "Workspace settings", icon: "settings", run: () => actions.editWorkspace?.(group.name) });
    if (group.kind === "workspace") {
      items.push({ separator: true }, {
        label: "Delete workspace…", icon: "trash", danger: true,
        run: () => openConfirm(`group:${group.key}`, node, kebab, {
          message: `Delete workspace ${group.name}? Detached terminals it owns are killed; attached ones keep running.`,
          confirmLabel: "Delete",
          keyboard,
          action: () => actions.deleteWorkspace?.(group.name),
        }),
      });
    }
    toggleMenu({
      anchor: headline,
      trigger: kebab,
      items,
      label: `Workspace ${group.label}`,
      onClose: (reason) => { if (reason !== "run") handBack(); },
    });
  };

  const createGroup = () => {
    const node = make("div", "session-group");
    const headline = make("div", "session-group-headline");
    const head = make("button", "session-group-head");
    head.type = "button";
    const chevron = make("span", "session-group-chevron");
    const dot = make("span", "session-group-dot");
    const name = make("span", "session-group-name");
    const count = make("span", "sidebar-count");
    head.append(chevron, dot, name, count);
    const tray = make("div", "group-actions");
    const closeView = iconButton("group-action group-close", "x", "Close view");
    const kebab = iconButton("group-action group-more", "more", "Workspace actions");
    kebab.setAttribute("aria-haspopup", "menu");
    kebab.setAttribute("aria-expanded", "false");
    tray.append(closeView, kebab);
    headline.append(head, tray);
    const slot = make("div", "session-group-detail");
    const rows = make("div", "session-group-rows");
    node.append(headline, slot, rows);
    parts.set(node, { headline, head, chevron, dot, name, count, closeView, kebab, slot, rows });

    head.addEventListener("click", (event) => {
      const group = itemFor(node);
      if (!group) return;
      // A closed scratch view is never reopened (its id would come back as
      // a workspace of that name); its terminals are rows to attach instead.
      const closedScratch = group.kind === "scratch" && !group.open;
      if (!group.name || closedScratch || event.target.closest?.(".session-group-chevron")) {
        toggleFold(node);
        return;
      }
      actions.openWorkspace?.(group.name);
    });
    head.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        toggleFold(node, event.key === "ArrowLeft");
      }
    });
    closeView.addEventListener("click", () => {
      const group = itemFor(node);
      if (group?.name) Promise.resolve(actions.closeWorkspace?.(group.name)).finally(handBack);
    });
    kebab.addEventListener("click", (event) => groupMenu(node, fromKeyboard(event)));
    return node;
  };

  const updateGroup = (node, group) => {
    const { head, chevron, dot, name, count, closeView, kebab, slot, rows } = parts.get(node);
    const hasRows = group.sessions.length > 0;
    const closed = hasRows && closedGroups.has(foldId(group));
    for (const kind of ["workspace", "scratch", "unassigned", "flat"]) setClass(node, kind, group.kind === kind);
    setClass(node, "open", group.open);
    setClass(node, "active", group.active);
    setClass(node, "has-attention", group.counts.attention > 0);
    setClass(node, "folded", closed);
    setClass(head, "warning", group.pathExists === false);
    // Always drawn, so every head reads as a row you can open: down while its
    // terminals show, right when folded or when there is nothing inside.
    setClass(chevron, "empty", !hasRows);
    const glyph = closed || !hasRows ? "chevron-right" : "chevron-down";
    if (chevron.dataset.glyph !== glyph) {
      chevron.dataset.glyph = glyph;
      chevron.textContent = "";
      chevron.append(icon(glyph, 10));
    }
    setClass(dot, "hollow", !group.open);
    if (group.open && group.color) dot.style.setProperty("--group-color", group.color);
    else dot.style.removeProperty("--group-color");
    setText(name, group.label);
    setText(count, String(group.sessions.length));
    count.hidden = !hasRows;
    const where = group.kind === "unassigned" ? "Live terminals no workspace owns"
      : group.path ? `${group.path}${group.pathExists === false ? " (missing)" : ""}`
        : group.label;
    setAttrs(head, {
      title: `${where} · ${groupSummary(group)}`,
      "aria-expanded": hasRows ? String(!closed) : false,
      "aria-current": group.active ? "true" : false,
    });
    closeView.hidden = !group.open;
    setLabel(closeView, `Close view ${group.label}: saves it, terminals keep running`);
    kebab.hidden = !group.name;
    setLabel(kebab, `${group.label}: workspace actions`);
    if (group.active) {
      if (activeLine.parentNode !== slot) slot.append(activeLine);
      patchActiveLine(group);
    }
    // Folding is the `.folded` class, not `hidden`: the rail still shows the
    // dots of a folded group.
    patchList(rows, group.sessions, {
      key: (entry) => `session:${entry.session.id}`,
      create: createRow,
      update: (entry, item) => updateRow(entry, item, group),
    });
  };

  const patchGroups = () => {
    const focused = sessionList.contains(document.activeElement) ? document.activeElement : null;
    const everything = sidebarGroups(model.sessions, { ...model, view });
    const { groups, hidden } = visibleGroups(everything, view);
    const nodes = patchList(groupList, groups, {
      key: (group) => `group:${group.key}`,
      create: createGroup,
      update: updateGroup,
    });
    if (!nodes.some((node) => itemFor(node)?.active) && activeLine.parentNode !== parking) parking.append(activeLine);
    emptyNote.hidden = groups.length > 0 || hidden > 0;
    hiddenNote.hidden = hidden === 0;
    setText(hiddenNote, `Show ${hidden} empty workspace${hidden === 1 ? "" : "s"}`);
    hiddenNote.title = "Workspaces with no terminals that are not open. The view menu above hides or shows them.";
    // Close a confirmation whose terminal or workspace is no longer listed.
    const listed = new Set();
    for (const group of groups) {
      listed.add(`group:${group.key}`);
      for (const entry of group.sessions) listed.add(`session:${entry.session.id}`);
    }
    for (const [key, { handle, trigger }] of [...confirms]) {
      if (!listed.has(key) || !trigger.isConnected) handle.close("gone");
    }
    if (focused && focused.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
  };

  // Footer -----------------------------------------------------------------
  // Keyed by the label the shell passes in `chrome`, so a new footer entry is
  // one map line away from its own glyph instead of silently falling back
  // to the terminal one.
  const footer = make("nav", "sidebar-footer");
  footer.setAttribute("aria-label", "Application");
  const navIcons = {
    dashboard: "dashboard", settings: "settings", help: "help",
    commands: "terminal", "new window": "new-window",
  };
  for (const [label, onClick, shortcut] of chrome || []) {
    const button = iconButton("sidebar-nav-button", navIcons[label] || "terminal",
      shortcut ? `${label} (${shortcut})` : label, onClick);
    button.dataset.nav = label;
    footer.append(button);
  }
  if (elevated) {
    const badge = make("span", "sidebar-admin-badge");
    badge.title = "Administrator mode";
    badge.append(icon("shield", 13));
    footer.prepend(badge);
  }
  const collapse = iconButton("sidebar-collapse", "chevron-right", "", () => {
    setMode(mode === "rail" ? "full" : "rail");
  });
  describeCollapse = () => {
    const title = mode === "rail" ? "Expand sidebar (Alt+Shift+S cycles)" : "Collapse sidebar to dots (Alt+Shift+S cycles)";
    collapse.title = title;
    collapse.setAttribute("aria-label", title);
    collapse.setAttribute("aria-expanded", String(mode !== "rail"));
  };
  footer.append(collapse);
  el.append(footer);

  // Resize grip -------------------------------------------------------------
  // The sidebar is a grid column of #app, so the width lives in --sidebar-w on
  // the root rather than on this element: the column has to know it.
  const grip = make("div", "sidebar-grip");
  grip.tabIndex = 0;
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-orientation", "vertical");
  grip.setAttribute("aria-label", "Resize sidebar");
  grip.title = "Drag to resize the sidebar, double-click to reset";
  el.append(grip);

  let desired = loadWidth();
  let width = desired;
  const applyWidth = (next, persist = false) => {
    width = clampSidebarWidth(next, window.innerWidth);
    if (persist) { desired = width; saveWidth(width); }
    document.documentElement.style.setProperty("--sidebar-w", `${width}px`);
    // A dragged-wide sidebar earns the extra line on every terminal row. The
    // class rides the same coalesced write as the width, so a drag still costs
    // one style write per frame.
    document.body.classList.toggle("sidebar-wide", isWideSidebar(width));
    grip.setAttribute("aria-valuenow", String(width));
    grip.setAttribute("aria-valuemin", String(SIDEBAR_WIDTH_MIN));
    grip.setAttribute("aria-valuemax", String(maxSidebarWidth(window.innerWidth)));
  };

  let frame = 0;
  let pending = width;
  let fitTimer = 0;
  // The shell answers sidebarResized by re-fitting every xterm to its new
  // pixel size, which is far too heavy to run per pointermove. So the width
  // write is coalesced into one animation frame and the fit trails the last
  // change; the end of a drag asks for it straight away.
  const notifyResize = (now = false) => {
    clearTimeout(fitTimer);
    if (now) { actions.sidebarResized?.(); return; }
    fitTimer = setTimeout(() => actions.sidebarResized?.(), 90);
  };
  const commit = () => {
    frame = 0;
    applyWidth(pending);
    notifyResize();
  };
  const queueWidth = (next) => {
    pending = next;
    if (!frame) frame = requestAnimationFrame(commit);
  };

  let dragging = false;
  let originLeft = 0;
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || mode !== "full") return;
    dragging = true;
    // Measured once: reading the rect on every move forces a layout inside the
    // very gesture that must stay smooth.
    originLeft = el.getBoundingClientRect().left;
    grip.setPointerCapture(event.pointerId);
    grip.classList.add("dragging");
    document.body.classList.add("sidebar-resizing", "sidebar-sizing");
    // Leave the keyboard where it was. Dragging a grip is not a request to
    // take focus off the terminal, and focus.js would hand it straight back.
    event.preventDefault();
  }, { signal });

  grip.addEventListener("pointermove", (event) => {
    if (dragging) queueWidth(event.clientX - originLeft);
  }, { signal });

  const endDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    try { grip.releasePointerCapture(event.pointerId); } catch (_) { /* already gone */ }
    grip.classList.remove("dragging");
    document.body.classList.remove("sidebar-resizing", "sidebar-sizing");
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    applyWidth(pending, true);
    notifyResize(true);
  };
  // Pointer capture is what makes this correct: a drag that ends outside the
  // window still delivers its pointerup here, so the body class cannot stick.
  grip.addEventListener("pointerup", endDrag, { signal });
  grip.addEventListener("pointercancel", endDrag, { signal });

  const resetWidth = () => {
    applyWidth(SIDEBAR_WIDTH_DEFAULT, true);
    notifyResize(true);
  };
  grip.addEventListener("dblclick", resetWidth, { signal });

  // A pointer-only resize is unreachable without a pointer, so the grip is in
  // the tab order and answers the arrows. Shift takes a coarse step, Home/End
  // go to the bounds, Enter/Space are the double-click reset.
  grip.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 32 : 8;
    let next = null;
    if (event.key === "ArrowLeft") next = width - step;
    else if (event.key === "ArrowRight") next = width + step;
    else if (event.key === "Home") next = SIDEBAR_WIDTH_MIN;
    else if (event.key === "End") next = maxSidebarWidth(window.innerWidth);
    else if (event.key === "Enter" || event.key === " ") next = SIDEBAR_WIDTH_DEFAULT;
    else return;
    event.preventDefault();
    applyWidth(next, true);
    notifyResize();
  }, { signal });

  // The cap is relative to the window, so a shrinking window has to pull the
  // sidebar in. The stored width is left alone: it comes back when there is
  // room for it again.
  window.addEventListener("resize", () => {
    const before = width;
    applyWidth(desired);
    if (width !== before) notifyResize();
  }, { signal });

  signal.addEventListener("abort", () => {
    if (frame) cancelAnimationFrame(frame);
    clearTimeout(fitTimer);
    for (const { handle } of [...confirms.values()]) handle.close("gone");
  });

  // The stored width must land before the grid animates, or every start slides
  // the sidebar out from the default in the stylesheet.
  document.body.classList.add("sidebar-sizing");
  applyWidth(desired);
  applyMode();
  describeCollapse();
  requestAnimationFrame(() => { if (!dragging) document.body.classList.remove("sidebar-sizing"); });

  const LAUNCH_KEYS = ["profiles", "inventory", "defaultProfile", "selectedTerminal", "configuredOnly"];
  const update = (partial = {}) => {
    model = { ...model, ...partial };
    if (LAUNCH_KEYS.some((key) => key in partial)) patchLaunch();
    if ("here" in partial) patchHere();
    patchGroups();
  };

  const updateHere = (here) => update({ here: here || null });

  patchLaunch();
  patchHere();
  patchGroups();
  return {
    update,
    updateHere,
    cycleTerminal(delta = 1) {
      if (!choices.length) return null;
      const current = Math.max(0, choices.findIndex((choice) => choice.key === choiceKey(selected)));
      select(choices[(current + (delta < 0 ? -1 : 1) + choices.length) % choices.length]);
      handBack();
      return selected;
    },
    mode: () => mode,
    setMode,
    cycleMode() { setMode(nextSidebarMode(mode)); return mode; },
  };
}
