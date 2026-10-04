// Inline SVG icon set (feather-style: 24 viewBox, stroke currentColor).
// icon(name, size) returns a fresh SVG element; safe to append anywhere.

const PATHS = {
  workspaces: '<rect x="2" y="4" width="8" height="16" rx="1.5"/><rect x="14" y="4" width="8" height="16" rx="1.5"/>',
  dashboard:
    '<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/>' +
    '<rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/>',
  settings:
    '<line x1="3" y1="7" x2="21" y2="7"/><circle cx="9.5" cy="7" r="2.6"/>' +
    '<line x1="3" y1="17" x2="21" y2="17"/><circle cx="14.5" cy="17" r="2.6"/>',
  help:
    '<circle cx="12" cy="12" r="9"/><path d="M9.3 9.2a2.8 2.8 0 1 1 3.9 2.9c-.8.35-1.2.9-1.2 1.9"/>' +
    '<line x1="12" y1="17.2" x2="12" y2="17.3"/>',
  "chevron-down": '<polyline points="6 9.5 12 15.5 18 9.5"/>',
  "chevron-right": '<polyline points="9.5 6 15.5 12 9.5 18"/>',
  "arrow-up-right": '<line x1="6.5" y1="17.5" x2="17" y2="7"/><polyline points="8.5 7 17 7 17 15.5"/>',
  check: '<polyline points="4.5 12.5 9.5 17.5 19.5 6.5"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  maximize: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>',
  minimize: '<path d="M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5"/>',
  x: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
  trash:
    '<polyline points="3.5 6.5 20.5 6.5"/><path d="M8.5 6.5v-2a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v2"/>' +
    '<path d="M6 6.5l1 13a1.6 1.6 0 0 0 1.6 1.5h6.8a1.6 1.6 0 0 0 1.6-1.5l1-13"/>',
  folder: '<path d="M3 6.5h6l2 2h10v9.8A1.7 1.7 0 0 1 19.3 20H4.7A1.7 1.7 0 0 1 3 18.3z"/><path d="M3 9V5.7A1.7 1.7 0 0 1 4.7 4h4.1l2 2H19a2 2 0 0 1 2 2v.5"/>',
  power: '<path d="M12 3v8"/><path d="M6.6 6.6a8 8 0 1 0 10.8 0"/>',
  terminal: '<polyline points="4.5 6.5 10.5 12 4.5 17.5"/><line x1="12.5" y1="18" x2="20" y2="18"/>',
  shield: '<path d="M12 3 20 6v5.5c0 4.8-3.2 8-8 9.5-4.8-1.5-8-4.7-8-9.5V6z"/><path d="M12 7v10M7 12h10"/>',
  circle: '<circle cx="12" cy="12" r="7.5"/>',
  "circle-dashed": '<circle cx="12" cy="12" r="7.5" stroke-dasharray="3.4 3.6"/>',
  diamond: '<path d="M12 3.2 20.8 12 12 20.8 3.2 12z"/>',
  link: '<path d="M10 14a5 5 0 0 0 7.1 0l2.4-2.4a5 5 0 0 0-7.1-7.1L11 5.9"/><path d="M14 10a5 5 0 0 0-7.1 0l-2.4 2.4a5 5 0 0 0 7.1 7.1L13 18.1"/>',
  code: '<polyline points="8.5 7 3.5 12 8.5 17"/><polyline points="15.5 7 20.5 12 15.5 17"/><line x1="13.6" y1="5" x2="10.4" y2="19"/>',
  "new-window":
    '<rect x="3" y="4.5" width="13" height="13" rx="1.8"/><path d="M15 3.5h5.5V9"/><line x1="20" y1="4" x2="13.5" y2="10.5"/>',
  more: '<circle cx="12" cy="5.5" r="1.1"/><circle cx="12" cy="12" r="1.1"/><circle cx="12" cy="18.5" r="1.1"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><line x1="15.3" y1="15.3" x2="20.5" y2="20.5"/>',
  filter: '<line x1="4" y1="7" x2="20" y2="7"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="10" y1="17" x2="14" y2="17"/>',
  keyboard:
    '<rect x="2.5" y="6" width="19" height="12" rx="2"/>' +
    '<path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01"/><line x1="8" y1="14" x2="16" y2="14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.5"/>',
  unplug:
    '<path d="M14.5 4.5 19.5 9.5 17.6 11.4a2.8 2.8 0 0 1-4 0l-1-1a2.8 2.8 0 0 1 0-4z"/>' +
    '<path d="M9.5 19.5 4.5 14.5 6.4 12.6a2.8 2.8 0 0 1 4 0l1 1a2.8 2.8 0 0 1 0 4z"/>' +
    '<line x1="19.5" y1="4.5" x2="21" y2="3"/><line x1="3" y1="21" x2="4.5" y2="19.5"/>' +
    '<line x1="8.6" y1="12.1" x2="10.6" y2="10.1"/><line x1="11.9" y1="15.4" x2="13.9" y2="13.4"/>',
  agent:
    '<path d="M11 3.5 12.9 8.6 18 10.5 12.9 12.4 11 17.5 9.1 12.4 4 10.5 9.1 8.6z"/>' +
    '<path d="M18.5 15.5v5M16 18h5"/>',
  window: '<rect x="3" y="4.5" width="18" height="15" rx="1.8"/><line x1="3" y1="9" x2="21" y2="9"/>',
};

const SVG_NS = "http://www.w3.org/2000/svg";

export function icon(name, size = 16) {
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
  svg.classList.add("icon");
  svg.innerHTML = PATHS[name] || PATHS.terminal;
  return svg;
}
