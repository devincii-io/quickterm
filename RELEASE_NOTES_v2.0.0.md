QuickTerm 2.0 is a focused developer-workspace release.

Highlights:

- Reworked the interface into a compact, neutral workbench with flatter controls, denser panes, clearer focus and exit states, keyboard-operable splitters, stronger contrast, improved screen-reader semantics, and a four-theme featured picker with the remaining designs in a catalog.
- Added easier directional split shortcuts: `Alt+Shift+Right` and `Alt+Shift+Down`. Existing `Alt+Shift+H/V` shortcuts remain available.
- Hardened long-running sessions: touched or busy terminals are never idle-reaped, slow viewers resync instead of losing terminal control bytes, reconnect replay has no output race, resize geometry stays current, and stale workspace session references are pruned.
- Improved responsiveness through bounded WebSocket queues, capped frames, disabled terminal compression, byte-accurate PTY batching, frontend write backpressure, and duplicate-spawn protection.
- Made destructive session/workspace actions confirm intent, paused dashboard refresh while editing, fixed default-profile launching and the zero idle-timeout setting, and made JSON saves atomic.
- Removed MCP completely: bridge executable, server module, REST surfaces, discovery environment variables, configuration, UI, documentation, tests, and packaging hooks are gone.

This is a breaking major release for anyone who used `quickterm-mcp` or the removed terminal-control REST endpoints.
