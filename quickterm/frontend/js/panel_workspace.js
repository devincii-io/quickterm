// "Workspace settings" from a sidebar workspace's menu: its location and
// folder, its environment, what it starts with, its logo and a miniature of
// its saved layout. The board shows status, not settings.

import * as api from "./api.js";
import { locationKind, locationLabel } from "./locations.js";
import { countPanes, folderPickerControl, make } from "./panel_shared.js";
import { envEditor, startupEditor } from "./panel_setup_fields.js";
import { agentCatalog } from "./panel_settings_agents.js";
import { cleanStartupItem, startupItems } from "./workspace_setup.js";

// A miniature of a workspace's split layout.
export function layoutPreview(layout) {
  const build = (node) => {
    if (!node || node.type !== "split") {
      const pane = make("span", "workspace-preview-pane");
      pane.append(make("i", "", node && node.profile ? node.profile : "terminal"));
      return pane;
    }
    const split = make("span", `workspace-preview-split ${node.dir === "v" ? "vertical" : "horizontal"}`);
    const ratio = Math.max(20, Math.min(80, Math.round((node.ratio || 0.5) * 100)));
    const children = node.children || [];
    const first = build(children[0]);
    const second = build(children[1]);
    first.style.flex = `${ratio} 1 0`;
    second.style.flex = `${100 - ratio} 1 0`;
    split.append(first, second);
    return split;
  };
  const preview = make("div", "workspace-preview");
  preview.append(build(layout));
  return preview;
}

function section(title, hint) {
  const box = make("section", "workspace-settings-section");
  const head = make("div", "workspace-settings-section-head");
  head.append(make("h2", "workspace-settings-section-title", title));
  if (hint) head.append(make("p", "field-hint", hint));
  box.append(head);
  return box;
}

export async function renderWorkspaceSettings(name) {
  const panel = this;
  const body = panel.bodyEl;
  body.textContent = "";
  body.append(make("div", "panel-loading", "Reading the workspace…"));
  const [saved, config] = await Promise.all([
    api.getWorkspace(name).catch(() => null),
    api.getConfig().catch(() => null),
  ]);
  if (panel.open !== "workspace" || panel._workspaceName !== name) return;
  body.textContent = "";
  if (!saved) {
    body.append(make("div", "settings-error", `Workspace "${name}" could not be read.`));
    return;
  }

  const root = make("div", "workspace-settings");
  const host = saved.host || null;
  const kind = locationKind(host);
  const location = make("div", "workspace-settings-location");
  location.append(make("span", "workspace-settings-location-label", locationLabel(host)));
  const locationField = make("div", "settings-field");
  locationField.append(make("span", "field-label", "Location"), location,
    make("span", "field-hint", kind === "local" ? "A folder on this PC." : "Set when the workspace was created."));
  const input = panel._textInput(saved.path || "", kind === "local" ? "Folder for this workspace" : "/home/you/app");
  // The folder browser shows this PC's folders; a WSL or SSH folder is typed.
  const folder = kind === "local" ? folderPickerControl(input, { label: `Choose the folder for ${name}` }) : input;
  const folderNote = saved.path && saved.path_exists === false ? "That folder is missing." : "";
  const folderField = panel._field("Folder", folder,
    folderNote || "Every terminal of this workspace starts here.");

  // Environment and "Start with" (CONTRACTS 4.5 wave 2).
  const envSection = section("Environment", "Every terminal of this workspace gets these variables.");
  const env = envEditor({
    env: saved.env || {},
    note: kind === "ssh"
      ? `Over SSH the values are exported on ${host}, where other users of that machine can see them in its process list.`
      : "",
  });
  envSection.append(env.el);
  const startSection = section("Start with",
    "Started in order, each in its own pane, when the workspace opens with nothing running. The workspace's ⋮ menu starts them again.");
  const start = startupEditor({
    items: startupItems(saved.startup),
    catalog: () => agentCatalog(panel),
    shells: () => (panel.services || api).getTerminalOptions?.(),
    defaultShell: config?.shell || undefined,
    agentSettings: (agent) => config?.agents?.[agent] || null,
    remote: kind !== "local",
  });
  startSection.append(start.el);
  let logo = saved.logo || null;
  const appearance = panel._logoPicker({
    title: "Workspace logo", value: logo, hint: "Overrides the app logo for this workspace.",
    onChange: async (assetId) => { logo = assetId; },
  });
  const panes = countPanes(saved.layout);
  const layout = make("div", "workspace-settings-layout");
  layout.append(
    make("span", "field-label", `Saved layout · ${panes} pane${panes === 1 ? "" : "s"}`),
    layoutPreview(saved.layout),
  );

  const footer = make("footer", "settings-footer");
  const message = make("span", "settings-message", "");
  const cancel = panel._button("Cancel", "secondary-button");
  cancel.addEventListener("click", () => panel.close());
  const runNow = panel._button("Save and start them", "secondary-button");
  runNow.title = "Saves, then starts the Start with list next to what is open";
  const save = panel._button("Save", "primary-button");
  let busy = false;
  // Resolves true once the folder, logo, variables and start list are saved.
  const store = async () => {
    if (busy) return false;
    const envProblems = env.check();
    const startProblems = start.check();
    if (!envProblems.ok || !startProblems.ok) {
      message.textContent = "Fix the marked fields first.";
      if (!envProblems.ok) env.focusProblem();
      else start.focusProblem();
      return false;
    }
    busy = true;
    save.disabled = true;
    runNow.disabled = true;
    message.textContent = "Saving…";
    try {
      const done = await panel.app.setWorkspaceAppearance(name, input.value, logo);
      if (!done) {
        message.textContent = "Workspace settings could not be saved.";
        return false;
      }
      await panel.app.saveWorkspaceSetup(name, {
        env: env.value(),
        startup: start.value().map(cleanStartupItem),
      });
      await panel.app.onWorkspacesChanged?.();
      return true;
    } catch (error) {
      message.textContent = error?.detail || "The environment and start list could not be saved.";
      return false;
    } finally {
      busy = false;
      save.disabled = false;
      runNow.disabled = false;
    }
  };
  const apply = async () => {
    if (await store()) panel.close();
  };
  save.addEventListener("click", apply);
  runNow.addEventListener("click", async () => {
    if (!(await store())) return;
    panel.close();
    await panel.app.runWorkspaceSetup?.(name);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") apply();
  });
  footer.append(message, make("span", "footer-spacer"), runNow, cancel, save);
  root.append(locationField, folderField, envSection, startSection, appearance, layout);
  body.append(root, footer);
  input.focus();
}
