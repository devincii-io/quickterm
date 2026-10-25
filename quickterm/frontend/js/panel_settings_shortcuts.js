// Settings > Shortcuts: the summon key and a reference of the keys QuickTerm
// uses inside the window. The global key is captured by pressing it
// (shortcut_input.js) and saved with the footer Save; the server rebinds it
// at once.

import { make } from "./panel_shared.js";
import { SHORTCUTS } from "./keys.js";
import { shortcutInput, shortcutWarnings } from "./shortcut_input.js";

function warningLines(target, rows) {
  target.textContent = "";
  for (const row of rows) target.append(make("p", `shortcut-${row.level}`, row.text));
}

/** The summon key field, shared by the Window and Shortcuts tabs. */
export function renderSummonField(hint = "Shows or hides QuickTerm from anywhere in Windows.") {
  const cfg = this.settingsDraft;
  const warnings = make("div", "shortcut-warnings");
  const refresh = () => warningLines(warnings, shortcutWarnings(cfg.summon_hotkey));
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
  host.append(this._sectionHeading("Shortcuts", "The global key works anywhere in Windows. Press a key combination to set it."));

  const global = make("div", "settings-group");
  global.append(make("h3", "settings-group-title", "Global"));
  global.append(renderSummonField.call(this));
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
