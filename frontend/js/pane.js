// One pane: xterm.js Terminal + FitAddon (+WebGL when possible) + one WS
// to /ws/session/{id}. Implements the CONTRACTS.md attach protocol:
// replay_size -> resize to recorded size, write scrollback, replay_done ->
// fit to real size and send resize. Client-side backpressure via
// term.write callbacks; reconnect with backoff on unexpected close.

import * as api from "./api.js";

const ENC = new TextEncoder();
const PENDING_LIMIT = 1 << 20; // ~1 MiB unwritten -> pause processing
const BACKOFF_MIN = 500;
const BACKOFF_MAX = 8000;
const FIT_DEBOUNCE_MS = 50;

// Graphite/amber identity: muted ANSI set, amber reserved for cursor/accents.
export const XTERM_THEME = {
  background: "#1E2124",
  foreground: "#D6D3C9",
  cursor: "#E0A030",
  cursorAccent: "#1E2124",
  selectionBackground: "#3A4046",
  black: "#22262A",
  red: "#B4544B",
  green: "#7C9B6E",
  yellow: "#C89543",
  blue: "#6E8898",
  magenta: "#9A7F9E",
  cyan: "#6FA090",
  white: "#B9B6AD",
  brightBlack: "#4C545C",
  brightRed: "#C97B70",
  brightGreen: "#98B58B",
  brightYellow: "#E0A030",
  brightBlue: "#8FA9BA",
  brightMagenta: "#B49CB8",
  brightCyan: "#8FBCAC",
  brightWhite: "#D6D3C9",
};

export class Pane {
  constructor(opts = {}) {
    this.fontFamily = opts.fontFamily || "JetBrains Mono";
    this.onFocusRequest = opts.onFocusRequest || (() => {});
    this.onStateChange = opts.onStateChange || (() => {});
    this.profileName = opts.profile || null;
    this.cwd = opts.cwd || null;

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
      '<div class="term-host"></div>' +
      '<div class="pane-empty">no session &middot; ctrl+p</div>' +
      '<div class="pane-dim"></div>' +
      '<div class="pane-exitbar" hidden></div>';
    this.el = el;
    this.termHost = el.querySelector(".term-host");
    this.emptyEl = el.querySelector(".pane-empty");
    this.exitBar = el.querySelector(".pane-exitbar");
    el.addEventListener("mousedown", () => this.onFocusRequest(this));

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

  showNotice(text) {
    this.exitBar.textContent = text;
    this.exitBar.hidden = false;
  }

  sendText(text) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && !this._exited) {
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
    if (info.profile) this.profileName = info.profile;
    this._exited = false;
    this._detached = false;
    this._backoff = BACKOFF_MIN;
    this.exitBar.hidden = true;
    this.emptyEl.hidden = true;
    this.state = "attached";
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
      fontSize: 13,
      cursorBlink: false,
      cursorStyle: "block",
      scrollback: 5000,
      minimumContrastRatio: 1,
      allowProposedApi: true,
      theme: XTERM_THEME,
    });
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
      this._webgl = null; // canvas/DOM renderer fallback
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
    const ws = new WebSocket(`${proto}//${location.host}/ws/session/${encodeURIComponent(this.session.id)}`);
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
  _pump() {
    while (this._queue.length && this._pending < PENDING_LIMIT) {
      const chunk = this._queue.shift();
      this._pending += chunk.byteLength;
      this.term.write(chunk, () => {
        this._pending -= chunk.byteLength;
        if (this._queue.length && this._phase === "live") this._pump();
      });
    }
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
