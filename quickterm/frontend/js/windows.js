// Who owns which workspace, decided in one place.
//
// One backend process serves every QuickTerm window, and main.js autosaves the
// layout on every pane change (`scheduleWorkspaceSave`). Two windows sitting on
// one workspace would therefore write over each other's layout file, silently,
// with no undo: the last pane change wins and the other window's panes are
// gone. So the backend registry (quickterm/windows.py) hands out exactly one
// claim per workspace name, and this module turns its answers into the
// decisions and the wording the UI needs.
//
// Everything here is pure. The registry can be unreachable, half-migrated, or
// answering a shape we did not expect, and none of that may throw inside a boot
// path or a workspace switch, so the parsing is deliberately forgiving and the
// only hard refusal comes from an explicit 409.

// A window with no workspace is on scratch. Scratch is never claimed: an
// unadopted scratch layout has no file, so there is nothing to overwrite. The
// moment scratch is adopted it becomes the workspace named "scratch" and is
// claimed like any other.
export function normalizeWindows(payload) {
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.windows) ? payload.windows : [];
  return raw
    .filter((entry) => entry && entry.id !== undefined && entry.id !== null)
    .map((entry) => ({
      id: String(entry.id),
      workspace: entry.workspace || null,
      label: entry.title || entry.label || "",
      primary: Boolean(entry.primary),
    }));
}

// The window named in a 409 body ({detail, error, workspace, owner}). Reading
// it from the refusal itself beats re-listing the registry: the list can have
// moved on by the time it arrives, and then the refusal names nobody.
export function conflictHolder(error) {
  const owner = error && error.payload && error.payload.owner;
  return owner && owner.id ? normalizeWindows([owner])[0] : null;
}

// The other window holding `name`, or null. `selfId` is excluded because this
// window re-claiming what it already holds is not a conflict.
export function workspaceHolder(list, selfId, name) {
  if (!name) return null;
  return normalizeWindows(list).find(
    (entry) => entry.id !== selfId && entry.workspace === name,
  ) || null;
}

// The registry knows ids; the user knows windows. Say the thing a person can
// point at: the main window is the one they started, and any other window is
// identified by its title when the registry has one.
export function describeHolder(entry) {
  if (entry && entry.primary) return "the main window";
  const label = entry && entry.label ? String(entry.label).trim() : "";
  return label ? `another window (${label})` : "another window";
}

// Shown in #app-error when a switch is refused. It names the consequence, not
// the mechanism: "taken" alone reads like a bug, "would overwrite your layout"
// reads like a reason.
export function claimRefusalMessage(name, holder) {
  return `“${name}” is already open in ${describeHolder(holder)}. `
    + "Two windows on one workspace overwrite each other's saved layout, "
    + "so this window stayed where it was.";
}

// Rows for the "open a new window on…" picker. Workspaces that are taken stay
// in the list: removing them reads as "that workspace is gone", and the whole
// point of the list is to say which ones are free and why the others are not.
export function windowChoices(names, list, selfId, current) {
  const windows = normalizeWindows(list);
  return (names || []).map((name) => {
    const entry = windows.find((window) => window.workspace === name) || null;
    const mine = Boolean(entry && entry.id === selfId) || name === current;
    const holder = mine ? null : entry;
    const taken = mine || Boolean(holder);
    return {
      name,
      taken,
      mine,
      holder,
      hint: mine
        ? "already open in this window"
        : holder ? `already open in ${describeHolder(holder)}` : "",
    };
  });
}

export function windowChoiceMessage(row) {
  if (!row || !row.taken) return "";
  return row.mine
    ? `“${row.name}” is the workspace this window is already on.`
    : `“${row.name}” is already open in ${describeHolder(row.holder)}. `
      + "Two windows on one workspace overwrite each other's saved layout.";
}

// A 409 is the registry doing its job. Anything else (route missing on an older
// backend, backend restarting, a dropped loopback connection) is the registry
// failing, and a failing registry must not stop the user from working: it
// degrades to "carry on", never to "your claim succeeded".
export function claimOutcome(error) {
  return error && error.status === 409 ? "refused" : "unavailable";
}

// The plain-browser fallback for "new window". The per-install token reaches a
// window only through the URL fragment (`#t=`, see auth.py and captureToken in
// main.js), so a window opened without it lands on a page that cannot call a
// single /api route.
//
// `workspace` is three-valued, like `path` on the workspace PUT: undefined
// omits the parameter and lets the new window restore whatever it remembers,
// null opens a disposable scratch, a string opens that workspace.
export function newWindowUrl(basePath, workspace, token) {
  const path = basePath || "/";
  const query = workspace === undefined
    ? ""
    : `?workspace=${encodeURIComponent(workspace || "")}`;
  const fragment = token ? `#t=${encodeURIComponent(token)}` : "";
  return `${path}${query}${fragment}`;
}
