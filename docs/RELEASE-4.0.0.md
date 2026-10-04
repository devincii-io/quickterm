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
smoke ran again on the final tree.

The theme rework landed last: 20 upstream palettes in place of the old set,
every stylesheet colour moved onto a theme token, and a contract test that
fails on a colour literal outside `:root`. Merging it with the contrast work
showed that three light themes (Tokyo Night Day, Kanagawa Lotus, Everforest
Light) keep their ink too soft for the accent on its tint; the accent text
now falls back toward black there. A review of the merge found four more:
these notes still listed the live agent and overlay runs as unverified, the
workspace view title used a view colour held only to 3:1, a comment in
`viewer.css` described values it does not carry, and nothing tested that the
native window's first paint equals `--bg`. All four are fixed. No
release-blocking source findings remain.

Limitations that stay: workspace layout ownership is still advisory for
authenticated API clients, and Settings conflict detection is a client-side
fresh read, as in 3.13. The recent conversation lists read files that Claude
Code and Codex keep for themselves; a format change in a CLI update empties
the list and leaves the CLI's own picker as the fallback.

## Checks

- Full manual gate (`scripts/check.py` from PowerShell with the venv
  PYTHONPATH and the direct 3.12.13 interpreter) on the final tree: exit 0,
  "Manual CI passed." pytest 1259 passed, 18 skipped in 32.05 s. Ruff clean.
  `node --test` 464/464 pass, `node --check` clean on every JS file,
  `git diff --check` clean. Earlier runs of the same gate on busier
  machines took 74 to 97 s.
- Native workspace smoke (`scripts/smoke_workspace_views.py`, TEMP and TMP
  pointing at a scratch folder so its isolated APPDATA lived there, a free
  port and no summon key): exit 0 on the tree with the themes merged. Every
  listed check passed, from "the shell hosts no workspace of its own" to
  "Native close-to-tray with retained terminals passed".
- Live UI run against an isolated backend (port 8641, its own APPDATA, no
  summon key) in a browser: the shell boots one scratch view and no main
  workspace; two workspaces open from the sidebar and tile; the sidebar order
  stays fixed while terminals change state; a row is killed by pointer
  (Cancel focused) and by keyboard (Kill focused, Enter); a click inside a
  view closes an open kill box; a reload restores the arrangement without
  leaking registry entries. Settings search, the Terminals list, the Codex
  and Claude Code option menus, shortcut capture and the palette prefixes
  were exercised. Open on a saved Codex profile started the vendored
  `codex.exe` with `--cd <workspace>`, and Open on a Claude Code profile
  started `claude` in the workspace folder. Both first screens were read,
  then both terminals were killed from the sidebar by keyboard and their
  processes were gone. `GET /api/system/ssh-hosts` returned the three hosts
  of this machine's `~/.ssh/config`; one resolved through `ssh -G`.
- Native window and overlay run from the source build on the real desktop
  (one 1920x1080 monitor, its own APPDATA, summon key Ctrl+Alt+F12 so the
  user's key stayed untouched): the window opened at the configured
  1280x800; the summon key showed the overlay at exactly the top half of the
  work area, without a frame and on top, sliding in over about 120 ms; a
  second press hid it; starting Notepad hid it on focus loss; turning the
  overlay off restored the frame, the original bounds and normal stacking.
  A changed summon key worked at once after saving, a key held by another
  program was reported in `hotkey_error`, and the remembered bounds were
  written about 0.5 s after a move and restored on the next start.
- Cold start, 3.13.0 against 4.0 on isolated headless backends, 5 measured
  runs each with the cache cleared: page load to the first cmd prompt,
  median 4578 ms against 4577 ms; to the terminal WebSocket opening, median
  1591 ms against 1796 ms (+13 %, inside the 25 % budget).
- PyInstaller built `dist/QuickTerm` from `quickterm.spec` with the bundled
  PuTTY tools present. Frozen v4.0.0 smoke (`scripts/smoke_packaged.py`,
  isolated APPDATA): passed with authenticated PTY creation, replay, live
  output and exit, and the dynamically loaded routes. The application
  folder is 42.80 MB. The release artifacts are rebuilt from the tagged
  commit and pass `scripts/check.py --artifacts` and both smokes again.
- The frozen build was also started on port 8681 with a fresh APPDATA and no
  summon key. `/api/health` reported 4.0.0. `GET /api/system/agents`
  answered 200 with Claude Code (12 options) and Codex (13 options),
  `GET /api/system/ssh-hosts` answered 200 with the three aliases and the
  System32 OpenSSH client, `GET /api/system/terminals` and
  `GET /api/agent-sessions` answered 200, `GET /api/system/ssh-hosts/-bad`
  400, `POST /api/open {"target":"ftp://x"}` 400 (not 500) and
  `GET /api/update` 200. Without the token `/api/system/ssh-hosts` answered
  403. The new importlib modules `agents`, `agent_sessions` and `ssh_config`
  are in the frozen build.
- No leftover processes. All of the above used scratch APPDATA folders; the
  user's running QuickTerm and its configuration were not touched.

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

- No SSH, SFTP or Telnet session was opened to a real host. Aliases were
  read and resolved, and the argument lists are covered by tests.
- No prompt was sent to Claude Code or Codex; their first screens were the
  check. The recent conversation lists were checked against this machine's
  session stores and sample data.
- The overlay was driven on one monitor from the source build. The packaged
  build was checked through its HTTP API, not by summoning it. Several
  monitors and high-DPI scaling were not tested.
- Remote hosts, container engines, serial hardware and RDP/VNC servers were
  not connected, as in 3.13.
- Release binaries are unsigned. SmartScreen may warn; SHA-256 manifests
  detect corruption but are not a publisher signature.
- Native UI was checked on this Windows desktop, not other Windows versions,
  high-DPI multi-monitor configurations or Linux desktops.
