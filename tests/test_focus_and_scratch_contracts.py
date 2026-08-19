"""Source-text contracts for the two rules that live in main.js and pane.js.

Both are timing rules that no unit test can observe from Python, and both were
regressions the user hit in the running app, so they are pinned here the way
tests/test_frontend_contracts.py pins the rest of the frontend.
"""

from pathlib import Path

FRONTEND_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js"
MAIN_JS = FRONTEND_JS / "main.js"
PANE_JS = FRONTEND_JS / "pane.js"
PALETTE_JS = FRONTEND_JS / "palette.js"
PANELS_JS = FRONTEND_JS / "panels.js"
FOCUS_JS = FRONTEND_JS / "focus.js"


def test_every_overlay_claims_the_keyboard_before_focusing_its_own_control():
    # A pane re-asserts term.focus() on a frame and on a timeout, so an overlay
    # that only focuses its input loses it again one frame later. Alt+K opened a
    # palette you could not type into for exactly this reason.
    assert FOCUS_JS.exists()
    for source in (PALETTE_JS, PANELS_JS, MAIN_JS):
        text = source.read_text(encoding="utf-8")
        assert 'from "./focus.js"' in text, source.name
        assert "claimFocus(" in text, source.name
        assert "releaseFocus(" in text, source.name


def test_the_deferred_terminal_refocus_stands_down_for_an_overlay():
    pane = PANE_JS.read_text(encoding="utf-8")
    start = pane.index("  focusSoon() {")
    end = pane.index("\n  setTheme(", start)
    implementation = pane[start:end]
    # The guard has to sit inside the deferred closure, not at the call site:
    # the rAF and the timeout run long after focusSoon() returned.
    assert "if (!terminalMayFocus()) return;" in implementation
    assert implementation.index("if (!terminalMayFocus()) return;") < implementation.index(
        "this.term.focus()"
    )
    assert "requestAnimationFrame(focus)" in implementation
    assert "setTimeout(focus, 0)" in implementation


def test_palette_focuses_its_input_on_open_and_returns_the_terminal_on_close():
    palette = PALETTE_JS.read_text(encoding="utf-8")
    open_start = palette.index("  async openPalette() {")
    open_impl = palette[open_start:palette.index("\n  close() {", open_start)]
    assert open_impl.index('claimFocus("palette")') < open_impl.index("this.focusInput()")

    close_start = palette.index("  close() {")
    close_impl = palette[close_start:palette.index("\n  focusInput() {", close_start)]
    # Release first: the guard this palette installed would otherwise refuse its
    # own hand-off back to the terminal.
    assert close_impl.index('releaseFocus("palette")') < close_impl.index(
        "this.app.refocusTerm()"
    )


def test_quick_settings_hands_focus_back_to_the_terminal_not_its_trigger():
    main = MAIN_JS.read_text(encoding="utf-8")
    start = main.index("  function closeQuickSettings(")
    implementation = main[start:main.index("\n  function toggleQuickSettings", start)]
    assert "if (!app.refocusTerm()) quickButton.focus();" in implementation
    assert 'releaseFocus("quick-settings")' in implementation


def test_new_scratch_only_destroys_terminals_that_are_idle_and_untouched():
    main = MAIN_JS.read_text(encoding="utf-8")
    start = main.index("  async function scratchTerminalsAtRisk()")
    implementation = main[start:main.index("\n  function discardScratchWarning(", start)]
    # POST /api/sessions/cleanup kills whatever it is handed; the "never expire
    # a shell the user typed into" rule only exists in reap_idle. So both facts
    # are checked here instead.
    assert "session.busy !== false" in implementation
    assert "Boolean(session.touched)" in implementation
    assert "pane.userWrote" in implementation
    # An unknown session must count as at risk, never as safe to kill.
    assert "const busy = session ? session.busy !== false : true;" in implementation
    assert "const used = session ? Boolean(session.touched) : true;" in implementation


def test_the_confirmation_names_the_terminals_instead_of_counting_panes():
    main = MAIN_JS.read_text(encoding="utf-8")
    start = main.index("  function discardScratchWarning(")
    implementation = main[start:main.index("\n  // Explicit replacement", start)]
    assert "atRisk.slice(0, 3).map((item) => item.name)" in implementation
    assert "still running something" in implementation

    start = main.index("  async function newScratchWorkspace()")
    new_scratch = main[start:main.index("\n  async function openFolderInScratch", start)]
    assert "const atRisk = await scratchTerminalsAtRisk();" in new_scratch
    assert "if (!atRisk.length) return replace();" in new_scratch
    assert "pane.confirmAction(discardScratchWarning(atRisk), replace, \"Discard\");" in new_scratch


def test_leaving_scratch_spares_busy_and_used_terminals():
    main = MAIN_JS.read_text(encoding="utf-8")
    start = main.index("  async function discardScratch(")
    implementation = main[start:main.index("\n  // Ephemeral scratch:", start)]
    # Replacing scratch is confirmed by the user first, so it kills everything.
    # Merely leaving it was never confirmed by anyone.
    assert "async function discardScratch({ force = false } = {})" in implementation
    assert "if (!sessions) return;" in implementation
    assert "return session.busy === false && !session.touched;" in implementation
    assert "await discardScratch({ force: true });" in main


def test_going_to_scratch_restores_it_and_only_new_scratch_replaces_it():
    # Clicking the sidebar's scratch row passes name=null, and that branch used
    # to delete the adopted "scratch" workspace file and build an empty layout,
    # so navigating to scratch from another workspace destroyed the scratch
    # terminals the user had left running there. Only the confirmed "New
    # scratch" action, which already carries replaceScratch, may replace it.
    main = MAIN_JS.read_text(encoding="utf-8")
    start = main.index("  async function switchWorkspace(")
    switch = main[start:main.index("\n  // Which scratch terminals", start)]

    guard = "} else if (!replaceScratch && workspaceNames.includes(SCRATCH_WS)) {"
    assert guard in switch
    restore_start = switch.index(guard)
    replace_start = switch.index("\n    } else {", restore_start)
    restore = switch[restore_start:replace_start]

    # Restored like any other workspace, and through rememberWorkspace, which
    # writes scratch's own flag rather than the durable key.
    assert "currentWorkspace = SCRATCH_WS;" in restore
    assert "rememberWorkspace(SCRATCH_WS)" in restore
    assert "await restoreWorkspace(SCRATCH_WS)" in restore
    # The backend drops the scratch file at app start, so an absent one is
    # normal and a fresh scratch is the right fallback.
    assert "if (!restored) opened = await startScratch(scratchCwd);" in restore
    # Nothing on this path may destroy anything.
    assert "deleteWorkspace" not in restore
    assert "discardScratch" not in restore

    replace = switch[replace_start:]
    assert "await discardScratch({ force: true })" in replace
    assert "api.deleteWorkspace(SCRATCH_WS)" in replace

    # The one caller allowed to reach that branch asks first.
    new_scratch_start = main.index("  async function newScratchWorkspace()")
    new_scratch = main[new_scratch_start:main.index("\n  async function openFolderInScratch", new_scratch_start)]
    assert "switchWorkspace(null, null, { replaceScratch: true })" in new_scratch
