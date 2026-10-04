// Settings > Shortcuts: the summon key, every saved terminal's global key in
// one table, and a reference of the keys QuickTerm uses inside the window.
// Each global key is captured by pressing it (shortcut_input.js) and saved
// with the footer Save; the server rebinds them at once.

import { inferTerminalType, make } from "./panel_shared.js";
import { SHORTCUTS } from "./keys.js";
import { shortcutInput, shortcutWarnings } from "./shortcut_input.js";
import { kindLabel } from "./panel_connections.js";

function warningLines(target, rows) {
  target.textContent = "";
  for (const row of rows) target.append(make("p", `shortcut-${row.level}`, row.text));
}

/** The summon key field, shared by the Window and Shortcuts tabs. */
export function renderSummonField(hint = "Shows or hides QuickTerm from anywhere in Windows.") {
  const cfg = this.settingsDraft;
  const warnings = make("div", "shortcut-warnings");
  const refresh = () => warningLines(warnings, shortcutWarnings(cfg.summon_hotkey, {
    profiles: cfg.profiles || [], selfIndex: -1,
  }));
  const input = shortcutInput({
    value: cfg.summon_hotkey,
    label: "Summon shortcut",
    onChange: (binding) => {
      cfg.summon_hotkey = binding || "";
      refresh();
    },
  });
  const error = this.app.hotkeyError?.();
  const field = this._field("Summon shortcut", input.el, error ? `Could not be registered: ${error}` : hint, { id: "summon_hotkey" });
  if (error) field.classList.add("has-error");
  field.append(warnings);
  refresh();
  return field;
}

export function renderShortcutSettings(host) {
  const cfg = this.settingsDraft;
  cfg.profiles ||= [];
  host.append(this._sectionHeading("Shortcuts", "Global keys work anywhere in Windows. Press a key combination to set one."));

  const global = make("div", "settings-group");
  global.append(make("h3", "settings-group-title", "Global"));
  global.append(renderSummonField.call(this));

  const table = make("div", "shortcut-table");
  table.dataset.setting = "terminal_shortcuts";
  table.setAttribute("role", "table");
  table.setAttribute("aria-label", "Terminal shortcuts");
  const rows = [];
  const refreshAll = () => {
    for (const { profile, warnings } of rows) {
      warningLines(warnings, shortcutWarnings(profile.keybinding, {
        summon: cfg.summon_hotkey, profiles: cfg.profiles, selfIndex: cfg.profiles.indexOf(profile),
      }));
    }
  };
  for (const profile of cfg.profiles) {
    const kind = inferTerminalType(profile);
    const desktop = kind === "rdp" || kind === "vnc";
    const row = make("div", "shortcut-table-row");
    row.setAttribute("role", "row");
    const name = make("div", "shortcut-table-name");
    name.setAttribute("role", "rowheader");
    name.append(make("strong", "", profile.name || "Untitled"), make("small", "", kindLabel(kind)));
    const warnings = make("div", "shortcut-warnings");
    const input = shortcutInput({
      value: profile.keybinding,
      label: `Global shortcut for ${profile.name || "this terminal"}`,
      disabled: desktop,
      onChange: (binding) => {
        profile.keybinding = binding || null;
        refreshAll();
      },
    });
    const control = make("div", "shortcut-table-control");
    control.setAttribute("role", "cell");
    control.append(input.el, warnings);
    row.append(name, control);
    table.append(row);
    rows.push({ profile, warnings });
  }
  if (!rows.length) {
    // An empty table with a loose paragraph in it is not a table.
    table.removeAttribute("role");
    table.removeAttribute("aria-label");
    table.append(make("p", "settings-note", "No saved terminals yet. Add one under Terminals to give it a global key."));
  }
  global.append(make("h3", "settings-group-title shortcut-table-title", "Terminals"), table);
  refreshAll();
  host.append(global);

  const inApp = make("div", "settings-group");
  inApp.dataset.setting = "app_keys";
  inApp.append(make("h3", "settings-group-title", "Inside QuickTerm"));
  inApp.append(make("p", "settings-note", "Only cold Alt keys are claimed. Plain Alt+V, Alt+P, Alt+H, Alt+B, Alt+F and Alt+0 to 9 stay with your shell and agents."));
  inApp.append(renderShortcutReference());
  host.append(inApp);
}

/** The in-app keys as rows of a kbd chip and a sentence, grouped. */
export function renderShortcutReference() {
  const box = make("div", "shortcut-reference");
  for (const group of [...new Set(SHORTCUTS.map((item) => item.group))]) {
    box.append(make("h4", "shortcut-group", group));
    for (const item of SHORTCUTS.filter((shortcut) => shortcut.group === group)) {
      const row = make("div", "shortcut-row");
      row.append(make("kbd", "", item.keys), make("span", "", item.label));
      box.append(row);
    }
  }
  return box;
}
