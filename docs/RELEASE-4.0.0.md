# QuickTerm 4.0.0 release verification

Date: 2026-10-04. Platform: Windows 11, Python 3.12.13, Node 24.18.0.

## Source review

The change against 3.13.0 (95392b3) was built in six streams from a frozen
spec: the shell with equal workspace views, the flat sidebar with row kill,
the Settings rework with key capture and search, the agent and SSH backend,
the window size memory with the drop-down overlay and live hotkeys, and the
launch and palette frontend. After the merge, five reviews (backend
security, shell and sidebar, settings and palette, a UI check, and
conventions, docs and tests) reported 36 findings, 11 major and 25 minor.
35 were fixed with tests; one, the second Save button in the terminal editor,
is intended and was kept. Follow-up commits closed the kill-all and scratch
resume gaps, restored remembered bounds on screen, fixed the overlay over a
maximized window, kept `config.json` readable for 3.x after a 4.0 shortcut
capture, and stopped retaining idle untouched shells when a scratch view
closes. A second review of the release commit found three more: text on
`--surface-soft` (hovered controls, the selected palette row) and the accent
on its own tint fell under 4.5:1 in most themes, the kill-all comment and
contract said open workspaces were not edited on disk when they are, and the
native smoke below had run before the review fixes. The contrast is now
derived and tested for both surfaces, the docs describe the code, and the
smoke ran again on the final tree. No release-blocking source findings
remain.

Limitations that stay: workspace layout ownership is still advisory for
authenticated API clients, and Settings conflict detection is a client-side
fresh read, as in 3.13. The recent conversation lists read files that Claude
Code and Codex keep for themselves; a format change in a CLI update empties
the list and leaves the CLI's own picker as the fallback.

## Checks

- Full manual gate (`scripts/check.py` from PowerShell with the venv
  PYTHONPATH and the direct 3.12.13 interpreter): exit 0, "Manual CI
  passed." pytest 1254 passed, 18 skipped in 83.40 s (separate full runs:
  81.0 s, and 97 s while the machine was busy). Ruff clean. `node --test`
  397/397 pass, `node --check` clean on every JS file, `git diff --check`
  clean. The node MODULE_TYPELESS warnings come from an untracked
  `package.json` in the working copy, which was left alone.
- Native workspace smoke (`scripts/smoke_workspace_views.py`, run the same
  way, with TEMP and TMP pointing at a scratch folder so its isolated APPDATA
  lived there, a free port and no summon key): exit 0, all 48 checks passed,
  plus "Native close-to-tray with retained terminals passed", in 36.8 s. This
  run is on the final tree, after every review fix; the first run (46.6 s)
  was on the integration tree before them.
- PyInstaller built `dist/QuickTerm` from `quickterm.spec` with the bundled
  PuTTY tools present. That build and the frozen checks below predate the
  second review's fixes (frontend colours, comments and docs), so the
  published artifacts must be rebuilt from the final commit.
- Frozen v4.0.0 smoke (`scripts/smoke_packaged.py`, isolated APPDATA under a
  scratch folder): passed. It verified authenticated PTY creation, replay,
  live output and exit, the dynamically loaded open, update and connection
  routes, workspace metadata edits and a settings history restore. The
  application folder is 42.80 MB.
- The frozen build was also started on port 8681 with a fresh APPDATA and no
  summon key. `/api/health` reported 4.0.0. `GET /api/system/agents`
  answered 200 with Claude Code (12 options) and Codex (13 options),
  `GET /api/system/ssh-hosts` answered 200 with the three aliases of this
  machine's `~/.ssh/config` and the System32 OpenSSH client,
  `GET /api/system/terminals` and `GET /api/agent-sessions` answered 200,
  `GET /api/system/ssh-hosts/-bad` 400, `POST /api/open {"target":"ftp://x"}`
  400 (not 500) and `GET /api/update` 200. Without the token
  `/api/system/ssh-hosts` answered 403. That proves the new importlib modules
  `agents`, `agent_sessions` and `ssh_config` are in the frozen build. The
  process was stopped by its PID afterwards.
- The full gate ran again on the release tree (version 4.0.0, changelog,
  README and these notes): exit 0, "Manual CI passed.", pytest 1254 passed,
  18 skipped in 81.23 s, ruff clean, `node --test` 397/397 pass. After the
  second review's fixes it ran once more: exit 0, pytest 1254 passed, 18
  skipped in 74.65 s, ruff clean, `node --test` 397/397 pass.
- No leftover processes. Nothing was pushed or tagged. The installer,
  portable ZIP, Python distributions and SHA256SUMS were not built for this
  verification; that is the release step.

## Rollback

Before installing, exit QuickTerm deliberately after finishing or recording
running work. Updating or rolling back cannot preserve live PTYs across
backend shutdown. Copy the complete `%APPDATA%\quickterm` directory to a
dated backup under the same Windows account, including workspace files,
assets, settings history and the new `window_state.json`. DPAPI-protected
values cannot be moved to another account.

To roll back, exit 4.0.0 and reinstall the 3.13.0 Setup asset from its GitHub
release after checking its SHA256SUMS manifest. Restore the complete
pre-update backup rather than combining directories. If you keep the 4.0
configuration instead, 3.13 still reads it: Claude Code profiles keep their
mode because 4.0 also writes `claude_mode`, and a shortcut 3.x cannot parse
is stored in a 4.0-only field, so 3.13 loses that one shortcut rather than
resetting the configuration. 3.13 does not know Codex profiles, the OpenSSH
client choice, ProxyJump, the window settings or the overlay. Start 3.13.0
and verify its workspace list and configured terminals.

No rollback or installation was performed against the user's running copy.

## Unverified

- No real Claude Code, Codex or ssh process was started by these checks and
  no SSH host was connected. Agent and OpenSSH argument lists, the
  `~/.ssh/config` parser, `ssh -G` parsing and the session stores are
  covered by tests on sample data.
- The overlay's Win32 path (frame stripping, topmost placement, the slide
  and hide on focus loss) is covered by tests with stubbed ctypes. The
  packaged build was checked through its HTTP API, not by summoning it.
- Remote hosts, container engines, serial hardware and RDP/VNC servers were
  not connected, as in 3.13.
- Release binaries are unsigned. SmartScreen may warn; SHA-256 manifests
  detect corruption but are not a publisher signature.
- Native UI was checked on this Windows desktop, not other Windows versions,
  high-DPI multi-monitor configurations or Linux desktops.
