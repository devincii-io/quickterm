# QuickTerm 2.0.1

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
