// Side by side workspaces without a DOM: which views the stage shows as
// columns and in what order, which column has the keyboard, how wide each
// column is, and the split as the open-views record keeps it.
// workspace_views.js and stage_chrome.js draw what these return.
//
// A column state is `{ shown, active }`: `shown` the views on screen in the
// order they were added, `active` the one with the keyboard, always one of
// them. The views themselves are opaque here.

export const MAX_COLUMNS = 4;
export const MIN_COLUMN_PX = 320;
// The gutter between two columns is a grid track of its own.
export const GUTTER_PX = 1;

const sameList = (a, b) => a.length === b.length && a.every((item, at) => item === b[at]);

export function sameColumns(a, b) {
  return a.active === b.active && sameList(a.shown, b.shown);
}

// `view` on its own, as a plain click in the sidebar shows it.
export function showAlone(view) {
  return { shown: [view], active: view };
}

// The keyboard goes to `view`: a column keeps the split, any other view is
// shown alone.
export function focusColumn({ shown, active }, view) {
  if (shown.includes(view)) return { shown: [...shown], active: view };
  return showAlone(view);
}

// A new column on the right, with the keyboard. Past MAX_COLUMNS the oldest
// column leaves, never the one that had the keyboard.
export function addColumn({ shown, active }, view) {
  if (shown.includes(view)) return { shown: [...shown], active: view };
  let next = [...shown, view];
  while (next.length > MAX_COLUMNS) {
    const oldest = next.find((each) => each !== active && each !== view);
    next = next.filter((each) => each !== oldest);
  }
  return { shown: next, active: view };
}

// One column out of the split; its view stays open. The last column cannot
// leave. When it had the keyboard, its left neighbour takes it (the new
// first column when it was the first).
export function removeColumn({ shown, active }, view) {
  const at = shown.indexOf(view);
  if (at < 0 || shown.length < 2) return { shown: [...shown], active };
  const next = shown.filter((each) => each !== view);
  return { shown: next, active: active === view ? next[Math.max(0, at - 1)] : active };
}

// Ctrl+click and the menu row: a column leaves, anything else joins.
export function toggleColumn(state, view) {
  return state.shown.includes(view) && state.shown.length > 1 ? removeColumn(state, view) : addColumn(state, view);
}

// The column left (-1) or right (1) of the active one; null at the edge or
// with one column.
export function stepColumn({ shown, active }, delta) {
  if (shown.length < 2) return null;
  const at = shown.indexOf(active);
  if (at < 0) return shown[0];
  return shown[at + (delta < 0 ? -1 : 1)] || null;
}

// ---- widths ----

export function equalFractions(count) {
  const n = Math.max(1, Math.floor(count) || 1);
  return Array.from({ length: n }, () => 1 / n);
}

// `values` as fractions that sum to 1, or equal ones when they cannot be:
// the wrong count, a value that is not a positive number.
export function normalizeFractions(values, count) {
  if (!Array.isArray(values) || values.length !== count || !count) return equalFractions(count);
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value) && value > 0)) {
    return equalFractions(count);
  }
  const sum = values.reduce((total, value) => total + value, 0);
  return values.map((value) => value / sum);
}

// Dragging the gutter after column `index` by `delta` pixels, of `total`
// pixels the columns share. Only the two columns beside the gutter change,
// and neither goes below `min` pixels; when the window is too narrow for
// that, the pair splits its space evenly at most.
export function dragFractions(fractions, index, delta, total, min = MIN_COLUMN_PX) {
  const next = [...fractions];
  if (index < 0 || index >= fractions.length - 1 || !(total > 0) || !Number.isFinite(delta)) return next;
  const pair = fractions[index] + fractions[index + 1];
  const floor = Math.min(min / total, pair / 2);
  const left = Math.min(pair - floor, Math.max(floor, fractions[index] + delta / total));
  next[index] = left;
  next[index + 1] = pair - left;
  return next;
}

// The stage's grid columns: each column a share of the width, a 1px gutter
// track between two.
export function gridTemplate(fractions) {
  const tracks = (fractions.length ? fractions : [1])
    .map((value) => `minmax(0, ${Math.round(value * 100000) / 1000}fr)`);
  return tracks.join(` ${GUTTER_PX}px `);
}

// Grid tracks are 1-based and gutters sit between: column n (0-based) is
// track 2n + 1, the gutter after it 2n + 2.
export const columnTrack = (index) => index * 2 + 1;
export const gutterTrack = (index) => index * 2 + 2;

// ---- the stored split ----

function splitName(value) {
  if (value === "") return "";
  return typeof value === "string" && value.trim() ? value : null;
}

// The split in a stored open-views record, checked: `split` names the
// columns in order (each one of `open`; "" is scratch), `widths` their
// fractions. Junk never costs the record: a bad name is skipped, duplicates
// and names past MAX_COLUMNS are dropped, widths that do not match fall back
// to equal ones. Null when fewer than two columns remain.
export function parseSplit(split, widths, open = []) {
  if (!Array.isArray(split)) return null;
  const names = [];
  let clean = true;
  for (const item of split) {
    const name = splitName(item);
    if (name === null || !open.includes(name) || names.includes(name) || names.length >= MAX_COLUMNS) {
      clean = false;
      continue;
    }
    names.push(name);
  }
  if (names.length < 2) return null;
  const sized = clean && Array.isArray(widths) && widths.length === names.length;
  return { names, widths: normalizeFractions(sized ? widths : null, names.length) };
}

// The record's split fields for `shown` (with 2+ columns), or null.
export function describeSplit(shown, fractions, nameOf) {
  if (!Array.isArray(shown) || shown.length < 2) return null;
  const widths = normalizeFractions(fractions, shown.length).map((value) => Math.round(value * 1000) / 1000);
  return { split: shown.map(nameOf), widths };
}

// The split that can come back once `open` is known: names that stay away
// leave it, and their widths with them.
export function keepSplit(split, open) {
  if (!split) return null;
  const kept = split.names.map((name, at) => [name, split.widths[at]]).filter(([name]) => open.includes(name));
  if (kept.length < 2) return null;
  return { names: kept.map(([name]) => name), widths: normalizeFractions(kept.map(([, width]) => width), kept.length) };
}
