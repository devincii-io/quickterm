// The Claude Code and Codex option fields, generated from the schema the
// backend serves at GET /api/system/agents. Nothing here knows an option by
// name except the one cross-option rule both sides check (agentConflicts):
// a new CLI flag is a backend change only.
//
// Values live in `profile.agent[key]` as strings. An empty value deletes the
// key, so a profile only carries what the user actually set. Drawing the
// fields writes nothing, so looking at a profile never marks it unsaved.

import { AGENT_MODES, AGENT_MODE_LABELS, agentModeOf } from "./agent_profile.js";
import { make } from "./panel_shared.js";
import {
  comboInput, configChoice, configProblems, configToggle,
} from "./panel_settings_kit.js";
import {
  agentConflicts,
} from "./profile_model.js";

function field(label, control, hint, key) {
  const wrap = make("label", "settings-field");
  if (key) wrap.dataset.option = key;
  wrap.append(make("span", "field-label", label), control);
  if (hint) wrap.append(make("span", "field-hint", hint));
  return wrap;
}

/** Writes one option, deleting it when the value is empty. */
export function setAgentOption(profile, key, value) {
  profile.agent ||= {};
  const text = value == null ? "" : String(value);
  if (text === "") delete profile.agent[key];
  else profile.agent[key] = text;
}

export function setAgentMode(profile, kind, mode) {
  profile.agent_mode = mode;
  // A claude-code profile also carries the legacy key, which builds before
  // 4.0 still read; codex never had one.
  if (kind === "claude-code") profile.claude_mode = mode;
  else delete profile.claude_mode;
}

function modeOptions(catalogType, kind) {
  if (catalogType?.modes?.length) return catalogType.modes.map((mode) => ({ value: mode.value, label: mode.label, detail: mode.detail }));
  return (AGENT_MODES[kind] || AGENT_MODES["claude-code"]).map((value) => ({ value, label: AGENT_MODE_LABELS[value] || value }));
}

function optionControl(option, profile, changed) {
  const value = profile.agent?.[option.key] ?? "";
  const label = option.label || option.key;
  if (option.kind === "choice") {
    const choice = configChoice({
      label,
      value,
      options: [{ value: "", label: "CLI default" }, ...(option.choices || []).map((item) => ({ value: item.value, label: item.label || item.value, detail: item.detail }))],
      onChange: (next) => changed(option.key, next),
    });
    return choice.el;
  }
  if (option.kind === "combo") {
    return comboInput({
      value,
      label,
      placeholder: option.placeholder || "CLI default",
      suggestions: () => (option.choices || []).map((item) => ({ value: item.value, label: item.label || item.value, detail: item.detail })),
      onInput: (next) => changed(option.key, next.trim()),
    }).el;
  }
  if (option.kind === "lines") {
    const area = make("textarea", "ui-input");
    area.rows = 3;
    area.spellcheck = false;
    area.value = value;
    area.placeholder = option.placeholder || "One per line";
    area.setAttribute("aria-label", label);
    area.addEventListener("keydown", (event) => event.stopPropagation());
    area.addEventListener("input", () => changed(option.key, area.value.split("\n").map((line) => line.trim()).filter(Boolean).join("\n")));
    return area;
  }
  const input = make("input", "ui-input");
  input.value = value;
  input.placeholder = option.placeholder || "";
  input.spellcheck = false;
  input.setAttribute("aria-label", label);
  input.addEventListener("keydown", (event) => event.stopPropagation());
  input.addEventListener("input", () => changed(option.key, input.value));
  return input;
}

/**
 * Draws the launch mode and every option of `catalogType` for `profile`.
 * `modeHost` and `advancedHost` place the mode and the advanced options
 * elsewhere in the editor (its own launch-mode slot and Advanced section);
 * without them everything goes into `container`, advanced options under a
 * disclosure. A null catalog type (the catalog did not load) still offers the
 * launch mode, with a note.
 */
export function renderAgentFields(container, profile, catalogType, { onChange, modeHost, advancedHost } = {}) {
  const kind = catalogType?.id || profile.terminal_type || "claude-code";
  const conflictSlot = make("div", "config-problem-slot");
  const showConflicts = () => {
    conflictSlot.textContent = "";
    const box = configProblems(agentConflicts(kind, profile.agent));
    if (box) conflictSlot.append(box);
  };
  const changed = (key, value) => {
    setAgentOption(profile, key, value);
    showConflicts();
    onChange?.(key, value);
  };

  const mode = configChoice({
    label: "Launch mode",
    value: agentModeOf(profile, kind),
    options: modeOptions(catalogType, kind),
    onChange: (next) => {
      setAgentMode(profile, kind, next);
      onChange?.("agent_mode", next);
    },
  });
  const modeField = field("Launch mode", mode.el, "What starts when you open it. A palette row can pick another mode for one launch.", "agent_mode");
  modeField.dataset.setting = "agent_mode";
  (modeHost || container).append(modeField);

  if (!catalogType) {
    container.append(make("p", "settings-note", "Agent options could not be loaded, so only the launch mode is shown. Options already saved are kept."));
    return { refresh: showConflicts };
  }

  // Labelled fields share a two-column grid; switches get a full-width row
  // group of their own after them. Mixed into the grid, a switch floated in
  // a cell beside a tall field and left a hole under it.
  const group = () => {
    const fields = make("div", "settings-grid two-column agent-options");
    const toggles = make("div", "agent-toggles");
    const wrap = make("div", "agent-option-group");
    wrap.append(fields, toggles);
    return { wrap, fields, toggles };
  };
  const basicGroup = group();
  const advancedGroup = group();
  for (const option of catalogType.options || []) {
    const { fields, toggles } = option.advanced ? advancedGroup : basicGroup;
    if (option.kind === "toggle") {
      const toggle = configToggle({
        label: option.label || option.key,
        checked: profile.agent?.[option.key] === "true",
        title: option.hint || "",
        onChange: (checked) => changed(option.key, checked ? "true" : ""),
      });
      toggle.el.dataset.option = option.key;
      toggles.append(toggle.el);
      continue;
    }
    fields.append(field(option.label || option.key, optionControl(option, profile, changed), option.hint, option.key));
  }
  for (const { fields, toggles } of [basicGroup, advancedGroup]) {
    if (!fields.children.length) fields.remove();
    if (!toggles.children.length) toggles.remove();
  }
  container.append(basicGroup.wrap, conflictSlot);
  if (advancedGroup.wrap.children.length) {
    if (advancedHost) advancedHost.append(advancedGroup.wrap);
    else {
      const more = make("details", "config-advanced");
      more.append(make("summary", "", "More options"), advancedGroup.wrap);
      container.append(more);
    }
  }
  showConflicts();
  return { refresh: showConflicts };
}
