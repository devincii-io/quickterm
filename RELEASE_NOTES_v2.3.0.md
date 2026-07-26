# QuickTerm 2.3.0

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
