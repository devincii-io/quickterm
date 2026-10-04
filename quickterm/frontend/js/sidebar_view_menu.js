// The Workspaces header's search and view buttons. launcher.js places them;
// the view options and what they do to the list are pure, in sidebar_model.js.

import { toggleMenu } from "./menu.js";
import { setClass } from "./render.js";
import { iconButton, setLabel } from "./sidebar_dom.js";
import { SIDEBAR_VIEW_DEFAULTS, isDefaultView, loadView, normalizeView, saveView } from "./sidebar_model.js";

export function createViewControls({ anchor, onSearch, onChange, handBack, signal }) {
  let view = loadView();
  // Search hands over to the palette, already narrowed to workspaces and
  // terminals: one finder, not a second one squeezed into the sidebar.
  const search = iconButton("sidebar-section-add sidebar-section-search", "search",
    "Find a workspace or terminal (Alt+K, then @)", () => onSearch?.());
  // The view menu: what the list shows and how. Per window, like the mode.
  const button = iconButton("sidebar-section-add sidebar-section-view", "filter", "View options");
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  const paint = () => {
    const custom = !isDefaultView(view);
    setClass(button, "custom", custom);
    setLabel(button, custom ? "View options (changed)" : "View options");
  };
  const set = (patch) => {
    view = normalizeView({ ...view, ...patch });
    saveView(view);
    paint();
    onChange?.(view);
  };
  button.addEventListener("click", () => {
    const choose = (label, detail, selected, patch) => ({ label, detail, selected, run: () => set(patch) });
    toggleMenu({
      anchor,
      trigger: button,
      label: "View options",
      align: "end",
      items: [
        { heading: "Show" },
        choose("Empty workspaces", "no terminals, not open", view.empty, { empty: !view.empty }),
        choose("Finished terminals", "kept for their last output", view.finished, { finished: !view.finished }),
        { heading: "Group by" },
        choose("Workspace", "", view.group === "workspace", { group: "workspace" }),
        choose("Nothing", "one list of terminals", view.group === "none", { group: "none" }),
        { heading: "Sort by" },
        choose("Name", "rows stay where they are", view.sort === "name", { sort: "name" }),
        choose("Recent activity", "busy and new output first", view.sort === "activity", { sort: "activity" }),
        { separator: true },
        { label: "Reset view", icon: "x", disabled: isDefaultView(view), run: () => set({ ...SIDEBAR_VIEW_DEFAULTS }) },
      ],
      onClose: (reason) => { if (reason !== "run") handBack?.(); },
    });
  }, { signal });
  paint();
  return { search, button, view: () => view, set };
}
