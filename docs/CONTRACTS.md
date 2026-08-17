# QuickTerm — Module & Protocol Contracts

Binding interface contract for all components. If you need to deviate, keep the
public surface below intact and extend, don't rename. Read plan.md first for
goals, quirks, and design tokens.

## Paths & config

- Config dir: `%APPDATA%/quickterm/` (`config.config_dir() -> pathlib.Path`, creates it)
- `config.json` in config dir; workspaces in `workspaces/*.json` under config dir.
- All persistence is stdlib `json`.
- Windows serializes each profile environment value as a current-user DPAPI
  object (`{"protected":"dpapi-v1","data":"..."}`); the in-memory/API shape
  remains `dict[str, str]`. Plaintext legacy values migrate on load. POSIX
  config/token storage uses user-only permissions (`0700` directory, `0600`
  files).

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
    terminal_type: str | None = None  # powershell-core/windows-powershell/command-prompt/wsl/
                                      # git-bash/nushell/claude-code/ssh/sftp/custom
                                      # (POSIX adds bash/zsh/fish)
    wsl_distro: str | None = None
    start_command: str | None = None  # run inside supported shells, then remain interactive;
                                      # for ssh: remote command run instead of a shell
    claude_mode: str | None = None    # claude-code only: new/continue/resume/agents
    ssh_host: str | None = None       # ssh/sftp only; required for those types
    ssh_port: int | None = None       # None = 22; validated 1..65535
    ssh_user: str | None = None
    ssh_key: str | None = None        # path to a PuTTY .ppk; existence not validated

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
    max_sessions: int = 0                    # 0 = unlimited; otherwise 1..100 live
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
def validate_environment(env: object) -> dict[str, str]
```

Saving validates runtime-facing field types (including font family, update
toggle, profile terminal type, startup command, autostart, and shortcut) so a
malformed JSON config cannot reach launcher or spawn code and fail there.
Every non-WSL profile's configured starting folder must be an existing local
directory. WSL profiles accept Linux paths and are not checked against the
Windows filesystem. `ssh`/`sftp` profiles require a non-empty
`ssh_host`; the Settings UI keeps their `cwd` empty (a remote session has no
local starting folder). Passphrases and passwords are never stored — plink and
psftp prompt interactively inside the terminal.

Environment overrides are limited to 256 pairs / 256 KiB and reject non-string
pairs, empty names, `=`, control characters, NUL values, and names that collide
case-insensitively. Both PTY backends merge the validated override over the
QuickTerm process environment.

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
so a full stdin pipe never stalls the loop. Set `QUICKTERM_DEBUG_IO=1` to log
raw in/out bytes; `0` and every other value leave tracing disabled.

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
    def kill(self) -> bool    # verified process TREE kill; false when the process survives
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
    retained: bool              # explicit detach; keep even if untouched/idle
    workspace: str | None = None  # workspace this session belongs to

class Session:
    info: SessionInfo
    # ring buffer of raw output bytes, cap = scrollback_bytes
    # (deque of chunks + byte count; O(chunk) append/trim, joined only at attach)
    def scrollback(self) -> tuple[bytes, int, int]   # (data, cols_at_record, rows_at_record)

class SessionManager:
    def __init__(self, loop, scrollback_bytes: int = 512*1024,
                 max_sessions: int = 0) -> None
    def spawn(self, *, name: str | None = None, profile: str | None = None,
              cmd: str, args: list[str] = ..., cwd: str | None = None,
              env: dict[str, str] = ..., cols: int = 120, rows: int = 30,
              workspace: str | None = None) -> SessionInfo
    def list(self) -> list[SessionInfo]
    def get(self, sid: str) -> Session | None
    def sync_workspace(self, name: str, session_ids: set[str]) -> None
    def write(self, sid: str, data: bytes) -> None
    def resize(self, sid: str, cols: int, rows: int) -> None
    def kill(self, sid: str) -> bool          # verified tree kill + remove after grace
    def attach(self, sid: str) -> "Attachment"
    def busy_ids(self) -> set[str]            # sessions whose shell has a child process
    def session_metrics(self) -> tuple[set[str], dict[str, dict]]
    def session_activity(self, sid: str) -> dict[str, int | None]
    def set_max_sessions(self, limit: int) -> None
    def shutdown(self) -> None                # kill all

class Attachment:
    # bounded queue; slow viewers receive an explicit resync sentinel
    queue: asyncio.Queue
    def detach(self) -> None
```

- Flow control: subscriber queues are bounded. A slow viewer is disconnected
  with an explicit resync signal and replays the current ring; terminal bytes
  are never silently dropped or delivered in a corrupt partial sequence.
- Session ids: full random hex (`uuid4().hex`).

## quickterm/workspace.py

Layout tree (JSON-serializable, shared with the frontend — SAME schema):

```json
{"type": "split", "dir": "h", "ratio": 0.5, "children": [node, node]}
{"type": "pane", "profile": "claude", "cwd": "C:/dev/proj", "session_id": "a1b2c3d4"}
```

Pane nodes may also contain `launch_spec` for system terminals opened without a
saved profile. `session_id` is preferred when restoring. A missing/dead ID
becomes an explicit transcript-free unavailable pane; only a user-selected
recovery action may start a replacement or resume a Claude conversation.

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
| GET | /api/sessions | → `[SessionInfo + {attachments, busy, usage, activity}]`; `?metrics=false` skips process-tree sampling and returns lifecycle/activity data with unavailable usage for lightweight sidebar/status polling. `usage` has `{available, working_set_bytes, cpu_percent, process_count, uptime_seconds, scope}`. `activity` has `{idle_seconds, background_output_bytes, background_output_age_seconds}`; background output is counted only after a previously attached viewer detaches and is acknowledged by the next attach. WSL resource scope is explicitly partial. |
| POST | /api/sessions | `{profile?, cmd?, args?, cwd?, env?, name?, cols?, rows?, start_command?, claude_mode?, workspace?}` → `SessionInfo` (profile name resolves from config; a bounded `start_command` override supports shell-profile recovery; `claude_mode` is limited to `new`, `continue`, `resume`, or `agents` and only applies to a `claude-code` profile; explicit cmd overrides); 409 when the live-terminal limit is reached. When the bundled PuTTY tools are present, their directory is appended (never prepended) to the spawned session's `PATH`, so `plink`/`pscp`/`psftp` are callable from every terminal. `ssh`/`sftp` profiles resolve to plink/psftp argv (`[-ssh] [-P port] [-i key] [user@]host [remote-command]`); 400 if the tools are missing. |
| PATCH | /api/sessions/{id} | `{name}` → renamed `SessionInfo` |
| POST | /api/sessions/{id}/retain | Mark an explicit detach as user-owned so the untouched-shell reaper cannot end it → `SessionInfo` |
| POST | /api/launches | `{cwd}` → queue one authenticated Explorer folder handoff for the existing viewer |
| GET | /api/launches/next | Long-poll and atomically claim one queued folder handoff → `{cwd}` or 204 after timeout; `?wait=false` is the nonblocking probe |
| POST | /api/sessions/cleanup | `{session_ids}` → kill disposable sessions → 204 |
| POST | /api/sessions/kill-all | → attempt every live session → `{killed: int, killed_ids: string[], failed_ids: string[]}`. Partial failure remains HTTP 200 so clients remove only verified kills and keep failures visible for retry. |
| DELETE | /api/sessions/{id} | kill tree → 204 |
| GET | /api/profiles | → `[Profile]` |
| GET | /api/snippets | → `[Snippet]` |
| GET | /api/workspaces | → `[name]` |
| GET | /api/workspaces/{name} | → `Workspace` |
| PUT | /api/workspaces/{name} | `{layout, logo?, session_ids?}` → 204 |
| DELETE | /api/workspaces/{name} | delete the workspace; kill only detached sessions whose live authoritative owner is still this workspace, spare attached or since-moved sessions, and abort on any verified kill failure → 204 |
| GET | /api/config | → `{font_family, profiles, snippets, voice_available: bool, hotkey_error: str\|null}` — `hotkey_error` is set when a global hotkey parsed but Windows refused to register it (another program owns it); Settings renders it beside the shortcut field. |
| GET | /api/config/full | → the complete **persisted** `AppConfig`, never the live one: `app.py` rewrites `port` at startup (`--port 0`, and unconditionally for an elevated instance), and Settings PUTs this object straight back. |
| PUT | /api/config | complete `AppConfig` → 204. `port`, `host` and `summon_hotkey` need a restart and are not applied live; a submitted value identical to the running one is treated as unedited and the persisted value is kept, so a stale page can never write an ephemeral port to disk. |
| GET | /api/system/terminals | → detected terminal types and WSL distributions. Includes `ssh`/`sftp` entries backed by the bundled PuTTY tools (`quickterm/putty_tools.py`: frozen `_internal/putty/`, dev `vendor/putty/` via `scripts/fetch_putty.py`); `available: false` when absent (e.g. pip installs). The launcher lists them as profile-only (a hostless plink just prints usage). |
| POST | /api/assets | raw image body (≤1 MB) → `{id, url}` |
| GET | /api/assets/{id} | → stored PNG/JPEG/WebP/GIF/SVG/ICO |
| DELETE | /api/assets/{id} | → 204 |
| GET | /api/file?path=... | → `{path, size, truncated, text}` — read-only file viewer backend. Max 512 KiB read; decode utf-8 `errors="replace"`; 404 if missing, 400 if a directory. |
| GET | /api/update | → `{current, latest, update_available, url, notes, installable}` — probes the pinned GitHub repo's latest release (cached 6 h; `?force=true` bypasses). 502 on network failure. |
| POST | /api/update/install | download latest Setup asset, verify against the release's SHA256SUMS.txt, launch installer → `{launched, version}`. Windows only (else 400). |
| POST | /api/open | `{target}` → `{action: "url"\|"opened"\|"revealed"}` — terminal Ctrl+click. http(s) URLs and allowlisted passive local files open with the OS handler; every other file type is revealed in the file manager, never run (quickterm/opener.py). Other schemes/missing paths → 400/404. |

JSON bodies for session creation, elevation, and full-config updates are capped
at 1 MiB before buffering. API responses default to `Cache-Control: no-store`;
immutable asset responses retain their explicit long-lived cache policy.

WebSocket `/ws/session/{id}` — attach protocol, in order. Unknown IDs are
rejected with close code `4404`. An **exited** session that is still in the
registry is served in replay-only mode — steps 1-3 below, then
`{"type":"exit","code":N}` and close — and accepts no input. (It used to be
refused with `4410`, which made overflow permanently lossy: the client is told
to reconnect and replay the ring, and if the PTY died around the overflow that
replay could never happen, so the session's final output was unreachable while
still sitting in the ring.) A fresh subscription is drained from the moment it
exists, so output produced during the replay handshake is delivered in order
once the live phase begins instead of overflowing the bounded queue:

1. server → text JSON `{"type":"replay_size","cols":C,"rows":R}` (size scrollback was recorded at)
2. server → binary scrollback frames of at most 128 KiB; after xterm finishes
   parsing each frame, client → text JSON `{"type":"replay_ack"}`
3. server → text JSON `{"type":"replay_done"}` (an empty replay keeps the
   legacy empty binary frame but requires no acknowledgement)
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

class _DesktopApi:
    def pick_folder(self, initial_directory: str = "") -> str | None
```

- Fail fast unless `sys.getwindowsversion().build >= 17763` (Win10 1809).
- Optional positional `path` arg (Explorer "Open QuickTerm here"): if it is a
  directory, a first launch carries `?cwd=<dir>` in the window URL. A later
  ordinary process posts the folder to the authenticated `/api/launches` queue,
  summons the existing native viewer, and exits. The viewer opens it in Scratch.
- load_config → SessionManager → hotkeys thread → uvicorn (asyncio loop) →
  native Edge WebView2 viewer. The viewer receives `_DesktopApi` as its
  pywebview JS bridge; `pick_folder` opens only an OS folder dialog and returns
  one existing selected directory or `None` on Cancel/failure.
- Spawn autostart profiles on startup.
- Clean shutdown: manager.shutdown() on exit.
- Close-to-tray (win32, non-elevated): closing the primary window hides to the
  system tray (quickterm/tray.py, ctypes Shell_NotifyIcon) iff any live session
  has `touched=True`, `retained=True`, or its shell has a child process —
  otherwise the app quits.
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
- `panels.js` owns only panel lifecycle and shared controls. Dashboard, help,
  settings sections, and DOM-free helpers live in `panel_*.js` modules. Keep
  new tabs/large sections out of the coordinator.
- `pane_protocol.js` is the DOM-free attach/replay/backpressure state machine
  used by `pane.js`; `node --test tests/js/*.test.mjs` verifies replay gating,
  stale generations, transition to live input, and overflow-driven resync.
- `document.title = "QuickTerm"` (hotkey summon matches on this).
- Layout tree in JS mirrors the workspace JSON schema exactly.
- Panes: each pane = one xterm.js + one WS. Debounce resize ~50 ms. Use
  `term.write(data, cb)` callbacks for backpressure.
- Focus: 2px theme-accent rail with a compact semantic state dot; inactive
  terminals remain fully readable.
- Launcher: collapsible terminal-style sidebar with a compact profile dropdown,
  explicit open/admin actions, workspace/session rows, and dashboard/settings/help navigation.
- Dashboard: dense saved-workspace rows, global/current ownership and resource
  statistics, detached-session management, and quick profile launch.
- Sidebar workspace rows: named workspaces autosave layout and session IDs and
  restore the exact live sessions; the last active one is remembered locally.
  Scratch lifecycle: an unsaved scratch layout adopts the reserved
  workspace name `scratch` on the FIRST user keystroke (replacing the previous
  scratch file and its background-only sessions), autosaves from then on, and
  survives window close within a run; the backend deletes `workspaces/scratch.json`
  at process start and shutdown so it never survives a run. The name `scratch`
  (any case) and dot-prefixed names are rejected in user save paths; workspace
  names must survive `_safe_name` unchanged.
- Collapsible left sidebar: flat Personal/System terminal picker, one-click open/admin actions, workspaces, live/background sessions, and navigation. The terminal grid starts at the top edge and expands when the sidebar collapses; no top app bar or card shell owns vertical space.
  Session counts distinguish the current workspace from all backend sessions;
  when different the sidebar uses `workspace/global`, the status names the total,
  and Dashboard has separate **this workspace** / **all live** statistics plus
  explicit Unassigned ownership.
- Settings: tabbed General/Terminals/Snippets/Advanced/About editor. Terminal profiles expose shell type,
  detected WSL distributions, starting folder, start command, shortcut, and autostart without requiring JSON.
  `ssh`/`sftp` profiles swap the starting-folder field for Host/Port/Username/Private key (`.ppk`);
  `ssh` relabels start command as a remote command; `sftp` hides it.
  `claude-code` exposes a project folder and native launch modes: new,
  continue latest (`--continue`), choose a session (`--resume`), or open the
  background-agent manager (`claude agents`). Its executable is detected in the
  terminal inventory but is profile-only rather than a generic system shell.
- Themes: four featured choices stay visible; the catalog groups all remaining
  palettes under Dark, Neon, Soft, Warm, Light, and Custom. Clicking a theme previews
  both application chrome and every open xterm immediately; Cancel restores the
  persisted theme.
- Quick settings: the status-bar View drawer controls font size for either the
  focused pane or all panes, resizes the focused pane against its nearest
  horizontal/vertical split, balances that split, toggles focus mode, and links
  to full Settings. Ctrl+±/0 follows the selected scope; pane-only
  overrides are temporary, while All panes persists the global default.
- Starting folders are shell-native: blank Windows profiles use the Windows
  user home and blank WSL profiles use `wsl.exe --cd ~`. WSL profile folders
  are passed through `--cd` and may be Linux paths such as `~/dev`; the profile
  startup command runs after that location is selected. Every local profile's
  Starting folder / Project folder control includes a native pywebview folder
  picker while retaining manual entry. Cancel preserves the prior value; the
  picker is visibly unavailable in a standalone browser because browsers may
  not disclose an arbitrary host directory path.
- Command palette Alt+K: fuzzy over profiles / actions (new terminal, split h/v,
  zoom, detach, kill, open file viewer) / snippets / recent sessions. Workspaces
  are offered ONLY as enumerated `load workspace: <name>` rows — there is no
  free-text workspace prompt, because a typo used to tear the whole layout down
  silently; saving is owned by the Dashboard, which validates the name and shows
  the error. Snippet rows carry the command text and the destination pane, and a
  multi-line snippet is confirmed in the pane before it runs. Pane sizing is not
  duplicated here; it lives on the splitter and in Quick settings.
- Split actions launch the selected terminal choice in the source pane's
  best-known directory. Panes track only OSC 7 and OSC 9;9 shell-integration
  signals, falling back to their launch folder; prompt text is never parsed.
  Sidebar Open and Alt+N keep the selected profile's configured folder. A
  Claude split always uses its project folder and substitutes a normal
  conversation when that profile's default mode is `agents`; the palette's
  explicit **Split Claude agent view** runs `claude agents --cwd <project>`.
- Keybindings (in addition to palette): Alt+N opens a new default terminal,
  Alt+Shift+Right/Down split (H/V aliases), Alt+Z zoom, Alt+D detaches and
  retains the process, Alt+W always opens confirmation before a process-tree
  kill and pane close, Alt+arrows focus move,
  Ctrl+±/0 font size. Plain Alt+V/P/H/0-9/- pass through to the shell
  (Claude Code image paste & model switch, PSReadLine/readline bindings).
  The zoom layer matches only keys that actually produce `+`/`-`/`0`: physical
  codes are never matched on their own, so Ctrl+`]` (vim tag jump) and Ctrl+`/`
  (readline/PSReadLine undo) reach the shell on ANSI layouts.
  Alt+Shift+Left/Up cycle the previous/next new-terminal profile. Ctrl+Left/Right
  remain untouched for PowerShell/readline word navigation.
- A second ordinary QuickTerm process never creates another native viewer.
  It authenticates to the existing loopback backend, queues an optional Explorer
  folder through `/api/launches`, and restores/focuses the one existing window.
  The viewer atomically claims folder requests and opens them in Scratch.
- Destructive UI actions use an in-app confirmation placed by the triggering
  control (or inside the focused pane for keyboard actions). **Cancel** receives
  focus, so a reflexive Enter on a bar the user did not expect can never
  complete a destructive action; Escape and the Cancel button also cancel, and
  Escape inside a panel cancels the confirmation before it closes the panel. A
  short-lived pane notice never hides an open confirmation, and an inline
  popover follows its trigger while the panel body scrolls (dismissing itself if
  the trigger leaves the viewport). Application code does not use browser
  `alert`, `confirm`, or `prompt` dialogs.
- Pane title-bar verbs: `×` **detaches** (closes the view; the terminal keeps
  running), matching what that glyph means in every tabbed application. Killing
  is a separate, visually divided, text-labelled `.danger` control. The two must
  never be adjacent unlabelled glyphs.
- Sidebar workspace rows are idempotent: clicking the row you are already on is
  a no-op for every workspace, **scratch included**. Replacing the live scratch
  layout is the separate, confirmed "new scratch" action — no click on a row
  drawn as "current" may kill a running terminal.
- One visible failure surface: every gesture-triggered error goes to the
  dismissible `#app-error` banner (drawn above `.panel-overlay`) or to the
  focused pane's notice. `#sb-save` is reserved for the saving/saved lifecycle;
  it collapses when empty and sits under the panel overlay, so it must never
  carry anything the user has to act on. Nothing fails silently: elevation,
  workspace save/validation, bulk-kill failures and hotkey registration all
  report.
- Links: Ctrl+click opens URLs (web-links addon) and file paths (custom link
  provider) via POST /api/open. Paste is native-only: Ctrl+V and Ctrl+Shift+V must never
  be preventDefault'ed (WebView2 denies navigator.clipboard.readText silently).
  QuickTerm also overrides xterm's default OSC hyperlink handler, which would
  otherwise use a browser confirmation dialog.
- Copy: Ctrl+C, Ctrl+Shift+C, or right-click copies the current selection
  (navigator.clipboard.writeText, execCommand fallback), with a visible
  `[copied]` / `[copy failed]` confirmation; copy is read-only and never counts
  as user input. No selection → Ctrl+C passes through to the shell as interrupt.
- Desktop file/image drops use pywebview's native WebView2 bridge to obtain
  host-verified full paths, then insert them shell-quoted and separated by
  spaces without submitting the command. WSL receives `/mnt/<drive>/...`
  translation; SSH/SFTP refuse misleading local paths. A browser that withholds
  the native path produces an explicit Copy-as-path/Ctrl+V hint rather than a
  fake basename. Native Ctrl+V/Ctrl+Shift+V remains the ordinary
  PowerShell-friendly paste path.
- Pane focus is reasserted after creation, attach, and replay completion only
  while that pane is still selected; a late callback may never steal focus from
  a pane the user subsequently selected. Closing a full-screen Settings,
  Dashboard, Help, or similar panel returns focus to the selected terminal
  before considering the control that originally opened the panel.
- Workspace restore attaches only matching live session IDs. A missing process
  restores as a transcript-free unavailable pane with explicit replacement and,
  for Claude profiles, `claude --continue` recovery actions; it is never silently
  replaced under the old terminal identity.
- Normal persistent logging is warning/error-only, bounded to one 128 KB file
  plus one rotation, and redacts common user-local path prefixes. Session IDs
  and terminal transcripts are excluded. `QUICKTERM_DEBUG_IO=1` is the sole
  explicit exception for raw input diagnostics.
- OSC 52: apps inside the terminal (Claude Code, tmux, vim, …) copy to the
  system clipboard by emitting `ESC]52;c;<base64>`; the pane honors it via the
  same write path (async + execCommand fallback). Read requests (`…;?`) are
  declined and decoded writes are capped at 1 MiB. Without this the copy is
  silently dropped though the app reports it.
- Rendering: WebGL renderer (DOM fallback) + Unicode 11 width tables
  (`addon-unicode11`, activeVersion "11") so emoji/wide glyphs measure correctly
  and modern TUIs don't drift the cursor; falls back to xterm's built-in v6.
- On session exit: show `[exited: code N]` bar in pane, keep last frame visible.
- Reconnect with backoff on WS drop.
- File viewer: `viewer.html?path=...` — separate minimal page, fetches
  `/api/file`, renders read-only monospace text, same design tokens. Opened
  via palette action ("view file: <path>") with `window.open(..., "_blank",
  "popup,width=900,height=700")`. Hidden by default — no button in main chrome.
- Design tokens: compact, flat workbench chrome derives restrained semantic
  surfaces and focus colors from the selected palette; terminal ANSI colors
  remain separate. Reduced-motion and forced-colors modes are supported.

## Testing

`tests/` with pytest. Backend units must not require a real browser. PTY tests
spawn `cmd.exe /c echo hi` style short-lived processes. Server tests use
`fastapi.testclient.TestClient` with a stub/real manager. Keep tests fast (<30 s
total). Run: `uv run --no-sync pytest` (env is pre-synced; do NOT run uv sync,
uv add, or uv lock).
