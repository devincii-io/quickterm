"""Source-text contracts for the focus and scratch rules (scratch.js, pane.js).

Both are timing rules that no unit test can observe from Python, and both were
regressions the user hit in the running app, so they are pinned here the way
tests/test_contracts_*.py pin the rest of the frontend.
"""

from pathlib import Path

FRONTEND_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js"
SCRATCH_JS = FRONTEND_JS / "scratch.js"
WORKSPACE_SWITCH_JS = FRONTEND_JS / "workspace_switch.js"


def test_new_scratch_only_destroys_terminals_that_are_idle_and_untouched():
    scratch = SCRATCH_JS.read_text(encoding="utf-8")
    start = scratch.index("  async function scratchTerminalsAtRisk()")
    implementation = scratch[start:scratch.index("\n  // Explicit replacement", start)]
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
    scratch = SCRATCH_JS.read_text(encoding="utf-8")
    start = scratch.index("export function discardScratchWarning(")
    implementation = scratch[start:scratch.index("\nexport function createScratch(", start)]
    assert "atRisk.slice(0, 3).map((item) => item.name)" in implementation
    assert "still running something" in implementation

    start = scratch.index("  async function newScratchWorkspace()")
    new_scratch = scratch[start:scratch.index("\n  async function openFolderInScratch", start)]
    assert "const atRisk = await scratchTerminalsAtRisk();" in new_scratch
    assert "if (!atRisk.length) return replace();" in new_scratch
    assert "pane.confirmAction(discardScratchWarning(atRisk), replace, \"Discard\");" in new_scratch


def test_leaving_scratch_spares_busy_and_used_terminals():
    scratch = SCRATCH_JS.read_text(encoding="utf-8")
    start = scratch.index("  async function discardScratch(")
    implementation = scratch[start:scratch.index("\n  // Ephemeral scratch:", start)]
    # Replacing scratch is confirmed by the user first, so it kills everything.
    # Merely leaving it was never confirmed by anyone.
    assert "async function discardScratch({ force = false } = {})" in implementation
    assert "if (!sessions) return;" in implementation
    assert "return session.busy === false && !session.touched;" in implementation
    assert "await discardScratch({ force: true });" in scratch


def test_going_to_scratch_restores_it_and_only_new_scratch_replaces_it():
    # Clicking the sidebar's scratch row passes name=null, and that branch used
    # to delete the adopted "scratch" workspace file and build an empty layout,
    # so navigating to scratch from another workspace destroyed the scratch
    # terminals the user had left running there. Only the confirmed "New
    # scratch" action, which already carries replaceScratch, may replace it.
    switcher = WORKSPACE_SWITCH_JS.read_text(encoding="utf-8")
    scratch = SCRATCH_JS.read_text(encoding="utf-8")
    start = switcher.index("  async function switchWorkspace(")
    switch = switcher[start:switcher.index("\n  return {", start)]

    guard = "} else if (!replaceScratch && state.workspaceNames.includes(SCRATCH_WS)) {"
    assert guard in switch
    restore_start = switch.index(guard)
    replace_start = switch.index("\n    } else {", restore_start)
    restore = switch[restore_start:replace_start]

    # Restored like any other workspace, and through rememberWorkspace, which
    # writes scratch's own flag rather than the durable key.
    assert "state.currentWorkspace = SCRATCH_WS;" in restore
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
    new_scratch_start = scratch.index("  async function newScratchWorkspace()")
    new_scratch = scratch[
        new_scratch_start:scratch.index("\n  async function openFolderInScratch", new_scratch_start)
    ]
    assert "switchWorkspace(null, null, { replaceScratch: true })" in new_scratch


def test_new_scratch_opens_its_own_view_and_replaces_nothing():
    # Every scratch is a view of its own now. "New scratch" opens another
    # one beside what is open, so the confirmed replace path above is never
    # reached from the UI and no terminal is put at risk by asking for one.
    shell = (FRONTEND_JS / "shell.js").read_text(encoding="utf-8")
    main = (FRONTEND_JS / "main.js").read_text(encoding="utf-8")
    start = shell.index("  async function newScratchView()")
    new_scratch = shell[start:shell.index("\n  }\n", start)]
    assert "return Boolean(await views.open(null));" in new_scratch
    assert "newScratchWorkspace" not in shell and "newScratchWorkspace" not in main
    assert "discardScratch" not in shell
    assert "newScratch: newScratchView," in shell


def test_closing_a_scratch_view_kills_nothing():
    # Closing a view is leaving its workspace, scratch included, and leaving
    # was never confirmed by anyone: every owned terminal is retained.
    lifecycle = (FRONTEND_JS / "lifecycle.js").read_text(encoding="utf-8")
    start = lifecycle.index("  async function closeView()")
    close = lifecycle[start:lifecycle.index("\n  return {", start)]
    assert "await api.retainSession(id)" in close
    assert "killSession" not in close and "cleanupSessions" not in close
    assert "discardScratch" not in close
