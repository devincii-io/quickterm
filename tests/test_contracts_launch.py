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
PANE_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js" / "pane.js"
PALETTE_JS = Path(__file__).parents[1] / "quickterm" / "frontend" / "js" / "palette.js"


def test_pane_uses_the_tested_attach_protocol_state_machine():
    source = PANE_JS.read_text(encoding="utf-8")
    assert 'from "./pane_protocol.js"' in source
    assert "new PaneAttachProtocol(" in source
    assert "this._protocol.canSendInput()" in source


def test_pane_focus_is_reasserted_after_async_attach_without_stealing_it_back():
    source = PANE_JS.read_text(encoding="utf-8")
    assert 'if (this._disposed || !this.term || !this.el.classList.contains("focused")) return;' in source
    assert "requestAnimationFrame(focus)" in source
    assert "setTimeout(focus, 0)" in source
    assert source.count("this.focusSoon();") >= 3


def test_only_real_user_input_marks_a_session_touched():
    # The backend counted every WebSocket byte as use, including xterm's
    # automatic replies to terminal queries, so an untyped shell was never
    # reaped. Only onKey, the native paste shortcut, any paste or IME
    # composition on xterm's textarea, and sendText (snippets and drops) reach
    # _markWrote, which sends one touch frame per connection.
    pane = PANE_JS.read_text(encoding="utf-8")
    protocol = (FRONTEND_JS / "pane_protocol.js").read_text(encoding="utf-8")
    assert "this.term.onKey(() => this._markWrote());" in pane
    # Input that never fires onKey (menu or middle-click paste, IME, dictation).
    assert 'this.term.textarea?.addEventListener("paste", typed, true);' in pane
    assert 'this.term.textarea?.addEventListener("compositionend", typed, true);' in pane
    mark = pane[pane.index("  _markWrote() {"):pane.index("  _sendTouch() {")]
    assert "this._sendTouch();" in mark
    touch = pane[pane.index("  _sendTouch() {"):]
    touch = touch[:touch.index("\n  }\n")]
    assert 'this.ws.send(JSON.stringify({ type: "touch" }));' in touch
    assert "this._protocol.takeTouch()" in touch
    for handler in ("this.term.onData((d) => {", "this.term.onBinary((d) => {"):
        body = pane[pane.index(handler):]
        body = body[:body.index("\n    });")]
        assert "_markWrote" not in body and "touch" not in body
    replay = protocol[protocol.index("  beginReplay() {"):protocol.index("  takeTouch() {")]
    assert "this.touchSent = false;" in replay


def test_the_api_client_carries_no_dead_wrappers():
    api = (FRONTEND_JS / "api.js").read_text(encoding="utf-8")
    assert "getSnippets" not in api
    assert "sessionBusy" not in api
    assert "/api/snippets" not in api
    assert '".scratch"' not in api


def test_workspace_folder_reaches_every_spawn_path():
    spawner = SPAWNER_JS.read_text(encoding="utf-8")
    api = (FRONTEND_JS / "api.js").read_text(encoding="utf-8")
    # An absent "path" key preserves the stored folder; every layout autosave
    # relies on that, so the wrapper must not default it to null.
    assert "...(path === undefined ? {} : { path })" in api
    assert "function contextCwd(explicit)" in spawner
    # Profiles carry no folder, so nothing local can pre-empt the workspace
    # root the backend resolves. Scratch is the one exception: its throwaway
    # root is only known to the viewer.
    for module in MAIN_MODULES:
        assert "profile.cwd" not in module.read_text(encoding="utf-8"), module.name
    assert "return state.scratchRoot || null;" in spawner


def test_splits_inherit_signalled_directory_without_changing_new_terminal_policy():
    spawner = SPAWNER_JS.read_text(encoding="utf-8")
    commands = PANE_COMMANDS_JS.read_text(encoding="utf-8")
    pane = PANE_JS.read_text(encoding="utf-8")
    palette = PALETTE_JS.read_text(encoding="utf-8")

    assert 'from "./split_policy.js"' in spawner
    assert "spawnSplitInto(pane, source)" in commands
    assert "newTerminal:" in commands and "spawnDefaultInto(pane)" in commands
    assert "registerOscHandler(7" in pane
    assert "registerOscHandler(9" in pane
    assert "split Claude agent view:" in palette
    assert 'claudeMode: "agents"' in spawner


def test_panes_move_by_dragging_their_header():
    """The header is the drag handle. It is only drawn with two or more panes,
    and a zoomed pane draws it but refuses the drag, so a lone pane cannot
    start one. The geometry
    and the tree surgery live in pane_move.js, pure and unit-tested; layout.js
    renders the result and autosaves it like any other structural change.
    """
    layout = (FRONTEND_JS / "layout.js").read_text(encoding="utf-8")
    app_css = (Path(__file__).parents[1] / "quickterm" / "frontend" / "css" / "app.css").read_text(
        encoding="utf-8"
    )
    pane = PANE_JS.read_text(encoding="utf-8")

    assert 'import { dropZone, movePaneNode, zoneRect } from "./pane_move.js";' in layout
    assert "this._wireDrag(pane);" in layout
    move = layout[layout.index("  movePane(pane, target, zone) {"):]
    move = move[:move.index("\n  }\n") + 4]
    assert "const root = movePaneNode(this.root, pane, target, zone);" in move
    assert "this.render();" in move and "this._changed();" in move
    # A press has to travel before it is a drag, or a double-click rename and
    # a click to focus would both start one.
    assert "const DRAG_START_PX = 6;" in layout
    assert "if (down.button !== 0 || this.zoomed) return;" in layout
    assert 'title="Drag to move · double-click to rename"' in pane
    assert ".pane-drop-hint" in app_css and ".pane-drag-ghost" in app_css
    assert ".pane-drag-ghost {" in app_css and "pointer-events: none;" in app_css


def test_broadcast_mirrors_only_real_input_within_this_document():
    """xterm's onData also carries its automatic replies to terminal queries;
    typing those into other shells is garbage, so only data behind the input
    gate is mirrored, and binary data never is. The switch lives in the layout,
    which is one document, and restore() (every workspace switch) clears it.
    """
    pane = PANE_JS.read_text(encoding="utf-8")
    layout = (FRONTEND_JS / "layout.js").read_text(encoding="utf-8")
    palette = PALETTE_JS.read_text(encoding="utf-8")
    app_css = (Path(__file__).parents[1] / "quickterm" / "frontend" / "css" / "app.css").read_text(
        encoding="utf-8"
    )

    data = pane[pane.index("this.term.onData((d) => {"):]
    data = data[:data.index("\n    });")]
    assert "if (this._inputGate.open) this.onUserInput(d, this);" in data
    binary = pane[pane.index("this.term.onBinary((d) => {"):]
    binary = binary[:binary.index("\n    });")]
    assert "onUserInput" not in binary
    assert "this.term.onKey(() => this._inputGate.arm());" in pane
    # On the host in the capture phase: xterm's own textarea listeners run
    # first at the target and would emit the data before the gate opened.
    gate = pane[pane.index('for (const type of ["paste", "compositionend", "input"]) {'):]
    gate = gate[:gate.index("\n    }\n")]
    assert "this.termHost.addEventListener(type, () => {" in gate
    assert 'this._inputGate.arm(type === "compositionend" ? 2 : 1);' in gate
    assert "}, true);" in gate
    assert "onUserInput: (data, p) => this._broadcastFrom(p, data)," in layout
    assert "for (const p of broadcastTargets(this.panes(), source)) {" in layout
    # Automatic replies are stripped, and a paste is re-pasted per target.
    assert "withoutTerminalReplies(data)" in layout
    assert "if (pasted !== null) p.pasteText(pasted);" in layout
    restore = layout[layout.index("  restore(layout) {"):]
    restore = restore[:restore.index("\n  }\n")]
    assert "this.broadcasting = false;" in restore
    assert '"broadcast input to all panes in this workspace"' in palette
    assert '"stop broadcasting input"' in palette
    assert ".pane.broadcasting:not(.drop-target)::after" in app_css


def test_search_and_export_are_palette_rows():
    palette = PALETTE_JS.read_text(encoding="utf-8")
    actions = (FRONTEND_JS / "terminal_actions.js").read_text(encoding="utf-8")
    main = MAIN_JS.read_text(encoding="utf-8")

    assert 'label: "search all terminals…"' in palette
    assert 'label: "save terminal output"' in palette
    assert 'label: "open last saved output"' in palette
    assert "/api/search?q=${encodeURIComponent(query)}" in actions
    assert "/export`" in actions
    # Opening goes through the one token-gated opener route.
    assert "api.openTarget(lastSaved)" in actions
    # A hit outside this layout is attached the way "attach here" does it.
    assert "if (!attachSession(info)) return false;" in actions
    assert "...createTerminalActions({ api, layout, attachSession, restartSavedPane, showError })," in main


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
