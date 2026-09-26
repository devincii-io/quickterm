// One pane: xterm.js Terminal + FitAddon (+WebGL when possible) + one WS
// to /ws/session/{id}. Implements the CONTRACTS.md attach protocol:
// replay_size -> resize to recorded size, write scrollback, replay_done ->
// fit to real size and send resize. Client-side backpressure via
// term.write callbacks; reconnect with backoff on unexpected close.

import * as api from "./api.js";
import { getTheme, DEFAULT_THEME } from "./themes.js";
import { PaneAttachProtocol } from "./pane_protocol.js";
import { claimFocus, releaseFocus, terminalMayFocus } from "./focus.js";
import { RealInputGate } from "./broadcast.js";
import { findInBuffer } from "./buffer_search.js";

const ENC = new TextEncoder();
// Written between a dead session's last output and its restart, which
// attaches without the replay's reset. The dead program's input modes
// (mouse reporting, bracketed paste, application cursor keys) would otherwise
// shape what the new shell receives, and its colours would bleed into it.
const RESTART_RESET = "\x1b[0m\x1b[?25h\x1b[?1l\x1b>\x1b[?1000l\x1b[?1002l\x1b[?1003l"
  + "\x1b[?1006l\x1b[?1015l\x1b[?1004l\x1b[?2004l";
const RESTART_MARK = "\x1b[2m[restarted]\x1b[0m\r\n";
const PENDING_LIMIT = 1 << 20; // ~1 MiB unwritten -> pause processing
const CLIENT_QUEUE_LIMIT = 2 << 20; // reconnect before sustained output grows JS heap
const OSC52_MAX_BYTES = 1 << 20; // clipboard writes from terminal output
const OSC52_MAX_BASE64 = Math.ceil(OSC52_MAX_BYTES / 3) * 4;
let nativeDropPane = null;

if (typeof window !== "undefined") {
  window.quicktermNativeDrop = (paths) => {
    if (!nativeDropPane || nativeDropPane._disposed) return false;
    return nativeDropPane.pasteDroppedPaths(Array.isArray(paths) ? paths : []);
  };
}

// File-path links (Ctrl+click): quoted paths may contain spaces; bare ones
// stop at whitespace/quotes. Windows drive + UNC, POSIX absolute, ~ paths.
// URLs are handled separately by the web-links addon.
const FILE_PATH_RE = /"([A-Za-z]:[\\/][^"]+|\\\\[^"]+|~[\\/][^"]+)"|((?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/(?!\/))[^\s"'`<>|]+)/g;

// Only linkify from a sane left boundary so "and/or" or the tail of a URL
// never lights up. ':' and '=' are allowed before Windows/~ paths ("saved
// to: C:\x") but not before bare "/..." (that is how URLs would re-match).
function pathBoundaryOk(ch, path) {
  if (ch === "" || ch === " " || ch === "\t" || ch === '"' || ch === "'" || ch === "(" || ch === "[") return true;
  return (ch === ":" || ch === "=" || ch === ",") && !path.startsWith("/");
}

function makeFilePathProvider(term, activate) {
  return {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) { callback(undefined); return; }
      const text = line.translateToString(true);
      const links = [];
      FILE_PATH_RE.lastIndex = 0;
      let match;
      while ((match = FILE_PATH_RE.exec(text))) {
        const quoted = match[1] !== undefined;
        let path = quoted ? match[1] : match[2];
        if (!quoted) path = path.replace(/[.,;:!?)\]}]+$/, ""); // trailing prose punctuation
        const startIdx = match.index + (quoted ? 1 : 0);
        const boundary = match.index === 0 ? "" : text[match.index - 1];
        if (!pathBoundaryOk(boundary, path) || path.length < 3) continue;
        links.push({
          range: { start: { x: startIdx + 1, y }, end: { x: startIdx + path.length, y } },
          text: path,
          activate,
        });
      }
      callback(links.length ? links : undefined);
    },
  };
}
// Quiet for this long and a Claude pane reads as idle. Long enough that the
// gaps inside one streamed answer do not flicker the badge.
const ACTIVITY_IDLE_MS = 2500;
const BACKOFF_MIN = 500;
const BACKOFF_MAX = 8000;
const FIT_DEBOUNCE_MS = 50;

// The backend is always on this machine (loopback only), so the client's
// platform is the platform every path is resolved on.
function clientIsWindows() {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent || "");
}

// A POSIX shell reports OSC 7 as file://<its hostname>/path. Reading that host
// as a UNC server turned every split's cwd on Linux into \\host\path and the
// split failed. Only Windows has UNC shares, and there only a host other than
// localhost names one; a drive-letter path is local whatever host it carries.
export function fileUrlToPath(value, { windows = clientIsWindows() } = {}) {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const path = decodeURIComponent(url.pathname || "");
    if (/^\/[A-Za-z]:\//.test(path)) return path.slice(1).replaceAll("/", "\\");
    const host = (url.hostname || "").toLowerCase();
    if (windows && host && host !== "localhost") return `\\\\${url.hostname}${path.replaceAll("/", "\\")}`;
    return path;
  } catch (_) {
    return null;
  }
}

export function droppedFilePaths(dataTransfer) {
  if (!dataTransfer) return [];
  const paths = [];
  const add = (value) => {
    const path = String(value || "").trim();
    if (path && !paths.includes(path)) paths.push(path);
  };
  for (const file of dataTransfer.files || []) {
    // WebView hosts may expose a desktop-only File.path. Standard Chromium
    // deliberately does not; never substitute File.name because that is not a
    // usable path and could point at the wrong file in the shell's cwd.
    if (typeof file.path === "string" && file.path) add(file.path);
  }
  for (const type of ["text/uri-list", "text/plain"]) {
    let text = "";
    try { text = dataTransfer.getData(type) || ""; } catch (_) { /* unavailable */ }
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const path = fileUrlToPath(line.trim());
      if (path) add(path);
    }
  }
  return paths;
}

export function quoteDroppedPath(path, shellHint = "") {
  const hint = shellHint.toLowerCase();
  if (hint.includes("command prompt") || /(^|\W)cmd(?:\.exe)?(\W|$)/.test(hint)) {
    return `"${path.replaceAll('"', '""')}"`;
  }
  if (hint.includes("powershell") || hint.includes("pwsh") || /^[A-Za-z]:\\/.test(path)) {
    return `'${path.replaceAll("'", "''")}'`;
  }
  return `'${path.replaceAll("'", "'\\''")}'`;
}

export function windowsPathForWsl(path) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (!match) return path;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

export function parseOscCwd(code, data, terminalType = null) {
  let value = String(data || "");
  if (code === 9) {
    if (!value.startsWith("9;")) return null;
    value = value.slice(2);
  } else if (code !== 7) {
    return null;
  }
  if (!value || value.length > 4096 || /[\x00-\x1f]/.test(value)) return null;
  if (value.startsWith("file:")) {
    if (terminalType === "wsl") {
      try {
        const url = new URL(value);
        return url.protocol === "file:" ? decodeURIComponent(url.pathname || "") || null : null;
      } catch (_) { return null; }
    }
    return fileUrlToPath(value);
  }
  return value;
}

export class Pane {
  constructor(opts = {}) {
    this.fontFamily = opts.fontFamily || "JetBrains Mono";
    this.fontSize = opts.fontSize || 14;
    this.theme = opts.theme || getTheme(DEFAULT_THEME).xterm;
    this.onFocusRequest = opts.onFocusRequest || (() => {});
    this.onStateChange = opts.onStateChange || (() => {});
    this.onActionRequest = opts.onActionRequest || (() => {});
    // Real input typed here, for broadcast (layout.js decides who else gets it).
    this.onUserInput = opts.onUserInput || (() => {});
    this.profileName = opts.profile || null;
    this.cwd = opts.cwd || null;
    this.currentCwd = this.cwd;
    this.savedSessionId = opts.sessionId || null;
    this.launchSpec = opts.launchSpec || null;
    // Claude mode, start command or args beyond the profile (launch_options.js).
    this.launchOptions = opts.launchOptions || null;
    this.terminalType = opts.terminalType || null;
    this.title = opts.title || null; // user-given name, wins over session name
    this.userWrote = false;    // real keystrokes/paste in this pane
    this.spawnedFresh = false; // session was created by this pane (vs reattached)
    this.spawnPending = false;
    this.closeArmed = false;   // busy-close guard: next close press proceeds
    this._closeArmTimer = null;

    this.session = null;
    this.state = "empty"; // empty | attached | exited
    this.term = null;
    this.fit = null;
    this.ws = null;
    this._webgl = null;

    this._protocol = new PaneAttachProtocol(CLIENT_QUEUE_LIMIT);
    this._queue = [];
    this._pending = 0;

    this._backoff = BACKOFF_MIN;
    this._reconnectTimer = null;
    this._fitTimer = null;
    this._detached = false;
    this._exited = false;
    this._resync = false; // last close was a 1013 overflow: reconnect to replay
    this._disposed = false;
    this._exitCode = null;
    this._keepScreen = false; // the next attach is a restart in place
    this._keepScreenGeneration = null;
    this._stateBeforeSpawn = null;
    this._pendingReveal = null; // a search hit to show once the replay is in
    this._inputGate = new RealInputGate();

    const el = document.createElement("div");
    el.className = "pane";
    el.innerHTML =
      '<div class="pane-tab" title="Drag to move · double-click to rename"><span class="pane-tab-dot"></span><span class="pane-tab-name"></span><span class="pane-tab-activity" hidden></span></div>' +
      '<div class="pane-actions" aria-label="Pane actions">' +
        '<button class="pane-action" type="button" data-action="split-h" title="Split right (Alt+Shift+Right)">|</button>' +
        '<button class="pane-action" type="button" data-action="split-v" title="Split below (Alt+Shift+Down)">─</button>' +
        '<button class="pane-action" type="button" data-action="zoom" title="Zoom pane (Alt+Z)">□</button>' +
        // "×" means "close this view" everywhere else, so it detaches: the
        // terminal keeps running. Killing is a separate, labelled danger
        // control, never the glyph a user reaches for to tidy up a pane.
        '<button class="pane-action detach" type="button" data-action="detach" title="Close view; the terminal keeps running (Alt+D)">×</button>' +
        '<span class="pane-action-sep" aria-hidden="true"></span>' +
        '<button class="pane-action kill danger" type="button" data-action="kill" title="Kill the terminal and everything running in it (Alt+W)">Kill</button>' +
      '</div>' +
      '<div class="term-host"></div>' +
      '<div class="pane-empty">no session &middot; alt+k</div>' +
      '<div class="pane-dim"></div>' +
      '<div class="pane-exitbar" hidden></div>';
    this.el = el;
    el.style.background = this.theme.background;
    this.termHost = el.querySelector(".term-host");
    this.emptyEl = el.querySelector(".pane-empty");
    this.exitBar = el.querySelector(".pane-exitbar");
    this.tabEl = el.querySelector(".pane-tab");
    this.tabNameEl = el.querySelector(".pane-tab-name");
    this.tabDotEl = el.querySelector(".pane-tab-dot");
    this.tabActivityEl = el.querySelector(".pane-tab-activity");
    this.tabEl.addEventListener("dblclick", (e) => { e.stopPropagation(); this._startRename(); });
    el.querySelector(".pane-actions").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      this.onFocusRequest(this);
      this.onActionRequest(button.dataset.action, this);
      requestAnimationFrame(() => this.focusSoon());
    });
    el.addEventListener("mousedown", () => this.onFocusRequest(this));
    this._wireDrop();
    this._renderTab();

    this._ro = new ResizeObserver(() => this.fitSoon());
    this._ro.observe(el);
  }

  get canReplace() {
    return !this.spawnPending && (this.state === "empty" || this.state === "exited");
  }

  // An exited terminal, or a saved one that is no longer running: both can be
  // started again with the launch this pane remembers.
  get canRestart() {
    return !this.spawnPending && (this.state === "exited" || this.state === "missing");
  }

  get _phase() { return this._protocol.phase; }
  get _generation() { return this._protocol.generation; }

  bestKnownCwd() { return this.currentCwd || this.cwd || null; }

  setLaunchCwd(cwd) {
    this.cwd = cwd || null;
    this.currentCwd = this.cwd;
  }

  // The next attach continues below what is on screen instead of resetting
  // it, so a restart keeps the dead session's last output (the reason it was
  // restarted is usually right there). A later reattach replays as usual.
  keepScreenOnNextAttach() {
    this._keepScreen = Boolean(this.term);
  }

  beginSpawn() {
    if (this.spawnPending) return false;
    this._clearRecovery();
    this._stateBeforeSpawn = this.state;
    this.spawnPending = true;
    this.state = "spawning";
    if (this._keepScreen) {
      this.showNotice("[restarting…]");
    } else {
      this.emptyEl.hidden = false;
      this.emptyEl.textContent = "starting terminal…";
    }
    this._renderTab();
    return true;
  }

  endSpawn() {
    this.spawnPending = false;
    this._keepScreen = false;
    // A failed restart leaves an exited pane exited, so Enter can try again;
    // "empty" would hide the output it still shows and drop the way back.
    if (this.state === "spawning") {
      this.state = this._stateBeforeSpawn === "exited" && this.term ? "exited" : "empty";
    }
    this.emptyEl.textContent = "no session · alt+k";
    this._renderTab();
  }

  setFocused(focused) {
    this.el.classList.toggle("focused", focused);
    if (focused) this.focusSoon();
    // An armed confirmation belongs to the pane the user is in. Moving to
    // another pane drops it, so no bar waits armed on a terminal nobody is
    // looking at and no later Enter lands on it by surprise.
    else if (this._confirmation) this.cancelConfirmation();
  }

  // The zoomed pane keeps its header, because it is the only place the way
  // back can live; the zoom control flips to "show all" while it is.
  setZoomed(zoomed) {
    this.el.classList.toggle("zoomed", zoomed);
    const button = this.el.querySelector('.pane-action[data-action="zoom"]');
    if (!button) return;
    button.textContent = zoomed ? "▣" : "□";
    button.title = zoomed ? "Show all panes (Alt+Z)" : "Zoom pane (Alt+Z)";
    button.classList.toggle("active", zoomed);
  }

  focusSoon() {
    const focus = () => {
      // Async spawn/replay callbacks from an older pane must never steal focus
      // after the user has already moved elsewhere.
      if (this._disposed || !this.term || !this.el.classList.contains("focused")) return;
      // …nor after an overlay opened. These calls are deliberately deferred to
      // a frame and a timeout, which puts them *after* whatever the palette or
      // a panel focused, so the guard has to be re-checked here and not only
      // at the call site.
      if (!terminalMayFocus()) return;
      try { this.term.focus(); } catch (_) { /* terminal is being recreated */ }
    };
    focus();
    requestAnimationFrame(focus);
    setTimeout(focus, 0);
  }

  setTheme(theme) {
    this.theme = theme;
    this.el.style.background = theme.background;
    if (this.term) this.term.options.theme = theme;
  }

  setFontSize(px) {
    this.fontSize = px;
    if (this.term) {
      this.term.options.fontSize = px;
      this.fitSoon();
    }
  }

  setFontFamily(family) {
    this.fontFamily = family || "JetBrains Mono";
    if (this.term) {
      this.term.options.fontFamily = `"${this.fontFamily}", "JetBrains Mono", "Cascadia Mono", Consolas, monospace`;
      this.fitSoon();
    }
  }

  displayName() {
    return this.title
      || (this.session && this.session.name)
      || this.profileName
      || (this.launchSpec && this.launchSpec.name)
      || "terminal";
  }

  // Stable hue from the name so the same terminal keeps its color everywhere.
  _renderTab() {
    const name = this.displayName();
    this.tabNameEl.textContent = name;
    this.el.dataset.state = this.state;
    this._renderActivity();
  }

  // Claude panes say whether Claude is still producing output. The signal is
  // the live byte stream this pane already receives, never an OS process
  // snapshot: the status poll runs with metrics off on purpose, and the app
  // promises it does not sample processes continuously. Child-process presence
  // would also read wrong here, because Claude thinking between tool calls has
  // no child and is still working.
  _renderActivity() {
    const el = this.tabActivityEl;
    if (!el) return;
    if (this.terminalType !== "claude-code" || this.state !== "attached") {
      el.hidden = true;
      this._stopActivityTicker();
      return;
    }
    const working = Date.now() - (this._lastOutputAt || 0) < ACTIVITY_IDLE_MS;
    el.hidden = false;
    el.textContent = working ? "working" : "idle";
    el.classList.toggle("working", working);
    el.title = working
      ? "Claude produced output in the last few seconds"
      : "No output from Claude recently";
    this._startActivityTicker();
  }

  _startActivityTicker() {
    if (this._activityTimer) return;
    this._activityTimer = setInterval(() => this._renderActivity(), 1000);
  }

  _stopActivityTicker() {
    clearInterval(this._activityTimer);
    this._activityTimer = null;
  }

  // A rename that happened elsewhere (the sidebar row). The backend already
  // knows; this pane only has to show it and let the workspace save it.
  setTitle(value, info = null) {
    const name = String(value || "").trim();
    if (!name) return;
    this.title = name;
    if (info && this.session && this.session.id === info.id) this.session = info;
    this._renderTab();
    this.onStateChange(this);
  }

  _startRename() {
    if (this.tabEl.querySelector("input")) return;
    const input = document.createElement("input");
    input.className = "pane-tab-input";
    input.value = this.displayName();
    input.spellcheck = false;
    this.tabNameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      input.replaceWith(this.tabNameEl);
      if (!save || !value || value === this.displayName()) { this._renderTab(); return; }
      this.title = value;
      this._renderTab();
      if (this.session) {
        api.renameSession(this.session.id, value).then((info) => {
          if (info && this.session && this.session.id === info.id) this.session = info;
        }).catch(() => {});
      }
      this.onStateChange(this); // persist the new title into the workspace
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") commit(true);
      else if (e.key === "Escape") commit(false);
    });
    input.addEventListener("blur", () => commit(true));
  }

  showNotice(text) {
    if (this._confirmation) this.cancelConfirmation();
    this._clearRecovery();
    this.exitBar.classList.remove("confirming", "exited");
    this.exitBar.textContent = text;
    this.exitBar.hidden = false;
    const live = document.getElementById("live-status");
    if (live) live.textContent = text.replace(/^\[|\]$/g, "");
  }

  // An exited pane keeps its final output and offers to start the same launch
  // again. Enter does that from the keyboard (input is off here anyway), so
  // the button never takes the keyboard from the terminal.
  _renderExitBar() {
    const text = this._exitCode === null ? "[exited]" : `[exited · code ${this._exitCode}]`;
    const copy = document.createElement("span");
    copy.className = "pane-confirm-copy";
    copy.textContent = text;
    const actions = document.createElement("span");
    actions.className = "pane-confirm-actions";
    const restart = document.createElement("button");
    restart.type = "button";
    restart.className = "pane-exit-restart";
    restart.textContent = "Restart";
    restart.title = "Start this terminal again the way it was started (Enter)";
    restart.addEventListener("mousedown", (event) => event.preventDefault());
    restart.addEventListener("click", (event) => {
      event.stopPropagation();
      this.requestRestart();
    });
    actions.append(restart);
    this.exitBar.textContent = "";
    this.exitBar.append(copy, actions);
    this.exitBar.classList.add("confirming", "exited");
    this.exitBar.hidden = false;
    const live = document.getElementById("live-status");
    if (live) live.textContent = text.replace(/^\[|\]$/g, "");
  }

  requestRestart() {
    if (!this.canRestart) return false;
    this.onFocusRequest(this);
    this.onActionRequest("restart", this);
    return true;
  }

  markUnavailable(opts = {}) {
    this._renderRecovery(opts, null);
  }

  // Every recovery action runs through spawnInto(), which begins with
  // _clearRecovery() and, on failure, showNotice(). Both detach these nodes.
  // So a failed attempt re-renders the whole bar from the same descriptor
  // instead of writing into detached DOM and leaving a bare empty pane.
  _renderRecovery({ exitCode = null, onRestart, onResumeClaude, onPickClaude } = {}, errorText = null) {
    const opts = { exitCode, onRestart, onResumeClaude, onPickClaude };
    this._clearRecovery();
    clearTimeout(this._noticeTimer);
    this.session = null;
    this.state = "missing";
    this.emptyEl.hidden = false;
    this.emptyEl.textContent = "saved terminal is not running";
    this._renderTab();
    const copy = document.createElement("span");
    copy.className = "pane-confirm-copy";
    copy.textContent = errorText || (exitCode === null
      ? "Live session unavailable. Nothing was silently restarted."
      : `Session exited with code ${exitCode}. Nothing was silently restarted.`);
    const actions = document.createElement("span");
    actions.className = "pane-recovery-actions";
    const makeAction = (label, action, primary = false) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      if (primary) button.classList.add("primary");
      button.addEventListener("click", async () => {
        for (const item of actions.querySelectorAll("button")) item.disabled = true;
        try {
          const recovered = await action();
          if (!recovered && !this._disposed) {
            this._renderRecovery(opts, "Recovery did not start. The previous session was not replaced.");
          }
        } catch (error) {
          if (this._disposed) return;
          this._renderRecovery(opts, error?.detail || "Recovery failed. The previous session was not replaced.");
        }
      });
      actions.append(button);
    };
    if (onResumeClaude) makeAction("Continue latest", onResumeClaude, true);
    if (onPickClaude) makeAction("Choose session", onPickClaude);
    if (onRestart) makeAction("Start replacement shell", onRestart, !onResumeClaude);
    this.exitBar.textContent = "";
    this.exitBar.append(copy, actions);
    this.exitBar.classList.add("confirming", "recovering");
    this.exitBar.hidden = false;
    this._recovery = { actions, opts };
  }

  _clearRecovery() {
    if (!this._recovery) return;
    this._recovery = null;
    this.exitBar.classList.remove("confirming", "recovering");
    this.exitBar.hidden = true;
  }

  _wireDrop() {
    let depth = 0;
    const accepts = (event) => {
      const types = [...(event.dataTransfer?.types || [])];
      return types.includes("Files") || types.includes("text/uri-list");
    };
    this.el.addEventListener("dragenter", (event) => {
      if (!accepts(event)) return;
      event.preventDefault();
      nativeDropPane = this;
      depth += 1;
      this.el.classList.add("drop-target");
    });
    this.el.addEventListener("dragover", (event) => {
      if (!accepts(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
    this.el.addEventListener("dragleave", (event) => {
      if (!accepts(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) this.el.classList.remove("drop-target");
    });
    this.el.addEventListener("drop", (event) => {
      if (!accepts(event)) return;
      event.preventDefault();
      depth = 0;
      this.el.classList.remove("drop-target");
      this.onFocusRequest(this);
      const paths = droppedFilePaths(event.dataTransfer);
      if (!paths.length) {
        clearTimeout(this._dropFallbackTimer);
        this._dropFallbackTimer = setTimeout(() => {
          this.flashNotice("[full file path unavailable · use Copy as path, then Ctrl+V]");
        }, 400);
        return;
      }
      this.pasteDroppedPaths(paths);
    });
  }

  pasteDroppedPaths(paths) {
    clearTimeout(this._dropFallbackTimer);
    const clean = paths.filter((path) => typeof path === "string" && path);
    if (!clean.length) return false;
    if (this.terminalType === "ssh" || this.terminalType === "sftp") {
      this.flashNotice("[local file paths are unavailable inside a remote terminal]");
      return false;
    }
    const mapped = this.terminalType === "wsl" ? clean.map(windowsPathForWsl) : clean;
    const signature = mapped.join("\0");
    const now = Date.now();
    if (signature === this._lastDropSignature && now - (this._lastDropAt || 0) < 1000) return true;
    this._lastDropSignature = signature;
    this._lastDropAt = now;
    const hint = [this.terminalType, this.displayName(), this.profileName, this.launchSpec?.cmd]
      .filter(Boolean).join(" ");
    // Only claim the paste happened if the bytes actually reached the PTY.
    // An empty, exited or reconnecting pane silently drops them, and the
    // dedupe window below would then swallow the user's retry.
    if (!this.sendText(mapped.map((path) => quoteDroppedPath(path, hint)).join(" "))) {
      this._lastDropSignature = null;
      if (this.state !== "exited") this.flashNotice("[no live terminal here · nothing was pasted]");
      return false;
    }
    this.flashNotice(`[pasted ${mapped.length} file path${mapped.length === 1 ? "" : "s"}]`);
    return true;
  }

  // Short-lived notice (e.g. "no room to split") that cleans up after itself.
  flashNotice(text, ms = 2000) {
    if (this._recovery) {
      const live = document.getElementById("live-status");
      if (live) live.textContent = text.replace(/^\[|\]$/g, "");
      return;
    }
    this.showNotice(text);
    clearTimeout(this._noticeTimer);
    clearTimeout(this._dropFallbackTimer);
    this._noticeTimer = setTimeout(() => {
      // A confirmation or recovery bar rendered into the same element since
      // this timer was armed must never be hidden out from under the user.
      if (this._confirmation || this._recovery) return;
      // The notice covered an exited pane's bar; put its Restart back.
      if (this.state === "exited") this._renderExitBar();
      else if (!this.closeArmed) this.exitBar.hidden = true;
    }, ms);
  }

  // `focusConfirm` is for the keyboard path: Alt+W is the user asking for
  // this bar, so Enter or a second Alt+W completes it. A bar that appeared
  // from a pointer press keeps Cancel first (see AGENTS.md).
  confirmAction(message, action, confirmLabel = "Kill", { focusConfirm = false } = {}) {
    this.cancelConfirmation();
    clearTimeout(this._noticeTimer);
    // Alt+W arms this bar without the pointer ever touching the header, so mark
    // the control the shortcut stands for. The user has already decided to
    // kill; showing which button that was makes the confirmation legible
    // instead of a bar appearing from nowhere.
    this._armedAction = this.el.querySelector(`.pane-action[data-action="${confirmLabel === "Kill" ? "kill" : "detach"}"]`);
    if (this._armedAction) this._armedAction.classList.add("armed");
    const text = document.createElement("span");
    text.className = "pane-confirm-copy";
    text.textContent = message;
    const actions = document.createElement("span");
    actions.className = "pane-confirm-actions";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "pane-confirm-accept";
    confirm.textContent = confirmLabel;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "pane-confirm-cancel";
    cancel.textContent = "Cancel";
    actions.append(confirm, cancel);
    this.exitBar.textContent = "";
    this.exitBar.append(text, actions);
    this.exitBar.classList.add("confirming");
    this.exitBar.hidden = false;

    const run = async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      try {
        await action();
        if (!this._disposed) this.cancelConfirmation();
      } catch (error) {
        if (this._disposed) return;
        text.textContent = error?.detail || "Action failed. Try again.";
        confirm.textContent = "Retry";
        confirm.disabled = false;
        cancel.disabled = false;
        confirm.focus();
      }
    };
    confirm.addEventListener("click", run);
    cancel.addEventListener("click", () => this.cancelConfirmation(true));
    // Escape cancels from anywhere in the pane, not only while a button has
    // focus: a click back into the terminal used to leave the bar armed and
    // send the Escape to the shell. Capture runs before xterm sees the key.
    const keyHandler = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.cancelConfirmation(true);
      }
    };
    this.el.addEventListener("keydown", keyHandler, true);
    this._confirmation = { confirm, cancel, keyHandler, label: confirmLabel };
    // The bar owns the keyboard while it is up, or the pane's deferred
    // term.focus() calls take it back a frame later (focus.js).
    claimFocus("pane-confirm");
    // A bar the user did not ask for keeps Cancel first, so a reflexive Enter
    // never completes a destructive action. The keyboard path asked for it.
    requestAnimationFrame(() => (focusConfirm ? confirm : cancel).focus());
  }

  // The label of the armed confirmation ("Kill", "Run", ...) or null.
  confirmationLabel() {
    return this._confirmation ? this._confirmation.label : null;
  }

  // Complete the armed confirmation, as Enter on its button would.
  acceptConfirmation() {
    const bar = this._confirmation;
    if (!bar || bar.confirm.disabled) return false;
    bar.confirm.click();
    return true;
  }

  cancelConfirmation(refocus = false) {
    if (this._armedAction) {
      this._armedAction.classList.remove("armed");
      this._armedAction = null;
    }
    if (!this._confirmation) return;
    this.el.removeEventListener("keydown", this._confirmation.keyHandler, true);
    this._confirmation = null;
    releaseFocus("pane-confirm");
    this.exitBar.classList.remove("confirming");
    // A dismissed bar on an exited pane left its buttons behind, still wired.
    if (this.state === "exited") this._renderExitBar();
    else this.exitBar.hidden = true;
    if (refocus && this.term) this.term.focus();
  }

  // Copy text (default: the terminal's current selection) to the clipboard,
  // with a visible confirmation and a legacy fallback for WebView2, where the
  // async clipboard API is sometimes denied and otherwise fails silently.
  // Read-only, and never counts as user input. Returns whether there was anything
  // to copy.
  copySelection(selection = this.term.getSelection()) {
    if (!selection) return false;
    this._writeClipboard(selection, () => this.flashNotice("[copied]"), () => this.flashNotice("[copy failed]"));
    return true;
  }

  // Write text to the system clipboard via the async API, falling back to the
  // legacy execCommand path when it is unavailable or denied (WebView2 denies
  // navigator.clipboard.writeText silently). onOk/onFail are optional feedback
  // callbacks. Shared by the Ctrl+C / right-click selection copy and by
  // the OSC 52 handler (apps inside the terminal, such as Claude Code, tmux or
  // vim, that copy programmatically). Read-only; never counts as user input.
  _writeClipboard(text, onOk, onFail) {
    const ok = () => { if (onOk) onOk(); };
    const fallback = () => {
      if (this._execCopy(text)) ok();
      else if (onFail) onFail();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, fallback);
    } else {
      fallback();
    }
  }

  // Deprecated execCommand path: best effort when the async clipboard API is
  // unavailable or denied. Uses an off-screen textarea and restores terminal
  // focus afterward.
  _execCopy(text) {
    // OSC 52 is driven by terminal *output*, so this can run for a pane the
    // user is not looking at. Put focus back exactly where it was rather than
    // pulling it into this pane.
    const previous = document.activeElement;
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(ta);
      try {
        if (previous && previous !== document.body && document.contains(previous)
          && typeof previous.focus === "function") previous.focus();
        else if (this.el.classList.contains("focused")) this.term.focus();
      } catch (e) {}
      return copied;
    } catch (e) {
      return false;
    }
  }

  // Returns whether the bytes actually reached the PTY. Callers that report
  // "[pasted …]" must not claim success when this is false.
  sendText(text) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN
      && this._protocol.canSendInput() && !this._exited) {
      this._markWrote();
      this.ws.send(ENC.encode(text));
      return true;
    }
    return false;
  }

  // Whether sendText would reach the PTY right now.
  acceptsInput() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN
      && this._protocol.canSendInput() && !this._exited);
  }

  setBroadcasting(on) {
    this.el.classList.toggle("broadcasting", Boolean(on));
  }

  // Scroll to a search hit and select it. Returns whether it was found.
  revealMatch(match) {
    if (!this.term) return false;
    const found = findInBuffer(this.term.buffer.active, match);
    if (!found) {
      this.flashNotice("[that line is no longer in this terminal's scrollback]", 4000);
      return false;
    }
    this.term.scrollToLine(Math.max(0, found.row - Math.floor(this.term.rows / 3)));
    this.term.select(found.col, found.row, found.cells);
    return true;
  }

  // A pane that was just attached for a search hit has no text until its
  // replay has been parsed; the reveal waits for live (or for the exit of a
  // replay-only session) instead of searching an empty buffer.
  revealWhenReady(match) {
    if (this._phase === "live" || this.state === "exited") return this.revealMatch(match);
    this._pendingReveal = match;
    return true;
  }

  _runPendingReveal() {
    const match = this._pendingReveal;
    this._pendingReveal = null;
    if (match) this.revealMatch(match);
  }

  // Every real input (a key, a native paste, sendText, a drop) comes through
  // here. It tells the backend once per connection, because the session's
  // `touched` flag keeps it from the idle reaper and keeps the app in the tray,
  // and it flips userWrote once per pane: the workspace layer uses that moment
  // to adopt a scratch layout as the "scratch" workspace.
  _markWrote() {
    this._sendTouch();
    if (this.userWrote) return;
    this.userWrote = true;
    this.onStateChange(this);
  }

  _sendTouch() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this._exited) return;
    if (this._protocol.takeTouch()) this.ws.send(JSON.stringify({ type: "touch" }));
  }

  // Two-step close: something is running inside this shell, so the first
  // close press only warns; a second press within the window proceeds.
  armClose() {
    this.closeArmed = true;
    this.showNotice("[running: close again to detach]");
    clearTimeout(this._closeArmTimer);
    this._closeArmTimer = setTimeout(() => {
      this.closeArmed = false;
      if (this.state !== "exited") this.exitBar.hidden = true;
    }, 3000);
  }

  fitSoon() {
    clearTimeout(this._fitTimer);
    this._fitTimer = setTimeout(() => {
      if (this._disposed || !this.term || this._phase === "replay" || this._phase === "prelive") return;
      try { this.fit.fit(); } catch (e) { /* zero-size host */ }
      if (this._phase === "live") this._sendResize();
    }, FIT_DEBOUNCE_MS);
  }

  attach(info) {
    if (this._disposed) return;
    const keepScreen = this._keepScreen && Boolean(this.term);
    this.endSpawn();
    clearTimeout(this._reconnectTimer);
    this._teardownWs();
    this.session = info;
    this.savedSessionId = info.id;
    if (info.profile) this.profileName = info.profile;
    this._exited = false;
    this._resync = false;
    this._detached = false;
    this._backoff = BACKOFF_MIN;
    this._clearRecovery();
    this.exitBar.hidden = true;
    this.emptyEl.hidden = true;
    this.state = "attached";
    this._exitCode = null;
    this._renderTab();
    if (!this.term) this._createTerm();
    this._connect(keepScreen);
    // A split focuses the new pane before its terminal exists, so setFocused()
    // could not focus the xterm textarea (it was still null). Re-apply now that
    // the terminal is live, or the freshly-split pane swallows no keystrokes.
    this.focusSoon();
    this.onStateChange(this);
  }

  detach() {
    this._detached = true;
    clearTimeout(this._reconnectTimer);
    this._teardownWs();
  }

  killSession() {
    if (this.session) api.killSession(this.session.id).catch(() => {});
  }

  // `keepElement` leaves the box in the DOM for the layout's leave animation;
  // the layout removes it once the neighbours have slid over it.
  dispose({ keepElement = false } = {}) {
    this._disposed = true;
    this._stopActivityTicker();
    this.detach();
    clearTimeout(this._fitTimer);
    clearTimeout(this._closeArmTimer);
    clearTimeout(this._noticeTimer);
    clearTimeout(this._dropFallbackTimer);
    this._pendingReveal = null;
    if (nativeDropPane === this) nativeDropPane = null;
    this.cancelConfirmation();
    this._ro.disconnect();
    if (this._linkProvider) { try { this._linkProvider.dispose(); } catch (e) {} this._linkProvider = null; }
    if (this._webgl) { try { this._webgl.dispose(); } catch (e) {} this._webgl = null; }
    if (this.term) { try { this.term.dispose(); } catch (e) {} this.term = null; }
    if (!keepElement) this.el.remove();
  }

  // ---- internals ----

  _createTerm() {
    // Override xterm's default OSC hyperlink handler: the vendor default uses
    // window.confirm(). Every terminal link must stay inside QuickTerm's own
    // Ctrl+click flow and token-gated local opener.
    const activateLink = (event, text) => {
      if (!event.ctrlKey && !event.metaKey) return;
      api.openTarget(text.trim()).catch(() => this.flashNotice("[could not open]"));
    };
    this.term = new Terminal({
      fontFamily: `"${this.fontFamily}", "JetBrains Mono", "Cascadia Mono", Consolas, monospace`,
      fontSize: this.fontSize,
      cursorBlink: false,
      cursorStyle: "block",
      scrollback: 5000,
      minimumContrastRatio: 4.5,
      allowProposedApi: true,
      linkHandler: { activate: activateLink },
      theme: this.theme,
      // On Windows the backend PTY is ConPTY; telling xterm lets it apply the
      // ConPTY reflow/sequence handling and fixes Windows-specific key quirks.
      ...(/Windows/i.test(navigator.userAgent) ? { windowsPty: { backend: "conpty" } } : {}),
    });
    // Unicode 11 width tables. Without this xterm uses its built-in v6 widths,
    // which miscount many emoji and wide glyphs and drift the cursor / corrupt
    // redraws in modern TUIs (Claude Code, etc.). Optional: it falls back to v6
    // if the addon global failed to load.
    try {
      if (window.Unicode11Addon) {
        this.term.loadAddon(new Unicode11Addon.Unicode11Addon());
        this.term.unicode.activeVersion = "11";
      }
    } catch (e) { /* v6 fallback, non-fatal */ }
    // Windows-style selection-aware copy and native paste. Ctrl+C copies only
    // when xterm has a selection; otherwise it reaches the PTY as SIGINT.
    // Ctrl+Shift+C/V remain compatible aliases.
    this.term.attachCustomKeyEventHandler((e) => {
      // Enter on an exited pane restarts it: stdin is off, so the key had no
      // other meaning, and the terminal keeps the keyboard throughout.
      if (e.type === "keydown" && e.key === "Enter" && this.state === "exited"
        && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        this.requestRestart();
        return false;
      }
      if (e.type !== "keydown" || !e.ctrlKey || e.altKey || e.metaKey) return true;
      const key = e.key.toLowerCase();
      if (key === "c") {
        const selection = this.term.getSelection();
        if (!selection) return true;
        this.copySelection(selection);
        e.preventDefault();
        return false;
      }
      if (key === "v") {
        // Do NOT intercept Ctrl+V or Ctrl+Shift+V: Chromium fires a native paste
        // event on xterm's textarea and xterm handles it. Programmatic clipboard
        // reads are permission-gated in WebView2, so this is the reliable path.
        if (this._protocol.canSendInput() && !this._exited) this._markWrote();
        return true;
      }
      return true;
    });
    // Real keystrokes only: onData also fires for xterm's automatic replies
    // to terminal queries (DA/DSR), which must not count as user activity.
    this.term.onKey(() => this._markWrote());
    // The same events open the broadcast gate (broadcast.js): only data that
    // follows one of them is the user's, never xterm's own query replies.
    this.term.onKey(() => this._inputGate.arm());
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.termHost);
    // Real input that never fires onKey: a paste from a context menu or a
    // middle click, IME composition, dead keys, Win+H dictation. Capture phase,
    // so the touch frame leaves before xterm turns the event into onData.
    const typed = () => {
      if (this._protocol.canSendInput() && !this._exited) this._markWrote();
    };
    this.term.textarea?.addEventListener("paste", typed, true);
    this.term.textarea?.addEventListener("compositionend", typed, true);
    // The broadcast gate opens on the host, in the capture phase, because
    // xterm's own textarea listeners were registered first and a listener on
    // the target runs in registration order: its capture listener for
    // `input` (dead-key accents, dictation, injected text) emits the data
    // before one added here on the textarea would run.
    for (const type of ["paste", "compositionend", "input"]) {
      this.termHost.addEventListener(type, () => {
        this._inputGate.arm(type === "compositionend" ? 2 : 1);
      }, true);
    }
    // OSC 52: apps running inside the terminal (Claude Code, tmux, vim, etc.)
    // copy to the system clipboard by emitting ESC]52;c;<base64>. xterm.js has
    // no built-in OSC 52 handler, so without this the copy is silently dropped
    // even though the app reports success ("copied N chars to clipboard").
    // Reuses the fallback-capable write so it works under WebView2. Read
    // requests (…;?) are declined. WebView2 blocks clipboard reads anyway, and
    // echoing clipboard contents back to the PTY on demand is a footgun.
    try {
      this.term.parser.registerOscHandler(52, (data) => {
        // data is "<targets>;<base64>"; require the separator (a valid OSC 52
        // write always has both fields) so a malformed sequence never copies
        // garbage decoded from the targets field.
        const sep = data.indexOf(";");
        if (sep === -1) return true;
        const payload = data.slice(sep + 1);
        if (!payload || payload === "?") return true;
        // Terminal output is untrusted. Bound work before atob allocates and
        // verify decoded length too in case padding quirks slip through.
        if (payload.length > OSC52_MAX_BASE64) return true;
        let text;
        try {
          const bin = atob(payload);
          if (bin.length > OSC52_MAX_BYTES) return true;
          const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
          text = new TextDecoder().decode(bytes);
        } catch (e) { return true; } // malformed base64 -> ignore, don't leak
        this._writeClipboard(text);
        return true;
      });
    } catch (e) { /* no parser API: copy-from-app unsupported, non-fatal */ }
    // Shell integration directory signals. OSC 7 is the portable convention;
    // OSC 9;9 is emitted by Windows shell integrations. Never scrape prompts.
    try {
      const trackCwd = (code, data) => {
        const cwd = parseOscCwd(code, data, this.terminalType);
        if (!cwd) return false;
        this.currentCwd = cwd;
        return true;
      };
      this.term.parser.registerOscHandler(7, (data) => trackCwd(7, data));
      this.term.parser.registerOscHandler(9, (data) => trackCwd(9, data));
    } catch (e) { /* shell integration is optional */ }
    // Right-click copies the current selection (the Windows Terminal
    // convention) with a visible confirmation. Paste stays native on Ctrl+V.
    // WebView2 silently denies programmatic clipboard reads, so there is no
    // reliable right-click paste to offer here.
    this.termHost.addEventListener("contextmenu", (e) => {
      if (this.copySelection()) e.preventDefault();
    });
    try {
      const gl = new WebglAddon.WebglAddon();
      gl.onContextLoss(() => {
        try { gl.dispose(); } catch (e) {}
        if (this._webgl === gl) this._webgl = null;
      });
      this.term.loadAddon(gl);
      this._webgl = gl;
    } catch (e) {
      this._webgl = null; // DOM renderer fallback (much slower on heavy output)
      console.warn("QuickTerm: WebGL renderer unavailable, using DOM renderer", e);
    }
    // Ctrl+click links: URLs via the web-links addon, file paths via the
    // custom provider above. Both open through the token-gated backend
    // (/api/open), which refuses non-http(s) URLs and reveals executables
    // in the file manager instead of running them.
    try {
      this.term.loadAddon(new WebLinksAddon.WebLinksAddon(activateLink));
    } catch (e) { /* links are a nicety, never fatal */ }
    try {
      this._linkProvider = this.term.registerLinkProvider(makeFilePathProvider(this.term, activateLink));
    } catch (e) { this._linkProvider = null; }
    // Only forward while live: replayed scrollback contains terminal queries
    // (DA/DSR) that xterm auto-answers during the async replay parse, and those
    // answers must never reach the PTY as typed input.
    this.term.onData((d) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN && !this._exited && this._protocol.canSendInput()) {
        this.ws.send(ENC.encode(d));
        if (this._inputGate.open) this.onUserInput(d, this);
      }
    });
    this.term.onBinary((d) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this._exited || !this._protocol.canSendInput()) return;
      const b = new Uint8Array(d.length);
      for (let i = 0; i < d.length; i++) b[i] = d.charCodeAt(i) & 0xff;
      this.ws.send(b);
    });
    try { this.fit.fit(); } catch (e) {}
  }

  _connect(keepScreen = false) {
    if (this._disposed || this._detached || !this.session) return;
    this._queue.length = 0;
    this._pending = 0;
    this.term.options.disableStdin = true;
    this.showNotice("[restoring terminal…]");
    const generation = this._protocol.beginReplay();
    this._keepScreenGeneration = keepScreen ? generation : null;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws/session/${encodeURIComponent(this.session.id)}`;
    const ws = new WebSocket(url, api.wsSubprotocols());
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => { if (this.ws === ws) this._backoff = BACKOFF_MIN; };
    ws.onmessage = (ev) => {
      if (this.ws !== ws || !this._protocol.isCurrent(generation)) return;
      if (typeof ev.data === "string") {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        this._control(msg);
      } else {
        this._binary(ev.data, generation);
      }
    };
    ws.onclose = () => { if (this.ws === ws) this._closed(); };
  }

  _control(msg) {
    switch (msg.type) {
      case "replay_size":
        if (this._keepScreenGeneration === this._generation) {
          // A restart in place: the fresh session's replay continues below
          // the dead one's output, after a separator, instead of a reset.
          this._keepScreenGeneration = null;
          this.term.write(this._restartSeparator());
          break;
        }
        // Replay-then-resize: render scrollback at the size it was recorded.
        this.term.reset();
        if (msg.cols > 0 && msg.rows > 0) this.term.resize(msg.cols, msg.rows);
        break;
      case "replay_done":
        if (this._protocol.replayComplete()) this._goLive();
        break;
      case "overflow":
        this.flashNotice("[output busy · resynchronizing]");
        this._resync = true;
        if (this.ws) this.ws.close();
        break;
      case "exit":
        this._onExit(typeof msg.code === "number" ? msg.code : null);
        break;
    }
  }

  _binary(buf, generation = this._generation) {
    const data = new Uint8Array(buf);
    const action = this._protocol.acceptBinary(data.byteLength);
    if (action === "ignore") return; // xterm never acks empty writes
    if (action === "replay") {
      this.term.write(data, () => {
        const completed = this._protocol.completeReplayWrite(generation);
        if (completed.stale) return;
        if (completed.acknowledge && this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "replay_ack" }));
        }
        if (completed.goLive) this._goLive();
      });
    } else {
      if (action === "overflow") {
        this.flashNotice("[output busy · resynchronizing]");
        this._resync = true;
        if (this.ws) this.ws.close();
        return;
      }
      this._queue.push(data);
      // Live output is the activity signal for the header badge. Replayed
      // scrollback is history, so it must not make a quiet pane look busy.
      if (this._phase === "live") {
        this._lastOutputAt = Date.now();
        this._pump();
      }
    }
  }

  _goLive() {
    if (this._disposed || this._exited) return;
    this._protocol.goLive();
    this.term.options.disableStdin = false;
    this.exitBar.hidden = true;
    try { this.fit.fit(); } catch (e) {}
    this._sendResize();
    this._pump();
    // Sidebar clicks and long scrollback replay can both outlive the original
    // focus event. Reassert focus only if this pane is still the chosen pane.
    this.focusSoon();
    this._runPendingReveal();
  }

  // Leaving the alternate screen with 1047, not 1049: 1049 also restores a
  // saved cursor, which would put the mark in the middle of old output.
  _restartSeparator() {
    const leaveAlt = this.term.buffer.active.type === "alternate" ? "\x1b[?1047l" : "";
    const newline = this.term.buffer.normal.cursorX > 0 ? "\r\n" : "";
    return leaveAlt + RESTART_RESET + newline + RESTART_MARK;
  }

  // Write queued output; when >PENDING_LIMIT bytes are unacknowledged by
  // xterm's write callbacks, stop and resume as callbacks drain the count.
  // Queued chunks are merged into one write per tick: fewer parser calls and
  // callbacks than writing each frame separately.
  _pump() {
    while (this._queue.length && this._pending < PENDING_LIMIT) {
      const data = this._drainQueue();
      const generation = this._generation;
      this._protocol.takeQueued(data.byteLength);
      this._pending += data.byteLength;
      this.term.write(data, () => {
        if (!this._protocol.isCurrent(generation)) return;
        this._pending -= data.byteLength;
        // Resume after exit too: _onExit flips the phase to "idle", and gating
        // the resume on "live" alone stranded everything still queued.
        if (this._queue.length && !this._disposed
          && (this._phase === "live" || this._exited)) this._pump();
      });
    }
  }

  // Write everything still queued straight to xterm, ignoring the pending
  // budget. Used on exit, where the pump's callback-driven resume can no
  // longer fire and queued bytes would otherwise be dropped and retained.
  _flushQueue() {
    if (!this.term) { this._queue.length = 0; return; }
    while (this._queue.length) {
      const data = this._drainQueue();
      this._protocol.takeQueued(data.byteLength);
      try { this.term.write(data); } catch (e) { break; }
    }
  }

  // Concatenate all currently queued chunks (capped) into one Uint8Array.
  _drainQueue() {
    if (this._queue.length === 1) return this._queue.shift();
    let total = 0;
    const batch = [];
    while (this._queue.length && total < PENDING_LIMIT) {
      const c = this._queue.shift();
      batch.push(c);
      total += c.byteLength;
    }
    const data = new Uint8Array(total);
    let off = 0;
    for (const c of batch) { data.set(c, off); off += c.byteLength; }
    return data;
  }

  _sendResize() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.term) {
      this.ws.send(JSON.stringify({ type: "resize", cols: this.term.cols, rows: this.term.rows }));
    }
  }

  _onExit(code) {
    this._exited = true;
    // Drain before the phase flips to "idle". The session's final output is
    // usually the part the user actually wants (build result, exit message).
    this._flushQueue();
    this._protocol.exit();
    this.state = "exited";
    this._exitCode = code;
    if (this.term) this.term.options.disableStdin = true;
    this._renderTab();
    // showNotice first: it dismisses any confirmation or recovery bar.
    this.showNotice(code === null ? "[exited]" : `[exited · code ${code}]`);
    this._renderExitBar();
    this.onStateChange(this);
    this._runPendingReveal();
  }

  _closed() {
    this.ws = null;
    if (this._disposed || this._detached || this._exited) return;
    // A 1013 overflow close is an instruction to reconnect and replay the
    // ring. Reconnect even if the session has meanwhile exited: its final
    // output only exists in that replay, and the server now serves it in
    // replay-only mode. Without this the pane rendered "[exited]" over a
    // transcript truncated at the overflow point.
    if (this._resync) {
      this._resync = false;
      this._connect();
      return;
    }
    // Only alive/exit_code are read here. Never ask for the full-machine
    // metrics scan on a socket close.
    api.getSessions({ metrics: false }).then((list) => {
      if (this._disposed || this._detached || this._exited) return;
      const s = list.find((x) => x.id === this.session.id);
      if (!s) { this._onExit(null); return; }
      if (!s.alive) { this._onExit(typeof s.exit_code === "number" ? s.exit_code : null); return; }
      this._scheduleReconnect();
    }).catch(() => {
      this._scheduleReconnect(); // server unreachable: keep trying
    });
  }

  _scheduleReconnect() {
    const delay = this._backoff;
    this._backoff = Math.min(this._backoff * 2, BACKOFF_MAX);
    clearTimeout(this._reconnectTimer);
    this.showNotice(`[connection lost · retrying in ${Math.max(1, Math.ceil(delay / 1000))}s]`);
    this._reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  _teardownWs() {
    this._protocol.invalidate();
    if (this.ws) {
      const w = this.ws;
      this.ws = null;
      w.onopen = w.onmessage = w.onclose = null;
      try { w.close(); } catch (e) {}
    }
  }
}
