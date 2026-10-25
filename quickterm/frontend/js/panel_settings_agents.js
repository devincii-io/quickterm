// Settings > Terminals: the Agents section. Claude Code and Codex are one
// settings entry each (config `agents`, CONTRACTS 4.3): a row that
// shows the command the settings start, opening into the option editor. Both
// run inside the configured shell. Edits go into `settingsDraft.agents`; the
// footer Save persists them like every other setting.

import { AGENT_NAMES, AGENT_TYPES, agentCommandLine, agentInstalled } from "./agent_profile.js";
import { make } from "./panel_shared.js";
import { agentCatalog, renderEnvironment } from "./panel_connections.js";
import { renderAgentFields } from "./panel_agent_fields.js";

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
