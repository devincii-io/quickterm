// Inline SVG icon set (feather-style: 24 viewBox, stroke currentColor).
// icon(name, size) returns a fresh SVG element; safe to append anywhere.

const PATHS = {
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
  x: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
  trash:
    '<polyline points="3.5 6.5 20.5 6.5"/><path d="M8.5 6.5v-2a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v2"/>' +
    '<path d="M6 6.5l1 13a1.6 1.6 0 0 0 1.6 1.5h6.8a1.6 1.6 0 0 0 1.6-1.5l1-13"/>',
  power: '<path d="M12 3v8"/><path d="M6.6 6.6a8 8 0 1 0 10.8 0"/>',
  terminal: '<polyline points="4.5 6.5 10.5 12 4.5 17.5"/><line x1="12.5" y1="18" x2="20" y2="18"/>',
  shield: '<path d="M12 3 20 6v5.5c0 4.8-3.2 8-8 9.5-4.8-1.5-8-4.7-8-9.5V6z"/><path d="M12 7v10M7 12h10"/>',
  circle: '<circle cx="12" cy="12" r="7.5"/>',
  "circle-dashed": '<circle cx="12" cy="12" r="7.5" stroke-dasharray="3.4 3.6"/>',
  diamond: '<path d="M12 3.2 20.8 12 12 20.8 3.2 12z"/>',
  link: '<path d="M10 14a5 5 0 0 0 7.1 0l2.4-2.4a5 5 0 0 0-7.1-7.1L11 5.9"/><path d="M14 10a5 5 0 0 0-7.1 0l-2.4 2.4a5 5 0 0 0 7.1 7.1L13 18.1"/>',
  "new-window":
    '<rect x="3" y="4.5" width="13" height="13" rx="1.8"/><path d="M15 3.5h5.5V9"/><line x1="20" y1="4" x2="13.5" y2="10.5"/>',
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
