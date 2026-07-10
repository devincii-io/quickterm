// Chrome panels: dashboard (workspaces / sessions / profiles), settings
// (quick fields + full config JSON), help (keys + concepts). One overlay,
// same visual language as the palette.

import * as api from "./api.js";

export class Panels {
  constructor(app) {
    this.app = app;
    this.open = null; // "dashboard" | "settings" | "help" | null

    const overlay = document.createElement("div");
    overlay.className = "panel-overlay";
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="panel">' +
      '<div class="panel-head"><span class="panel-title"></span>' +
      '<button class="panel-close" title="close">esc</button></div>' +
      '<div class="panel-body"></div>' +
      "</div>";
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.titleEl = overlay.querySelector(".panel-title");
    this.bodyEl = overlay.querySelector(".panel-body");

    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) this.close();
    });
    overlay.querySelector(".panel-close").addEventListener("click", () => this.close());
    // global: Escape must close the panel wherever focus sits
    document.addEventListener(
      "keydown",
      (e) => {
        if (this.open && e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          this.close();
        }
      },
      true,
    );
  }

  close() {
    this.open = null;
    this.overlay.hidden = true;
    this.app.refocusTerm();
  }

  toggle(name) {
    if (this.open === name) this.close();
    else this.show(name);
  }

  show(name) {
    this.open = name;
    this.overlay.hidden = false;
    this.titleEl.textContent = name;
    this.bodyEl.textContent = "";
    if (name === "dashboard") this._dashboard();
    else if (name === "settings") this._settings();
    else this._help();
  }

  // ---- builders ----

  _section(title) {
    const sec = document.createElement("div");
    sec.className = "panel-section";
    const h = document.createElement("div");
    h.className = "panel-section-title";
    h.textContent = title;
    sec.appendChild(h);
    this.bodyEl.appendChild(sec);
    return sec;
  }

  _row(sec, label, hint, buttons) {
    const row = document.createElement("div");
    row.className = "panel-row";
    const lab = document.createElement("span");
    lab.className = "panel-row-label";
    lab.textContent = label;
    row.appendChild(lab);
    if (hint) {
      const h = document.createElement("span");
      h.className = "panel-row-hint";
      h.textContent = hint;
      row.appendChild(h);
    }
    const spacer = document.createElement("span");
    spacer.className = "panel-row-flex";
    row.appendChild(spacer);
    for (const [text, onClick, danger] of buttons) {
      const b = document.createElement("button");
      b.className = "panel-btn" + (danger ? " danger" : "");
      b.textContent = text;
      b.addEventListener("click", onClick);
      row.appendChild(b);
    }
    sec.appendChild(row);
    return row;
  }

  _empty(sec, text) {
    const d = document.createElement("div");
    d.className = "panel-empty";
    d.textContent = text;
    sec.appendChild(d);
  }

  async _dashboard() {
    const app = this.app;

    const wsSec = this._section("workspaces");
    const saveRow = document.createElement("div");
    saveRow.className = "panel-row";
    const nameInput = document.createElement("input");
    nameInput.className = "panel-input";
    nameInput.placeholder = "workspace name";
    nameInput.spellcheck = false;
    const saveBtn = document.createElement("button");
    saveBtn.className = "panel-btn";
    saveBtn.textContent = "save current";
    const doSave = async () => {
      const name = nameInput.value.trim();
      if (!name) return;
      await app.saveWorkspace(name);
      this.show("dashboard");
    };
    saveBtn.addEventListener("click", doSave);
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doSave();
      e.stopPropagation();
    });
    saveRow.appendChild(nameInput);
    saveRow.appendChild(saveBtn);
    wsSec.appendChild(saveRow);

    const [workspaces, sessions] = await Promise.all([
      api.listWorkspaces().catch(() => []),
      api.getSessions().catch(() => []),
    ]);
    if (this.open !== "dashboard") return;

    if (!workspaces.length) this._empty(wsSec, "none saved yet");
    for (const name of workspaces) {
      this._row(wsSec, name, null, [
        ["load", () => { this.close(); app.loadWorkspace(name); }],
        ["delete", async () => {
          await api.deleteWorkspace(name).catch(() => {});
          this.show("dashboard");
        }, true],
      ]);
    }

    const sessSec = this._section("live sessions");
    const attached = new Set(app.attachedSessionIds());
    const alive = sessions.filter((s) => s.alive);
    if (!alive.length) this._empty(sessSec, "no live sessions");
    for (const s of alive) {
      const here = attached.has(s.id);
      this._row(
        sessSec,
        s.name || s.id,
        `${s.profile || "?"} · ${s.cols}x${s.rows}` + (here ? " · attached" : ""),
        [
          ...(here ? [] : [["attach", () => { this.close(); app.attachSession(s); }]]),
          ["kill", async () => {
            await api.killSession(s.id).catch(() => {});
            this.show("dashboard");
          }, true],
        ],
      );
    }

    const profSec = this._section("profiles");
    for (const p of app.profiles) {
      this._row(profSec, p.name, [p.cmd, ...(p.args || [])].join(" "), [
        ["run", () => { this.close(); app.runProfile(p); }],
      ]);
    }
  }

  async _settings() {
    const cfg = await api.getFullConfig().catch(() => null);
    if (this.open !== "settings") return;
    if (!cfg) {
      this._empty(this._section("settings"), "could not load config");
      return;
    }

    const quick = this._section("quick settings");

    const fontRow = document.createElement("div");
    fontRow.className = "panel-row";
    fontRow.innerHTML = '<span class="panel-row-label">font family</span>';
    const fontInput = document.createElement("input");
    fontInput.className = "panel-input";
    fontInput.value = cfg.font_family;
    fontInput.spellcheck = false;
    fontInput.addEventListener("keydown", (e) => e.stopPropagation());
    fontRow.appendChild(fontInput);
    quick.appendChild(fontRow);

    const defRow = document.createElement("div");
    defRow.className = "panel-row";
    defRow.innerHTML = '<span class="panel-row-label">default profile</span>';
    const defSel = document.createElement("select");
    defSel.className = "panel-input";
    for (const p of cfg.profiles) {
      const o = document.createElement("option");
      o.value = p.name;
      o.textContent = p.name;
      if (p.name === cfg.default_profile) o.selected = true;
      defSel.appendChild(o);
    }
    defRow.appendChild(defSel);
    quick.appendChild(defRow);

    const advSec = this._section("full config (json)");
    const note = document.createElement("div");
    note.className = "panel-empty";
    note.textContent = "profiles, snippets, keybindings, voice — port and global hotkeys apply after restart";
    advSec.appendChild(note);
    const ta = document.createElement("textarea");
    ta.className = "panel-json";
    ta.spellcheck = false;
    ta.value = JSON.stringify(cfg, null, 2);
    ta.addEventListener("keydown", (e) => e.stopPropagation());
    advSec.appendChild(ta);

    const actions = document.createElement("div");
    actions.className = "panel-row panel-actions";
    const msg = document.createElement("span");
    msg.className = "panel-row-hint";
    const saveBtn = document.createElement("button");
    saveBtn.className = "panel-btn";
    saveBtn.textContent = "save";
    saveBtn.addEventListener("click", async () => {
      let parsed;
      try {
        parsed = JSON.parse(ta.value);
      } catch (e) {
        msg.textContent = "invalid json";
        return;
      }
      parsed.font_family = fontInput.value.trim() || parsed.font_family;
      parsed.default_profile = defSel.value;
      try {
        await api.putConfig(parsed);
        msg.textContent = "saved";
        this.app.onConfigSaved();
      } catch (e) {
        msg.textContent = `rejected: ${e.status || "error"}`;
      }
    });
    actions.appendChild(msg);
    const spacer = document.createElement("span");
    spacer.className = "panel-row-flex";
    actions.appendChild(spacer);
    actions.appendChild(saveBtn);
    advSec.appendChild(actions);
  }

  _help() {
    const keys = this._section("keys");
    const rows = [
      ["ctrl+p", "command palette — everything is in here"],
      ["alt+h / alt+v", "split pane right / down"],
      ["alt+arrows", "move focus between panes"],
      ["alt+z", "zoom focused pane (toggle)"],
      ["alt+w", "close pane — session keeps running"],
      ["ctrl+alt+`", "summon / hide the window (global)"],
    ];
    for (const [k, v] of rows) this._row(keys, k, v, []);

    const concepts = this._section("how it works");
    for (const [k, v] of [
      ["sessions", "terminals live in the backend — closing this window never kills them; reattach from the dashboard or palette"],
      ["profiles", "preconfigured commands (top strip) — edit them in settings"],
      ["workspaces", "saved split layouts — save/load from the dashboard"],
      ["snippets", "reusable text blocks pasted via the palette"],
      ["file viewer", "palette → open file viewer — read-only popup for any file"],
      ["voice", "install voice extras, then one hotkey press records, second press types the transcript"],
    ]) {
      this._row(concepts, k, v, []);
    }
  }
}
