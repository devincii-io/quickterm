// The "New workspace…" dialog: Location, Folder, Name, Create. One sheet
// for this PC, WSL and SSH; the rules live in new_workspace.js. It claims
// the keyboard while open (focus.js), so the terminal's deferred focus does
// not take the inputs away, and the folder browser stacks on top of it.

import { claimFocus, releaseFocus } from "./focus.js";
import { icon } from "./icons.js";
import { toggleMenu } from "./menu.js";
import { openFolderBrowser } from "./folder_browser.js";
import {
  DEFAULT_START_WITH, OTHER_SSH, START_WITH, THIS_PC, browseStart, browsedFolder, canBrowse,
  createLocationWorkspace, createRequest, hostFor, normalizeLocations, startWithItems, suggestName,
  toggleStartWith, workspaceAt,
} from "./new_workspace.js";
import { startupKindLabel } from "./workspace_setup.js";

const OWNER = "new-workspace";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function field(label, control, hint) {
  const wrap = el("label", "settings-field nw-field");
  wrap.append(el("span", "field-label", label), control);
  if (hint) wrap.append(hint);
  return wrap;
}

function folderHint(location, typedHost) {
  if (location.kind === "local") return "A folder on this PC.";
  if (location.kind === "wsl") return `A folder in ${location.label}, like /home/you/app or ~/app.`;
  const host = hostFor(location, typedHost) || "the host";
  return `A folder on ${host}, like /srv/app or ~/code/app.`;
}

/** Opens the dialog. Resolves to the name of the workspace it opened, or
 *  null when it was closed. `takenNames()` prefills a free name; the save
 *  reads the list again before it writes. */
export function openNewWorkspaceDialog({
  api, folders, takenNames = () => [], suggestedFolder = "", nativePicker = null, openView, onWorkspacesChanged,
}) {
  const overlay = el("div", "nw-overlay");
  const dialog = el("div", "nw");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "nw-title");

  const head = el("div", "nw-head");
  const title = el("strong", "nw-title", "New workspace");
  title.id = "nw-title";
  const closeBtn = el("button", "nw-close");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Cancel");
  closeBtn.title = "Cancel (Esc)";
  closeBtn.append(icon("x", 14));
  head.append(title, closeBtn);

  const locationBtn = el("button", "ui-input nw-location");
  locationBtn.type = "button";
  locationBtn.setAttribute("aria-haspopup", "menu");
  locationBtn.setAttribute("aria-expanded", "false");
  const locationText = el("span", "nw-location-label");
  const locationDetail = el("small", "nw-location-detail");
  locationBtn.append(locationText, locationDetail, icon("chevron-down", 12));

  const hostInput = el("input", "ui-input nw-host");
  hostInput.spellcheck = false;
  hostInput.autocomplete = "off";
  hostInput.placeholder = "user@server, ssh://user@server:2222 or a Host alias";
  const hostField = field("SSH host", hostInput, el("span", "field-hint", "Port, key and ProxyJump come from ~/.ssh/config."));

  const folderInput = el("input", "ui-input nw-folder");
  folderInput.spellcheck = false;
  folderInput.autocomplete = "off";
  const browseBtn = el("button", "secondary-button nw-browse", "Browse…");
  browseBtn.type = "button";
  const folderRow = el("div", "nw-folder-row");
  folderRow.append(folderInput, browseBtn);
  const folderHintEl = el("span", "field-hint");

  const nameInput = el("input", "ui-input nw-name");
  nameInput.spellcheck = false;
  nameInput.autocomplete = "off";

  // "Start with": toggles, any combination; Shell is on to begin with.
  let startWith = [...DEFAULT_START_WITH];
  const startRow = el("div", "nw-start");
  startRow.setAttribute("role", "group");
  startRow.setAttribute("aria-label", "Start with");
  const startButtons = new Map();
  for (const kind of START_WITH) {
    const button = el("button", "nw-start-toggle", startupKindLabel(kind));
    button.type = "button";
    button.addEventListener("click", () => {
      startWith = toggleStartWith(startWith, kind);
      paintStartWith();
    });
    startButtons.set(kind, button);
    startRow.append(button);
  }
  const startHint = el("span", "field-hint");
  function paintStartWith() {
    for (const [kind, button] of startButtons) button.setAttribute("aria-pressed", String(startWith.includes(kind)));
    startHint.textContent = startWith.length
      ? "Each starts in its own pane when the workspace opens. Change it later in Workspace settings."
      : "Nothing chosen: the workspace opens with one shell.";
  }
  paintStartWith();
  const startField = el("div", "settings-field nw-field");
  startField.append(el("span", "field-label", "Start with"), startRow, startHint);

  const message = el("div", "nw-msg");
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");

  const body = el("div", "nw-body");
  body.append(
    field("Location", locationBtn),
    hostField,
    field("Folder", folderRow, folderHintEl),
    field("Name", nameInput, el("span", "field-hint", "Named after the folder; change it if you like.")),
    startField,
    message,
  );

  const foot = el("div", "nw-foot");
  const cancelBtn = el("button", "secondary-button nw-cancel", "Cancel");
  cancelBtn.type = "button";
  const createBtn = el("button", "primary-button nw-create", "Create");
  createBtn.type = "button";
  foot.append(el("span", "nw-foot-gap"), cancelBtn, createBtn);

  dialog.append(head, body, foot);
  overlay.append(dialog);
  document.body.append(overlay);
  claimFocus(OWNER);

  let locations = [THIS_PC];
  let location = THIS_PC;
  let nameEdited = false;
  // The host and folder whose check failed: a second Create saves them.
  let unchecked = null;
  let busy = false;
  let settled = false;

  return new Promise((resolve) => {
    function finish(value) {
      if (settled) return;
      settled = true;
      overlay.remove();
      // Before resolving: whoever takes the keyboard next must not be refused.
      releaseFocus(OWNER);
      resolve(value);
    }

    const say = (text, error = false) => {
      message.textContent = text || "";
      message.classList.toggle("nw-msg-error", Boolean(text) && error);
    };

    const currentHost = () => hostFor(location, hostInput.value);

    function prefillName() {
      if (nameEdited) return;
      nameInput.value = suggestName(currentHost(), folderInput.value, takenNames());
    }

    function showLocation() {
      locationText.textContent = location.label;
      locationDetail.textContent = location.detail || "";
      locationDetail.hidden = !location.detail;
      hostField.hidden = location.kind !== "other";
      browseBtn.hidden = !canBrowse(location);
      folderInput.placeholder = location.kind === "local" ? "C:\\code\\app" : "/home/you/app";
      folderHintEl.textContent = folderHint(location, hostInput.value);
    }

    function chooseLocation(next) {
      const wasLocal = location.kind === "local";
      location = next;
      unchecked = null;
      // A Windows folder means nothing in WSL or over SSH, and the other way.
      if (wasLocal !== (next.kind === "local")) folderInput.value = next.kind === "local" ? suggestedFolder || "" : "";
      showLocation();
      prefillName();
      say("");
      (next.kind === "other" ? hostInput : folderInput).focus();
    }

    function openLocationMenu() {
      const items = locations.map((entry) => ({
        label: entry.label, detail: entry.detail || undefined, selected: entry === location,
        icon: entry.kind === "local" ? "folder" : "terminal",
        run: () => chooseLocation(entry),
      }));
      items.push({ separator: true }, {
        label: OTHER_SSH.label, detail: "type a destination", selected: location.kind === "other",
        run: () => chooseLocation(OTHER_SSH),
      });
      toggleMenu({
        anchor: locationBtn, trigger: locationBtn, items, label: "Location",
        onClose: (reason) => { if (reason !== "run" && !settled) locationBtn.focus(); },
      });
    }

    async function browse() {
      const start = browseStart(location, folderInput.value, suggestedFolder);
      const chosen = await openFolderBrowser({
        startPath: start || "",
        title: `Folder for the new workspace${location.kind === "wsl" ? ` in ${location.label}` : ""}`,
        label: "Choose the new workspace's folder",
        confirmLabel: "Use this folder",
        nativePicker: location.kind === "local" ? nativePicker : null,
      });
      if (settled) return;
      folderInput.focus();
      const answer = browsedFolder(location, chosen);
      if (answer.problem) { say(answer.problem, true); return; }
      if (!answer.path) return;
      folderInput.value = answer.path;
      unchecked = null;
      say("");
      prefillName();
    }

    async function create() {
      if (busy) return;
      const request = createRequest({
        location, typedHost: hostInput.value, folder: folderInput.value, name: nameInput.value,
      });
      if (request.problem) {
        say(request.problem, true);
        ({ host: hostInput, folder: folderInput, name: nameInput })[request.field]?.focus();
        return;
      }
      busy = true;
      createBtn.disabled = true;
      try {
        let path = request.path;
        if (request.kind === "local") {
          // Resolved like the folder browser does, so a typo is said here
          // instead of becoming a workspace whose folder does not exist.
          say("Checking the folder…");
          const listed = await api.listDirs(path).catch((error) => ({ error }));
          if (settled) return;
          if (listed.error) { say(listed.error.detail || `${path} is not a folder on this PC.`, true); return; }
          path = listed.path || path;
        } else {
          const key = `${request.host}\u0000${path}`;
          // A folder that already is a workspace's opens that one unchecked.
          if (unchecked !== key && !workspaceAt(request.host, path, folders)) {
            say(`Checking ${path} in ${location.kind === "wsl" ? location.label : request.host}…`);
            const check = await api.checkRemoteFolder(request.host, path)
              .catch((error) => ({ ok: false, message: error?.detail || "The check failed." }));
            if (settled) return;
            if (!check?.ok) {
              unchecked = key;
              say(`${check?.message || `${path} was not found.`} Create again to save it anyway.`, true);
              return;
            }
          }
        }
        say("Creating the workspace…");
        const made = await createLocationWorkspace({
          api, host: request.host, path, name: request.name, folders, openView, onWorkspacesChanged,
          startup: startWithItems(startWith),
        });
        finish(made.name);
      } catch (error) {
        if (!settled) say(error?.detail || error?.message || "The workspace could not be saved.", true);
      } finally {
        busy = false;
        createBtn.disabled = false;
      }
    }

    locationBtn.addEventListener("click", openLocationMenu);
    browseBtn.addEventListener("click", browse);
    createBtn.addEventListener("click", create);
    cancelBtn.addEventListener("click", () => finish(null));
    closeBtn.addEventListener("click", () => finish(null));
    overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) finish(null); });
    hostInput.addEventListener("input", () => {
      unchecked = null;
      folderHintEl.textContent = folderHint(location, hostInput.value);
      prefillName();
    });
    folderInput.addEventListener("input", () => { unchecked = null; prefillName(); });
    nameInput.addEventListener("input", () => { nameEdited = Boolean(nameInput.value.trim()); });

    dialog.addEventListener("keydown", (event) => {
      // The sheet and keys.js listen on document; this dialog's keys stay here.
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        finish(null);
      } else if (event.key === "Enter" && event.target.tagName === "INPUT") {
        event.preventDefault();
        create();
      } else if (event.key === "Tab") {
        const focusable = [...dialog.querySelectorAll("button:not([disabled]), input:not([disabled])")]
          .filter((node) => !node.hidden && node.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });

    folderInput.value = suggestedFolder || "";
    showLocation();
    prefillName();
    Promise.resolve(api.getLocations?.()).then((answer) => {
      if (settled) return;
      locations = normalizeLocations(answer);
    }).catch((error) => {
      if (!settled) say(`Only this PC is offered: ${error?.detail || "the locations could not be read"}.`, true);
    });
    // WebView2 does not reliably focus an element that only just entered the
    // layout, so ask again on the next frame.
    folderInput.focus();
    requestAnimationFrame(() => { if (!settled && !dialog.contains(document.activeElement)) folderInput.focus(); });
  });
}
