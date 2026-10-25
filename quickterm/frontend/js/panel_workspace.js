// "Workspace settings" from a sidebar workspace's menu: its folder, its logo
// and a miniature of its saved layout. This was the dashboard card's editor;
// the board that replaced the dashboard shows status, not settings.

import * as api from "./api.js";
import { countPanes, folderPickerControl, make } from "./panel_shared.js";

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

export async function renderWorkspaceSettings(name) {
  const panel = this;
  const body = panel.bodyEl;
  body.textContent = "";
  body.append(make("div", "panel-loading", "Reading the workspace…"));
  const saved = await api.getWorkspace(name).catch(() => null);
  if (panel.open !== "workspace" || panel._workspaceName !== name) return;
  body.textContent = "";
  if (!saved) {
    body.append(make("div", "settings-error", `Workspace "${name}" could not be read.`));
    return;
  }

  const root = make("div", "workspace-settings");
  const input = panel._textInput(saved.path || "", "Folder for this workspace");
  const folder = folderPickerControl(input, { label: `Choose the folder for ${name}` });
  const folderNote = saved.path && saved.path_exists === false ? "That folder is missing." : "";
  const folderField = panel._field("Folder", folder,
    folderNote || "Every terminal of this workspace starts here.");
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
  const save = panel._button("Save", "primary-button");
  const apply = async () => {
    save.disabled = true;
    message.textContent = "Saving…";
    const done = await panel.app.setWorkspaceAppearance(name, input.value, logo);
    save.disabled = false;
    if (!done) {
      message.textContent = "Workspace settings could not be saved.";
      return;
    }
    await panel.app.onWorkspacesChanged?.();
    panel.close();
  };
  save.addEventListener("click", apply);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") apply();
  });
  footer.append(message, make("span", "footer-spacer"), cancel, save);
  root.append(folderField, appearance, layout);
  body.append(root, footer);
  input.focus();
}
