// One pane: xterm.js Terminal + FitAddon (+WebGL when possible) + one WS
// to /ws/session/{id}. Implements the CONTRACTS.md attach protocol:
// replay_size -> resize to recorded size, write scrollback, replay_done ->
// fit to real size and send resize. Client-side backpressure via
// term.write callbacks; reconnect with backoff on unexpected close.

import * as api from "./api.js";
import { getTheme, DEFAULT_THEME } from "./themes.js";

const ENC = new TextEncoder();
const PENDING_LIMIT = 1 << 20; // ~1 MiB unwritten -> pause processing
const BACKOFF_MIN = 500;
const BACKOFF_MAX = 8000;
const FIT_DEBOUNCE_MS = 50;

export class Pane {
  constructor(opts = {}) {
    this.fontFamily = opts.fontFamily || "JetBrains Mono";
    this.fontSize = opts.fontSize || 14;
    this.theme = opts.theme || getTheme(DEFAULT_THEME).xterm;
    this.onFocusRequest = opts.onFocusRequest || (() => {});
    this.onStateChange = opts.onStateChange || (() => {});
    this.profileName = opts.profile || null;
    this.cwd = opts.cwd || null;
    this.savedSessionId = opts.sessionId || null;
    this.launchSpec = opts.launchSpec || null;
    this.title = opts.title || null; // user-given name, wins over session name
    this.userWrote = false;    // real keystrokes/paste in this pane
    this.spawnedFresh = false; // session was created by this pane (vs reattached)

    this.session = null;
    this.state = "empty"; // empty | attached | exited
    this.term = null;
    this.fit = null;
    this.ws = null;
    this._webgl = null;

    this._phase = "idle"; // idle | replay | prelive | live
    this._replayDone = false;
    this._replayWrites = 0;
    this._queue = [];
    this._pending = 0;

    this._backoff = BACKOFF_MIN;
    this._reconnectTimer = null;
    this._fitTimer = null;
    this._detached = false;
    this._exited = false;
    this._disposed = false;

    const el = document.createElement("div");
    el.className = "pane";
    el.innerHTML =
      '<div class="pane-tab" title="Double-click to rename"><span class="pane-tab-dot"></span><span class="pane-tab-name"></span></div>' +
      '<div class="term-host"></div>' +
      '<div class="pane-empty">no session &middot; alt+p</div>' +
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
    this.tabEl.addEventListener("dblclick", (e) => { e.stopPropagation(); this._startRename(); });
    el.addEventListener("mousedown", () => this.onFocusRequest(this));
    this._renderTab();

    this._ro = new ResizeObserver(() => this.fitSoon());
    this._ro.observe(el);
  }

  get canReplace() {
    return this.state === "empty" || this.state === "exited";
  }

  setFocused(focused) {
    this.el.classList.toggle("focused", focused);
    if (focused && this.term) this.term.focus();
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
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    this.tabDotEl.style.background = `hsl(${((hash % 360) + 360) % 360} 42% 62%)`;
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
    this.exitBar.textContent = text;
    this.exitBar.hidden = false;
  }

  sendText(text) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && !this._exited) {
      this.userWrote = true;
      this.ws.send(ENC.encode(text));
    }
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
    clearTimeout(this._reconnectTimer);
    this._teardownWs();
    this.session = info;
    this.savedSessionId = info.id;
    if (info.profile) this.profileName = info.profile;
    this._exited = false;
    this._detached = false;
    this._backoff = BACKOFF_MIN;
    this.exitBar.hidden = true;
    this.emptyEl.hidden = true;
    this.state = "attached";
    this._renderTab();
    if (!this.term) this._createTerm();
    this._connect();
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

  dispose() {
    this._disposed = true;
    this.detach();
    clearTimeout(this._fitTimer);
    this._ro.disconnect();
    if (this._webgl) { try { this._webgl.dispose(); } catch (e) {} this._webgl = null; }
    if (this.term) { try { this.term.dispose(); } catch (e) {} this.term = null; }
    this.el.remove();
  }

  // ---- internals ----

  _createTerm() {
    this.term = new Terminal({
      fontFamily: `"${this.fontFamily}", "JetBrains Mono", "Cascadia Mono", Consolas, monospace`,
      fontSize: this.fontSize,
      cursorBlink: false,
      cursorStyle: "block",
      scrollback: 5000,
      minimumContrastRatio: 1,
      allowProposedApi: true,
      theme: this.theme,
      // On Windows the backend PTY is ConPTY; telling xterm lets it apply the
      // ConPTY reflow/sequence handling and fixes Windows-specific key quirks.
      ...(/Windows/i.test(navigator.userAgent) ? { windowsPty: { backend: "conpty" } } : {}),
    });
    // Ctrl+Shift+C/V copy & paste, scoped to the terminal so the plain
    // Ctrl+C/V (SIGINT / literal paste event) keep their terminal meaning.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return true;
      const key = e.key.toLowerCase();
      if (key === "c") {
        const selection = this.term.getSelection();
        if (!selection) return true;
        if (navigator.clipboard) navigator.clipboard.writeText(selection).catch(() => {});
        e.preventDefault();
        return false;
      }
      if (key === "v") {
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then((text) => {
            if (text && this._phase === "live" && !this._exited) {
              this.userWrote = true;
              this.term.paste(text);
            }
          }).catch(() => {});
        }
        e.preventDefault();
        return false;
      }
      return true;
    });
    // Real keystrokes only: onData also fires for xterm's automatic replies
    // to terminal queries (DA/DSR), which must not count as user activity.
    this.term.onKey(() => { this.userWrote = true; });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.termHost);
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
    // Only forward while live: replayed scrollback contains terminal queries
    // (DA/DSR) that xterm auto-answers during the async replay parse — those
    // answers must never reach the PTY as typed input.
    this.term.onData((d) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN && !this._exited && this._phase === "live") {
        this.ws.send(ENC.encode(d));
      }
    });
    this.term.onBinary((d) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this._exited || this._phase !== "live") return;
      const b = new Uint8Array(d.length);
      for (let i = 0; i < d.length; i++) b[i] = d.charCodeAt(i) & 0xff;
      this.ws.send(b);
    });
    try { this.fit.fit(); } catch (e) {}
  }

  _connect() {
    if (this._disposed || this._detached || !this.session) return;
    this._phase = "replay";
    this._replayDone = false;
    this._replayWrites = 0;
    this._queue.length = 0;
    this._pending = 0;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws/session/${encodeURIComponent(this.session.id)}`;
    const ws = new WebSocket(url, api.wsSubprotocols());
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => { this._backoff = BACKOFF_MIN; };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        this._control(msg);
      } else {
        this._binary(ev.data);
      }
    };
    ws.onclose = () => { if (this.ws === ws) this._closed(); };
  }

  _control(msg) {
    switch (msg.type) {
      case "replay_size":
        // Replay-then-resize: render scrollback at the size it was recorded.
        this.term.reset();
        if (msg.cols > 0 && msg.rows > 0) this.term.resize(msg.cols, msg.rows);
        break;
      case "replay_done":
        this._replayDone = true;
        if (this._replayWrites === 0) this._goLive();
        else this._phase = "prelive"; // wait for replay writes to flush
        break;
      case "exit":
        this._onExit(typeof msg.code === "number" ? msg.code : null);
        break;
    }
  }

  _binary(buf) {
    const data = new Uint8Array(buf);
    if (data.byteLength === 0) return; // xterm never acks empty writes
    if (this._phase === "replay") {
      this._replayWrites++;
      this.term.write(data, () => {
        this._replayWrites--;
        if (this._replayDone && this._replayWrites === 0) this._goLive();
      });
    } else {
      this._queue.push(data);
      if (this._phase === "live") this._pump();
    }
  }

  _goLive() {
    if (this._disposed || this._exited) return;
    this._phase = "live";
    try { this.fit.fit(); } catch (e) {}
    this._sendResize();
    this._pump();
  }

  // Write queued output; when >PENDING_LIMIT bytes are unacknowledged by
  // xterm's write callbacks, stop and resume as callbacks drain the count.
  // Queued chunks are merged into one write per tick — fewer parser calls and
  // callbacks than writing each frame separately.
  _pump() {
    while (this._queue.length && this._pending < PENDING_LIMIT) {
      const data = this._drainQueue();
      this._pending += data.byteLength;
      this.term.write(data, () => {
        this._pending -= data.byteLength;
        if (this._queue.length && this._phase === "live") this._pump();
      });
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
    this._phase = "idle";
    this.state = "exited";
    this.showNotice(code === null ? "[exited]" : `[exited · code ${code}]`);
    this.onStateChange(this);
  }

  _closed() {
    this.ws = null;
    if (this._disposed || this._detached || this._exited) return;
    api.getSessions().then((list) => {
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
    this._reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  _teardownWs() {
    if (this.ws) {
      const w = this.ws;
      this.ws = null;
      w.onopen = w.onmessage = w.onclose = null;
      try { w.close(); } catch (e) {}
    }
  }
}
