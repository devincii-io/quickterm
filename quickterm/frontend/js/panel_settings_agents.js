// Settings > Agents. Claude Code and Codex are one settings entry each
// (config `agents`, CONTRACTS 4.3): a row that shows the command the
// settings start, opening into the option editor. Both run inside the
// configured shell. Edits go into `settingsDraft.agents`; the footer Save
// persists them like every other setting.

import * as api from "./api.js";
import { AGENT_NAMES, AGENT_TYPES, agentCommandLine, agentInstalled } from "./agent_profile.js";
import { icon } from "./icons.js";
import { make } from "./panel_shared.js";
import { renderAgentFields } from "./panel_agent_fields.js";
import { configToggle } from "./panel_settings_kit.js";

// The option schema (GET /api/system/agents), read once per opening of
// Settings; Settings never waits for it.
export function agentCatalog(panel) {
  panel.agentCatalogLoad ||= Promise.resolve()
    .then(() => (panel.services || api).getAgentCatalog?.())
    .catch(() => null);
  return panel.agentCatalogLoad;
}

export function emptyAgentSettings() {
  return { cmd: "", args: [], agent_mode: null, agent: {}, env: {} };
}

export function renderAgentSettings(host) {
  const cfg = this.settingsDraft;
  cfg.agents ||= {};
  for (const kind of AGENT_TYPES) cfg.agents[kind] ||= emptyAgentSettings();
  host.append(this._sectionHeading("Agents", "Claude Code and Codex, started from the + menu inside your shell, in the workspace folder."));
  const section = make("div", "settings-group agent-settings");
  host.append(section);
  for (const kind of AGENT_TYPES) section.append(agentRow.call(this, kind, cfg.agents[kind]));
  const limits = make("div", "settings-group");
  limits.append(make("h3", "settings-group-title", "Usage limits"), configToggle({
    id: "usage_online",
    label: "Ask Anthropic for each Claude account's current limits",
    checked: cfg.usage_online !== false,
    onChange: (checked) => { cfg.usage_online = checked; },
  }).el, make("p", "field-hint",
    "Uses Claude Code's own sign-in on this computer, sent only to api.anthropic.com and never stored. "
    + "Off: limits come from Claude Code's status line and its last /usage."));
  host.append(limits);
}

function agentRow(kind, settings) {
  const row = make("details", "config-advanced agent-settings-row");
  row.dataset.setting = `agents.${kind}`;
  const summary = make("summary", "agent-settings-summary");
  const name = make("strong", "", AGENT_NAMES[kind]);
  const line = make("code", "agent-settings-line");
  const state = make("span", "field-hint");
  summary.append(name, " ", line, " ", state);
  row.append(summary);
  let options = [];
  const paint = () => {
    line.textContent = agentCommandLine(kind, settings, options);
    state.textContent = agentInstalled(this.terminalInventory, kind, settings) ? "" : "not found on PATH";
  };
  const touched = () => paint();
  paint();

  // The editor is drawn when the row is first opened, so a closed row costs
  // nothing and looking at it never changes the draft.
  let drawn = false;
  row.addEventListener("toggle", () => {
    if (!row.open || drawn) return;
    drawn = true;
    const body = make("div", "agent-settings-body");
    row.append(body);
    const fields = make("div", "settings-grid two-column connection-fields");
    const exe = this._textInput(settings.cmd || "", kind === "codex" ? "codex" : "claude");
    exe.setAttribute("aria-label", `${AGENT_NAMES[kind]} executable`);
    exe.addEventListener("input", () => { settings.cmd = exe.value; touched(); });
    fields.append(this._field("Executable", exe, "Empty means the one found on PATH."));
    body.append(fields);
    const optionsHost = make("div", "agent-fields");
    optionsHost.append(make("p", "config-detail-placeholder", "Loading options…"));
    body.append(optionsHost);
    agentCatalog(this).then((catalog) => {
      const type = catalog?.types?.find((item) => item.id === kind) || null;
      options = type?.options || [];
      optionsHost.textContent = "";
      renderAgentFields(optionsHost, settings, type || { id: kind, options: [] }, { onChange: touched });
      paint();
    });
    const args = make("textarea", "ui-input connection-args");
    args.value = (settings.args || []).join("\n");
    args.rows = 2;
    args.spellcheck = false;
    args.setAttribute("aria-label", "Arguments, one per line");
    args.addEventListener("keydown", (event) => event.stopPropagation());
    args.addEventListener("input", () => {
      settings.args = args.value.split(/\r?\n/).filter((item) => item !== "");
      touched();
    });
    const more = make("details", "config-advanced");
    more.append(make("summary", "", "Advanced"));
    more.append(this._field("Arguments, one per line", args, "Added after the options above."));
    more.append(renderEnvironment.call(this, settings, touched));
    body.append(more);
  });
  return row;
}

// The agent's environment variables as key and value rows.
export function renderEnvironment(profile, touched) {
  const box = make("div", "connection-environment-field");
  box.dataset.setting = "environment";
  box.append(make("span", "field-label", "Environment"));
  const rowsHost = make("div", "connection-environment");
  const rows = Object.entries(profile.env || {}).map(([key, value]) => ({ key, value }));
  const sync = () => {
    profile.env = Object.fromEntries(rows.filter((row) => row.key).map((row) => [row.key, row.value]));
    touched();
  };
  const draw = () => {
    rowsHost.textContent = "";
    for (const row of rows) {
      const line = make("div", "connection-env-row");
      for (const part of ["key", "value"]) {
        const input = this._textInput(row[part], part === "key" ? "Variable" : "Value");
        input.setAttribute("aria-label", part === "key" ? "Environment variable name" : "Environment variable value");
        input.addEventListener("input", () => { row[part] = input.value; sync(); });
        line.append(input);
      }
      const remove = this._button("", "icon-button");
      remove.append(icon("x", 14));
      remove.title = "Remove variable";
      remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", () => {
        const index = rows.indexOf(row);
        rows.splice(index, 1);
        sync();
        draw();
        // draw() rebuilt every row and dropped focus to <body>, outside the
        // modal sheet. Keep the place: the row that moved up, else the one
        // before, else Add variable.
        const next = rowsHost.children[Math.min(index, rowsHost.children.length - 1)];
        (next?.children?.[0] || add).focus();
      });
      line.append(remove);
      rowsHost.append(line);
    }
  };
  const add = this._button("Add variable", "secondary-button compact");
  add.title = "Values are encrypted on disk with your Windows account.";
  add.addEventListener("click", () => {
    rows.push({ key: "", value: "" });
    draw();
    rowsHost.lastElementChild?.querySelector?.("input")?.focus();
  });
  box.append(rowsHost, add);
  draw();
  return box;
}
