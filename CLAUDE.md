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
per-subscriber fan-out queues (drop-oldest per slow subscriber). →
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
- UI keyboard layer is **Alt-only** (Alt+P palette, Alt+H/V split, Alt+Z zoom,
  Alt+W close, Alt+arrows focus, Alt+±/0 font). Never claim Ctrl+key combos a
  shell uses; copy/paste stays Ctrl+Shift+C/V inside the terminal.
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
- Verify any packaged build by launching `dist/QuickTerm.exe --port 8641`,
  then: `/api/health` answers and `/api/sessions` (header `X-QuickTerm-Token`
  from `%APPDATA%/quickterm/runtime.token`) shows `alive: true`.
- Frontend is served with `Cache-Control: no-cache` — required, WebView2
  otherwise serves stale JS/CSS after updates.

## Release workflow

Version lives in THREE places that must agree: `quickterm/__init__.py`,
`pyproject.toml`, and (derived) `uv.lock` — bump the first two, then
`uv lock`. The tag must be exactly `v<__version__>`; the Release workflow
(`.github/workflows/release.yml`) checks this, then builds EXE + Inno Setup
installer + portable zip + sdist/wheel + SHA256SUMS and publishes the release
with generated notes.

**If GitHub Actions is unavailable** (the account hit a billing lock in
2026-07 — check `gh run list` after pushing a tag), replicate the workflow
locally; artifact names must match exactly, README/installer links depend on
them:

```
uv run --no-sync pyinstaller --noconfirm --clean quickterm.spec
& "$env:LOCALAPPDATA\Inno Setup 6\ISCC.exe" /Q /DAppVersion=<ver> packaging\quickterm.iss
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
