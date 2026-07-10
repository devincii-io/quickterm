# QuickTerm — Project Plan

A native-feeling terminal host for Windows: real ConPTY terminals, split-pane window manager, persistent sessions, quick-launch profiles (e.g. Claude Code, Codex), and local push-to-talk voice input (German/English). Everything local, no cloud services.

## Goals

- Real terminals via Windows ConPTY — full VT support, interactive TUIs work (claude, codex, vim)
- Split-screen window manager: recursive horizontal/vertical splits, resize, zoom, keyboard-driven
- Sessions survive UI disconnects: PTYs live in the backend process, reattach with scrollback replay
- Quick terminals: instantly spawn preconfigured profiles (command + cwd + env) via hotkey, launcher strip, or command palette
- Workspaces: named layouts (splits + profiles + cwds) persisted to disk, restored on demand
- Voice input: push-to-talk hotkey → local Whisper transcription (DE/EN auto-detect) → text into focused pane
- A visual identity that does not look like an AI-generated product

## Non-Goals (v1)

- No remote/SSH multiplexing
- No Linux/macOS support (Windows-only, ConPTY)
- No LLM cleanup pass on voice transcripts (raw transcript is fine)
- No bundled speech models — downloaded on first use (bring-your-own-model)
- No Electron, no node build pipeline

## Tooling: uv only

The project is managed exclusively with uv. No pip, no requirements.txt, no manual venvs.

- `pyproject.toml` is the single source of truth; `uv.lock` is committed
- `requires-python = ">=3.12"`
- Entry point via `[project.scripts]`: `quickterm = "quickterm.app:main"` → run with `uv run quickterm`
- Voice is an optional extra so the base install stays tiny:
  `[project.optional-dependencies] voice = ["faster-whisper", "sounddevice"]`
  → `uv sync --extra voice`; the app detects at runtime whether voice deps are present and degrades gracefully
- Dev tools in the dev group: `uv add --dev ruff pytest`
- Distribution later: installable as a tool (`uv tool install quickterm` / `uvx quickterm`)
- CI/agent workflow: `uv sync --all-extras --dev` then `uv run pytest`

Runtime dependencies (keep it at this, prefer stdlib for everything else):
`pywinpty`, `fastapi`, `uvicorn[standard]` — plus the optional voice extra. Frontend assets (xterm.js + addons) are vendored as static files, pinned versions, committed to the repo.

## Architecture

```
quickterm/
  app.py             # entry point: config load, server startup, browser launch
  config.py          # app config, profile definitions, paths (stdlib json/tomllib)
  pty_session.py     # one ConPTY: spawn, reader thread -> asyncio queue, write, resize, exit
  session_manager.py # session registry, lifecycle, scrollback ring buffer, process-tree kill
  workspace.py       # workspace + profile models, JSON persistence
  server.py          # FastAPI app: static files, REST (sessions/profiles/workspaces), WS attach
  hotkeys.py         # global Windows hotkeys via ctypes RegisterHotKey (no extra dep)
  voice/
    capture.py       # mic capture, push-to-talk
    transcribe.py    # faster-whisper wrapper, lazy model load, VAD
frontend/
  index.html
  js/                # pane manager, layout tree, ws client, palette, keybindings
  css/
  vendor/            # xterm.js, fit addon, webgl addon (pinned)
```

Key decisions:
- One backend process owns all PTYs. Browser tabs are dumb views that attach/detach via WebSocket.
- WS protocol: binary frames for raw PTY bytes (no base64/JSON wrapping), small JSON control messages (attach, spawn, resize, kill, focus)
- Scrollback: server-side ring buffer of raw bytes (default 512 KB/session), replayed on attach, then live
- Session state is in-memory; workspaces/profiles are what persist across restarts
- Voice runs in the backend; transcribed text goes through the normal session write path

## Windows/ConPTY Quirks — handle these explicitly

- **Blocking reads:** pywinpty reads block. One reader thread per session pushing into an asyncio queue; never block the event loop.
- **Resize order:** apply resize on the ConPTY *and* xterm.js together; debounce resize events (~50 ms) or fast drag-resizing floods the PTY and garbles TUIs.
- **Replay then resize:** on reattach, replay scrollback at the size it was recorded, then send current size — resizing first corrupts the replayed frames.
- **Process trees:** killing the PTY does not kill children (claude spawns node, shells spawn tools). Kill via Windows Job Objects or `taskkill /T /F` on the root PID.
- **UTF-8:** ConPTY speaks UTF-8. Decode nothing on the wire — bytes in, bytes out; only the frontend renders.
- **Flow control:** a runaway command (huge `type`/`cat`) floods the WS. Use xterm.js write callbacks for backpressure and pause the reader when the client lags.
- **Exit detection:** poll/wait on the process handle, not on EOF alone; surface exit code in the pane instead of a silently dead terminal.
- **Global hotkeys:** `RegisterHotKey` + message loop via ctypes in a dedicated thread — no `keyboard` package needed.
- **Chromeless feel:** launch the default browser with `--app=http://127.0.0.1:<port>` (Edge/Chrome) so it doesn't look like a website. Bind the server to 127.0.0.1 only.
- **Windows 10 1809+** required; check at startup and fail with a clear message.

## Quick Commands System

Three entry paths, one spawn mechanism underneath:

1. **Launcher strip** — profiles rendered as a row of labeled keys (see design); click spawns into the focused split or a new pane
2. **Command palette** — `Ctrl+P`: fuzzy search over profiles, actions (split, zoom, kill, workspace switch), and recent sessions
3. **Hotkeys** — per-profile global bindings (e.g. `Ctrl+Alt+1` → claude profile), plus one global summon/hide hotkey for the whole window (quake-style)

Profiles are plain config entries: `{name, cmd, args, cwd, env, keybinding, autostart}`. `autostart: true` profiles spawn with the workspace. Also support **snippets**: named text blocks the palette can paste into the focused pane (no execution, just types it).

## Design Direction — deliberately not AI-default

Avoid the recognizable AI-product looks: no cream-background-with-serif-and-terracotta, no pure-black-with-neon-green hacker glow, no purple/blue gradients, no glassmorphism, no glow effects, no rounded-2xl-everything, no emoji in UI chrome, no "✨ AI-powered" anything.

Direction: **instrument, not website.** QuickTerm should feel like well-built test equipment — quiet, dense, labeled, functional.

Tokens:
- **Palette:** background `#16181A` (cool graphite, not pure black); pane surface `#1E2124`; text `#D6D3C9` (warm paper-gray); accent `#E0A030` (amber — *only* for the focused pane rail and active states); muted secondary `#6E8898`; danger `#B4544B`. Nothing else.
- **Type:** UI chrome uses the *same monospace as the terminal* (default JetBrains Mono, user-configurable) at a small size with uppercase, letter-spaced labels — the UI speaks the same language as its content. No second typeface, no serif display font.
- **Layout:** 1px hairline borders, square corners (2px radius max), dense spacing, a single thin status bar. Focus shown by a 2px amber rail on the pane edge + slight dimming of inactive panes — no glowing borders.
- **Signature:** the launcher strip styled as a row of physical function keys — flat keycaps with the profile name, pressed state on click. This is the one memorable element; everything else stays quiet.
- **Motion:** essentially none. Instant state changes; at most a 80ms ease on the quake-summon. Respect `prefers-reduced-motion`.

## Milestones

1. **Scaffold + PTY core** — uv project, pyproject, entry point; spawn a shell via pywinpty, reader thread, write, resize, clean shutdown, process-tree kill. CLI smoke test, no UI.
2. **Single terminal in browser** — FastAPI serves frontend, one xterm.js pane over WS (binary protocol). Typing, colors, resize, an interactive TUI, and flow control must work.
3. **Session manager** — multiple named sessions, scrollback ring buffer, detach/reattach with correct replay-then-resize.
4. **Window manager** — layout tree with recursive splits, focus handling, pane resize, zoom, close; keyboard shortcuts.
5. **Quick commands** — profiles from config, launcher strip, command palette, global hotkeys, snippets, quake summon.
6. **Workspaces** — save/restore layout + profiles + cwds; autostart profiles.
7. **Voice input** — optional extra; push-to-talk, faster-whisper (DE/EN), inject into focused pane; model size configurable, downloaded on first use.
8. **Polish** — theme/keybinding config file, reconnect with backoff, PTY-death handling in UI, README with uv-only instructions.

Each milestone must end in a runnable, testable state (`uv run quickterm`) before starting the next.

## Constraints for Implementation

- Modular architecture — no business logic dumped into one file, no god modules
- Comments: sparse, terse, only where non-obvious; no AI-sounding boilerplate comments
- Type hints on public functions
- No telemetry; no network calls except user-initiated model download
- Windows 10 1809+ target
- License: project MIT; only MIT/BSD dependencies