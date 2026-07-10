# QuickTerm

A native-feeling terminal host for Windows: real ConPTY terminals, a split-pane
window manager, persistent sessions, quick-launch profiles, and local
push-to-talk voice input. Everything local, no cloud services, no Electron.

Requires Windows 10 1809+ and [uv](https://docs.astral.sh/uv/).

## Run

```
uv sync
uv run quickterm
```

The backend starts on `127.0.0.1:8620` and opens a chromeless browser app
window. Sessions live in the backend process — closing the window does not
kill your terminals; reopen and reattach with full scrollback.

### Voice input (optional)

```
uv sync --extra voice
```

Adds local Whisper transcription (German/English auto-detect). Press the voice
hotkey (default `Ctrl+Alt+V`) once to start recording, again to stop —
the transcript is typed into the focused pane. The model downloads on first
use; size is configurable (`voice.model_size` in the config).

## Keys

| Key | Action |
|---|---|
| `Ctrl+P` | Command palette (profiles, actions, snippets, workspaces, sessions, file viewer) |
| `Alt+H` / `Alt+V` | Split pane horizontally / vertically |
| `Alt+Arrows` | Move focus between panes |
| `Alt+Z` | Zoom focused pane |
| `Alt+W` | Close pane (detaches — session keeps running) |
| `Ctrl+Alt+`` ` | Summon/hide the window (global, configurable) |

Per-profile global hotkeys (e.g. `Ctrl+Alt+1` → spawn the claude profile) are
set via `keybinding` in the profile config.

## Configuration

`%APPDATA%\quickterm\config.json` — created with defaults on first run.
Profiles are plain entries:

```json
{"name": "claude", "cmd": "claude", "args": [], "cwd": "C:/dev/proj",
 "env": {}, "keybinding": "ctrl+alt+1", "autostart": false}
```

Snippets (palette-pasteable text blocks), the summon hotkey, port, scrollback
size, font family, and voice settings live in the same file. Workspaces
(named split layouts + profiles) are saved to `%APPDATA%\quickterm\workspaces\`
via the palette.

## Development

```
uv sync --all-extras --dev
uv run pytest
uv run ruff check quickterm tests
```

Architecture: one backend process owns all PTYs (`pty_session.py`,
`session_manager.py`); browser tabs are dumb views attaching over a binary
WebSocket protocol (`server.py`); the frontend is plain ES modules + vendored
xterm.js, no build step. See `plan.md` and `docs/CONTRACTS.md`.

MIT licensed.
