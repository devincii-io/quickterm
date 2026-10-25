// The split tree under the panes: where a new pane goes and what a tree's
// leaves are.
import test from "node:test";
import assert from "node:assert/strict";

import { dwindleDir, findLeaf, leaf, leaves } from "../../quickterm/frontend/js/split_tree.js";

test("dwindle cuts along the longer side, so repeated opens spiral inward", () => {
  assert.equal(dwindleDir({ width: 1600, height: 900 }), "h");
  assert.equal(dwindleDir({ width: 800, height: 900 }), "v");
  assert.equal(dwindleDir({ width: 800, height: 450 }), "h");
  // A square, or no size at all, goes side by side: the common two-pane case.
  assert.equal(dwindleDir({ width: 500, height: 500 }), "h");
  assert.equal(dwindleDir(null), "h");
});

test("leaves lists every payload in order and findLeaf names its parent", () => {
  const root = { type: "split", dir: "h", ratio: 0.5, children: [leaf("a"), { type: "split", dir: "v", ratio: 0.5, children: [leaf("b"), leaf("c")] }] };
  assert.deepEqual(leaves(root), ["a", "b", "c"]);
  assert.equal(findLeaf(root, "c").parent, root.children[1]);
  assert.equal(findLeaf(root, "nope"), null);
});
