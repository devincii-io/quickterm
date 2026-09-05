// Drag a pane header onto another pane: the outer band docks the dragged
// pane on that side, the middle swaps the two. These pin the zone geometry
// and the tree surgery; layout.js only renders what movePaneNode returns.
import test from "node:test";
import assert from "node:assert/strict";

import { dropZone, movePaneNode, zoneRect } from "../../quickterm/frontend/js/pane_move.js";

const rect = { left: 100, top: 50, width: 400, height: 200 };

function leaf(name) { return { type: "pane", pane: { name } }; }
function split(dir, a, b, ratio = 0.5) { return { type: "split", dir, ratio, children: [a, b] }; }
function shape(node) {
  if (node.type === "pane") return node.pane.name;
  return `${node.dir}(${shape(node.children[0])},${shape(node.children[1])})`;
}

test("the outer band picks the nearest edge, the middle swaps, outside is nothing", () => {
  assert.equal(dropZone(rect, 110, 150), "left");
  assert.equal(dropZone(rect, 490, 150), "right");
  assert.equal(dropZone(rect, 300, 60), "top");
  assert.equal(dropZone(rect, 300, 240), "bottom");
  assert.equal(dropZone(rect, 300, 150), "center");
  // A corner goes to whichever edge is nearer in the pane's own proportions.
  assert.equal(dropZone(rect, 130, 60), "top");
  assert.equal(dropZone(rect, 99, 150), null);
  assert.equal(dropZone({ left: 0, top: 0, width: 0, height: 0 }, 0, 0), null);
});

test("the preview covers the half the pane would take, or all of it for a swap", () => {
  assert.deepEqual(zoneRect(rect, "left"), { left: 100, top: 50, width: 200, height: 200 });
  assert.deepEqual(zoneRect(rect, "bottom"), { left: 100, top: 150, width: 400, height: 100 });
  assert.deepEqual(zoneRect(rect, "center"), rect);
});

test("docking on an edge lifts the pane out and splits the target", () => {
  const a = leaf("a");
  const b = leaf("b");
  const c = leaf("c");
  const root = split("h", a, split("v", b, c));
  const next = movePaneNode(root, a.pane, c.pane, "bottom");
  assert.equal(shape(next), "v(b,v(c,a))");
});

test("the split that held the dragged pane collapses into its sibling, even at the root", () => {
  const a = leaf("a");
  const b = leaf("b");
  const root = split("h", a, b, 0.7);
  const next = movePaneNode(root, a.pane, b.pane, "right");
  assert.equal(shape(next), "h(b,a)");
  const again = movePaneNode(next, b.pane, a.pane, "top");
  assert.equal(shape(again), "v(b,a)");
});

test("the middle swaps two panes and keeps every ratio", () => {
  const a = leaf("a");
  const b = leaf("b");
  const c = leaf("c");
  const inner = split("v", b, c, 0.3);
  const root = split("h", a, inner, 0.6);
  const next = movePaneNode(root, a.pane, c.pane, "center");
  assert.equal(next, root);
  assert.equal(shape(next), "h(c,v(b,a))");
  assert.equal(root.ratio, 0.6);
  assert.equal(inner.ratio, 0.3);
});

test("dropping a pane where it already is changes nothing", () => {
  const a = leaf("a");
  const b = leaf("b");
  const root = split("h", a, b, 0.7);
  assert.equal(movePaneNode(root, a.pane, b.pane, "left"), null);
  assert.equal(movePaneNode(root, a.pane, a.pane, "right"), null);
  assert.equal(movePaneNode(root, leaf("x").pane, b.pane, "right"), null);
  assert.equal(shape(root), "h(a,b)");
  assert.equal(root.ratio, 0.7);
});
