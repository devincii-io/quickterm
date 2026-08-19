// A very small keyed reconciler, and the only thing in QuickTerm that resembles
// a rendering library.
//
// Why it exists: the dashboard reloads itself every 5 s. The first version
// answered that by emptying the panel body and rebuilding every node, which
// threw away whatever the user was in the middle of. The focused input, the
// text they had selected, the in-place folder editor open on a card, the
// "Overwrite?" state armed on the save button: all gone, five seconds after
// they started. Worst of all, the shared folder picker captures its <input>,
// awaits the directory chooser, then writes the chosen path back into that
// captured node. If the refresh replaced the node in the meantime, the user
// picked a folder and nothing happened.
//
// So: build the DOM once, then change only what differs. Reusing the existing
// node for a key that is still present is the whole point. Focus, selection,
// scroll position, an <details> left open and any editor inside a row all
// survive because the node itself survives.
//
// This is deliberately not a framework. No virtual DOM, no templates, no
// scheduling, no reactivity. A caller builds its skeleton, keeps references to
// the parts it will change, and calls patchList/setText/setAttrs on refresh.

// The key a node was created for. Kept in the dataset rather than a WeakMap so
// a list is legible in devtools when something goes wrong.
const KEY = "key";
// A node the user is actively editing. update() must not touch it; see below.
const EDITING = "editing";

// The item a node currently stands for. Event handlers are wired once, at
// create time, so they must not close over the item they were built from: it is
// stale on the very next refresh. They read itemFor(node) instead.
const LATEST = new WeakMap();

export function itemFor(node) {
  return LATEST.get(node);
}

// Mark a row as being edited in place. patchList then leaves its content
// completely alone until the mark comes off, so a folder editor open on one
// workspace card is not rewritten out from under the user when that card's own
// row is refreshed.
//
// The mark suppresses updates, not removal: a row whose item has disappeared
// from the data has nothing left to edit, and keeping it forever would be a
// worse lie than closing it.
export function markEditing(node, editing = true) {
  if (editing) node.dataset[EDITING] = "";
  else delete node.dataset[EDITING];
}

export function isEditing(node) {
  return node.dataset ? node.dataset[EDITING] !== undefined : false;
}

// Write text only when it actually differs. An unconditional assignment to
// textContent replaces the text node even when the string is identical, which
// collapses a selection inside it and can drop an in-flight IME composition.
export function setText(node, value) {
  const text = value == null ? "" : String(value);
  if (node.textContent !== text) node.textContent = text;
}

// Same rule for attributes. `false`, `null` and `undefined` remove the
// attribute, `true` sets it empty, anything else is stringified.
export function setAttrs(node, attrs) {
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value == null) {
      if (node.hasAttribute(name)) node.removeAttribute(name);
      continue;
    }
    const next = value === true ? "" : String(value);
    if (node.getAttribute(name) !== next) node.setAttribute(name, next);
  }
}

export function setClass(node, name, on) {
  const wanted = Boolean(on);
  if (node.classList.contains(name) !== wanted) node.classList.toggle(name, wanted);
}

// Diff `container`'s children against `items`.
//
//   key(item, index)    -> a stable string, unique within the list
//   create(item, index) -> a fresh node: structure and event listeners only
//   update(node, item, index) -> content; runs for new and reused nodes alike,
//                                so there is one code path for what a row says
//
// The container must hold nothing but this list's own nodes. Empty states and
// headings go next to it, not inside it, because ordering is done by position.
//
// Returns the nodes in their final order.
export function patchList(container, items, { key, create, update }) {
  const survivors = new Map();
  for (const node of [...container.children]) {
    const existing = node.dataset ? node.dataset[KEY] : undefined;
    if (existing !== undefined) survivors.set(existing, node);
  }

  const ordered = [];
  for (const [index, item] of [...items].entries()) {
    const id = String(key(item, index));
    let node = survivors.get(id);
    if (node) {
      survivors.delete(id);
      LATEST.set(node, item);
      if (!isEditing(node) && update) update(node, item, index);
    } else {
      node = create(item, index);
      node.dataset[KEY] = id;
      LATEST.set(node, item);
      if (update) update(node, item, index);
    }
    ordered.push(node);
  }

  // Whatever is left in the map is no longer in the data.
  for (const node of survivors.values()) node.remove();

  // Put the survivors in order. `container.children` is live, so once index i
  // matches, children[0..i] is already correct and only genuinely misplaced
  // nodes move. Moving a node detaches it, which blurs it in Chromium, so the
  // "already in the right place" case has to stay a no-op.
  for (const [index, node] of ordered.entries()) {
    const current = container.children[index];
    if (current !== node) container.insertBefore(node, current || null);
  }
  return ordered;
}
