// Small DOM helpers and the right panel's own icons (same 24-unit, stroked
// style as icons.js, which holds the chrome's shared set).

import { icon as sharedIcon } from "./icons.js";

const PATHS = {
  files: '<path d="M4 4.5h6l2 2h8v12.8a1.7 1.7 0 0 1-1.7 1.7H5.7A1.7 1.7 0 0 1 4 19.3z"/>',
  branch:
    '<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="7.5" r="2"/>' +
    '<path d="M6.5 7.5v9M17.5 9.5c0 4-5 4-9.6 7.2"/>',
  pr:
    '<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="18.5" r="2"/>' +
    '<path d="M6.5 7.5v9M17.5 16.5V9a2.5 2.5 0 0 0-2.5-2.5h-4"/><polyline points="12.5 4 10 6.5 12.5 9"/>',
  file: '<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><polyline points="14 3 14 7 18 7"/>',
  minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
  undo: '<polyline points="8.5 5 4 9.5 8.5 14"/><path d="M4 9.5h10.5a5 5 0 0 1 0 10H9"/>',
  "arrow-up": '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/>',
  "arrow-down": '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="6 13 12 19 18 13"/>',
  columns: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.6"/><line x1="12" y1="4.5" x2="12" y2="19.5"/>',
  rows: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.6"/><line x1="3.5" y1="12" x2="20.5" y2="12"/>',
  spinner: '<path d="M12 3.5a8.5 8.5 0 1 1-8.5 8.5"/>',
  "x-circle": '<circle cx="12" cy="12" r="8.5"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/>',
  "check-circle": '<circle cx="12" cy="12" r="8.5"/><polyline points="8 12.5 11 15.5 16.5 9.5"/>',
  skip: '<circle cx="12" cy="12" r="8.5"/><line x1="8" y1="12" x2="16" y2="12"/>',
};

const SVG_NS = "http://www.w3.org/2000/svg";

export function icon(name, size = 14) {
  if (!PATHS[name]) return sharedIcon(name, size);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon", `icon-${name}`);
  svg.innerHTML = PATHS[name];
  return svg;
}

export function make(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

// An icon-only button with its name as tooltip and accessible label.
export function iconButton(name, title, className = "rp-icon-button") {
  const button = make("button", className);
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.append(icon(name));
  return button;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const area = make("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    let done = false;
    try { done = document.execCommand("copy"); } catch (_) { done = false; }
    area.remove();
    return done;
  }
}

// What a person reads for a git status letter, and the class that tints it.
export function gitMark(letter) {
  if (letter === "?") return { text: "U", tint: "git-new", title: "Untracked" };
  if (letter === "A") return { text: "A", tint: "git-new", title: "Added" };
  if (letter === "D") return { text: "D", tint: "git-del", title: "Deleted" };
  if (letter === "R") return { text: "R", tint: "git-mod", title: "Renamed" };
  if (letter === "U") return { text: "!", tint: "git-del", title: "Conflict" };
  if (letter) return { text: letter, tint: "git-mod", title: "Modified" };
  return { text: "", tint: "", title: "" };
}
