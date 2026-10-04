// Alt+K command palette: one input, subsequence fuzzy match over actions,
// profiles, agents, snippets, workspaces, running terminals, settings and
// configs. A leading `>`, `@`, `#` or `!` narrows the list to one kind.
// Sub-modes (kill, search, new window, move here) and the file path prompt
// reuse the same input.

import * as api from "./api.js";
import { displaySnippet, layoutSessionIds } from "./panel_shared.js";
import { claimFocus, releaseFocus } from "./focus.js";
import { resultLabel } from "./terminal_actions.js";
import { connectionLabel, connectionTarget } from "./panel_connections.js";
import { workspaceLabel } from "./boot_context.js";
import { AGENT_TYPES, agentTypeOf } from "./agent_profile.js";
import {
  PREFIX_HINT, agentRows, agentSessionRows, agentSessionTarget, configRows, fuzzyScore, killName, killRows,
  parsePrefix, rowGroup, settingRows, terminalRows, workspaceRows,
} from "./palette_items.js";

// Snippet rows must show what will actually be sent. Keep it to one line so a
// long multi-line snippet cannot push the destination out of view.
function snippetHint(text) {
  const body = displaySnippet(text);
  const lines = body.split("\n");
  const head = lines[0].length > 60 ? `${lines[0].slice(0, 59)}…` : lines[0];
  return lines.length > 1 ? `${head} … (+${lines.length - 1} more)` : head;
}

// What openPalette learns after the list is already shown.
function emptyLate() {
  return { names: [], details: new Map(), attach: [], agentSessions: [] };
}

export class Palette {
  constructor(app) {
    this.app = app;
    this.open = false;
    this.items = [];
    this.filtered = [];
    this.sel = 0;
    this.prompt = null; // {submit(text)}
    this.foreignMode = false;
    this.windowMode = false;
    this.searchMode = false;
    this.killMode = false;
    this.killTarget = null;
    this.killPending = false;
    this.foreignSessions = [];
    this.late = emptyLate();
    this.requestId = 0;

    const overlay = document.createElement("div");
    overlay.className = "palette-overlay";
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">' +
      '<input type="text" role="combobox" aria-label="Find a command" aria-autocomplete="list" aria-controls="palette-list" aria-expanded="true" spellcheck="false" autocomplete="off" autocapitalize="off">' +
      '<div id="palette-list" class="palette-list" role="listbox"></div>' +
      "</div>";
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.input = overlay.querySelector("input");
    this.listEl = overlay.querySelector(".palette-list");

    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) this.close();
    });
    this.input.addEventListener("input", () => {
      if (!this.prompt) this._refilter();
    });
    this.input.addEventListener("keydown", (e) => this._key(e));
  }

  toggle() {
    if (this.open) this.close();
    else this.openPalette();
  }

  // `query` pre-fills the box, so a caller can open it already narrowed by a
  // prefix (the sidebar's search opens it on "@").
  async openPalette(query = "") {
    const requestId = ++this.requestId;
    const wasOpen = this.open;
    this.open = true;
    // Claim the keyboard before focusing: whatever this palette replaced has
    // already asked the focused pane to re-focus itself, and that request lands
    // a frame from now. Without the claim it wins and Alt+K opens a palette you
    // cannot type into.
    //
    // Once per open, though. A sub-mode's "back to commands" row re-enters here
    // while the palette is still open, and focus.js counts claims per owner, so
    // claiming twice left one claim standing after close() and the terminal
    // never took the keyboard back.
    if (!wasOpen) claimFocus("palette");
    this._leaveSubModes();
    this.overlay.hidden = false;
    this.input.value = typeof query === "string" ? query : "";
    this.input.placeholder = `Find anything · ${PREFIX_HINT}`;
    this.late = emptyLate();
    this._compose();
    this._refilter();
    this.focusInput();
    this._fillAgentSessions(requestId);
    // enrich with live data
    const [sessions, workspaces] = await Promise.all([
      api.getSessions().catch(() => []),
      api.listWorkspaces().catch(() => []),
    ]);
    if (!this._current(requestId)) return;
    this.late.names = workspaces;
    this._compose();
    this._refilter(false);
    const workspaceData = await Promise.all(workspaces.map(async (name) => ({
      name,
      saved: await api.getWorkspace(name).catch(() => null),
    })));
    if (!this._current(requestId)) return;
    const owners = new Map();
    const layoutBound = new Set();
    for (const { name, saved } of workspaceData) {
      if (!saved) continue;
      // The folder is what distinguishes two similarly named workspaces, so
      // the row shows it once the details have arrived.
      this.late.details.set(name, saved);
      const ids = new Set(saved.session_ids || []);
      layoutSessionIds(saved.layout, ids);
      for (const sid of ids) if (!owners.has(sid)) owners.set(sid, name);
      layoutSessionIds(saved.layout, layoutBound);
    }
    const a = this.app;
    const attached = new Set(a.attachedSessionIds?.() || []);
    const current = a.currentWorkspace?.() || "scratch";
    const currentOwned = new Set(a.ownedSessionIds?.() || []);
    this.foreignSessions = [];
    for (const s of sessions) {
      if (!s.alive || attached.has(s.id) || s.attachments > 0 || layoutBound.has(s.id)) continue;
      const owner = owners.get(s.id) || (currentOwned.has(s.id) ? current : null);
      if (owner === current) {
        this.late.attach.push({
          kind: "session",
          label: `attach here: ${s.name || s.id}`,
          hint: s.profile ? `${s.profile} · ${s.id}` : s.id,
          run: () => a.attachSession?.(s),
        });
      } else {
        this.foreignSessions.push({ info: s, workspace: owner || "Unassigned" });
      }
    }
    this._compose();
    this._refilter(false);
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.requestId++;
    this._leaveSubModes();
    this.overlay.hidden = true;
    // Release before asking for the terminal back, or the guard this palette
    // installed would refuse its own hand-off.
    releaseFocus("palette");
    this.app.refocusTerm?.();
  }

  // The sidebar's "new window" button and the palette's own "new window…" row
  // land here, so exactly one place decides what a second window may open on.
  // Opening the picker directly skips the command list the button's user never
  // asked for.
  newWindowMode(beside = false) {
    if (!this.open) {
      this.open = true;
      this.requestId++;
      claimFocus("palette");
      this.overlay.hidden = false;
    }
    this._newWindowMode(beside);
  }

  // The input is the palette: every path that shows it, opening or stepping
  // into a two-step prompt, lands here. Focus is re-asserted on the next frame
  // because the overlay was hidden a moment ago and WebView2 does not always
  // move focus into an element that was display:none in the same task.
  focusInput() {
    this.input.focus();
    requestAnimationFrame(() => {
      if (this.open && document.activeElement !== this.input) this.input.focus();
    });
  }

  // ---- internals ----

  // A prompt or one of the lists reached from a command row: the command
  // list's late enrichment must not overwrite it.
  _inSubMode() {
    return Boolean(this.prompt || this.foreignMode || this.windowMode || this.searchMode || this.killMode);
  }

  _leaveSubModes() {
    this.prompt = null;
    this.foreignMode = false;
    this.windowMode = false;
    this.searchMode = false;
    this.killMode = false;
    this.killTarget = null;
  }

  _current(requestId) {
    return this.open && requestId === this.requestId && !this._inSubMode();
  }

  _compose() {
    this.items = [
      ...this._staticItems(),
      ...workspaceRows(this.app, this.late.names, this.late.details),
      ...this.late.attach,
      ...this.late.agentSessions,
    ];
  }

  // "resume <agent> session: <title>" rows for the first profile of each agent
  // type, from that agent's own session store for this view's folder: a named
  // workspace's, or the one a scratch view starts its agents in.
  async _fillAgentSessions(requestId) {
    const a = this.app;
    const target = agentSessionTarget(a);
    if (!target || typeof api.listAgentSessions !== "function") return;
    const profiles = AGENT_TYPES
      .map((type) => (a.profiles || []).find((profile) => agentTypeOf(profile) === type))
      .filter(Boolean);
    if (!profiles.length) return;
    const answers = await Promise.all(profiles.map((profile) =>
      api.listAgentSessions(profile.terminal_type, target).then(
        (answer) => ({ profile, sessions: answer?.sessions || [] }),
        () => ({ profile, sessions: [] }),
      )));
    if (!this._current(requestId)) return;
    this.late.agentSessions = answers.flatMap(({ profile, sessions }) => agentSessionRows(profile, sessions, a));
    this._compose();
    this._refilter(false);
  }

  _staticItems() {
    const a = this.app;
    // The two folder rows name the folder they would open: that is the
    // focused terminal's directory when there is one, else the workspace's.
    const here = a.hereFolder?.() || null;
    const folderHint = (keys) => (here ? `${here} · ${keys}` : keys);
    const items = [
      { kind: "action", label: "dashboard", run: () => a.openPanel?.("dashboard") },
      { kind: "action", label: "settings", run: () => a.openPanel?.("settings") },
      { kind: "action", label: "terminals and connections", run: () => a.setupTerminals?.() },
      { kind: "action", label: "setup tour", run: () => a.setupTour?.() },
      { kind: "action", label: "help", run: () => a.openPanel?.("help") },
      { kind: "action", label: "new terminal", hint: "Alt+N", run: () => a.newTerminal?.() },
      { kind: "action", label: "previous new-terminal profile", hint: "Alt+Shift+Left", run: () => a.cycleTerminal?.(-1) },
      { kind: "action", label: "next new-terminal profile", hint: "Alt+Shift+Up", run: () => a.cycleTerminal?.(1) },
      ...(a.shellInstalls?.() || []).map((install) => ({
        kind: "action",
        label: `install ${install.label}`,
        hint: install.cmd ? "winget, in a new terminal" : "opens the download page",
        run: () => a.installShell?.(install),
      })),
      { kind: "action", label: "split right", hint: "Alt+Shift+Right · H", run: () => a.splitH?.() },
      { kind: "action", label: "split below", hint: "Alt+Shift+Down · V", run: () => a.splitV?.() },
      { kind: "action", label: a.isZoomed?.() ? "show all panes" : "zoom pane", hint: "Alt+Z", run: () => a.zoom?.() },
      { kind: "view", label: "text size: smaller", hint: "Ctrl+−", run: () => a.fontSmaller?.() },
      { kind: "view", label: "text size: bigger", hint: "Ctrl++", run: () => a.fontBigger?.() },
      { kind: "view", label: "text size: reset", hint: "Ctrl+0", run: () => a.fontReset?.() },
      // Pane sizing lives on the splitter (drag / arrows / double-click) and in
      // Quick settings. Duplicating it as five palette rows only crowded the list.
      { kind: "action", label: "detach pane", hint: "Alt+D", run: () => a.closePane?.() },
      { kind: "action", label: "kill session and close pane", hint: "Alt+W", run: () => a.killFocusedSession?.({ keyboard: true }) },
      // Any terminal the backend runs, not only the focused pane's. Choosing
      // one asks first, with the kill pre-selected: this is a keyboard path.
      {
        kind: "action", label: "kill terminal…", hint: "choose one, then confirm",
        keepOpen: true, run: () => this._killMode(),
      },
      // Only offered where there is something to restart; Enter in the exited
      // pane is the same action without opening the palette.
      ...(a.canRestartFocused?.() ? [{
        kind: "action", label: "restart terminal", hint: "Enter in an exited pane",
        run: () => a.restartTerminal?.(),
      }] : []),
      // Views beside this one are other documents with their own switch, so
      // the label says how far it reaches.
      {
        kind: "action",
        label: a.isBroadcasting?.() ? "stop broadcasting input" : "broadcast input to all panes in this workspace",
        run: () => a.toggleBroadcast?.(),
      },
      {
        kind: "action", label: "search all terminals…", hint: "every terminal's scrollback",
        keepOpen: true, run: () => this._searchPrompt(),
      },
      {
        kind: "action", label: "save terminal output", hint: "as plain text into Downloads",
        run: () => a.saveTerminalOutput?.(),
      },
      ...(a.lastSavedOutput?.() ? [{
        kind: "action", label: "open last saved output", hint: a.lastSavedOutput(),
        run: () => a.openLastSavedOutput?.(),
      }] : []),
      { kind: "action", label: "open folder in Explorer", hint: folderHint("Alt+Shift+E"), run: () => a.openExplorer?.() },
      { kind: "action", label: "open folder in VS Code", hint: folderHint("Alt+Shift+C"), run: () => a.openEditor?.() },
      {
        kind: "action", label: "move terminal here…", hint: "from another workspace or Unassigned",
        keepOpen: true, run: () => this._foreignSessionMode(),
      },
      // No shortcut: keys.js may only claim cold Alt combos, and every letter
      // left over is a readline or PSReadLine binding the shell needs (see
      // AGENTS.md). The sidebar footer button is the other way in.
      {
        kind: "action", label: "new window…", hint: "a second window on another workspace",
        keepOpen: true, run: () => this._newWindowMode(),
      },
      // Workspaces are opened only from enumerated "open workspace: <name>"
      // rows (palette_items.js workspaceRows); a free-text prompt here used to
      // tear the whole layout down on a typo. Saving is handed to the
      // Dashboard, which validates the name and shows the error.
      {
        kind: "action", label: "save workspace…", hint: "opens Dashboard",
        run: () => a.openPanel?.("dashboard"),
      },
      {
        kind: "action", label: "open file viewer…", keepOpen: true,
        run: () => this._promptMode("file path", (v) => {
          const t = api.token();
          window.open(
            `/viewer?path=${encodeURIComponent(v)}${t ? `#t=${encodeURIComponent(t)}` : ""}`,
            "_blank",
            "popup,width=900,height=700",
          );
        }),
      },
    ];
    for (const p of a.profiles || []) {
      const desktop = ["rdp", "vnc"].includes(p.terminal_type);
      // An agent profile has no target of its own; connectionTarget then
      // falls back to the same type and mode label, which read twice.
      const typeLabel = connectionLabel(p);
      const target = connectionTarget(p);
      items.push({
        kind: desktop ? "window" : "terminal",
        label: `open ${desktop ? "window" : "terminal"}: ${p.name}`,
        hint: target && target !== typeLabel ? `${typeLabel} · ${target}` : typeLabel,
        run: () => a.runProfile?.(p),
      });
      items.push(...agentRows(p, a));
    }
    // Snippets type straight into the focused terminal, so the row has to show
    // both what is sent and where it lands: two similarly named snippets are
    // otherwise indistinguishable in the list.
    const target = a.focusedPaneName?.();
    for (const s of a.snippets || []) {
      // A description says why the snippet is kept; the command usually only
      // repeats what the name already implies. Snippets written before
      // descriptions existed have none, so the command stays the fallback.
      const command = snippetHint(s.text);
      const what = (s.description || "").trim() || command;
      items.push({
        kind: "snippet",
        label: `snippet: ${s.name}`,
        hint: target ? `${what} → ${target}` : what,
        // Searched but not shown: the row has one line, and a snippet found by
        // a word from its description still has to be recognisable by name.
        // The label leads, so typing "snippet" still lists every snippet and
        // the word-start scoring bonus lands where it did before.
        search: [`snippet: ${s.name}`, s.description, command].filter(Boolean).join(" "),
        run: () => a.sendSnippet?.(s),
      });
    }
    items.push(...terminalRows(a));
    // Settings and configs are many and only worth showing once something is
    // typed (or `#` asks for them), so they stay out of the bare command list.
    for (const row of [...settingRows(a), ...configRows(a)]) items.push({ ...row, quiet: true });
    return items;
  }

  // `stayOpen`: the answer leads to another list in the palette (search
  // results) instead of an action, so Enter must not close it.
  _promptMode(placeholder, submit, { stayOpen = false } = {}) {
    this.prompt = { submit, stayOpen };
    this.input.value = "";
    this.input.placeholder = placeholder;
    this.listEl.textContent = "";
    this.filtered = [];
    this.sel = 0;
    this.focusInput();
  }

  _searchPrompt() {
    this.searchMode = false;
    this._promptMode("search every terminal's scrollback", (query) => this._searchMode(query), {
      stayOpen: true,
    });
  }

  // Results are one more list in the palette, like the session lists: type
  // to narrow them, Enter brings the terminal into view at that line, Escape
  // goes back to the commands.
  async _searchMode(query) {
    this._leaveSubModes();
    this.searchMode = true;
    this.input.value = "";
    this.input.placeholder = `searching for "${query}"…`;
    const request = ++this.requestId;
    this.items = [
      { kind: "back", label: "back to commands", keepOpen: true, run: () => this.openPalette() },
    ];
    this._refilter();
    this.focusInput();
    let results;
    try {
      results = await this.app.searchTerminals?.(query);
    } catch (error) {
      if (!this.open || !this.searchMode || request !== this.requestId) return;
      this.input.placeholder = error?.detail || "search failed";
      return;
    }
    if (!this.open || !this.searchMode || request !== this.requestId) return;
    results = results || [];
    this.input.placeholder = results.length
      ? `${results.length} line${results.length === 1 ? "" : "s"} match "${query}" · type to narrow`
      : `no terminal output matches "${query}"`;
    for (const result of results) {
      this.items.push({
        kind: "found",
        label: resultLabel(result),
        hint: [result.name, result.workspace, result.alive ? null : "exited"].filter(Boolean).join(" · "),
        search: `${result.name} ${result.text}`,
        run: () => this.app.revealSearchResult?.(result, query),
      });
    }
    // Enter goes to the first hit, unless the user already moved or typed
    // while the search ran.
    const untouched = !this.input.value && this.sel === 0;
    this._refilter(false);
    if (untouched && results.length && this.filtered[1]) {
      this.sel = 1;
      this._renderList();
    }
  }

  _foreignSessionMode() {
    this._leaveSubModes();
    this.foreignMode = true;
    this.input.value = "";
    this.input.placeholder = "Other workspaces; choosing one moves the session here";
    this.items = [
      { kind: "back", label: "back to commands", keepOpen: true, run: () => this.openPalette() },
      ...this.foreignSessions.map(({ info, workspace }) => ({
        kind: "session",
        label: `move here & attach: ${info.name || info.id}`,
        hint: `${workspaceLabel(workspace)} · ${info.id}`,
        run: () => this.app.moveSessionHere?.(info, workspace === "Unassigned" ? null : workspace),
      })),
    ];
    this._refilter();
    this.focusInput();
  }

  // Every running terminal, wherever it lives. The back row comes last so
  // the first terminal is the one Enter picks.
  _killMode() {
    this._leaveSubModes();
    this.killMode = true;
    this.input.value = "";
    const rows = killRows(this.app).map((row) => ({
      ...row, keepOpen: true, run: () => this._killConfirm(row.terminal),
    }));
    this.input.placeholder = rows.length ? "Kill which terminal? Esc goes back" : "No terminal is running";
    this.items = [
      ...rows,
      { kind: "back", label: "back to commands", keepOpen: true, run: () => this.openPalette() },
    ];
    this._refilter();
    this.focusInput();
  }

  // The keyboard asked for this kill, so the kill row comes first and is
  // selected: Enter completes it, Escape goes back to the list.
  _killConfirm(entry) {
    this.killTarget = entry;
    const name = killName(entry);
    this.input.value = "";
    this.input.placeholder = `kill ${name}? Enter kills, Esc goes back`;
    this.items = [
      {
        kind: "kill", label: `kill ${name}`, hint: "stops its whole process tree",
        keepOpen: true, run: () => this._killChosen(entry),
      },
      { kind: "back", label: "back", keepOpen: true, run: () => this._killMode() },
    ];
    this._refilter();
    this.focusInput();
  }

  // Only a verified kill closes the palette. A failure keeps the confirmation
  // up with the server's reason, so Enter retries and Escape backs out.
  async _killChosen(entry) {
    if (this.killPending) return;
    const name = killName(entry);
    if (typeof this.app.killTerminal !== "function") {
      this.input.placeholder = "Killing terminals is not available here";
      return;
    }
    this.killPending = true;
    this.input.placeholder = `killing ${name}…`;
    try {
      await this.app.killTerminal?.(entry.session);
    } catch (error) {
      if (this.open && this.killTarget === entry) {
        this.input.placeholder = `${error?.detail || `could not kill ${name}`} · Enter retries, Esc goes back`;
      }
      return;
    } finally {
      this.killPending = false;
    }
    if (this.open && this.killTarget === entry) this.close();
  }

  // Which workspace a second window opens on. Workspaces another window already
  // holds stay in the list and say so: hiding them would read as "that
  // workspace is gone", and the user needs to know where it went. Choosing one
  // explains the refusal instead of opening a window that would fight over the
  // same layout file.
  async _newWindowMode(beside = false) {
    this._leaveSubModes();
    this.windowMode = true;
    this.input.value = "";
    this.input.placeholder = beside ? "Tile a workspace beside this one…" : "Open a second window on…";
    const request = ++this.requestId;
    const a = this.app;
    this.items = [
      { kind: "back", label: "back to commands", keepOpen: true, run: () => this.openPalette() },
      ...[{
        kind: "window", label: beside ? "new scratch view" : "new window: scratch",
        hint: "a disposable layout of its own",
        run: () => beside ? a.openWorkspaceBeside?.(null) : a.openNewWindow?.(null),
      }],
    ];
    this._refilter();
    this.focusInput();
    const rows = await Promise.resolve()
      .then(() => a.newWindowChoices?.() || [])
      .catch(() => []);
    if (!this.open || !this.windowMode || request !== this.requestId) return;
    if (a.windowRegistryAvailable?.() === false) {
      // Say so rather than let every workspace look free: the list below is
      // this window's guess, not the registry's answer.
      this.input.placeholder = "Cannot check which workspaces are already open";
    }
    for (const row of rows) {
      this.items.push({
        kind: "window",
        label: `${beside ? "show beside" : "new window"}: ${row.name}`,
        hint: row.hint,
        // A workspace this window already shows in another view is focused,
        // not explained: it is one click away, not busy elsewhere.
        run: () => (row.taken
          ? (beside && a.focusShownWorkspace?.(row.name)) || a.explainWindowChoice?.(row)
          : beside ? a.openWorkspaceBeside?.(row.name) : a.openNewWindow?.(row.name)),
      });
    }
    this._refilter(false);
  }

  _key(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (this.killMode && this.killTarget) {
        this._killMode();
        return;
      }
      if (this.foreignMode || this.windowMode || this.searchMode || this.killMode) {
        this.openPalette();
        return;
      }
      this.close();
      return;
    }
    if (this.prompt) {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const { submit, stayOpen } = this.prompt;
        const value = this.input.value.trim();
        if (stayOpen) {
          if (value) submit(value);
          return;
        }
        this.close();
        if (value) submit(value);
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (!this.filtered.length) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      this.sel = (this.sel + d + this.filtered.length) % this.filtered.length;
      this.moved = true;
      this._renderList();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const item = this.filtered[this.sel];
      if (!item) return;
      if (item.keepOpen) {
        item.run();
      } else {
        this.close();
        item.run();
      }
    }
  }

  // resetSelection=false keeps the highlighted row when the list is rebuilt for
  // a reason the user did not trigger (late session/workspace enrichment).
  // Resetting there let Enter run a different item than the one highlighted.
  //
  // The kind prefixes apply to the command list only: in a sub-mode the input
  // narrows that mode's own rows, where `#` or `!` may be what is searched for.
  _refilter(resetSelection = true) {
    const raw = this.input.value.trim();
    const { kind, text: q } = this._inSubMode() ? { kind: null, text: raw } : parsePrefix(raw);
    // A late fill (saved workspaces, agent sessions) keeps the row only when
    // someone picked it with the arrows. Otherwise the first row stays first:
    // keeping whatever was row 0 before the fill pushed "close workspace view"
    // to the bottom and left it selected.
    if (resetSelection) this.moved = false;
    const previous = resetSelection || !this.moved ? null : this.filtered[this.sel];
    this.filtered = this.items
      .filter((item) => (kind ? rowGroup(item) === kind : q || !item.quiet))
      // `search` widens what an item can be found by without widening what it
      // shows. A snippet carries its description there, so "deploy" finds the
      // snippet described as the deploy step even though its name is `dp`.
      .map((item, i) => ({ item, i, score: fuzzyScore(q, item.search || item.label) }))
      .filter((x) => x.score >= 0)
      .sort((x, y) => y.score - x.score || x.i - y.i)
      .map((x) => x.item);
    const kept = previous ? this.filtered.findIndex((item) => item.label === previous.label) : -1;
    this.sel = kept >= 0 ? kept : 0;
    this._renderList();
  }

  _renderList() {
    this.listEl.textContent = "";
    if (!this.filtered.length) {
      const none = document.createElement("div");
      none.className = "palette-none";
      none.textContent = "no matches";
      this.listEl.appendChild(none);
      return;
    }
    this.filtered.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "palette-item" + (i === this.sel ? " sel" : "");
      row.id = `palette-option-${i}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === this.sel));
      const kind = document.createElement("span");
      kind.className = "kind";
      kind.textContent = item.kind;
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = item.label;
      row.appendChild(kind);
      row.appendChild(label);
      if (item.hint) {
        const hint = document.createElement("span");
        hint.className = "hint";
        hint.textContent = item.hint;
        row.appendChild(hint);
      }
      row.addEventListener("mousemove", () => {
        if (this.sel !== i) { this.sel = i; this._renderList(); }
      });
      row.addEventListener("mousedown", (e) => e.preventDefault()); // keep input focus
      row.addEventListener("click", () => {
        this.sel = i;
        if (item.keepOpen) item.run();
        else { this.close(); item.run(); }
      });
      this.listEl.appendChild(row);
      if (i === this.sel) row.scrollIntoView({ block: "nearest" });
    });
    const active = this.filtered.length ? `palette-option-${this.sel}` : "";
    if (active) this.input.setAttribute("aria-activedescendant", active);
    else this.input.removeAttribute("aria-activedescendant");
  }
}
