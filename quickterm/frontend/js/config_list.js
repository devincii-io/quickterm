// Master-detail for a list of configured things (terminal configs, snippets):
// compact one-line rows on the left, the editor of the selected one on the
// right.
//
// Rows are patched with render.js, never rebuilt, and the editor is drawn only
// when the selection changes. Typing in the editor calls `updateRow`, which
// rewrites the rows' text in place (an edit can change another row's problem
// marker), so the field under the caret is never replaced. Filtering hides rows but keeps the selection and its editor.
// Below 820 px the detail replaces the list and offers a Back button.

import { icon } from "./icons.js";
import { make } from "./panel_shared.js";
import { itemFor, patchList, setAttrs, setClass, setText } from "./render.js";
import { configFilter, configNoMatch, matchesQuery, panelMenu } from "./panel_settings_kit.js";

export const NARROW_QUERY = "(max-width: 820px)";

// Rows are keyed by object identity: a name is edited while its row stays.
const ids = new WeakMap();
let nextId = 0;
export function identityKey(item) {
  if (!ids.has(item)) ids.set(item, `item-${++nextId}`);
  return ids.get(item);
}

/** Remember how each item looked when it was last saved. */
export function snapshotItems(snapshots, items) {
  for (const item of items || []) snapshots.set(item, JSON.stringify(item));
}

/** True for an item never saved, or changed since it was. */
export function itemDirty(snapshots, item) {
  return !snapshots || snapshots.get(item) !== JSON.stringify(item);
}

const FOCUSABLE = "input:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function renderConfigList({
  host, items, key = identityKey, row, editor, onAdd, addMenu, addLabel = "Add",
  onOpen, onRemove, removeMessage, confirm, selected = null, emptyState, filter = "",
  onFilter, filterPlaceholder = "Filter", matches, onSelect, noun = "items",
  placeholder = "Choose one on the left to edit it.", narrowMedia = globalThis.matchMedia?.(NARROW_QUERY),
}) {
  const list = typeof items === "function" ? items : () => items;
  const match = matches || ((item, query) => {
    const r = row(item);
    return matchesQuery(query, r.name, r.kind, r.summary, r.search);
  });
  let current = selected && list().includes(selected) ? selected : null;
  let query = filter || "";
  let narrow = Boolean(narrowMedia?.matches);
  let detailOpen = Boolean(current);
  const parts = new WeakMap();

  const layout = make("div", "config-layout");
  const master = make("div", "config-master");
  const head = make("div", "config-master-head");
  const rowsEl = make("div", "config-rows");
  // A plain list of focusable rows: a listbox option may not hold the Open
  // and Remove buttons, and screen readers flattened them away.
  rowsEl.setAttribute("role", "list");
  rowsEl.setAttribute("aria-label", noun);
  const emptyEl = make("div", "config-master-empty");
  const detail = make("div", "config-detail");
  const detailHead = make("div", "config-detail-head");
  const pane = make("div", "config-detail-body");

  const filterBox = configFilter({
    value: query,
    placeholder: filterPlaceholder,
    onInput: (value) => {
      query = value;
      onFilter?.(value);
      refresh();
    },
    onKey: (event) => {
      if (event.key !== "ArrowDown") return;
      event.preventDefault();
      rowsEl.children[0]?.focus();
    },
  });
  const add = make("button", "primary-button compact config-add");
  add.type = "button";
  add.append(icon("plus", 13), make("span", "", addLabel));
  add.title = addLabel;
  add.setAttribute("aria-label", addLabel);
  if (addMenu) add.setAttribute("aria-haspopup", "menu");
  const openAdd = () => {
    if (addMenu) panelMenu({ anchor: add, label: addLabel, items: addMenu(), align: "end", width: 260 });
    else onAdd?.();
  };
  add.addEventListener("click", openAdd);
  head.append(filterBox.el, add);
  master.append(head, rowsEl, emptyEl);

  const back = make("button", "text-button compact config-back");
  back.type = "button";
  back.append(icon("chevron-right", 12), make("span", "", "Back"));
  back.title = `Back to all ${noun}`;
  back.setAttribute("aria-label", back.title);
  back.addEventListener("click", () => goBack());
  detailHead.append(back);
  detail.append(detailHead, pane);
  layout.append(master, detail);
  host.append(layout);

  const applyLayout = () => {
    setClass(layout, "narrow", narrow);
    setClass(layout, "detail-open", narrow && detailOpen && Boolean(current));
    back.hidden = !narrow;
  };

  const nodeFor = (item) => [...rowsEl.children].find((node) => itemFor(node) === item) || null;

  const removeItem = (item, button, keyboard = false) => {
    if (!onRemove) return;
    const action = async () => {
      await onRemove(item);
      if (current === item) {
        current = null;
        detailOpen = false;
        drawEditor();
      }
      refresh();
    };
    const message = removeMessage ? removeMessage(item) : `Remove "${row(item).name}"?`;
    if (confirm) confirm(button, message, "Remove", action, { keyboard });
    else action();
  };

  const createRow = () => {
    const node = make("div", "config-row");
    node.tabIndex = 0;
    node.setAttribute("role", "listitem");
    const dot = make("span", "config-row-dot");
    const name = make("span", "config-row-name");
    const summary = make("span", "config-row-summary");
    const problem = make("span", "config-row-problem", "!");
    const dirty = make("span", "config-row-dirty");
    const actions = make("span", "config-row-actions");
    let open = null;
    if (onOpen) {
      open = make("button", "text-button compact config-row-open", "Open");
      open.type = "button";
      open.addEventListener("click", (event) => {
        event.stopPropagation();
        onOpen(itemFor(node));
      });
      actions.append(open);
    }
    let remove = null;
    if (onRemove) {
      remove = make("button", "icon-button danger-text config-row-remove");
      remove.type = "button";
      remove.append(icon("trash", 13));
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        removeItem(itemFor(node), remove);
      });
      actions.append(remove);
    }
    node.append(dot, name, summary, problem, dirty, actions);
    node.addEventListener("click", () => select(itemFor(node), { open: true }));
    node.addEventListener("keydown", (event) => {
      if (event.target !== node) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select(itemFor(node), { open: true, focus: true });
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const sibling = event.key === "ArrowDown" ? node.nextElementSibling : node.previousElementSibling;
        sibling?.focus();
      } else if (event.key === "Delete" && remove) {
        event.preventDefault();
        removeItem(itemFor(node), remove, true);
      }
    });
    parts.set(node, { dot, name, summary, problem, dirty, open, remove });
    return node;
  };

  const updateNode = (node, item) => {
    const r = row(item);
    const p = parts.get(node);
    const title = r.name || "Untitled";
    setText(p.name, title);
    setText(p.summary, r.kind ? `${r.kind} · ${r.summary || ""}` : (r.summary || ""));
    setAttrs(p.summary, { title: p.summary.textContent });
    const problems = r.problems || [];
    p.problem.hidden = !problems.length;
    setAttrs(p.problem, { title: problems.join(" "), "aria-label": problems.length ? `Problem: ${problems.join(" ")}` : false });
    p.dirty.hidden = !r.dirty;
    setAttrs(p.dirty, { title: r.dirty ? "Not saved yet" : false, "aria-label": r.dirty ? "Not saved yet" : false });
    if (r.dot) setAttrs(p.dot, { "data-kind": r.dot });
    if (p.open) {
      p.open.disabled = Boolean(r.openDisabled);
      setText(p.open, r.openLabel || "Open");
      setAttrs(p.open, { title: r.openTitle || `Open ${title}`, "aria-label": r.openTitle || `Open ${title}` });
    }
    if (p.remove) setAttrs(p.remove, { title: `Remove ${title}`, "aria-label": `Remove ${title}` });
    setClass(node, "selected", item === current);
    setClass(node, "has-problem", problems.length > 0);
    setAttrs(node, { "aria-current": item === current ? "true" : false });
  };

  const drawEditor = () => {
    pane.textContent = "";
    if (!current) {
      pane.append(make("p", "config-detail-placeholder", list().length ? placeholder : ""));
      return;
    }
    // An edit can change other rows' problems too (two terminals with one
    // name both carry the marker), so every drawn row is patched.
    editor(current, pane, { updateRow: () => { for (const item of list()) updateRow(item); } });
  };

  function updateRow(item = current) {
    const node = nodeFor(item);
    if (node) updateNode(node, item);
  }

  function refresh() {
    const all = list();
    if (current && !all.includes(current)) {
      current = null;
      detailOpen = false;
      drawEditor();
    }
    const shown = all.filter((item) => !query.trim() || match(item, query));
    patchList(rowsEl, shown, { key, create: createRow, update: updateNode });
    emptyEl.textContent = "";
    if (!all.length) {
      const empty = emptyState?.();
      if (empty) emptyEl.append(empty);
    } else if (!shown.length) {
      emptyEl.append(configNoMatch(query, noun));
    }
    setText(filterBox.count, query.trim() ? `${shown.length} of ${all.length}` : String(all.length));
    applyLayout();
  }

  function select(item, { open = true, focus = false } = {}) {
    if (item !== current) {
      const before = current;
      current = item || null;
      drawEditor();
      if (before) updateRow(before);
      onSelect?.(current);
    }
    detailOpen = Boolean(current) && open;
    if (current) updateRow(current);
    applyLayout();
    if (focus && current) {
      requestAnimationFrame(() => pane.querySelector?.(FOCUSABLE)?.focus());
    }
  }

  function goBack() {
    detailOpen = false;
    applyLayout();
    if (current) nodeFor(current)?.focus();
  }

  const onMedia = (event) => {
    if (!layout.isConnected) {
      narrowMedia?.removeEventListener?.("change", onMedia);
      return;
    }
    narrow = Boolean(event.matches);
    applyLayout();
  };
  narrowMedia?.addEventListener?.("change", onMedia);

  refresh();
  drawEditor();

  return {
    el: layout,
    pane,
    refresh,
    updateRow,
    select,
    selected: () => current,
    openAdd,
    back: goBack,
    // A new item must be visible, so adding clears the filter first.
    add(item, { focus = true } = {}) {
      query = "";
      filterBox.input.value = "";
      onFilter?.("");
      refresh();
      select(item, { open: true, focus });
    },
    setFilter(text) {
      query = text || "";
      filterBox.input.value = query;
      refresh();
    },
    setNarrow(on) {
      narrow = Boolean(on);
      applyLayout();
    },
    isNarrow: () => narrow,
    isDetailOpen: () => narrow && detailOpen && Boolean(current),
  };
}
