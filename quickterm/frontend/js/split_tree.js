// The binary split tree behind the terminal panes. Pure on purpose: no DOM,
// so the shape a split or a close leaves behind can be tested without a
// browser.
//
//   {"type":"split","dir":"h"|"v","ratio":r,"children":[node,node]}
//   {"type":"pane","pane":<payload>}

export function leaf(payload) {
  return { type: "pane", pane: payload };
}

export function leaves(node, out = []) {
  if (!node) return out;
  if (node.type === "pane") out.push(node.pane);
  else for (const child of node.children) leaves(child, out);
  return out;
}

export function findLeaf(node, payload, parent = null) {
  if (!node) return null;
  if (node.type === "pane") return node.pane === payload ? { node, parent } : null;
  for (const child of node.children) {
    const hit = findLeaf(child, payload, node);
    if (hit) return hit;
  }
  return null;
}

// null for the root, undefined when the node is not in the tree.
export function parentOf(node, target, parent = null) {
  if (node === target) return parent;
  if (!node || node.type !== "split") return undefined;
  for (const child of node.children) {
    const found = parentOf(child, target, node);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function replaceChild(parent, oldNode, newNode) {
  parent.children[parent.children.indexOf(oldNode)] = newNode;
}

// Dwindle, the way a tiling window manager places a new window: it takes
// half of the focused one, cut along its longer side. A wide pane gets a
// neighbour to its right, a tall one gets a neighbour below, and repeating
// the gesture spirals inward instead of stacking slivers.
export function dwindleDir(rect) {
  const width = Number(rect?.width) || 0;
  const height = Number(rect?.height) || 0;
  return width >= height ? "h" : "v";
}
