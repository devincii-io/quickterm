# QuickTerm 2.2.0

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
