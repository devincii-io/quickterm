# QuickTerm 2.0.2

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
