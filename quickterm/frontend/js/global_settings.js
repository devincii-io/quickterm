const REVISION_KEY = "quickterm.settingsRevision";

export function settingsPatch(draft, baseline, fresh) {
  const patch = {};
  for (const key of Object.keys(draft)) {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (same(draft[key], baseline[key])) continue;
    if (!same(fresh[key], baseline[key]) && !same(fresh[key], draft[key])) {
      throw new Error(`${key === "profiles" ? "Terminals and connections" : key} changed in another window. Reopen Settings before saving.`);
    }
    patch[key] = draft[key];
  }
  return patch;
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
