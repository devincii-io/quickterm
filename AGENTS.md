# QuickTerm — agent guide

Local terminal workspace for Windows (ConPTY) with a POSIX fallback: FastAPI
backend owns all PTYs, views attach over a binary WebSocket, frontend is plain
ES modules + vendored xterm.js (no Node build). One backend process per port;
windows are just viewers.

## Commands

Everything runs through uv. In agent shells the PATH may miss it — use the full
path `~/.local/bin/uv.exe`. Never run `uv sync/add/lock` to "fix" the test env
(it is pre-synced); `uv lock` is only legitimate after editing `pyproject.toml`.

```
uv run quickterm                  # run the app (native window; --port N to override)
uv run --no-sync pytest -q        # tests (~30 s, Windows + Linux parametrized)
uv run --no-sync ruff check quickterm tests scripts
uv run --no-sync pyinstaller --noconfirm --clean quickterm.spec   # dist/QuickTerm.exe
python scripts/bench_throughput.py 20                             # output throughput
```

## Architecture (hot path)

`pty_session.py` (win32; `pty_posix.py` elsewhere) — one ConPTY, three daemon
threads: reader (coalesces all immediately-available output into one callback,
≤128 KB), watcher (waits on the real process handle; winpty EOF lags ~8 s),
writer (queue-drained; PTY writes must NEVER run on the event loop — a full
stdin pipe blocks). → `session_manager.py` — registry, scrollback ring as a
deque of chunks (O(chunk) trim; do not go back to a flat bytearray), bounded
per-subscriber fan-out queues (overflow triggers a clean replay/resync). →
`server.py` — REST + WS attach (`replay_size` → scrollback frame →
`replay_done` → live); the output pump coalesces queued chunks into one WS
frame (≤128 KB cap keeps input interleaved). → `frontend/js/pane.js` — one
xterm.js + one WS per pane; write-callback backpressure; input only forwarded
in phase "live".

`docs/CONTRACTS.md` is the binding surface spec — update it when changing any
public surface. `app.py` boots backend + pywebview window; close-to-tray
(`tray.py`, ctypes) only when a live session has `touched=True`, else quit.
`update.py` probes the pinned GitHub repo's latest release; install downloads
the Setup asset, verifies it against SHA256SUMS.txt, and launches it.

## Conventions

- Backend I/O is bytes in / bytes out; no decoding on the hot path. Input
  decode for winpty is strict-UTF-8 with surrogateescape fallback — never
  `errors="replace"` (mangles 8-bit input).
- UI keyboard layer claims only **cold** Alt combos (`keys.js`): Alt+K palette,
  Alt+Z zoom, Alt+W close, Alt+arrows focus on plain Alt; Alt+Shift+Right/Down
  (or H/V) split and
  Alt+Shift+±/0 font on the Alt+Shift namespace. Plain Alt+V/P/H/0-9/- MUST pass
  through to the shell (Codex image paste & model switch, PSReadLine/readline
  bindings) — never re-claim them. Copy/paste stays Ctrl+Shift+C/V; the paste
  handler must NOT preventDefault (WebView2 denies `clipboard.readText` silently —
  let the native paste event reach xterm's textarea).
- Server handlers import stubbable modules via
  `importlib.import_module("quickterm.X")` — a plain `import` bypasses test
  `sys.modules` stubs and writes to the real `%APPDATA%`.
- Session activity tracking uses `touched` (set on user input via `onKey`, not
  `onData` — xterm auto-replies to DA/DSR must not count).
- `QUICKTERM_DEBUG_IO=1` logs raw bytes both directions (key-level debugging).
- Tests: pytest asyncio_mode=auto; real short-lived PTYs (`cmd.exe /c echo hi`
  style); server tests use TestClient + fakes. Keep the suite < 40 s.

## Packaging gotchas (learned the hard way)

- PyInstaller does NOT bundle pywinpty's runtime EXEs. `quickterm.spec` must
  ship `OpenConsole.exe`, `winpty-agent.exe`, `conpty.dll`, `winpty.dll` (dest
  "winpty") and keep `upx=False` (UPX corrupts them + the WebView2 loader).
  Symptom when broken: every terminal spawns then dies instantly with exit
  0xC000013A / 3221225786.
- Any module reached ONLY via `importlib.import_module("quickterm.X")` (server
  stubbable modules: `opener`, `update`, plus `workspace`/`config` which happen
  to also be static-imported) is invisible to PyInstaller's static graph and
  MUST be listed in `hiddenimports` in `quickterm.spec`, or the frozen build
  500s that endpoint with `ModuleNotFoundError`. When you add a new
  importlib-loaded route module, add it to the spec.
- Verify any packaged build by launching `dist/QuickTerm.exe --port 8641`,
  then: `/api/health` answers and `/api/sessions` (header `X-QuickTerm-Token`
  from `%APPDATA%/quickterm/runtime.token`) shows `alive: true`. Smoke-test the
  importlib routes too: `POST /api/open {"target":"ftp://x"}` -> 400 (not 500)
  proves `opener` is bundled; `GET /api/update` answers (not 500) proves
  `update` is. Use a FREE port — never the user's live 8642/8620.
- Frontend is served with `Cache-Control: no-cache` — required, WebView2
  otherwise serves stale JS/CSS after updates.

## Local release workflow

Version lives in THREE places that must agree: `quickterm/__init__.py`,
`pyproject.toml`, and (derived) `uv.lock` — bump the first two, then
`uv lock`. The tag must be exactly `v<__version__>`. Build releases locally;
artifact names must match exactly because README and installer links depend on
them:

```
uv run --no-sync pyinstaller --noconfirm --clean quickterm.spec
& "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" /Q /DAppVersion=<ver> packaging\quickterm.iss
Compress-Archive -Force -Path dist/QuickTerm.exe,README.md,LICENSE -DestinationPath QuickTerm-v<ver>-windows-x64.zip
uv build --no-sources
# SHA256SUMS.txt over: zip, dist/QuickTerm-v<ver>-Setup.exe, dist/*.whl, dist/*.tar.gz
gh release create v<ver> <assets...> --verify-tag --title "QuickTerm v<ver>" --notes-file <notes>
```

(Local ISCC is the user-scope install under `%LOCALAPPDATA%\Programs\Inno
Setup 6\ISCC.exe`.) Git pushes go over HTTPS with the gh credential helper
(`gh auth setup-git`); the SSH remote has no known_hosts entry.

The in-app updater (`update.py` + Settings → About) requires every release to
keep shipping `QuickTerm-v*-Setup.exe` and `SHA256SUMS.txt` under those names.

## Security model

Server binds 127.0.0.1. Three-layer guard in `server.py`: Host allowlist
(DNS rebinding), Origin allowlist (cross-origin/WS), and a per-install token
(`auth.py`) — delivered via URL fragment `#t=`, sent as `X-QuickTerm-Token` on
/api and as WS subprotocol `qtauth.<token>`. Exempt: `/api/health`,
`GET /api/assets/*`, static files. The Host/Origin guard alone does NOT stop
native local programs — the token does. Keep new /api routes token-gated by
default. `update.py` only fetches https URLs from the pinned repo's release
payload and hash-verifies installers.

## Author / license

MIT. Author and installer publisher: **Devin Isaac Worbis** (pyproject,
LICENSE, packaging/quickterm.iss must stay consistent).
