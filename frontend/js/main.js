// Boot: fetch config/profiles/sessions, build chrome, create the layout
// with one pane running the default profile (or reattach a live session).

import * as api from "./api.js";
import { LayoutManager } from "./layout.js";
import { Palette } from "./palette.js";
import { Panels } from "./panels.js";
import { initLauncher } from "./launcher.js";
import { initKeys } from "./keys.js";
import * as workspace from "./workspace.js";

document.title = "QuickTerm";

const $ = (id) => document.getElementById(id);

async function boot() {
  let cfg = { font_family: "JetBrains Mono", profiles: [], snippets: [], voice_available: false };
  const [c, p, s] = await Promise.all([
    api.getConfig().catch(() => null),
    api.getProfiles().catch(() => null),
    api.getSessions().catch(() => []),
  ]);
  if (c) cfg = c;
  let profiles = p || cfg.profiles || [];
  let snippets = cfg.snippets || [];
  const initialSessions = s || [];

  let currentWorkspace = "default";
  let statusTimer = null;

  const layout = new LayoutManager($("grid"), $("zoom-host"), {
    fontFamily: cfg.font_family || "JetBrains Mono",
    onFocusChange: (pane) => {
      if (pane && pane.session && pane.state === "attached") {
        api.postFocus(pane.session.id).catch(() => {});
      }
    },
    onPaneState: () => refreshStatusSoon(),
  });

  function defaultProfile() {
    return (
      profiles.find((x) => x.name === cfg.default_profile) ||
      profiles.find((x) => x.name === "powershell") ||
      profiles[0] ||
      null
    );
  }

  function autoDir(pane) {
    const r = pane.el.getBoundingClientRect();
    return r.width > r.height * 1.8 ? "h" : "v";
  }

  async function spawnInto(pane, profileName, cwd) {
    try {
      const info = await api.createSession({ profile: profileName });
      pane.profileName = profileName;
      if (cwd) pane.cwd = cwd;
      pane.attach(info);
      if (layout.focused === pane) api.postFocus(info.id).catch(() => {});
      refreshStatusSoon();
    } catch (e) {
      pane.showNotice(`[spawn failed: ${profileName}]`);
    }
  }

  function spawnDefaultInto(pane) {
    const dp = defaultProfile();
    if (dp) spawnInto(pane, dp.name, dp.cwd || null);
  }

  // Spawn a profile into the focused pane region: replace if the pane is
  // empty/exited, otherwise split and spawn into the new pane.
  async function runProfile(profile) {
    let pane = layout.focused || layout.init();
    if (!pane.canReplace) pane = layout.splitPane(pane, autoDir(pane));
    if (!pane) return;
    layout.focusPane(pane);
    await spawnInto(pane, profile.name, profile.cwd || null);
  }

  function attachSession(info) {
    let pane = layout.focused || layout.init();
    if (!pane.canReplace) pane = layout.splitPane(pane, autoDir(pane));
    if (!pane) return;
    layout.focusPane(pane);
    pane.attach(info);
    api.postFocus(info.id).catch(() => {});
    refreshStatusSoon();
  }

  const app = {
    profiles,
    snippets,
    runProfile,
    attachSession,
    splitH: () => { const np = layout.splitFocused("h"); if (np) spawnDefaultInto(np); },
    splitV: () => { const np = layout.splitFocused("v"); if (np) spawnDefaultInto(np); },
    zoom: () => layout.toggleZoom(),
    closePane: () => { layout.closePane(); refreshStatusSoon(); },
    killFocusedSession: () => {
      const pane = layout.focused;
      if (pane && pane.session) {
        api.killSession(pane.session.id).catch(() => {});
        refreshStatusSoon();
      }
    },
    sendSnippet: (sn) => {
      if (layout.focused) layout.focused.sendText(sn.text);
    },
    saveWorkspace: async (name) => {
      try {
        await workspace.save(name, layout.serialize());
        currentWorkspace = name;
        refreshStatusSoon();
      } catch (e) { /* backend rejected; leave name unchanged */ }
    },
    loadWorkspace: async (name) => {
      let lay;
      try { lay = await workspace.load(name); } catch (e) { return; }
      const panes = layout.restore(lay);
      currentWorkspace = name;
      for (const pane of panes) {
        if (pane.profileName) spawnInto(pane, pane.profileName, pane.cwd);
      }
      refreshStatusSoon();
    },
    attachedSessionIds: () =>
      layout.panes()
        .filter((x) => x.session && x.state === "attached")
        .map((x) => x.session.id),
    refocusTerm: () => { if (layout.focused) layout.focused.setFocused(true); },
    // settings saved: refresh profiles/snippets and rebuild the launcher
    onConfigSaved: async () => {
      const fresh = await api.getConfig().catch(() => null);
      if (!fresh) return;
      cfg = fresh;
      profiles = fresh.profiles || [];
      snippets = fresh.snippets || [];
      app.profiles = profiles;
      app.snippets = snippets;
      buildLauncher();
    },
  };

  const palette = new Palette(app);
  const panels = new Panels(app);
  app.openPanel = (name) => panels.show(name);

  initKeys({
    togglePalette: () => { panels.close(); palette.toggle(); },
    paletteOpen: () => palette.open || panels.open !== null,
    splitH: app.splitH,
    splitV: app.splitV,
    zoom: app.zoom,
    closePane: app.closePane,
    focusDir: (d) => layout.focusDir(d),
  });

  function buildLauncher() {
    initLauncher($("launcher"), profiles, (profile) => runProfile(profile), [
      ["dashboard", () => panels.toggle("dashboard")],
      ["settings", () => panels.toggle("settings")],
      ["help", () => panels.toggle("help")],
    ]);
  }
  buildLauncher();

  // ---- status bar ----

  function refreshStatus() {
    $("sb-workspace").textContent = `ws ${currentWorkspace}`;
    api.getSessions().then((list) => {
      const n = list.filter((x) => x.alive).length;
      $("sb-sessions").textContent = `${n} session${n === 1 ? "" : "s"}`;
    }).catch(() => {
      $("sb-sessions").textContent = "offline";
    });
  }

  function refreshStatusSoon() {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(refreshStatus, 250);
  }

  function tickClock() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    $("sb-clock").textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  $("voice-indicator").textContent = cfg.voice_available ? "voice" : "";
  tickClock();
  setInterval(tickClock, 15000);
  refreshStatus();
  setInterval(refreshStatus, 10000);

  // ---- initial layout: reattach all live sessions (spiral grid, capped)
  // or spawn the default profile into a single pane ----

  const pane = layout.init();
  const alive = initialSessions.filter((x) => x.alive);
  if (alive.length) {
    pane.attach(alive[0]);
    let p = pane;
    for (const info of alive.slice(1, 8)) {
      p = layout.splitPane(p, autoDir(p));
      if (!p) break;
      p.attach(info);
    }
    layout.focusPane(pane);
    api.postFocus(alive[0].id).catch(() => {});
  } else {
    const starters = profiles.filter((profile) => profile.autostart);
    if (!starters.length) {
      spawnDefaultInto(pane);
    } else {
      spawnInto(pane, starters[0].name, starters[0].cwd || null);
      let current = pane;
      for (const profile of starters.slice(1, 8)) {
        current = layout.splitPane(current, autoDir(current));
        if (!current) break;
        spawnInto(current, profile.name, profile.cwd || null);
      }
      layout.focusPane(pane);
    }
  }
}

boot();
