// The small DOM helpers the sidebar modules share (launcher.js and
// sidebar_view_menu.js).

import { icon } from "./icons.js";
import { patchList, setAttrs, setText } from "./render.js";
import { runningSubagents, subagentLabel } from "./sidebar_model.js";

export function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function iconButton(className, iconName, title, onClick) {
  const button = make("button", className);
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.append(icon(iconName, 14));
  if (onClick) button.addEventListener("click", onClick);
  return button;
}

export function setLabel(button, title) {
  setAttrs(button, { title, "aria-label": title });
}

// A footer icon that switches something on and off (the right panel): it
// shows as on while that thing shows. `root` is the sidebar element.
export function markNavToggle(root, label, on) {
  const button = root?.querySelector?.(`.sidebar-nav-button[data-nav="${label}"]`);
  if (!button) return false;
  button.setAttribute("aria-pressed", String(Boolean(on)));
  return true;
}

// A click synthesised by Enter or Space has no pointer behind it.
export function fromKeyboard(event) {
  return event?.detail === 0;
}

// The floating "+" that stands in for the sidebar while it is hidden. It is
// static in index.html and pinned by CSS at the top left; it does not move.
export function wireFloat(actions, signal, showSidebar) {
  const float = document.getElementById("float-launch");
  if (!float) return { show() {}, hide() {} };
  const open = float.querySelector(".float-new");
  const reveal = float.querySelector(".float-show");
  open?.addEventListener("click", () => actions.newTerminal?.(), { signal });
  open?.addEventListener("contextmenu", (event) => { event.preventDefault(); showSidebar(); }, { signal });
  reveal?.addEventListener("click", showSidebar, { signal });
  return {
    show() { float.hidden = false; },
    hide() { float.hidden = true; },
  };
}

// An agent's running subagents, one muted line each under its terminal row,
// only while they run. They are text, not terminals: nothing to focus or
// click. Returns whether any is shown.
export function patchSubagents(container, agent) {
  const subs = runningSubagents(agent);
  container.hidden = !subs.length;
  patchList(container, subs, {
    key: (sub) => `sub:${sub.id}`,
    create: () => make("div", "session-subagent"),
    update: (node, sub) => {
      setText(node, subagentLabel(sub));
      setAttrs(node, { title: [sub.type, sub.description].filter(Boolean).join(": ") || "subagent" });
    },
  });
  return subs.length > 0;
}
