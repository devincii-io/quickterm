import { environmentError } from "./panel_shared.js";

const REVISION_KEY = "quickterm.settingsRevision";

// Names a top-level key in the "changed in another window" message.
const KEY_LABELS = { profiles: "Terminals", snippets: "Snippets", window: "Window", overlay: "Overlay" };

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
 * footer shows it, or "". `profileProblem(profile, profiles)` adds the
 * per-type rules the Terminals tab knows about.
 */
export function settingsProblems(draft, { profileProblem } = {}) {
  const profiles = draft.profiles || [];
  const typed = profileProblem ? profiles.flatMap((profile) => profileProblem(profile, profiles)) : [];
  if (typed.length) return typed[0];
  if (profiles.some((profile) => !(profile.name || "").trim())) return "Every terminal needs a name.";
  const names = profiles.map((profile) => profile.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) return "Terminal names must be unique.";
  const badEnvironment = profiles.map((profile) => environmentError(profile.env)).find(Boolean);
  if (badEnvironment) return badEnvironment;
  const snippets = draft.snippets || [];
  if (snippets.some((snippet) => !(snippet.name || "").trim() || !(snippet.text || "").trim())) {
    return "Every snippet needs a name and command.";
  }
  const snippetNames = snippets.map((snippet) => snippet.name.trim().toLowerCase());
  if (new Set(snippetNames).size !== snippetNames.length) return "Snippet names must be unique.";
  return "";
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
