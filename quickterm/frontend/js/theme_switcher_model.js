// The theme switcher's rules, without a document: which cards it shows in
// which group, what a search keeps, where the arrows go, and what each way of
// leaving does to the theme. theme_switcher.js draws and wires it.
//
// Four ids are tracked. `original` is the theme in force when the sheet
// opened, `applied` the last one saved from it (Enter or a click), `selected`
// the card the keyboard is on, and `previewed` what the window shows now
// (the selected card, or the one under the pointer).

import { CUSTOM_THEME, customColors, getTheme, resolveThemeId, themeGroups } from "./themes.js";

export const GROUPS = ["Dark", "Light", "Custom"];

// One entry per card, in display order.
export function switcherEntries(custom = {}) {
  const entries = [];
  for (const [group, ids] of themeGroups()) {
    for (const id of ids) {
      const def = getTheme(id);
      entries.push({ id, group, label: def.label, note: def.note, light: def.light });
    }
  }
  const def = getTheme(CUSTOM_THEME, custom);
  entries.push({ id: CUSTOM_THEME, group: "Custom", label: def.label, note: def.note, light: def.light });
  return entries;
}

// A word that names a group ("dark", "light", "custom") keeps that group
// only; every other word must start a word of the card's name, note or id. So
// "light blue" finds the light themes that call themselves blue, and "dark"
// does not also find Tokyo Night Day's "daylight" or a note about lights.
export function filterEntries(entries, query) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return entries;
  const groups = GROUPS.map((group) => group.toLowerCase());
  const wanted = words.filter((word) => groups.includes(word));
  const rest = words.filter((word) => !groups.includes(word));
  return entries.filter((entry) => {
    if (wanted.length && !wanted.includes(entry.group.toLowerCase())) return false;
    const tokens = `${entry.label} ${entry.note} ${entry.id}`.toLowerCase().split(/[^\p{L}\p{N}]+/u);
    return rest.every((word) => tokens.some((token) => token.startsWith(word)));
  });
}

// [{ heading, entries }] in GROUPS order, empty groups left out.
export function groupEntries(entries) {
  return GROUPS
    .map((heading) => ({ heading, entries: entries.filter((entry) => entry.group === heading) }))
    .filter((group) => group.entries.length);
}

// The id `delta` cards away from `current` in `ids`, clamped at both ends.
// A current id the filter removed starts from the first card.
export function stepId(ids, current, delta) {
  if (!ids.length) return null;
  const at = ids.indexOf(current);
  if (at < 0) return ids[0];
  return ids[Math.max(0, Math.min(ids.length - 1, at + delta))];
}

// A saved id from an older release resolves the way the window shows it.
function shownId(id) {
  return id === CUSTOM_THEME ? CUSTOM_THEME : resolveThemeId(id);
}

export function createSwitcherModel({ theme, custom = {} } = {}) {
  const id = shownId(theme);
  const colors = customColors(custom);
  return {
    original: id,
    applied: id,
    selected: id,
    previewed: id,
    custom: colors,
    originalCustom: colors,
    appliedCustom: colors,
  };
}

export function select(model, id) {
  return { ...model, selected: id, previewed: id };
}

// The pointer over a card previews it; leaving the grid (null) goes back to
// the keyboard's card.
export function hover(model, id) {
  return { ...model, previewed: id ?? model.selected };
}

export function editCustom(model, key, value) {
  const custom = customColors({ ...model.custom, [key]: value });
  return { ...model, custom, selected: CUSTOM_THEME, previewed: CUSTOM_THEME };
}

export function apply(model, id = model.selected) {
  return { ...model, applied: id, selected: id, previewed: id, appliedCustom: model.custom };
}

const sameColors = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// What leaving the sheet does: the theme the window ends on, the custom
// colours that go with it, and whether that has to be saved.
//   cancel   (Escape, Cancel) back to the theme the sheet opened on, saving
//            it again if something else was applied meanwhile.
//   done     (Done) keeps the card the keyboard is on, saving it if it was
//            only previewed.
//   outside  (a click outside the sheet) keeps what was applied and drops a
//            preview that was never applied.
export function closePlan(model, how) {
  if (how === "cancel") {
    const changed = model.applied !== model.original
      || (model.original === CUSTOM_THEME && !sameColors(model.appliedCustom, model.originalCustom));
    return { theme: model.original, custom: model.originalCustom, persist: changed };
  }
  if (how === "done") {
    const changed = model.selected !== model.applied
      || (model.selected === CUSTOM_THEME && !sameColors(model.custom, model.appliedCustom));
    return { theme: model.selected, custom: model.custom, persist: changed };
  }
  return { theme: model.applied, custom: model.appliedCustom, persist: false };
}
