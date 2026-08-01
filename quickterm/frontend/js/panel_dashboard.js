import * as api from "./api.js";
import { icon } from "./icons.js";
import {
  countPanes, formatBytes, formatUptime, layoutSessionIds, make,
} from "./panel_shared.js";
export async function renderDashboard(refreshing = false) {
    this._dashLoading = true;
    if (!refreshing) {
      this.bodyEl.textContent = "";
      this.bodyEl.append(make("div", "panel-loading", "Collecting your workspace…"));
    }
    const scrollTop = refreshing ? this.bodyEl.scrollTop : 0;
    let workspaces;
    let sessions;
    try {
      const [names, sessionList] = await Promise.all([
        api.listWorkspaces().catch(() => []),
        api.getSessions().catch(() => []),
      ]);
      sessions = sessionList;
      workspaces = await Promise.all(names.map(async (name) => ({
        name,
        data: await api.getWorkspace(name).catch(() => null),
      })));
    } finally {
      this._dashLoading = false;
    }
    if (this.open !== "dashboard") return;
    this.bodyEl.textContent = "";
    if (refreshing) this.bodyEl.classList.add("no-entrance");
    else this.bodyEl.classList.remove("no-entrance");

    const hero = make("div", "dashboard-hero");
    const heroCopy = make("div", "hero-copy");
    heroCopy.append(
      make("span", "hero-kicker", "Workspace overview"),
      make("h2", "hero-title", this.app.currentWorkspace() || "Scratch"),
      make("p", "hero-text", "Open layouts, reattach background terminals, or clean up sessions from one place."),
    );
    const stats = make("div", "dashboard-stats");
    const liveSessions = sessions.filter((session) => session.alive);
    const measuredMemory = liveSessions.reduce((sum, session) =>
      sum + (session.usage?.available ? session.usage.working_set_bytes || 0 : 0), 0);
    const currentOwned = new Set(this.app.ownedSessionIds ? this.app.ownedSessionIds() : []);
    const currentLive = liveSessions.filter((session) => currentOwned.has(session.id));
    for (const [value, label] of [
      [workspaces.length, "workspaces"],
      [currentLive.length, "this workspace"],
      [liveSessions.length, "all live"],
      [formatBytes(measuredMemory), "host RAM"],
    ]) {
      const stat = make("div", "dashboard-stat");
      stat.append(make("strong", "", String(value).padStart(2, "0")), make("span", "", label));
      stats.append(stat);
    }
    hero.append(heroCopy, stats);
    this.bodyEl.append(hero);

    const usageSection = make("section", "dashboard-section usage-section");
    const usageHeading = this._sectionHeading(
      "Terminal usage",
      "Live host process-tree working set and sampled CPU. Figures are local estimates, not billing or enforcement data.",
    );
    if (liveSessions.length) {
      const killAll = this._button("Kill all terminals…", "secondary-button danger-text");
      killAll.addEventListener("click", () => {
        const count = liveSessions.length;
        const warning = `Stop ${count} live terminal${count === 1 ? "" : "s"} across all workspaces? Attached panes will close and unsaved shell work will be lost.`;
        this._confirmNear(killAll, warning, "Kill all", async () => {
          const result = await this.app.killAllSessions();
          if (this.open === "dashboard") this._dashboard(true);
          if (result.failed) {
            throw new Error(`${result.failed} terminal${result.failed === 1 ? "" : "s"} could not be stopped and remain visible.`);
          }
        });
      });
      usageHeading.append(killAll);
    }
    usageSection.append(usageHeading);
    const usageTable = make("div", "usage-table");
    if (!liveSessions.length) {
      usageTable.append(make("p", "detached-empty", "No live terminals to measure."));
    }
    for (const session of liveSessions) {
      const usage = session.usage || {};
      const row = make("div", "usage-row");
      const identity = make("div", "usage-identity");
      const ownership = currentOwned.has(session.id)
        ? "this workspace"
        : session.workspace ? `workspace ${session.workspace}` : "unassigned";
      const scope = usage.scope === "host-process-tree-partial-wsl"
        ? "host side only · WSL workload excluded"
        : `${ownership} · ${session.activity?.background_output_bytes > 0 ? "new background output" : (session.attachments > 0 ? "open" : "background")} · ${session.profile || "terminal"}`;
      identity.append(make("strong", "", session.name || session.id), make("small", "", scope));
      const values = make("div", "usage-values");
      const cpu = usage.cpu_percent == null ? "Sampling…" : `${usage.cpu_percent.toFixed(1)}%`;
      const metrics = [
        [usage.available ? formatBytes(usage.working_set_bytes) : "Unavailable", "RAM"],
        [usage.available ? cpu : "Unavailable", "CPU"],
        [String(usage.process_count || 0), "processes"],
        [formatUptime(usage.uptime_seconds), "uptime"],
      ];
      for (const [value, label] of metrics) {
        const cell = make("span", "usage-value");
        cell.append(make("strong", "", value), make("small", "", label));
        values.append(cell);
      }
      row.append(identity, values);
      usageTable.append(row);
    }
    usageSection.append(usageTable);
    this.bodyEl.append(usageSection);

    const workspaceSection = make("section", "dashboard-section");
    const wsHeading = this._sectionHeading("Workspaces", "Saved arrangements of terminals, folders and tools.");
    const saveForm = make("div", "save-workspace-form");
    const saveInput = this._textInput("", "Name this workspace");
    const saveButton = this._button("Save current", "primary-button");
    const saveNote = make("p", "save-workspace-note");
    let confirmOverwrite = null; // name armed for a second "really overwrite" click
    const existing = new Set(workspaces.map((workspace) => workspace.name));
    const save = async () => {
      const name = saveInput.value.trim();
      const problem = this.app.validateWorkspaceName ? this.app.validateWorkspaceName(name) : (name ? null : "Give the workspace a name.");
      if (problem) {
        saveNote.textContent = problem;
        saveInput.focus();
        return;
      }
      // Overwriting a different existing workspace loses its layout — ask once.
      const current = this.app.currentWorkspace && this.app.currentWorkspace();
      if (existing.has(name) && name !== current && confirmOverwrite !== name) {
        confirmOverwrite = name;
        saveButton.textContent = "Overwrite?";
        saveNote.textContent = `“${name}” already exists — save again to replace it.`;
        return;
      }
      saveButton.disabled = true;
      await this.app.saveWorkspace(name);
      if (this.open === "dashboard") this._dashboard(true);
    };
    saveButton.addEventListener("click", save);
    saveInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") save();
    });
    saveInput.addEventListener("input", () => {
      confirmOverwrite = null;
      saveButton.textContent = "Save current";
      saveNote.textContent = "";
    });
    saveForm.append(saveInput, saveButton);
    wsHeading.append(saveForm, saveNote);
    workspaceSection.append(wsHeading);

    const cards = make("div", "workspace-grid");
    if (!workspaces.length) {
      const empty = make("div", "workspace-empty-card");
      empty.append(make("span", "empty-orbit"), make("h3", "", "Your first workspace starts here"), make("p", "", "Arrange your terminals, give the layout a name, then save it above."));
      cards.append(empty);
    }
    for (const [index, workspace] of workspaces.entries()) {
      const layout = workspace.data && workspace.data.layout;
      const card = make("article", "workspace-card");
      const isCurrent = this.app.currentWorkspace && this.app.currentWorkspace() === workspace.name;
      if (isCurrent) card.classList.add("current");
      card.style.setProperty("--card-index", index);
      const top = make("div", "workspace-card-top");
      const badge = make("span", "workspace-badge", isCurrent ? "Open now" : `${countPanes(layout)} pane${countPanes(layout) === 1 ? "" : "s"}`);
      if (workspace.data && workspace.data.logo) {
        const logo = make("img", "workspace-card-logo");
        logo.src = api.assetUrl(workspace.data.logo);
        logo.alt = "";
        top.append(logo);
      }
      const menu = this._button("", "text-button danger-text");
      menu.append(icon("trash", 13), make("span", "", "Delete"));
      menu.addEventListener("click", (event) => {
        event.stopPropagation();
        this._confirmNear(menu, `Delete workspace “${workspace.name}” and stop its detached sessions?`, "Delete", async () => {
          const deleted = this.app.deleteWorkspace
            ? await this.app.deleteWorkspace(workspace.name)
            : await api.deleteWorkspace(workspace.name).then(() => true).catch(() => false);
          if (!deleted) throw new Error("Workspace could not be deleted.");
          await this._leave(card);
          if (this.open === "dashboard") this._dashboard(true);
        });
      });
      top.append(badge, menu);
      const preview = this._layoutPreview(layout);
      const footer = make("div", "workspace-card-footer");
      const name = make("div");
      name.append(make("h3", "", workspace.name), make("p", "", workspace.name === "scratch" ? "Disposable · gone when the app quits" : "Saved workspace"));
      const load = this._button("Open workspace", "card-open-button");
      load.addEventListener("click", () => {
        this.close();
        this.app.loadWorkspace(workspace.name);
      });
      footer.append(name, load);
      card.append(top, preview, footer);
      card.addEventListener("dblclick", () => load.click());
      cards.append(card);
    }
    workspaceSection.append(cards);
    this.bodyEl.append(workspaceSection);

    const sessionSection = make("section", "dashboard-section detached-section");
    const timeoutSeconds = this.app.idleTimeoutSeconds ?? 300;
    const timeoutCopy = timeoutSeconds <= 0
      ? "Untouched background shells are never expired automatically."
      : `Untouched background shells expire after ${Math.max(1, Math.round(timeoutSeconds / 60))} quiet minutes; used or busy sessions are kept.`;
    sessionSection.append(this._sectionHeading(
      "Detached sessions",
      timeoutCopy,
    ));
    const sessionGroups = make("div", "detached-groups");
    const currentName = (this.app.currentWorkspace && this.app.currentWorkspace()) || "scratch";
    const attachedHere = new Set(this.app.attachedSessionIds ? this.app.attachedSessionIds() : []);
    const liveById = new Map(sessions.filter((session) => session.alive).map((session) => [session.id, session]));
    const claimed = new Set();
    const groups = [];
    for (const workspace of workspaces) {
      if (!workspace.data) continue;
      const layoutIds = layoutSessionIds(workspace.data.layout);
      const owned = new Set(workspace.data.session_ids || []);
      for (const sid of layoutIds) owned.add(sid);
      if (workspace.name === currentName && this.app.ownedSessionIds) {
        for (const sid of this.app.ownedSessionIds()) owned.add(sid);
      }
      for (const sid of owned) claimed.add(sid);
      const detached = [...owned]
        .filter((sid) => !layoutIds.has(sid) && !attachedHere.has(sid))
        .map((sid) => liveById.get(sid))
        .filter((session) => session && !(session.attachments > 0));
      if (detached.length) groups.push({ name: workspace.name, sessions: detached });
    }
    if (!workspaces.some((workspace) => workspace.name === currentName) && this.app.ownedSessionIds) {
      const owned = new Set(this.app.ownedSessionIds());
      for (const sid of owned) claimed.add(sid);
      const detached = [...owned]
        .filter((sid) => !attachedHere.has(sid))
        .map((sid) => liveById.get(sid))
        .filter((session) => session && !(session.attachments > 0));
      if (detached.length) groups.push({ name: currentName, sessions: detached });
    }
    const unassigned = sessions.filter((session) =>
      session.alive && !(session.attachments > 0) && !claimed.has(session.id));
    if (unassigned.length) groups.push({ name: "Unassigned", sessions: unassigned });

    const sessionRow = (session, workspaceName, isCurrent) => {
      const row = make("div", "detached-session-row");
      const copy = make("div", "detached-session-copy");
      const unreadBytes = session.activity?.background_output_bytes || 0;
      const activity = unreadBytes > 0
        ? `New output ${formatBytes(unreadBytes)} · ${formatUptime(session.activity?.background_output_age_seconds || 0)} ago`
        : `Quiet ${formatUptime(session.activity?.idle_seconds || 0)} · ${session.id}`;
      copy.append(
        make("strong", "", session.name || session.id),
        make("small", "", `${session.profile || "terminal"} · ${activity}`),
      );
      const actions = make("div", "detached-session-actions");
      const attach = this._button(isCurrent ? "Attach" : "Move here & attach", "secondary-button compact");
      attach.addEventListener("click", async () => {
        this.close();
        if (isCurrent) this.app.attachSession(session);
        else await this.app.moveSessionHere(session, workspaceName === "Unassigned" ? null : workspaceName);
      });
      const kill = this._button("Kill", "text-button danger-text");
      kill.addEventListener("click", () => {
        this._confirmNear(kill, `Stop terminal “${session.name || session.id}”?`, "Kill", async () => {
          const stopped = await this.app.killWorkspaceSession(session, workspaceName === "Unassigned" ? null : workspaceName);
          if (!stopped) throw new Error("Terminal could not be stopped.");
          if (this.open === "dashboard") this._dashboard(true);
        });
      });
      actions.append(attach, kill);
      row.append(copy, actions);
      return row;
    };

    const currentGroup = groups.find((group) => group.name === currentName);
    if (currentGroup) {
      const group = make("section", "detached-group current");
      group.append(make("h3", "", currentName === "scratch" ? "Scratch" : currentName));
      for (const session of currentGroup.sessions) group.append(sessionRow(session, currentName, true));
      sessionGroups.append(group);
    }
    const otherGroups = groups.filter((group) => group !== currentGroup);
    if (otherGroups.length) {
      const other = make("details", "other-workspace-sessions");
      const count = otherGroups.reduce((sum, group) => sum + group.sessions.length, 0);
      other.append(make("summary", "", `Other workspaces · ${count} — explicit move required`));
      for (const item of otherGroups) {
        const group = make("section", "detached-group");
        group.append(make("h3", "", item.name));
        for (const session of item.sessions) group.append(sessionRow(session, item.name, false));
        other.append(group);
      }
      sessionGroups.append(other);
    }
    if (!groups.length) {
      sessionGroups.append(make("p", "detached-empty", "Nothing is detached. Alt+D puts a terminal here without stopping it."));
    }
    sessionSection.append(sessionGroups);
    this.bodyEl.append(sessionSection);

    const lower = make("div", "dashboard-lower");
    const profiles = make("section", "dashboard-list-card");
    profiles.append(this._sectionHeading("Quick launch", "Your terminal profiles"));
    const profileList = make("div", "quick-profile-list");
    if (!this.app.profiles.length) profileList.append(make("p", "quiet-empty", "No personal terminals yet. Create one in Settings — system shells are always available in the launcher."));
    for (const profile of this.app.profiles.slice(0, 6)) {
      const row = make("button", "quick-profile");
      row.type = "button";
      const mark = make("span", "profile-mark", (profile.name || "> ").slice(0, 2).toUpperCase());
      const copy = make("span", "quick-profile-copy");
      copy.append(make("strong", "", profile.name), make("small", "", this._terminalLabel(profile)));
      const arrow = make("span", "profile-arrow");
      arrow.append(icon("arrow-up-right", 13));
      row.append(mark, copy, arrow);
      row.addEventListener("click", () => {
        this.close();
        this.app.runProfile(profile);
      });
      profileList.append(row);
    }
    profiles.append(profileList);

    lower.append(profiles);
    this.bodyEl.append(lower);
    this.bodyEl.scrollTop = scrollTop;
  }
