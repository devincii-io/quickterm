from pathlib import Path


FRONTEND_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js"
MAIN_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js" / "main.js"
# main.js is the composition root; the code it wires lives in these modules.
BOOT_CONTEXT_JS = FRONTEND_JS / "boot_context.js"
CONFIG_SYNC_JS = FRONTEND_JS / "config_sync.js"
HERE_JS = FRONTEND_JS / "here.js"
LAUNCH_LOOP_JS = FRONTEND_JS / "launch_loop.js"
LIFECYCLE_JS = FRONTEND_JS / "lifecycle.js"
PANE_COMMANDS_JS = FRONTEND_JS / "pane_commands.js"
SCRATCH_JS = FRONTEND_JS / "scratch.js"
SIDEBAR_JS = FRONTEND_JS / "sidebar.js"
SPAWNER_JS = FRONTEND_JS / "spawner.js"
WINDOW_REGISTRY_JS = FRONTEND_JS / "window_registry.js"
WORKSPACE_ACTIONS_JS = FRONTEND_JS / "workspace_actions.js"
WORKSPACE_SWITCH_JS = FRONTEND_JS / "workspace_switch.js"
MAIN_MODULES = (
    MAIN_JS, BOOT_CONTEXT_JS, CONFIG_SYNC_JS, HERE_JS, LAUNCH_LOOP_JS, LIFECYCLE_JS,
    PANE_COMMANDS_JS, SCRATCH_JS, SIDEBAR_JS, SPAWNER_JS, WINDOW_REGISTRY_JS,
    WORKSPACE_ACTIONS_JS, WORKSPACE_SWITCH_JS,
    FRONTEND_JS / "app_state.js", FRONTEND_JS / "autosave.js", FRONTEND_JS / "feedback.js",
    FRONTEND_JS / "fonts.js", FRONTEND_JS / "layout_sessions.js",
    FRONTEND_JS / "session_ownership.js", FRONTEND_JS / "updates.js",
)
KEYS_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js" / "keys.js"
LAUNCHER_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js" / "launcher.js"


def test_sidebar_collapse_returns_input_focus_to_the_terminal():
    source = LAUNCHER_JS.read_text(encoding="utf-8")
    assert "requestAnimationFrame(() => options.onLaunchComplete?.())" in source


def test_sidebar_lists_every_live_terminal_grouped_by_workspace():
    """Nothing live may be filtered out of the sidebar, and none of it is stolen.

    The list is grouped by the workspace that owns each terminal, using the
    same ownership rule the dashboard applies, and the pill counts the backend
    total. Acting on a terminal another workspace owns stays a decision: the
    row offers "open that workspace" or an explicit move, and never attaches on
    the click itself.
    """
    launcher = LAUNCHER_JS.read_text(encoding="utf-8")
    # No filter may narrow the list to what this window happens to hold.
    assert "owned.has(session.id) || attached.has(session.id)" not in launcher
    assert "groupSessionsByWorkspace(sessions, {" in launcher
    assert "`${here} in ${workspaceName} · ${totalLive} live on this backend`" in launcher
    # Claude needs no profile: the CLI found by the inventory is offered as is.
    assert 'key: `claude:${mode}`' in launcher

    start = launcher.index("  const sessionEntry = (entry, group) => {")
    end = launcher.index("\n  const sessionGroup =", start)
    entry = launcher[start:end]
    # A foreign row arms its choices; only the two labelled buttons act.
    assert 'const foreign = !isHere && group.kind === "workspace" && !shown;' in entry
    assert "options.onFocusShownSession?.(session.id)" in entry
    assert entry.index("if (!foreign) {") < entry.index("options.onAttachSession?.(session)")
    assert "row.addEventListener(\"click\", () => setArmed(" in entry
    assert "options.onWorkspace?.(target)" in entry
    assert "options.onMoveSession(session, target)" in entry


def test_absolutely_positioned_sidebar_children_outrank_the_stretch_rule():
    """app.css stretches every direct sidebar child; the grip must outrank it.

    `.launcher.sidebar > * { width: 100% }` beats a bare `.sidebar-grip` on
    specificity whatever the file order, so the grip computed to the full
    sidebar width. Being absolutely positioned at z-index 30, it then covered
    the workspace list, the terminal picker and the footer buttons, and none of
    them could be clicked at all. Only caught by opening the app.
    """
    app_css = (Path(__file__).parents[1] / "quickterm" / "frontend" / "css" / "app.css").read_text(
        encoding="utf-8"
    )
    sidebar_css = (
        Path(__file__).parents[1] / "quickterm" / "frontend" / "css" / "sidebar.css"
    ).read_text(encoding="utf-8")

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


def test_the_chrome_is_the_sidebar_and_nothing_else():
    """No status bar, no quick-settings drawer, no header on a lone pane.

    The sidebar carries the workspace, the terminals and the four panel icons;
    a single pane is a terminal from edge to edge; the pane header returns only
    with a second pane and its actions only on hover. Alt+Shift+S cycles the
    sidebar through full, rail and hidden, and the hidden state leaves a
    floating "+" that can be dragged along the terminal's left edge.
    """
    html = (Path(__file__).parents[1] / "quickterm" / "frontend" / "index.html").read_text(
        encoding="utf-8"
    )
    app_css = (Path(__file__).parents[1] / "quickterm" / "frontend" / "css" / "app.css").read_text(
        encoding="utf-8"
    )
    keys = KEYS_JS.read_text(encoding="utf-8")
    launcher = LAUNCHER_JS.read_text(encoding="utf-8")
    main = MAIN_JS.read_text(encoding="utf-8")

    assert "statusbar" not in html and "quick-settings" not in html
    assert 'id="float-launch"' in html
    assert "#grid > .pane > .pane-tab" in app_css
    assert ".pane:hover .pane-actions" in app_css
    assert "quick-settings" not in app_css and ".statusbar" not in app_css
    assert 'if (key === "s") return done(actions.toggleSidebar);' in keys
    assert 'export const SIDEBAR_MODES = ["full", "rail", "hidden"];' in launcher
    assert "toggleSidebar: () => state.launcherView?.cycleMode()," in main
    # The save dot keeps its id: feedback.js drives it through data-state only.
    assert 'save.id = "sb-save";' in launcher
    for module in MAIN_MODULES:
        assert "status.textContent = text;" not in module.read_text(encoding="utf-8"), module.name
    assert "status.dataset.state = key;" in (FRONTEND_JS / "feedback.js").read_text(encoding="utf-8")


def test_the_sidebar_has_menus_not_native_selects():
    """Every chooser in the chrome is menu.js: the OS list cannot show a folder
    under a workspace name, a colour dot for a view, or a second action on a
    row. Menus own the keyboard while open and hand it back on close, and a
    trigger toggles rather than reopening on the press that closed it.
    """
    launcher = LAUNCHER_JS.read_text(encoding="utf-8")
    menu = (FRONTEND_JS / "menu.js").read_text(encoding="utf-8")
    html = (Path(__file__).parents[1] / "quickterm" / "frontend" / "index.html").read_text(
        encoding="utf-8"
    )
    sidebar_css = (
        Path(__file__).parents[1] / "quickterm" / "frontend" / "css" / "sidebar.css"
    ).read_text(encoding="utf-8")

    assert 'make("select"' not in launcher and "<select" not in launcher
    assert "showPicker" not in launcher
    assert 'import { toggleMenu } from "./menu.js";' in launcher
    assert "openMenu(" not in launcher
    assert 'claimFocus("menu")' in menu and 'releaseFocus("menu")' in menu
    assert "export function toggleMenu(options)" in menu
    assert '<link rel="stylesheet" href="/css/menu.css">' in html
    assert ".launcher.sidebar select" not in sidebar_css
    # The save dot and the rail rules survive the swap.
    assert 'save.id = "sb-save";' in launcher
    assert "body.sidebar-collapsed .sidebar-terminal-pick," in sidebar_css
