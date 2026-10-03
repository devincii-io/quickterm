# QuickTerm 3.13.0 release verification

Date: 2026-10-03. Platform: Windows 11, Python 3.12.13, Node 24.18.0.

## Source review

Reviewed the complete change against 3.12.0: shared window chrome, embedded
focus ownership, independent scratch identities, configured launch choices,
typed connection validation, desktop-client separation, settings propagation,
and workspace metadata writes. No release-blocking source findings remain.

The authenticated API still treats workspace layout ownership as advisory.
Metadata PATCH serializes edits and preserves the latest layout; arbitrary
authenticated clients can still submit stale layouts through PUT. Settings
conflict detection is a client-side fresh read, not a server-side revision
transaction. Simultaneous writes from independent clients remain a limitation.
Browser unload delivery is best-effort; explicit view close awaits its save.

The failing descendant-kill regression was a fixture problem. Windows Python
virtual-environment redirectors own a kill-on-close job. Terminating the
redirector also terminated the interpreter the test intended to preserve.
The fixture now launches the detached base interpreter directly, waits for
its PID, and retains all survivor and retry assertions. Production kill code
is unchanged. See issue #68.

## Checks

- Full manual gate: 890 Python tests passed, 18 platform skips, no exclusions;
  221 JavaScript tests passed. Ruff, byte compilation, module syntax and
  whitespace checks passed.
- Locked runtime dependencies were exported and audited with pip-audit.
  No known vulnerability advisories were reported.
- Native workspace smoke passed all 40 checks with real PTYs, view splits,
  zoom, focus, drag, dividers, failed-save retention, close/reopen, final save
  ordering and close-to-tray. User installation and terminals were untouched.
- Frozen v3.13.0 smoke verified authenticated PTY creation, WebSocket replay,
  live output and exit; dynamically loaded opener, update and connection
  routes; desktop rejection as a PTY; and metadata edits preserving layout
  and session ownership. The application folder is about 44.83 MiB.
- Backup restore was executed through the frozen application's settings
  history API. After a saved connection change, restoring the previous
  entry recovered the exact original full configuration. The smoke used
  disposable APPDATA, not user data.
- Inno Setup built the per-user installer. Portable ZIP integrity and required
  ConPTY, PuTTY and frontend files were checked; the wheel contains the new
  connection module and setup UI. The artifact gate checks the version trio,
  exact release filenames and SHA-256 manifest.
- Desktop/mobile browser checks covered one shared sidebar, unique scratch
  views, setup validation, cross-window committed themes and workspace-folder
  edits without replacing live PTYs.

## Rollback

Before installing, exit QuickTerm deliberately after finishing or recording
running work. Updating or rolling back cannot preserve live PTYs across
backend shutdown. Copy the complete `%APPDATA%\quickterm` directory to a
dated backup under the same Windows account. Include workspace files, assets
and settings history; DPAPI-protected values cannot be moved to another account.

To roll back, exit 3.13.0 and reinstall the 3.12.0 Setup asset from its GitHub
release after checking its SHA256SUMS manifest. Preserve the upgraded config
directory separately, then restore the complete pre-update backup rather
than combining directories. Older builds do not understand the new connection
types. Start 3.12.0 and verify its workspace list and configured terminals.

No rollback or installation was performed against the user's running copy.

## Unverified

- Real SSH/SFTP/Telnet hosts, container engines, serial hardware and RDP/VNC
  servers were not connected. Argument construction and validation were tested.
- Release binaries are unsigned. SmartScreen may warn; SHA-256 manifests
  detect corruption but are not a publisher signature.
- Native UI was checked on this Windows desktop, not other Windows versions,
  high-DPI multi-monitor configurations or Linux desktops.
