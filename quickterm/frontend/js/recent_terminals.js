// The terminals focused last, across the window's workspaces, for Ctrl+Tab.
// Pure: the shell notes every focus change, the switcher (switcher.js) asks
// for a frozen list when it opens and says which entry was chosen.
//
// While the list is open its order does not move: the view behind it keeps
// reporting focus, and a list that reorders under the Tab key would make the
// second Tab land somewhere else than the first one pointed. The current
// terminal is first, the selection starts on the second entry, so one tap of
// Ctrl+Tab goes back to the terminal before, and the next tap returns.

export const RECENT_LIMIT = 8;

export class RecentTerminals {
  constructor(limit = RECENT_LIMIT) {
    this.limit = limit;
    this.ids = [];
    this.list = null; // the frozen order while open
    this.index = 0;
  }

  get isOpen() {
    return this.list !== null;
  }

  // A terminal took focus. Ignored while the list is open.
  note(id) {
    if (!id || this.isOpen) return;
    this.ids = [id, ...this.ids.filter((each) => each !== id)].slice(0, this.limit);
  }

  // A terminal that is gone (killed, exited, closed) leaves the list.
  drop(id) {
    this.ids = this.ids.filter((each) => each !== id);
  }

  // Freeze the order and return it. `current` is the focused terminal, first
  // whatever was noted; `alive(id)` says whether a terminal still runs, and
  // the ones that do not are dropped for good.
  open({ current = null, alive = () => true } = {}) {
    if (this.isOpen) return this.list;
    this.ids = this.ids.filter((id) => id === current || alive(id));
    this.note(current);
    this.list = [...this.ids];
    this.index = this.list.length > 1 ? 1 : 0;
    return this.list;
  }

  // Tab (1) or Shift+Tab (-1), wrapping.
  move(delta) {
    if (!this.isOpen || !this.list.length) return null;
    const size = this.list.length;
    this.index = (((this.index + (delta < 0 ? -1 : 1)) % size) + size) % size;
    return this.selected();
  }

  select(index) {
    if (!this.isOpen || index < 0 || index >= this.list.length) return null;
    this.index = index;
    return this.selected();
  }

  selected() {
    return this.isOpen ? this.list[this.index] ?? null : null;
  }

  // Close the list. With `choose`, the selected terminal becomes the most
  // recent and is returned; without, the order stays as it was.
  close({ choose = false } = {}) {
    if (!this.isOpen) return null;
    const chosen = choose ? this.selected() : null;
    this.list = null;
    this.index = 0;
    if (chosen) this.note(chosen);
    return chosen;
  }
}
