// The split tree under panes and workspace views: where a new leaf lands,
// what a removal collapses into, and the pixel boxes a tree maps to.
import test from "node:test";
import assert from "node:assert/strict";

import {
  dwindleDir, insertBeside, layoutRects, leaf, leaves, removeLeaf,
} from "../../quickterm/frontend/js/split_tree.js";

function split(dir, a, b, ratio = 0.5) { return { type: "split", dir, ratio, children: [a, b] }; }
function shape(node) {
  if (!node) return "-";
  if (node.type === "pane") return node.pane;
  return `${node.dir}(${shape(node.children[0])},${shape(node.children[1])})`;
}

test("dwindle cuts along the longer side, so repeated opens spiral inward", () => {
  assert.equal(dwindleDir({ width: 1600, height: 900 }), "h");
  assert.equal(dwindleDir({ width: 800, height: 900 }), "v");
  assert.equal(dwindleDir({ width: 800, height: 450 }), "h");
  // A square, or no size at all, goes side by side: the common two-pane case.
  assert.equal(dwindleDir({ width: 500, height: 500 }), "h");
  assert.equal(dwindleDir(null), "h");
});

test("a new leaf takes half of its anchor and nothing else moves", () => {
  let root = insertBeside(null, null, "a");
  assert.equal(shape(root), "a");
  root = insertBeside(root, "a", "b", "h");
  assert.equal(shape(root), "h(a,b)");
  root = insertBeside(root, "b", "c", "v");
  assert.equal(shape(root), "h(a,v(b,c))");
  root = insertBeside(root, "a", "d", "v", { first: true });
  assert.equal(shape(root), "h(v(d,a),v(b,c))");
  assert.deepEqual(leaves(root), ["d", "a", "b", "c"]);
});

test("an anchor that is not in the tree docks the newcomer beside everything", () => {
  const root = insertBeside(split("h", leaf("a"), leaf("b")), "zzz", "c", "v");
  assert.equal(shape(root), "v(h(a,b),c)");
});

test("removing a leaf collapses its split into the sibling, even at the root", () => {
  let root = split("h", leaf("a"), split("v", leaf("b"), leaf("c"), 0.3), 0.6);
  root = removeLeaf(root, "b");
  assert.equal(shape(root), "h(a,c)");
  assert.equal(root.ratio, 0.6, "the surviving split keeps the ratio the user set");
  root = removeLeaf(root, "a");
  assert.equal(shape(root), "c");
  assert.equal(removeLeaf(root, "c"), null, "the last leaf leaves an empty tree");
  const untouched = split("h", leaf("x"), leaf("y"));
  assert.equal(removeLeaf(untouched, "nope"), untouched);
});

test("layout boxes tile the rect exactly, dividers included", () => {
  const root = split("h", leaf("a"), split("v", leaf("b"), leaf("c"), 0.25), 0.5);
  const { leaves: boxes, dividers } = layoutRects(root, { left: 0, top: 0, width: 1010, height: 610 }, 10);
  assert.deepEqual(boxes.get("a"), { left: 0, top: 0, width: 500, height: 610 });
  assert.deepEqual(boxes.get("b"), { left: 510, top: 0, width: 500, height: 150 });
  assert.deepEqual(boxes.get("c"), { left: 510, top: 160, width: 500, height: 450 });
  assert.equal(dividers.length, 2);
  assert.equal(dividers[0].node, root);
  assert.deepEqual([dividers[0].left, dividers[0].top, dividers[0].width, dividers[0].height], [500, 0, 10, 610]);
  assert.deepEqual(dividers[0].box, { left: 0, top: 0, width: 1010, height: 610 }, "a divider knows the split it resizes");
  assert.equal(dividers[1].node, root.children[1]);
  assert.deepEqual(dividers[1].box, { left: 510, top: 0, width: 500, height: 610 });
  assert.deepEqual([dividers[1].left, dividers[1].top, dividers[1].width, dividers[1].height], [510, 150, 500, 10]);
});

test("a stored ratio outside the clamp cannot squeeze a leaf away", () => {
  const root = split("h", leaf("a"), leaf("b"), 0.001);
  const { leaves: boxes } = layoutRects(root, { left: 0, top: 0, width: 1000, height: 100 }, 0, { min: 0.15, max: 0.85 });
  assert.equal(boxes.get("a").width, 150);
  assert.equal(boxes.get("b").width, 850);
});
