// The small DOM helpers the sidebar modules share (launcher.js and
// sidebar_view_menu.js).

import { icon } from "./icons.js";
import { setAttrs } from "./render.js";

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
