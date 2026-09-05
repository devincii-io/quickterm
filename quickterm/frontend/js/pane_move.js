// Rearranging panes by drag. Pure on purpose: which part of a pane the
// pointer is over, and the tree surgery that moves one leaf beside another,
// are the parts worth testing and neither needs a DOM. layout.js owns the
// pointer events and renders the result.

// The outer band of a pane docks the dragged pane on that side; the middle
// swaps the two. `band` is the share of each dimension the edges take, so a
// wide pane has wider side bands than top and bottom ones.
export const EDGE_BAND = 0.3;

export function dropZone(rect, x, y, band = EDGE_BAND) {
  const { width, height } = rect;
  if (!(width > 0) || !(height > 0)) return null;
  const fx = (x - rect.left) / width;
  const fy = (y - rect.top) / height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  let zone = "center";
  let nearest = band;
  for (const [candidate, distance] of [["left", fx], ["right", 1 - fx], ["top", fy], ["bottom", 1 - fy]]) {
    if (distance < nearest) {
      nearest = distance;
      zone = candidate;
    }
  }
  return zone;
}

// The half of the target the dragged pane would take, for the drop preview;
// the whole pane for a swap.
export function zoneRect(rect, zone) {
  const { left, top, width, height } = rect;
  switch (zone) {
    case "left": return { left, top, width: width / 2, height };
    case "right": return { left: left + width / 2, top, width: width / 2, height };
    case "top": return { left, top, width, height: height / 2 };
    case "bottom": return { left, top: top + height / 2, width, height: height / 2 };
    default: return { left, top, width, height };
  }
}

function findLeaf(node, pane, parent = null) {
  if (!node) return null;
  if (node.type === "pane") return node.pane === pane ? { node, parent } : null;
  for (const child of node.children) {
    const hit = findLeaf(child, pane, node);
    if (hit) return hit;
  }
  return null;
}

// null for the root, undefined when the node is not in the tree.
function parentOf(node, target, parent = null) {
  if (node === target) return parent;
  if (!node || node.type !== "split") return undefined;
  for (const child of node.children) {
    const found = parentOf(child, target, node);
    if (found !== undefined) return found;
  }
  return undefined;
}

function replaceChild(parent, oldNode, newNode) {
  parent.children[parent.children.indexOf(oldNode)] = newNode;
}

// Move `source` beside `target` (zone left/right/top/bottom) or swap the two
// (center). Edits the tree in place and returns the root, which changes when
// the split that held `source` collapses into its other child. Returns null
// when nothing would change: same pane, unknown pane, or a drop on the side
// the source already sits on, which keeps the ratio the user set.
export function movePaneNode(root, source, target, zone) {
  if (!root || !source || !target || source === target) return null;
  const from = findLeaf(root, source);
  const to = findLeaf(root, target);
  if (!from || !to || !from.parent) return null;
  if (zone === "center") {
    from.node.pane = target;
    to.node.pane = source;
    return root;
  }
  const dir = zone === "left" || zone === "right" ? "h" : "v";
  const first = zone === "left" || zone === "top";
  if (from.parent === to.parent && from.parent.dir === dir
      && from.parent.children.indexOf(from.node) === (first ? 0 : 1)) {
    return null;
  }
  // Lift the dragged leaf out: its sibling takes the parent's place.
  const sibling = from.parent.children.find((child) => child !== from.node);
  const grand = parentOf(root, from.parent);
  if (grand) replaceChild(grand, from.parent, sibling);
  else root = sibling;
  // The target's parent may have been the split just removed, so look again.
  const dest = findLeaf(root, target);
  const split = {
    type: "split",
    dir,
    ratio: 0.5,
    children: first ? [from.node, dest.node] : [dest.node, from.node],
  };
  if (dest.parent) replaceChild(dest.parent, dest.node, split);
  else root = split;
  return root;
}
