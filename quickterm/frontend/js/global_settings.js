import { environmentError } from "./panel_shared.js";
import { normalizeBinding, shortcutWarnings } from "./shortcut_input.js";

const REVISION_KEY = "quickterm.settingsRevision";

// Names a top-level key in the "changed in another window" message.
const KEY_LABELS = { agents: "Agents", snippets: "Snippets", window: "Window", overlay: "Overlay" };

// Every top-level key is compared and sent whole, nested ones (window,
// overlay, voice) included: two windows editing different fields of one of
// them report a conflict rather than merging, which is the safe failure.
export function settingsPatch(draft, baseline, fresh) {
  const patch = {};
  for (const key of Object.keys(draft)) {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (same(draft[key], baseline[key])) continue;
    if (!same(fresh[key], baseline[key]) && !same(fresh[key], draft[key])) {
      throw new Error(`${KEY_LABELS[key] || key} changed in another window. Reopen Settings before saving.`);
    }
    patch[key] = draft[key];
  }
  return patch;
}

/**
 * The first thing in the draft the backend would refuse, said the way the
 * footer shows it, or "".
 */
export function settingsProblems(draft, { baseline = null } = {}) {
  const binding = bindingProblem(draft, baseline);
  if (binding) return binding;
  const badEnvironment = Object.values(draft.agents || {}).map((agent) => environmentError(agent?.env)).find(Boolean);
  if (badEnvironment) return badEnvironment;
  const snippets = draft.snippets || [];
  if (snippets.some((snippet) => !(snippet.name || "").trim() || !(snippet.text || "").trim())) {
    return "Every snippet needs a name and command.";
  }
  const snippetNames = snippets.map((snippet) => snippet.name.trim().toLowerCase());
  if (new Set(snippetNames).size !== snippetNames.length) return "Snippet names must be unique.";
  return "";
}

// The red line under the summon field, as the save refuses it. A binding
// already saved (3.x took free text) is not refused again, the same rule as
// config.validate_new_bindings.
function bindingProblem(draft, baseline) {
  const binding = draft.summon_hotkey;
  if (!binding) return "";
  const legacy = Boolean(baseline?.summon_hotkey) && normalizeBinding(baseline.summon_hotkey) === normalizeBinding(binding);
  const error = shortcutWarnings(binding).find((row) => row.level === "error" && !(legacy && row.modifier));
  return error ? `Summon shortcut: ${error.text}` : "";
}

// Only a revision travels between windows; credentials stay in authenticated API calls.
export function watchGlobalSettings({ target = globalThis.window, storage = globalThis.localStorage, refresh }) {
  let pending = null;
  const sync = () => {
    if (pending) return pending;
    pending = Promise.resolve().then(refresh).catch(() => {}).finally(() => { pending = null; });
    return pending;
  };
  const changed = (event) => { if (event.key === REVISION_KEY) sync(); };
  const focused = () => sync();
  target.addEventListener("storage", changed);
  target.addEventListener("focus", focused);
  return {
    publish() { try { storage.setItem(REVISION_KEY, `${Date.now()}:${Math.random()}`); } catch (_) { /* focus also refreshes */ } },
    dispose() { target.removeEventListener("storage", changed); target.removeEventListener("focus", focused); },
  };
}
