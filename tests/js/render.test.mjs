import test from "node:test";
import assert from "node:assert/strict";

import {
  isEditing, itemFor, markEditing, patchList, setText,
} from "../../quickterm/frontend/js/render.js";

// Node has no DOM. patchList only ever touches an ordered child list,
// insertBefore, remove, dataset and textContent, so the fake below provides
// exactly that much and counts the mutations the reconciler is judged on.
function element(tag = "div") {
  const kids = [];
  let text = "";
  const node = {
    tag,
    dataset: {},
    parent: null,
    moves: 0,   // insertBefore calls landing on this container
    writes: 0,  // textContent assignments landing on this node
    get children() { return kids; },
    get textContent() { return text; },
    set textContent(value) { text = value; node.writes += 1; },
    insertBefore(child, ref) {
      node.moves += 1;
      if (child.parent) child.parent.removeChild(child);
      const at = ref ? kids.indexOf(ref) : -1;
      if (at < 0) kids.push(child);
      else kids.splice(at, 0, child);
      child.parent = node;
      return child;
    },
    append(child) { return node.insertBefore(child, null); },
    removeChild(child) {
      const at = kids.indexOf(child);
      if (at >= 0) kids.splice(at, 1);
      child.parent = null;
      return child;
    },
    remove() { if (node.parent) node.parent.removeChild(node); },
  };
  return node;
}

const spec = {
  key: (item) => item.id,
  create: () => element("span"),
  update: (node, item) => setText(node, item.label),
};

const patch = (container, items) => patchList(container, items, spec);
const labels = (container) => container.children.map((child) => child.textContent);
const keys = (container) => container.children.map((child) => child.dataset.key);

test("a key that is still present keeps its identical DOM node", () => {
  const list = element();
  patch(list, [{ id: "a", label: "one" }, { id: "b", label: "two" }]);
  const [first, second] = list.children;

  patch(list, [{ id: "a", label: "ONE" }, { id: "b", label: "two" }]);
  // Same node objects: focus, selection and anything open inside them survive.
  assert.equal(list.children[0], first);
  assert.equal(list.children[1], second);
  assert.deepEqual(labels(list), ["ONE", "two"]);
  // Unchanged text is not rewritten, so a selection inside it is not collapsed.
  assert.equal(second.writes, 1);
});

test("items that disappear from the data are removed", () => {
  const list = element();
  patch(list, [{ id: "a" }, { id: "b" }, { id: "c" }]);
  const gone = list.children[1];

  patch(list, [{ id: "a" }, { id: "c" }]);
  assert.deepEqual(keys(list), ["a", "c"]);
  assert.equal(gone.parent, null);

  patch(list, []);
  assert.deepEqual(list.children, []);
});

test("reordering moves only the nodes that are out of place", () => {
  const list = element();
  patch(list, [{ id: "a" }, { id: "b" }, { id: "c" }]);
  const [a, b, c] = list.children;
  list.moves = 0;

  patch(list, [{ id: "c" }, { id: "a" }, { id: "b" }]);
  assert.deepEqual(list.children, [c, a, b]);
  // One insertBefore: c ahead of a. Nodes already in position stay attached,
  // which is what keeps a focused control inside them focused.
  assert.equal(list.moves, 1);
});

test("a node marked as being edited is left alone by update", () => {
  const list = element();
  patch(list, [{ id: "a", label: "folder" }, { id: "b", label: "other" }]);
  const [edited] = list.children;
  markEditing(edited);
  assert.equal(isEditing(edited), true);

  patch(list, [{ id: "a", label: "rewritten" }, { id: "b", label: "changed" }]);
  assert.equal(edited.textContent, "folder");
  assert.equal(list.children[1].textContent, "changed");

  // The mark suppresses updates, not the item's identity: the row still tracks
  // the current data so its listeners act on it, and unmarking resumes writes.
  assert.equal(itemFor(edited).label, "rewritten");
  markEditing(edited, false);
  patch(list, [{ id: "a", label: "resumed" }, { id: "b", label: "changed" }]);
  assert.equal(edited.textContent, "resumed");
});

test("new keys are created, and every node carries the item it stands for", () => {
  const list = element();
  patch(list, [{ id: "a", label: "one" }]);
  const first = list.children[0];

  patch(list, [{ id: "z", label: "zero" }, { id: "a", label: "one" }]);
  assert.deepEqual(keys(list), ["z", "a"]);
  assert.equal(list.children[1], first);
  assert.equal(itemFor(list.children[0]).label, "zero");
});
