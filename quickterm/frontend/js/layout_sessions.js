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

// The layout JSON is the same split tree layout.js serializes, so a leaf
// can be docked beside a saved layout without loading it into a manager.
export function layoutWith(saved, extra) {
  if (!extra) return saved || { type: "pane" };
  if (!saved || !saved.type) return extra;
  return { type: "split", dir: "h", ratio: 0.5, children: [saved, extra] };
}
