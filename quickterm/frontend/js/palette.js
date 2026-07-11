// Ctrl+P command palette: one input, subsequence fuzzy match over
// profiles, actions, snippets, workspaces, and recent sessions.
// Two-step prompts (workspace name, file path) reuse the same input.

import * as api from "./api.js";

function fuzzyScore(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  let last = -2;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      streak = i === last + 1 ? streak + 1 : 1;
      score += 1 + streak * 2;
      if (i === 0 || t[i - 1] === " " || t[i - 1] === ":") score += 3;
      last = i;
      qi++;
    }
  }
  return qi === q.length ? score : -1;
}

export class Palette {
  constructor(app) {
    this.app = app;
    this.open = false;
    this.items = [];
    this.filtered = [];
    this.sel = 0;
    this.prompt = null; // {submit(text)}

    const overlay = document.createElement("div");
    overlay.className = "palette-overlay";
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="palette">' +
      '<input type="text" spellcheck="false" autocomplete="off" autocapitalize="off">' +
      '<div class="palette-list"></div>' +
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

  async openPalette() {
    this.open = true;
    this.prompt = null;
    this.overlay.hidden = false;
    this.input.value = "";
    this.input.placeholder = "command / profile / snippet / session";
    this.items = this._staticItems();
    this._refilter();
    this.input.focus();
    // enrich with live data
    const [sessions, workspaces] = await Promise.all([
      api.getSessions().catch(() => []),
      api.listWorkspaces().catch(() => []),
    ]);
    if (!this.open || this.prompt) return;
    this.items = this._staticItems();
    for (const name of workspaces) {
      this.items.push({
        kind: "workspace",
        label: `load workspace: ${name}`,
        run: () => this.app.loadWorkspace(name),
      });
    }
    const attached = new Set(this.app.attachedSessionIds());
    for (const s of sessions) {
      if (!s.alive || attached.has(s.id)) continue;
      this.items.push({
        kind: "session",
        label: `attach: ${s.name || s.id}`,
        hint: s.profile ? `${s.profile} · ${s.id}` : s.id,
        run: () => this.app.attachSession(s),
      });
    }
    this._refilter();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.prompt = null;
    this.overlay.hidden = true;
    this.app.refocusTerm();
  }

  // ---- internals ----

  _staticItems() {
    const a = this.app;
    const items = [
      { kind: "action", label: "dashboard", run: () => a.openPanel("dashboard") },
      { kind: "action", label: "settings", run: () => a.openPanel("settings") },
      { kind: "action", label: "help", run: () => a.openPanel("help") },
      { kind: "action", label: "split horizontal", run: () => a.splitH() },
      { kind: "action", label: "split vertical", run: () => a.splitV() },
      { kind: "action", label: "zoom pane", run: () => a.zoom() },
      { kind: "action", label: "close pane", run: () => a.closePane() },
      { kind: "action", label: "kill session", run: () => a.killFocusedSession() },
      {
        kind: "action", label: "save workspace…", keepOpen: true,
        run: () => this._promptMode("workspace name", (v) => a.saveWorkspace(v)),
      },
      {
        kind: "action", label: "load workspace…", keepOpen: true,
        run: () => this._promptMode("workspace name", (v) => a.loadWorkspace(v)),
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
    for (const p of a.profiles) {
      items.push({
        kind: "profile",
        label: `run: ${p.name}`,
        hint: [p.cmd, ...(p.args || [])].join(" "),
        run: () => a.runProfile(p),
      });
    }
    for (const s of a.snippets) {
      items.push({
        kind: "snippet",
        label: `snippet: ${s.name}`,
        run: () => a.sendSnippet(s),
      });
    }
    return items;
  }

  _promptMode(placeholder, submit) {
    this.prompt = { submit };
    this.input.value = "";
    this.input.placeholder = placeholder;
    this.listEl.textContent = "";
    this.filtered = [];
    this.sel = 0;
    this.input.focus();
  }

  _key(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if (this.prompt) {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const submit = this.prompt.submit;
        const value = this.input.value.trim();
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

  _refilter() {
    const q = this.input.value.trim();
    this.filtered = this.items
      .map((item, i) => ({ item, i, score: fuzzyScore(q, item.label) }))
      .filter((x) => x.score >= 0)
      .sort((x, y) => y.score - x.score || x.i - y.i)
      .map((x) => x.item);
    this.sel = 0;
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
  }
}
