# QuickTerm — Module & Protocol Contracts

Binding interface contract for all components. If you need to deviate, keep the
public surface below intact and extend, don't rename. Read plan.md first for
goals, quirks, and design tokens.

## Paths & config

- Config dir: `%APPDATA%/quickterm/` (`config.config_dir() -> pathlib.Path`, creates it)
- `config.json` in config dir; workspaces in `workspaces/*.json` under config dir.
- All persistence is stdlib `json`.

## quickterm/config.py

```python
@dataclass
class Profile:
    name: str
    cmd: str                    # executable, e.g. "powershell.exe" or "claude"
    args: list[str] = field(default_factory=list)
    cwd: str | None = None
    env: dict[str, str] = field(default_factory=dict)   # merged over os.environ
    keybinding: str | None = None   # e.g. "ctrl+alt+1" (global hotkey)
    autostart: bool = False
    terminal_type: str | None = None  # powershell-core/windows-powershell/command-prompt/wsl/custom
    wsl_distro: str | None = None
    start_command: str | None = None  # run inside supported shells, then remain interactive

@dataclass
class Snippet:
    name: str
    text: str

@dataclass
class VoiceConfig:
    enabled: bool = True            # effective only if voice deps importable
    model_size: str = "small"       # faster-whisper model name
    hotkey: str = "ctrl+alt+v"      # toggle push-to-talk (press start / press stop)
    language: str | None = None     # None = auto-detect (DE/EN)

@dataclass
class AppConfig:
    host: str = "127.0.0.1"
    port: int = 8620
    scrollback_bytes: int = 512 * 1024
    font_family: str = "JetBrains Mono"
    theme: str = "graphite"
    custom_theme: dict[str, str] = {}
    logo: str | None = None
    idle_timeout_s: int = 300
    update_check: bool = True               # UI probes GitHub releases when on
    summon_hotkey: str = "ctrl+alt+grave"   # quake-style summon/hide
    default_profile: str = ""
    profiles: list[Profile] = ...
    snippets: list[Snippet] = ...
    voice: VoiceConfig = ...

def config_dir() -> Path
def default_cwd() -> str
def load_config() -> AppConfig
def save_config(cfg: AppConfig) -> None
```

Saving validates that every non-WSL profile's configured starting folder is an
existing local directory. WSL profiles accept Linux paths and are not checked
against the Windows filesystem.

`default_cwd()` is the starting folder for any spawn that specifies no `cwd`
(profiles without one, detected system shells, splits). It prefers the user's
Desktop, then home, then the process cwd — never the install directory, which
is where a frozen exe's `os.getcwd()` would otherwise land. `SessionManager.spawn`
applies it, so every PTY backend receives a concrete folder.

## quickterm/pty_session.py

One ConPTY. Reader thread pushes bytes into the owner's callback via
`loop.call_soon_threadsafe` — never blocks the event loop. The reader coalesces
all immediately-available output into one callback (bounded). `write()` only
enqueues; a dedicated writer thread performs the (possibly blocking) PTY write,
so a full stdin pipe never stalls the loop. Set `QUICKTERM_DEBUG_IO` to log raw
in/out bytes.

```python
class PtySession:
    def __init__(self, cmd: str, args: list[str], cwd: str | None,
                 env: dict[str, str], cols: int, rows: int,
                 loop: asyncio.AbstractEventLoop,
                 on_output: Callable[[bytes], None],       # called on loop thread
                 on_exit: Callable[[int], None]) -> None    # exit code, on loop thread
    def write(self, data: bytes) -> None
    def resize(self, cols: int, rows: int) -> None
    @property
    def alive(self) -> bool
    @property
    def exit_code(self) -> int | None
    @property
    def pid(self) -> int
    def kill(self) -> None    # process TREE kill: taskkill /T /F on root pid, then close pty
```

- Exit detection: watch the process (pywinpty `isalive()` poll thread or wait on
  handle), not EOF alone.
- Bytes in / bytes out. No decoding anywhere in the backend.

## quickterm/session_manager.py

```python
@dataclass
class SessionInfo:
    id: str; name: str; profile: str | None
    alive: bool; exit_code: int | None; cols: int; rows: int
    touched: bool               # True once the user typed/pasted into it
    workspace: str | None = None  # workspace this session belongs to

class Session:
    info: SessionInfo
    # ring buffer of raw output bytes, cap = scrollback_bytes
    # (deque of chunks + byte count; O(chunk) append/trim, joined only at attach)
    def scrollback(self) -> tuple[bytes, int, int]   # (data, cols_at_record, rows_at_record)

class SessionManager:
    def __init__(self, loop, scrollback_bytes: int = 512*1024) -> None
    def spawn(self, *, name: str | None = None, profile: str | None = None,
              cmd: str, args: list[str] = ..., cwd: str | None = None,
              env: dict[str, str] = ..., cols: int = 120, rows: int = 30,
              workspace: str | None = None) -> SessionInfo
    def list(self) -> list[SessionInfo]
    def get(self, sid: str) -> Session | None
    def write(self, sid: str, data: bytes) -> None
    def resize(self, sid: str, cols: int, rows: int) -> None
    def kill(self, sid: str) -> None          # tree kill + remove after grace
    def attach(self, sid: str) -> "Attachment"
    def busy_ids(self) -> set[str]            # sessions whose shell has a child process
    def shutdown(self) -> None                # kill all

class Attachment:
    # bounded queue; slow viewers receive an explicit resync sentinel
    queue: asyncio.Queue
    def detach(self) -> None
```

- Flow control: subscriber queues are bounded. A slow viewer is disconnected
  with an explicit resync signal and replays the current ring; terminal bytes
  are never silently dropped or delivered in a corrupt partial sequence.
- Session ids: short hex (`uuid4().hex[:8]`).

## quickterm/workspace.py

Layout tree (JSON-serializable, shared with the frontend — SAME schema):

```json
{"type": "split", "dir": "h", "ratio": 0.5, "children": [node, node]}
{"type": "pane", "profile": "claude", "cwd": "C:/dev/proj", "session_id": "a1b2c3d4"}
```

Pane nodes may also contain `launch_spec` for system terminals opened without a
saved profile. `session_id` is preferred when restoring; a missing/dead session
falls back to spawning `profile` or `launch_spec`.

```python
@dataclass
class Workspace:
    name: str
    layout: dict   # tree above
    logo: str | None = None
    session_ids: list[str] = field(default_factory=list)  # includes detached

def list_workspaces() -> list[str]
def load_workspace(name: str) -> Workspace | None
def save_workspace(ws: Workspace) -> None
def delete_workspace(name: str) -> None
```

## quickterm/server.py

```python
def create_app(manager: SessionManager, cfg: AppConfig) -> FastAPI
```

Static: serve packaged `quickterm/frontend/` at `/` and its viewer at `/viewer`.

REST (JSON, under `/api`):

| Method | Path | Body → Response |
|---|---|---|
| GET | /api/sessions | → `[SessionInfo + {attachments: int, busy: bool}]` — `busy` = the shell has a child process right now (WSL in-VM work is invisible to it) |
| POST | /api/sessions | `{profile?, cmd?, args?, cwd?, env?, name?, cols?, rows?}` → `SessionInfo` (profile name resolves from config; explicit cmd overrides) |
| PATCH | /api/sessions/{id} | `{name}` → renamed `SessionInfo` |
| POST | /api/sessions/cleanup | `{session_ids}` → kill disposable sessions → 204 |
| DELETE | /api/sessions/{id} | kill tree → 204 |
| GET | /api/profiles | → `[Profile]` |
| GET | /api/snippets | → `[Snippet]` |
| GET | /api/workspaces | → `[name]` |
| GET | /api/workspaces/{name} | → `Workspace` |
| PUT | /api/workspaces/{name} | `{layout, logo?, session_ids?}` → 204 |
| DELETE | /api/workspaces/{name} | kill sessions referenced by the workspace, delete it → 204 |
| GET | /api/config | → `{font_family, profiles, snippets, voice_available: bool}` |
| GET | /api/config/full | → complete `AppConfig` |
| PUT | /api/config | complete `AppConfig` → 204 |
| GET | /api/system/terminals | → detected terminal types and WSL distributions |
| POST | /api/assets | raw image body (≤1 MB) → `{id, url}` |
| GET | /api/assets/{id} | → stored PNG/JPEG/WebP/GIF/SVG/ICO |
| DELETE | /api/assets/{id} | → 204 |
| GET | /api/file?path=... | → `{path, size, truncated, text}` — read-only file viewer backend. Max 512 KiB read; decode utf-8 `errors="replace"`; 404 if missing, 400 if a directory. |
| GET | /api/update | → `{current, latest, update_available, url, notes, installable}` — probes the pinned GitHub repo's latest release (cached 6 h; `?force=true` bypasses). 502 on network failure. |
| POST | /api/update/install | download latest Setup asset, verify against the release's SHA256SUMS.txt, launch installer → `{launched, version}`. Windows only (else 400). |
| POST | /api/open | `{target}` → `{action: "url"\|"opened"\|"revealed"}` — terminal Ctrl+click. http(s) URLs open in the browser; existing local paths open with the OS handler; executable-ish files are revealed in the file manager, never run (quickterm/opener.py). Other schemes/missing paths → 400/404. |

WebSocket `/ws/session/{id}` — attach protocol, in order:

1. server → text JSON `{"type":"replay_size","cols":C,"rows":R}` (size scrollback was recorded at)
2. server → ONE binary frame: scrollback bytes (may be empty)
3. server → text JSON `{"type":"replay_done"}`
4. live phase:
   - server → binary frames: raw PTY output
   - server → text JSON `{"type":"exit","code":N}` then close, on session death
   - client → binary frames: raw keyboard input bytes (written to PTY verbatim)
   - client → text JSON `{"type":"resize","cols":C,"rows":R}`

If a viewer falls behind its bounded queue, the server sends
`{"type":"overflow"}` and closes the socket. The client reconnects and replays
the current bounded scrollback instead of continuing with missing VT bytes.

Client is responsible for replay-then-resize: set xterm to replay size, write
scrollback, THEN resize to real size and send resize message.

Server binds 127.0.0.1 by default. Host and Origin allowlists protect the local
HTTP and WebSocket surface against DNS rebinding and cross-origin browser use.

## quickterm/app.py

```python
def main() -> None
```

- Fail fast unless `sys.getwindowsversion().build >= 17763` (Win10 1809).
- Optional positional `path` arg (Explorer "Open QuickTerm here"): if it is a
  directory, the window URL carries `?cwd=<dir>` (query before the `#t=` token
  fragment) and the frontend opens its first terminal there. Works whether or
  not a backend is already running (a second process opens a new window).
- load_config → SessionManager → hotkeys thread → uvicorn (asyncio loop) →
  launch browser `--app=http://127.0.0.1:<port>` (try msedge, then chrome,
  else webbrowser.open).
- Spawn autostart profiles on startup.
- Clean shutdown: manager.shutdown() on exit.
- Close-to-tray (win32, non-elevated): closing the primary window hides to the
  system tray (quickterm/tray.py, ctypes Shell_NotifyIcon) iff any live session
  has `touched=True` or its shell has a child process — otherwise the app quits.
  Tray menu: Open / Quit. The summon hotkey also restores a tray-hidden window.

## quickterm/hotkeys.py

ctypes RegisterHotKey in a dedicated thread with a GetMessageW loop. No
`keyboard` package.

```python
class HotkeyManager:
    def __init__(self, loop: asyncio.AbstractEventLoop) -> None
    def register(self, binding: str, callback: Callable[[], None]) -> bool
        # binding grammar: "ctrl+alt+1", "ctrl+alt+grave", "win+f12"...
        # callback scheduled via loop.call_soon_threadsafe
    def start(self) -> None
    def stop(self) -> None
```

Summon/hide: toggle the app browser window via user32
(EnumWindows/FindWindow matching window title "QuickTerm", ShowWindow +
SetForegroundWindow). Best-effort; degrade silently.

## quickterm/voice/ (parked)

Voice is currently NOT wired up: `_wire_voice` in app.py is a stub and the
Settings tab is hidden, because the hotkey had no capture overlay/feedback and
read as broken. The modules below remain and keep this contract for when a
real overlay exists.

`capture.py`: `Recorder` — start()/stop() -> numpy float32 mono 16 kHz via
sounddevice. `transcribe.py`: `Transcriber(model_size)` — lazy
`WhisperModel` load on first use, `transcribe(audio) -> str`, language
auto-detect (de/en), VAD filter on.

ALL voice imports guarded: module exposes `voice_available() -> bool`;
missing deps must never break startup. Hotkey toggle: first press start
recording, second press stop → transcribe → `manager.write(focused, text.encode())`.

## frontend/

- `index.html`, `css/`, `js/` (ES modules, no build step), `vendor/` with
  pinned xterm: `@xterm/xterm@5.5.0`, `@xterm/addon-fit@0.10.0`,
  `@xterm/addon-webgl@0.18.0`, `@xterm/addon-web-links@0.11.0` (js+css committed).
- `document.title = "QuickTerm"` (hotkey summon matches on this).
- Layout tree in JS mirrors the workspace JSON schema exactly.
- Panes: each pane = one xterm.js + one WS. Debounce resize ~50 ms. Use
  `term.write(data, cb)` callbacks for backpressure.
- Focus: 2px amber rail + dim inactive; POST /api/focus on change.
- Launcher: compact profile dropdown with an explicit open action and dashboard/settings/help navigation.
- Dashboard: saved workspace cards with layout previews and quick profile launch
  (no separate live-session list — sessions always belong to a workspace).
- App bar workspace dropdown: named workspaces autosave layout and session IDs
  and restore the exact live sessions; the last active one is remembered
  locally. Scratch lifecycle: an unsaved scratch layout adopts the reserved
  workspace name `scratch` on the FIRST user keystroke (replacing the previous
  scratch file and its background-only sessions), autosaves from then on, and
  survives window close within a run; the backend deletes `workspaces/scratch.json`
  at process start and shutdown so it never survives a run. The name `scratch`
  (any case) and dot-prefixed names are rejected in user save paths; workspace
  names must survive `_safe_name` unchanged.
- App bar terminal dropdown: custom-rendered Personal and System sections. System entries are availability-aware; WSL auto-selects one installed distro or expands a distro submenu for several.
- Settings: tabbed General/Terminals/Voice/Advanced editor. Terminal profiles expose shell type,
  detected WSL distributions, starting folder, start command, shortcut, and autostart without requiring JSON.
- Command palette Alt+K: fuzzy over profiles / actions (split h/v, zoom, kill,
  workspace save/switch, open file viewer) / snippets (paste = send text over WS)
  / recent sessions.
- Keybindings (in addition to palette): Alt+Shift+Right/Down split (H/V aliases), Alt+Z zoom,
  Alt+W detach pane (two-step when the session is busy), Alt+arrows focus move,
  Alt+Shift+±/0 font size. Plain Alt+V/P/H/0-9/- pass through to the shell
  (Claude Code image paste & model switch, PSReadLine/readline bindings).
- Links: Ctrl+click opens URLs (web-links addon) and file paths (custom link
  provider) via POST /api/open. Paste is native-only: Ctrl+Shift+V must never
  be preventDefault'ed (WebView2 denies navigator.clipboard.readText silently).
- Copy: Ctrl+Shift+C or right-click copies the current selection
  (navigator.clipboard.writeText, execCommand fallback), with a visible
  `[copied]` / `[copy failed]` confirmation; copy is read-only and never counts
  as user input. No selection → the combo passes through to the shell.
- OSC 52: apps inside the terminal (Claude Code, tmux, vim, …) copy to the
  system clipboard by emitting `ESC]52;c;<base64>`; the pane honors it via the
  same write path (async + execCommand fallback). Read requests (`…;?`) are
  declined. Without this the copy is silently dropped though the app reports it.
- Rendering: WebGL renderer (DOM fallback) + Unicode 11 width tables
  (`addon-unicode11`, activeVersion "11") so emoji/wide glyphs measure correctly
  and modern TUIs don't drift the cursor; falls back to xterm's built-in v6.
- On session exit: show `[exited: code N]` bar in pane, keep last frame visible.
- Reconnect with backoff on WS drop.
- File viewer: `viewer.html?path=...` — separate minimal page, fetches
  `/api/file`, renders read-only monospace text, same design tokens. Opened
  via palette action ("view file: <path>") with `window.open(..., "_blank",
  "popup,width=900,height=700")`. Hidden by default — no button in main chrome.
- Design tokens: graphite surfaces with warm amber focus, a softer system UI face
  around the monospace terminal, restrained rounded corners, and reduced-motion support.

## Testing

`tests/` with pytest. Backend units must not require a real browser. PTY tests
spawn `cmd.exe /c echo hi` style short-lived processes. Server tests use
`fastapi.testclient.TestClient` with a stub/real manager. Keep tests fast (<30 s
total). Run: `uv run --no-sync pytest` (env is pre-synced; do NOT run uv sync,
uv add, or uv lock).
