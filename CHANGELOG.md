# Changelog

Release history is also available on the [GitHub Releases page](https://github.com/devincii-io/quickterm/releases).

## QuickTerm 3.1.0

### Nothing destructive without consent

- The pane title bar's `×` now closes the view and leaves the terminal
  running, matching what that glyph means everywhere else. Killing moved to a
  separate, divided, labelled **Kill** control, and every destructive
  confirmation now opens with **Cancel** focused so a reflexive Enter cannot
  complete it.
- Clicking the workspace row you are already on is a no-op for every workspace,
  scratch included. Previously the row drawn as “current” discarded every live
  scratch terminal without asking; replacing scratch is now the explicit,
  confirmed **new scratch** action.
- Removed the palette's free-text workspace prompts, where a typo silently tore
  down the whole layout. Workspaces are offered as exact `load workspace: <name>`
  rows, and saving is handled by the Dashboard, which validates the name.
- The in-app updater now stands the window down before starting Setup. It used
  to launch the installer while close-to-tray was actively refusing to close,
  leaving Setup stalled on a window missing from the taskbar — or
  force-terminating the app and every terminal in it.

### Nothing fails silently

- Added a single dismissible message banner for blocking failures, drawn above
  the panel overlay. Errors previously went to a 9 px status-bar slot that
  collapsed when empty, never cleared, and sat underneath open panels.
- The sidebar **admin** button now reports its outcome instead of swallowing
  every failure, including a declined UAC prompt, in an empty catch.
- A global shortcut that Windows refuses to register (another program owns it)
  is now reported in Settings next to the field, along with the fact that the
  shortcut and port apply after a restart.
- Failed workspace saves roll back instead of leaving the app pointing at a
  workspace that was never written, and rejected names explain themselves.
- Snippets show the command and the destination pane before running, and
  multi-line snippets are confirmed in the pane first.
- Settings' **System default shell** option works; it previously always
  resolved to the first personal profile.

### No lost terminal output

- A viewer that falls behind now recovers even if the session exits during the
  resync: an exited session still in the registry is served in replay-only
  mode instead of being refused, so its final output stays reachable.
- A fresh attachment is drained from the moment it exists. A busy session could
  previously overflow its queue during the replay handshake and be disconnected
  the instant it went live, looping on “output busy · resynchronizing” forever.
- Output still queued in the browser when a session exits is flushed to the
  terminal instead of being dropped mid-stream and then retained.

### Correctness and performance

- Saving Settings no longer writes the runtime port into `config.json`. An
  Administrator window or any `--port` launch used to overwrite the configured
  port with an ephemeral one for every later launch.
- `Ctrl+]` and `Ctrl+/` reach the shell again on US/UK layouts — the vim tag
  jump and the readline/PSReadLine undo were being swallowed as font zoom.
- Moved the idle reaper, bulk session cleanup and the UAC handshake off the
  event loop; a reaper pass that killed a live shell froze every pane for
  hundreds of milliseconds and then overflowed the queues it had stalled.
- Process metrics sample only the session process trees rather than every
  process on the machine, and the dashboard stops polling while hidden.
- Workspace names that differ only in case no longer share one file on NTFS.
- POSIX `kill()` verifies termination instead of reporting success on `EPERM`,
  and the POSIX resize/write paths can no longer touch a recycled descriptor.
- Fixed Escape closing a whole panel instead of cancelling the destructive
  confirmation inside it, confirmation popovers drifting away from their
  trigger while the panel scrolled, pane resizing silently dropping zoom, the
  palette running a different item than the highlighted one, Advanced-tab JSON
  edits being discarded on tab switch, a folder handoff retrying a permanently
  failing spawn forever, and replaced branding assets never being reclaimed.
- Removed duplicate entry points: the Dashboard had two adjacent identical
  sidebar buttons, and pane sizing was offered in three places at once.

## QuickTerm 3.0.1

### Native profile folder picker

- Added a Windows folder chooser beside every local terminal profile's
  Starting folder or Claude Project folder while preserving direct path entry.
- Cancel leaves the existing path untouched; failed dialogs remain retryable,
  and standalone browsers clearly disable the native-only control rather than
  pretending they can disclose a host path.
- WSL profiles continue accepting Linux paths manually and can use Browse to
  select an absolute Windows directory for `wsl.exe --cd`.

## QuickTerm 3.0.0

### Terminal-first workspace

- Replaced the card-heavy launcher and top bar with a compact, collapsible
  terminal-style sidebar while letting panes use the full window height.
- Added dense pane chrome for horizontal and vertical splits, zoom, true
  detach, and confirmed process-tree termination, plus current-workspace and
  global live-session counters.
- Added `Alt+N` new-terminal, `Alt+D` detach, `Alt+W` confirmed kill,
  `Alt+Z` zoom, directional focus/split shortcuts, and fast profile cycling
  while preserving native PowerShell/readline navigation and Chromium paste.

### Reliable sessions and desktop handoff

- Separated explicit retention from typed activity so detached shells remain
  alive without falsifying usage state; verified kills remove only processes
  the backend actually terminated.
- Restored missing sessions as transcript-free unavailable panes with explicit
  recovery instead of silently starting a different process under the old ID.
- Made workspace ownership and destructive cleanup server-authoritative, with
  protection against stale duplicate references killing a moved terminal.
- A second ordinary QuickTerm launch now hands Explorer's folder to the
  authenticated running instance, summons that one window, and opens the
  terminal in Scratch instead of creating another QuickTerm.
- Hardened focus restoration across terminal creation, splits, attach/replay,
  panel close, recovery, detach, kill, and workspace transitions.

### Claude Code, folders, and file drops

- Promoted Claude Code to a first-class project profile with new, continue,
  session-picker, and background-agent-manager modes plus explicit recovery
  actions when its PTY is gone.
- Splits use the selected terminal profile in the focused pane's OSC 7 or
  OSC 9;9 directory, falling back to its launch/project folder without prompt
  scraping. Claude agent views remain an explicit separate action.
- Explorer file and image drops now insert host-verified, shell-quoted paths
  without submitting the command, including WSL path conversion and explicit
  refusal for misleading remote-terminal paths.

### Privacy, performance, and packaging

- Kept terminal transcripts and session IDs off disk. Normal diagnostics are
  warning/error-only, path-redacted, and bounded to 128 KiB plus one rotation;
  raw terminal bytes remain opt-in through `QUICKTERM_DEBUG_IO=1` only.
- Reduced status polling and frozen dependencies while retaining bounded
  scrollback, subscriber resynchronization, WebSocket coalescing, and xterm
  write-backpressure. The unpacked Windows build is 47.05 MB.
- Fixed GUI-subsystem ConPTY startup by allocating one hidden process-wide
  console before pywinpty creates terminal sessions.
- Added a packaged-app smoke test that verifies authenticated real-PTY spawn,
  initial attach, reconnect replay, live I/O, exit, and dynamic route bundling.

## QuickTerm 2.4.0

### Tested terminal attachment

- Extracted the pane replay, write-backpressure, resync, and live-input phases
  into an explicit state machine.
- Added fast Node tests for replay ordering, stale WebSocket callbacks, input
  gating, and overflow-triggered resync, plus shared panel utility tests.
- Added architectural contract tests that keep panes on the tested protocol and
  prevent the panel coordinator growing back into a monolith.

### Smaller, maintainable frontend

- Split the 1,456-line panels class into a small coordinator and focused
  dashboard, help, settings, terminal, snippet, appearance, and shared modules.
- Preserved the existing no-build ES-module frontend and its public UI behavior.

### One-command manual CI

- Added `uv run --no-sync python scripts/check.py` as the local release gate:
  Python tests, Ruff, byte compilation, JavaScript tests and syntax, version
  consistency, and clean diffs.
- Added `--artifacts` verification for the exact updater-facing release names
  and their SHA-256 manifest. Hosted CI remains intentionally disabled.

### Maintenance and diagnostics

- Session and PTY snapshot/write failures now leave debug diagnostics instead
  of disappearing silently.
- Production routes now rely on the real session-manager interface; test fakes
  implement that interface instead of shaping production branches.
- Removed the stray server source BOM, consolidated duplicate agent guidance,
  and replaced scattered root release notes with this changelog.

## QuickTerm 2.3.0

## Session controls that actually stay visible

- Fixed the dashboard confirmation bug that hid **Kill** and **Kill all** before
  measuring their position, which could place the confirmation outside the
  visible window and make the action appear broken.
- Destructive controls now remain visible and disabled while their confirmation
  is open, and the confirmation is clamped above or below the trigger inside the
  viewport.
- Kill All reports verified per-session successes and failures. Only confirmed
  kills are removed; failures remain visible and retryable.
- Successful kills remove stale session ownership and pane references from saved
  workspaces. Exited or stale session cards cannot be attached again.
- A real WSL PTY kill and registry-removal smoke test passes.

## Better background-agent awareness

- Detached terminals now show when new output arrived, how much arrived, and how
  long ago it appeared.
- Reattaching acknowledges that output, providing a lightweight working/waiting
  signal without guessing from terminal contents.

## Expanded dark theme catalog

- Added Catppuccin Frappé, Rosé Pine Moon, Tokyo Night Storm, GitHub Dark
  Dimmed, and Oxocarbon.
- The 27-theme catalog now separates Neon palettes while preserving custom
  themes, live preview, cancel-to-revert, and fallback behavior.

## Additional hardening

- Configuration validation now rejects malformed runtime-facing field types
  before they can break profile launch or accidentally enable autostart.
- Ctrl-click accepts HTTP and HTTPS schemes case-insensitively.
- Public contracts and agent guidance document the verified kill semantics.

## Validation

- 231 automated tests pass.
- Ruff, Python compilation, JavaScript syntax checks, diff checks, real WSL
  termination, PyInstaller packaging, and isolated packaged smoke tests pass.

## QuickTerm 2.2.0

## Familiar Windows shortcuts

- `Ctrl+C` copies selected terminal text and remains the terminal interrupt
  when nothing is selected.
- `Ctrl+V` uses the native WebView2/xterm paste path. The existing
  `Ctrl+Shift+C` and `Ctrl+Shift+V` gestures remain available as aliases.
- `Ctrl+Plus`, `Ctrl+Minus`, and `Ctrl+0` now control terminal text size,
  including German and other non-US keyboard-layout fallbacks.
- Plain `Alt+V` remains untouched for Claude Code image paste.

## Reliable session cleanup

- Background-session kills are now verified instead of trusting that
  `taskkill` succeeded. Windows uses a direct process-termination fallback
  when necessary.
- Kill, Kill All, scratch cleanup, and workspace deletion now report failures
  instead of hiding a process that is still running.
- Session state changes and removal timers are marshalled safely onto the
  owning asyncio loop, so killed sessions disappear promptly and consistently.

## Hardening and correctness

- Live terminal WebSocket frames remain within their documented 128 KiB cap,
  preserving input responsiveness during heavy output.
- JSON requests and image uploads are size-bounded before buffering; malformed
  JSON now produces a client error instead of an internal server error.
- Corrupt local authentication tokens are repaired automatically, and OSC 52
  clipboard writes from terminal output are capped at 1 MiB.
- Workspace filenames no longer collide after Windows-safe normalization, and
  malformed workspace files cannot break the workspace list.
- Windows process APIs now use explicit 64-bit-safe handle signatures.

## Validation

- 215 automated tests pass.
- Ruff, Python compilation, JavaScript syntax checks, the PyInstaller build,
  and packaged health/opener/update smoke tests pass.

## QuickTerm 2.1.0

## SSH and SFTP terminals, powered by bundled PuTTY

- **New terminal types: SSH and SFTP.** Create a profile in Settings →
  Terminals with a host, optional port, username and PuTTY `.ppk` private
  key. Sessions run through the bundled PuTTY `plink`/`psftp` — no separate
  install needed. Passphrases and passwords are never stored; you are
  prompted inside the terminal.
- **`pscp`, `plink` and `psftp` work in every terminal.** The bundled tools
  folder is appended to each session's `PATH`, so one-off transfers are as
  simple as `pscp file.txt user@host:/tmp/`. A tool you installed yourself
  still takes precedence.
- **SSH remote command.** An SSH profile can run a single remote command
  instead of opening a shell.
- The PuTTY binaries (release 0.84) are pinned and SHA-256-verified against
  the official published checksums at build time. Licences ship in
  `THIRD-PARTY-NOTICES.md`.

## Fixes and details

- Settings: picking Git Bash or Nushell as a profile's type now fills in the
  detected executable path automatically.
- The launcher lists SSH/SFTP under personal profiles only; system entries
  stay limited to shells that work without configuration.

## QuickTerm 2.0.3

This security release hardens terminal profile environment variables from
storage through process launch without changing normal profile behavior.

## Environment security

- Encrypts profile environment values at rest with Windows current-user DPAPI
  and automatically migrates existing plaintext values.
- Protects administrator-terminal launch specifications with DPAPI instead of
  placing recoverable Base64 JSON in the process command line.
- Rejects malformed names, NUL characters, case-insensitive duplicates, and
  oversized environment payloads consistently across config, API, UAC, and PTY
  entry points.
- Caps configuration/session JSON requests before buffering and prevents
  sensitive API responses from being cached.

## Local secret handling

- Creates the local auth token atomically and enforces user-only token/config
  permissions on POSIX fallback systems.
- Enables raw terminal I/O logging only for the exact value
  `QUICKTERM_DEBUG_IO=1`; values such as `0` no longer activate it accidentally.
- Warns in the log whenever raw input tracing is enabled and documents that
  child processes inherit profile variables.

## Compatibility

- Keeps the public in-memory and API environment shape as `dict[str, str]`.
- Continues accepting legacy plaintext config values and rewrites them securely
  after a successful load.

Validated with 184 tests, Ruff, frontend syntax checks, Windows DPAPI
round-trips, and a packaged application smoke test covering encrypted config,
real ConPTY environment delivery, authentication, and dynamic routes.

## QuickTerm 2.0.2

This release adds visible resource usage and safer session controls while keeping QuickTerm's security claims precise and auditable.

## Usage and limits

- Added live per-terminal RAM, CPU, process-count, and uptime reporting, plus aggregate RAM in the dashboard.
- Usage is measured locally from each terminal's process tree. No metrics are uploaded or persisted.
- Added a configurable live-session limit. Once reached, QuickTerm refuses new sessions with a clear in-app message while existing sessions continue normally.
- Reports WSL measurements as partial instead of implying host-and-guest accounting is exact.

## Session termination

- Added `Alt+Shift+W` to terminate the focused terminal's process tree and close its pane.
- Added a Kill all action for terminating every live session.
- Destructive actions use keyboard-accessible in-app confirmations next to the relevant control; Enter confirms and Escape cancels.
- Removed browser-native confirmation dialogs from QuickTerm-owned flows, including terminal link handling.

## UI and documentation

- Fixed the launcher controls clipping their borders in narrow windows and kept the New terminal label readable.
- Added an honest company-use security guide covering the local-only architecture, authentication boundaries, operational limitations, usage-measurement scope, deployment checklist, and Windows code-signing options.
- Documented the new API fields, session-limit response, and kill-all endpoint.

Validated with 167 tests, Ruff, frontend syntax checks, live browser interaction at desktop and 442 px widths, Windows process-tree metric probes, and packaged application/API smoke tests.

## QuickTerm 2.0.1

This is a broad developer-experience, reliability, and packaging pass over 2.0.

## Faster and smaller in real use

- Replaced the self-extracting one-file runtime with a normal per-user app-folder install. The installer is 17.23 MB, the portable ZIP is 20.15 MB, and the 45.1 MB runtime is shared by every window instead of extracting about 37.7 MB per process.
- Health-ready startup averaged 1.60 s in local tests, down from 2.73 s for the old one-file build.
- Desktop and Start Menu shortcuts point at the installed launcher; no administrator access is required.

## Terminal usability

- Added a compact View drawer with pane-first text sizing, explicit minus/plus/reset buttons, selected/all scope, width/height controls, split balancing, focus mode, and a Settings shortcut.
- Fixed the decrease-font shortcut across WebView2 and international/numpad keyboard reports.
- Made splitters wider and visible, pointer-friendly, arrow-key adjustable, and double-clickable to balance.
- Restored a clearly visible themed scrollbar in every terminal with scrollback.
- WSL profiles with no folder now start in Linux `~`; Windows shells start in the Windows user home. WSL profile folders and startup commands now resolve together correctly.
- Session counts now distinguish open terminals from background sessions instead of presenting every backend process as a visible terminal.

## Reliability and safety

- Added paced, acknowledged scrollback replay and stale-reconnect guards.
- Bounded PTY input queues on Windows and POSIX so blocked shells cannot stall or grow memory indefinitely.
- Preserved autostart sessions and made autostart/global-hotkey launches use the same profile resolver as normal launches.
- Added visible workspace-save state with retry and stopped optimistic UI deletion when backend operations fail.
- Hardened config/workspace recovery, spawn and resize validation, passive-file opening, and update download URL/size/version/checksum verification.
- Added categorized themes with live app-wide preview, stronger derived contrast, and a four-theme featured catalog.
- MCP remains completely removed.

Validated with 162 tests, Ruff, frontend syntax checks, live browser/xterm interaction, WSL path probes, packaged ConPTY/API smoke tests, and installer/portable builds.

## QuickTerm 2.0.0

QuickTerm 2.0 is a focused developer-workspace release.

Highlights:

- Reworked the interface into a compact, neutral workbench with flatter controls, denser panes, clearer focus and exit states, keyboard-operable splitters, stronger contrast, improved screen-reader semantics, and a four-theme featured picker with the remaining designs in a catalog.
- Added easier directional split shortcuts: `Alt+Shift+Right` and `Alt+Shift+Down`. Existing `Alt+Shift+H/V` shortcuts remain available.
- Hardened long-running sessions: touched or busy terminals are never idle-reaped, slow viewers resync instead of losing terminal control bytes, reconnect replay has no output race, resize geometry stays current, and stale workspace session references are pruned.
- Improved responsiveness through bounded WebSocket queues, capped frames, disabled terminal compression, byte-accurate PTY batching, frontend write backpressure, and duplicate-spawn protection.
- Made destructive session/workspace actions confirm intent, paused dashboard refresh while editing, fixed default-profile launching and the zero idle-timeout setting, and made JSON saves atomic.
- Removed MCP completely: bridge executable, server module, REST surfaces, discovery environment variables, configuration, UI, documentation, tests, and packaging hooks are gone.

This is a breaking major release for anyone who used `quickterm-mcp` or the removed terminal-control REST endpoints.
