import re
from pathlib import Path

FRONTEND = Path(__file__).parents[1] / "quickterm" / "frontend"
FRONTEND_JS = FRONTEND / "js"
LAUNCHER_JS = FRONTEND_JS / "launcher.js"
CONFIRM_JS = FRONTEND_JS / "confirm_popover.js"
KEYS_JS = FRONTEND_JS / "keys.js"
SIDEBAR_CSS = FRONTEND / "css" / "sidebar.css"
APP_CSS = FRONTEND / "css" / "app.css"
INDEX_HTML = FRONTEND / "index.html"


SIDEBAR_MODEL_JS = FRONTEND_JS / "sidebar_model.js"


def _launcher() -> str:
    """launcher.js and the pure model it re-exports, read as one module."""
    return LAUNCHER_JS.read_text(encoding="utf-8") + "\n" + SIDEBAR_MODEL_JS.read_text(encoding="utf-8")


def test_the_sidebar_model_stays_split_from_its_dom():
    launcher = LAUNCHER_JS.read_text(encoding="utf-8")
    model = SIDEBAR_MODEL_JS.read_text(encoding="utf-8")
    assert len(launcher.splitlines()) < 900
    assert "document." not in model
    assert 'from "./sidebar_model.js";' in launcher


def _block(source: str, start: str, end: str) -> str:
    begin = source.index(start)
    return source[begin : source.index(end, begin)]


def test_sidebar_collapse_returns_input_focus_to_the_terminal():
    source = _launcher()
    assert "const handBack = () => requestAnimationFrame(() => actions.handBack?.());" in source
    # Menus and confirmations hand the keyboard back when they close.
    assert "onClose: handBack" in source


def test_sidebar_lists_every_live_terminal_grouped_by_workspace():
    """One flat list, every saved workspace once, in an order state never changes.

    The groups come from the pure `sidebarGroups`: saved workspaces by name,
    scratch views next, Unassigned last, rows by name then id. A terminal that
    needs you is a chip and a class, never a reason to move a row: a list that
    reorders under the pointer turns one click into a click on another row.
    A row click activates the terminal wherever it lives; there is no foreign
    row and no armed choice strip any more.
    """
    launcher = _launcher()
    groups = _block(launcher, "export function sidebarGroups(", "\nexport function groupSummary")

    assert "groupSessionsByWorkspace" not in launcher
    assert "const owner = attachedIn || lookup(owned, session.id) || session.workspace || null;" in groups
    assert "for (const name of saved.keys()) if (!isScratchWorkspace(name)) ensure(name);" in groups
    # No rank table and no current-first sort.
    assert "rank" not in groups and '"current"' not in launcher
    assert "const KIND_ORDER = { flat: 0, workspace: 0, scratch: 1, unassigned: 2 };" in launcher
    assert 'localeCompare(rowName(b), undefined, { numeric: true })' in groups
    # Claude and Codex need no profile: the CLI found by the inventory is offered as is.
    assert 'key: prefix === "claude" ? `claude:${mode}` : `${prefix}:${mode}`' in launcher

    rows = _block(launcher, "  const createRow = () => {", "\n  const updateRow =")
    assert 'row.addEventListener("click", () => {' in rows
    assert "actions.activateTerminal?.(session)" in rows
    for gone in ("foreign", "setArmed", "session-choices", "onMoveSession", "onWorkspace"):
        assert gone not in launcher, gone
    update = _block(launcher, "  const updateRow = (entry, item, group) => {", "\n  const toggleFold =")
    assert 'setClass(entry, "needs-you", state.key === "attention");' in update
    assert 'setClass(node, "has-attention", group.counts.attention > 0);' in launcher


def test_sidebar_list_patches_and_never_clears_itself_on_update():
    """The 10 s poll must not close an open confirmation, menu or rename.

    The group list and each group's rows go through render.js patchList, keyed
    `group:<key>` and `session:<id>`. A rename marks its row as being edited so
    patchList leaves it alone, and a confirmation whose row has gone closes.
    """
    launcher = _launcher()
    assert 'import { itemFor, markEditing, patchList, setAttrs, setClass, setText } from "./render.js";' in launcher
    assert "key: (group) => `group:${group.key}`," in launcher
    assert "key: (entry) => `session:${entry.session.id}`," in launcher
    assert 'textContent = ""' not in _block(launcher, "  const patchGroups = () => {", "\n  // Footer")
    assert "sessionList.textContent" not in launcher and "groupList.textContent" not in launcher
    assert "markEditing(entry, true);" in launcher and "markEditing(entry, false);" in launcher
    assert "if (!listed.has(key) || !trigger.isConnected) handle.close(\"gone\");" in launcher
    # Listeners read the live item, not the data they were built from.
    assert "itemFor(entry)?.session" in launcher
    # The shell builds the sidebar once and patches it.
    assert "const update = (partial = {}) => {" in launcher
    assert "model = { ...model, ...partial };" in launcher
    assert "updateSessions" not in launcher


def test_kill_is_a_danger_control_behind_a_confirmation():
    """Kill is never one click away, and the keyboard path focuses Kill.

    The row's kill is a separate labelled `.danger` control that opens
    confirm_popover.js; Delete on a focused row and the context menu reach the
    same confirmation. A pointer focuses Cancel, the keyboard focuses Kill.
    Detach is its own control and never kills.
    """
    launcher = _launcher()
    confirm = CONFIRM_JS.read_text(encoding="utf-8")

    assert 'import { confirmNear } from "./confirm_popover.js";' in launcher
    assert 'iconButton("session-action session-kill danger", "stop", "Kill",' in launcher
    assert "setLabel(kill, `Kill ${label}…`);" in launcher
    assert "message: `Kill ${name}? This stops its whole process tree.`," in launcher
    assert 'confirmLabel: "Kill",' in launcher
    assert 'owner: "sidebar-confirm",' in launcher
    assert 'event.key === "Delete"' in launcher and "killConfirm(entry, true);" in launcher
    assert "killConfirm(entry, fromKeyboard(event))" in launcher
    assert 'label: "Kill…", icon: "stop", danger: true' in launcher
    detach = _block(launcher, "  const detach = (entry) => {", "\n  };")
    assert "killTerminal" not in detach and "detachTerminal" in detach

    assert 'import { claimFocus, releaseFocus } from "./focus.js";' in confirm
    assert "export function confirmNear(trigger, {" in confirm
    assert "export function confirmPlacement(triggerRect, boxSize, viewport, { margin = 12, gap = 6 } = {})" in confirm
    # Measure before the trigger changes, claim before focusing.
    body = confirm[confirm.index("export function confirmNear(") :]
    assert body.index("trigger.getBoundingClientRect()") < body.index("trigger.disabled = true;")
    assert body.index("claimFocus(owner);") < body.index('(initialFocus(keyboard) === "confirm" ? confirm : cancel).focus();')
    close = _block(body, "  const close = (reason", "\n  };")
    assert close.index("releaseFocus(owner);") < close.index("onClose?.(reason);")
    assert 'confirm.textContent = "Retry";' in body
    assert 'window.addEventListener("scroll", reposition, true);' in body


def test_absolutely_positioned_sidebar_children_outrank_the_stretch_rule():
    """app.css stretches every direct sidebar child; the grip must outrank it.

    `.launcher.sidebar > * { width: 100% }` beats a bare `.sidebar-grip` on
    specificity whatever the file order, so the grip computed to the full
    sidebar width. Being absolutely positioned at z-index 30, it then covered
    the workspace list, the terminal picker and the footer buttons, and none of
    them could be clicked at all. Only caught by opening the app.
    """
    app_css = APP_CSS.read_text(encoding="utf-8")
    sidebar_css = SIDEBAR_CSS.read_text(encoding="utf-8")

    # The stretch rule is the hazard this guards against. If it ever goes away,
    # this test should be revisited rather than silently kept.
    assert ".launcher.sidebar > * { width: 100%" in app_css
    # Two classes plus the child element beat two classes plus the universal.
    assert ".launcher.sidebar > .sidebar-grip {" in sidebar_css
    grip = sidebar_css[sidebar_css.index(".launcher.sidebar > .sidebar-grip {"):]
    grip = grip[: grip.index("}")]
    assert "width: 3px" in grip
    # inset:0 without an explicit left would stretch it back across the sidebar.
    assert "left: auto" in grip
    # The hover trays are absolutely positioned inside rows, never direct
    # sidebar children, so the stretch rule cannot reach them.
    assert re.search(r"\.group-actions, \.session-actions \{\s*position: absolute;", sidebar_css)


def test_the_chrome_is_the_sidebar_and_nothing_else():
    """No status bar, no quick-settings drawer, no header on a lone pane.

    The sidebar carries the workspaces, the terminals and the footer icons; a
    single pane is a terminal from edge to edge. Alt+Shift+S cycles the sidebar
    through full, rail and hidden, and the hidden state leaves a floating "+"
    pinned at the top. Nothing in the sidebar drags except the width grip.
    """
    html = INDEX_HTML.read_text(encoding="utf-8")
    app_css = APP_CSS.read_text(encoding="utf-8")
    keys = KEYS_JS.read_text(encoding="utf-8")
    launcher = _launcher()
    sidebar_css = SIDEBAR_CSS.read_text(encoding="utf-8")

    assert "statusbar" not in html and "quick-settings" not in html
    assert 'id="float-launch"' in html
    assert "#grid > .pane > .pane-tab" in app_css
    assert "quick-settings" not in app_css and ".statusbar" not in app_css
    assert 'if (key === "s") return done(actions.toggleSidebar);' in keys
    assert 'export const SIDEBAR_MODES = ["full", "rail", "hidden"];' in launcher
    assert "cycleMode() { setMode(nextSidebarMode(mode)); return mode; }," in launcher
    # The save dot keeps its id and contract: feedback.js drives it through
    # data-state only, on the active group's head. The head stays one row:
    # folder and save dot go into it, Explorer and VS Code into its tray, and
    # only the "workspace here" offer takes a line below.
    assert 'save.id = "sb-save";' in launcher
    assert 'save.setAttribute("role", "status");' in launcher
    assert "if (save.parentNode !== head) head.append(save);" in launcher
    assert "if (tools.parentNode !== tray) tray.insertBefore(tools, closeView);" in launcher
    assert "activeLine.hidden = !here;" in launcher
    assert "flex-wrap: wrap" not in sidebar_css.split(".session-row {", 1)[1].split("}", 1)[0]
    assert ".sidebar-save[data-state=\"saving\"]" in sidebar_css
    # Removed chrome stays removed.
    for gone in ("sidebar-window", "sidebar-view-list", "sidebar-where", "workspace beside"):
        assert gone not in launcher, gone
    for gone in (".sidebar-window", ".sidebar-view-list", ".session-choice", ".session-group.current", ":not(.current)"):
        assert gone not in sidebar_css, gone
    # No drag but the width grip: the floating "+" is pinned.
    assert "floatTop" not in launcher and "quickterm.floatTop" not in launcher
    assert "float-handle" not in launcher
    assert ".float-launch > .float-handle { display: none; }" in sidebar_css
    assert launcher.count("setPointerCapture") == 1
    assert 'grip.addEventListener("pointerdown"' in launcher


def test_the_sidebar_has_menus_not_native_selects():
    """Every chooser in the chrome is menu.js: the OS list cannot show a folder
    under a workspace name, a colour dot for a view, or a second action on a
    row. Menus own the keyboard while open and hand it back on close, and a
    trigger toggles rather than reopening on the press that closed it.
    """
    launcher = _launcher()
    menu = (FRONTEND_JS / "menu.js").read_text(encoding="utf-8")
    html = INDEX_HTML.read_text(encoding="utf-8")
    sidebar_css = SIDEBAR_CSS.read_text(encoding="utf-8")

    assert 'make("select"' not in launcher and "<select" not in launcher
    assert "showPicker" not in launcher
    assert 'import { toggleMenu } from "./menu.js";' in launcher
    assert "openMenu(" not in launcher
    # The launch chooser, the Workspaces "+", the group kebab and the row's
    # context menu are all menus.
    assert launcher.count("toggleMenu({") == 4
    assert 'label: "Workspaces",' in launcher
    assert 'iconButton("group-action group-more", "more", "Workspace actions")' in launcher
    assert 'row.addEventListener("contextmenu"' in launcher
    assert '(event.key === "F10" && event.shiftKey)' in launcher
    assert 'claimFocus("menu")' in menu and 'releaseFocus("menu")' in menu
    assert "export function toggleMenu(options)" in menu
    assert '<link rel="stylesheet" href="/css/menu.css">' in html
    assert ".launcher.sidebar select" not in sidebar_css
    # The rail rules survive: one dot per terminal across every group.
    assert "body.sidebar-collapsed .sidebar-terminal-pick," in sidebar_css
    # The rail drops the guide line and its indent with the padding.
    assert "body.sidebar-collapsed .session-group.folded > .session-group-rows { display: flex; margin: 0; padding: 0; border: 0; }" in sidebar_css


def test_the_sidebar_honours_reduced_motion_and_forced_colours():
    sidebar_css = SIDEBAR_CSS.read_text(encoding="utf-8")
    motion = _block(sidebar_css, "@media (prefers-reduced-motion: reduce) {", "\n}")
    assert "animation: none;" in motion and "transition: none;" in motion
    assert "@media (forced-colors: active) {" in sidebar_css
    # Hover actions are reachable from the keyboard too.
    assert ".session-entry:focus-within > .session-actions," in sidebar_css
    assert ".session-group-headline:focus-within > .group-actions," in sidebar_css
