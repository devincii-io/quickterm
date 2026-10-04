// The saved layout JSON (the split tree layout.js serializes) read and edited
// without a LayoutManager: which sessions it references, dropping one, and
// docking a leaf beside it. Pure, so it is tested in node.

export function sessionIdsInLayout(node, out = new Set()) {
  if (!node) return out;
  if (node.type === "split") {
    for (const child of node.children || []) sessionIdsInLayout(child, out);
  } else if (node.session_id) {
    out.add(node.session_id);
  }
  return out;
}

export function removeSessionFromLayout(node, sessionId) {
  if (!node) return false;
  if (node.type === "split") {
    return (node.children || []).reduce((changed, child) =>
      removeSessionFromLayout(child, sessionId) || changed, false);
  }
  if (node.session_id !== sessionId) return false;
  delete node.session_id;
  return true;
}

// The tree without the leaf that shows `sessionId`, with a split left holding
// one child collapsed into that child: the tree LayoutManager.closePane
// leaves behind when a view kills a terminal. Stripping only the session id
// (removeSessionFromLayout) turns the leaf into a template, and the next
// restore spawns a fresh process there, so a killed agent came back as a new
// conversation. Returns {layout, changed}; the input is not modified, and a
// tree with no leaf left is null.
export function withoutSessionLeaf(node, sessionId) {
  if (!node) return { layout: node ?? null, changed: false };
  if (node.type !== "split") {
    return node.session_id === sessionId
      ? { layout: null, changed: true }
      : { layout: node, changed: false };
  }
  let changed = false;
  const children = [];
  for (const child of node.children || []) {
    const result = withoutSessionLeaf(child, sessionId);
    changed = changed || result.changed;
    if (result.layout) children.push(result.layout);
  }
  if (!changed) return { layout: node, changed: false };
  if (!children.length) return { layout: null, changed: true };
  if (children.length === 1) return { layout: children[0], changed: true };
  return { layout: { ...node, children }, changed: true };
}

// The layout JSON is the same split tree layout.js serializes, so a leaf
// can be docked beside a saved layout without loading it into a manager.
export function layoutWith(saved, extra) {
  if (!extra) return saved || { type: "pane" };
  if (!saved || !saved.type) return extra;
  return { type: "split", dir: "h", ratio: 0.5, children: [saved, extra] };
}
