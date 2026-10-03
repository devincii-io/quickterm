# QuickTerm module and protocol contracts

Binding interface contract for all components. If you need to deviate, keep the
public interface below intact and extend it, don't rename. Read `AGENTS.md`
first for the architecture, conventions, and packaging rules.

## Paths & config

- Config dir: `%APPDATA%/quickterm/` (`config.config_dir() -> pathlib.Path`, creates it)
- `config.json` in config dir; workspaces in `workspaces/*.json` under config dir.
  An elevated instance keeps its own workspaces in `workspaces/elevated/`
  (`workspace.set_namespace("elevated")`), because it is a second backend with
  its own window registry and must never autosave the normal instance's files.
- `window_state.json` in config dir holds the primary window's remembered
  bounds `{x, y, width, height, maximized}` (`quickterm/window_state.py`). It
  is optional, a corrupt file is ignored, and it stays out of `config.json` so
  dragging the window never touches the settings history.
- All persistence is stdlib `json`, written atomically (temp file, fsync,
  `os.replace`). On Windows a replace or read that meets a sharing violation
  (another thread has the file open) retries 5 times, 20 ms apart
  (`config.replace_file`, `config.read_text`).
- Every successful config save first copies the file it replaces to
  `config.prev.json` (best effort; skipped for an identical save and for the
  one save that encrypts a legacy plaintext config). A `config.json` or
  workspace file that cannot be parsed is renamed to
  `<stem>.invalid-<ns>.json` so it can be recovered, never silently overwritten.
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
    description: str = ""       # one line: what this terminal is for. Optional and
                                # defaulted, so a config written by an older
                                # build still loads.
    args: list[str] = field(default_factory=list)
    # No folder field of any kind: the workspace root places every session.
    env: dict[str, str] = field(default_factory=dict)   # merged over os.environ
    keybinding: str | None = None   # e.g. "ctrl+alt+1" (global hotkey)
    autostart: bool = False
    terminal_type: str | None = None  # powershell-core/windows-powershell/command-prompt/wsl/
                                      # git-bash/nushell/claude-code/codex/ssh/sftp/custom
                                      # telnet/serial/docker/podman/kubernetes/rdp/vnc
                                      # (POSIX adds bash/zsh/fish)
    wsl_distro: str | None = None
    start_command: str | None = None  # run inside supported shells, then remain interactive;
                                      # for ssh: remote command run instead of a shell
    agent_mode: str | None = None     # agent profiles only (replaces claude_mode, see below)
    agent: dict[str, str] = field(default_factory=dict)  # typed agent options, allowlisted per type
    ssh_host: str | None = None       # ssh/sftp only; required for those types
    ssh_port: int | None = None       # None = 22; validated 1..65535
    ssh_user: str | None = None
    ssh_key: str | None = None        # key file path; existence not validated
    ssh_client: str | None = None     # "openssh" | "putty"; None = putty
    ssh_proxy_jump: str | None = None # OpenSSH only
    connection: dict[str, str] = field(default_factory=dict)

@dataclass
class Snippet:
    name: str
    text: str                   # exact keystrokes, ending in the "\r" that runs the command
    description: str = ""       # one line: what it does and when to reach for it.
                                # Optional and defaulted, as on Profile.

@dataclass
class VoiceConfig:
    enabled: bool = True            # effective only if voice deps importable
    model_size: str = "small"       # faster-whisper model name
    hotkey: str = "ctrl+alt+v"      # toggle push-to-talk (press start / press stop)
    language: str | None = None     # None = auto-detect (DE/EN)

@dataclass
class WindowConfig:
    width: int = 1280               # 760..16384, pywebview logical units
    height: int = 800               # 480..16384
    remember_bounds: bool = True    # reopen the primary where it was (window_state.py)

@dataclass
class OverlayConfig:
    enabled: bool = False           # the summon key drops the primary window down
    edge: str = "top"               # "top" | "bottom"
    width_pct: int = 100            # 30..100 of the monitor work area
    height_pct: int = 50            # 20..100
    always_on_top: bool = True
    hide_on_blur: bool = True       # hide when another program takes the foreground
    monitor: str = "cursor"         # "cursor" | "primary"
    animate: bool = True            # ~120 ms slide

@dataclass
class AppConfig:
    host: str = "127.0.0.1"
    port: int = 8620
    scrollback_bytes: int = 512 * 1024
    font_family: str = "JetBrains Mono"
    font_size: int = 14
    theme: str = "graphite"
    custom_theme: dict[str, str] = {}
    logo: str | None = None
    idle_timeout_s: int = 300
    max_sessions: int = 0                    # 0 = unlimited; otherwise 1..100 live
    update_check: bool = True               # UI probes GitHub releases when on
    summon_hotkey: str = "ctrl+alt+grave"   # summon/hide; with the overlay, the drop-down
    scratch_dir: str = ""                   # "" = <system temp>/QuickTerm/scratch
    default_profile: str = ""                # a profile name or a shell id ("git-bash")
    profiles: list[Profile] = ...
    snippets: list[Snippet] = ...
    voice: VoiceConfig = ...
    window: WindowConfig = ...
    overlay: OverlayConfig = ...

def config_dir() -> Path
def default_cwd() -> str
def scratch_root(configured: str = "") -> str
def config_from_dict(raw: dict) -> AppConfig
def validate_config(cfg: AppConfig) -> None
def load_config() -> AppConfig
def save_config(cfg: AppConfig) -> None      # keeps config.prev.json
def validate_environment(env: object) -> dict[str, str]
def replace_file(source, target) -> None     # os.replace, retried on Windows sharing errors
def read_text(path) -> str                   # read, retried the same way
```

`app.py` sets two attributes on the live `AppConfig` that are not dataclass
fields and are never persisted: `runtime_overrides: set[str]` (the fields it
overrode for this run only, today `{"port"}` for `--port` and an elevated
instance) and `launch_error: str | None` (the latest autostart or global-hotkey
launch failure). `hotkey_error` follows the same pattern.

Saving validates runtime-facing field types (including font family, update
toggle, profile terminal type, startup command, autostart, and shortcut) so a
malformed JSON config cannot reach launcher or spawn code and fail there.
Profiles hold no folder, so there is none to validate here; the workspace root
is checked when a session actually spawns. `ssh`/`sftp` profiles require a
non-empty `ssh_host`. Passphrases and passwords are never stored; ssh, sftp,
plink and psftp prompt interactively inside the terminal.

Migration and validation added in 4.0:

- `config_from_dict` copies a raw profile's `claude_mode` into `agent_mode`
  when `agent_mode` is absent. `claude_mode` is no longer a field, so the next
  save drops it, except that claude-code profiles keep writing `claude_mode`
  next to `agent_mode` so an older build still reads the mode.
- `window` and `overlay` are parsed with `_parse`, like `voice`. Messages follow
  the existing style: `Window width must be between 760 and 16384`,
  `Overlay edge must be top or bottom`.
- `agent_mode` must be in the type's mode set or null. claude-code accepts
  `new | continue | resume | agents` (null means `continue`); codex accepts
  `new | continue | resume | fork | agents` (null means `new`). Profiles that
  Settings creates start at `new`.
- `agent` keys must belong to the type's allowlist ("unknown agent option:
  <key>"), values are strings without NUL, and only `add_dirs` may hold
  newlines. Choices come from their sets with `""` meaning unset; toggles are
  `"true"`, `"false"` or `""`. Errors read
  `Terminal profile "<name>": <agent/ssh error>`.
- `ssh_host` and `ssh_user` must not start with `-` and hold no whitespace or
  control characters (argument injection, both clients). `ssh_proxy_jump`
  must match `^[A-Za-z0-9._@:,\[\]%-]+$`, must not start with `-`, and with
  PuTTY is an error: "ProxyJump needs the OpenSSH client". A `.ppk` key with
  OpenSSH is an error: "OpenSSH cannot read PuTTY .ppk keys; choose the PuTTY
  client or an OpenSSH key". New ssh profiles default to OpenSSH when it is
  installed, else PuTTY; old profiles (`ssh_client` null) keep PuTTY.

`connection` holds typed connection fields, exposed individually in Settings:
host/port for Telnet and desktop clients; device/baud/data_bits/parity/stop_bits/flow
for serial; target/shell/user/context/namespace/container for containers; and
fullscreen/width/height for RDP. Values are strings, unknown fields are rejected,
and required targets, numeric bounds and serial enums are validated on save.
`connections.resolve` builds argv without shell interpolation. Telnet/serial use
bundled plink; Docker/Podman/Kubernetes use their configured CLI executable.
RDP/VNC are external desktop windows, never PTYs. They require an explicit open
and reject autostart/global shortcuts; credentials remain in the client.

Environment overrides are limited to 256 pairs / 256 KiB and reject non-string
pairs, empty names, `=`, control characters, NUL values, and names that collide
case-insensitively. Both PTY backends merge the validated override over the
QuickTerm process environment with `pty_base.merge_environment`: on Windows the
merge is case-insensitive (a profile `Path` replaces the inherited `PATH` and
keeps its own spelling); on POSIX `TERM=xterm-256color` and
`COLORTERM=truecolor` are set before the override, so only a profile changes
them.

### Where a session starts

A workspace IS a folder. The resolution order for a new session's directory is
fixed and applies to every spawn path:

1. an explicit `cwd` in the request (Explorer handoff, a split inheriting the
   source pane's directory), which always wins;
2. otherwise the workspace root (`Workspace.path`); a root that no longer
   exists degrades to step 3, never to an error;
3. `default_cwd()`.

Profiles hold no folder, so there is no third source and no way for one to
point somewhere the workspace does not.

`default_cwd()` prefers the user's home directory, then the process cwd, never
the install directory, which is where a frozen exe's `os.getcwd()` would
otherwise land. `SessionManager.spawn` applies it and records the result on
`SessionInfo.cwd`, so every PTY backend receives a concrete folder and every
client can show where a terminal actually opened.

`scratch_root(configured)` is the disposable scratch workspace's folder:
`AppConfig.scratch_dir` when set, else `<system temp>/QuickTerm/scratch`. It is
created on demand, reused across runs, and its contents are never deleted by
QuickTerm. Scratch terminals start there rather than in the user's home folder.

Agent profiles (Claude Code and Codex) need a project folder and cannot carry
one, so the workspace root is the only source. `launch.resolve_profile` raises
when nothing resolves, which surfaces as a 400 on the spawn rather than a
config-save error. Autostart and global hotkeys have no workspace, so an agent
profile there fails the same way and the failure is reported as `launch_error`.

## quickterm/pty_session.py and quickterm/pty_posix.py

One PTY each: ConPTY on Windows (the ctypes binding in `conpty.py`), `pty.fork`
elsewhere. Both
subclass `pty_base.PtyBase` and expose the same interface, so
`SessionManager` uses either unchanged. Set `QUICKTERM_DEBUG_IO=1` to log raw
in/out bytes; `0` and every other value leave tracing disabled.

```python
class PtySession:
    def __init__(self, cmd: str, args: list[str], cwd: str | None,
                 env: dict[str, str], cols: int, rows: int,
                 loop: asyncio.AbstractEventLoop,
                 on_output: Callable[[bytes], None],       # called on loop thread
                 on_exit: Callable[[int], None]) -> None    # exit code, on loop thread
        # raises OSError for every failure to start the child;
        # a missing executable is FileNotFoundError("command not found: <cmd>")
    def write(self, data: bytes) -> None       # enqueue only; BufferError when full
    def resize(self, cols: int, rows: int) -> None
    @property
    def alive(self) -> bool
    @property
    def exit_code(self) -> int | None
    @property
    def pid(self) -> int
    def kill(self) -> bool    # True only when every process it targeted is gone
```

Threads, per session:

- **Reader**: drains everything immediately available into one `on_output`
  callback of at most 128 KiB (`pty_base.READ_COALESCE_BYTES`): one thread
  hop, one ring edit and one WS frame per burst.
- **Writer** (`PtyBase`): a bounded queue of 64 items; queued input is written
  in chunks of up to 256 KiB. A full stdin pipe blocks only this thread,
  never the loop. It stops only after a verified kill or a natural exit, so a
  terminal whose kill failed still takes input.
- **Watcher**: exit detection follows the process, not EOF, because a
  background job that inherited the terminal keeps it open after the shell
  is gone. Windows waits on the CreateProcess handle; POSIX owns `waitpid`.
  On Windows the pseudoconsole is released right after the spawn, so the
  console host ends by itself once its last client is gone and the reader
  reads EOF after the final output; when that does not come, the watcher
  closes the host once the output has been quiet 0.15 s (at most 1 s), and
  the reader still reads what is left in the pipe. POSIX drains the same way.
  `on_exit` is posted exactly once, after the final output.

POSIX specifics: the master is non-blocking and non-inheritable (a later
terminal must not hold an earlier one's master), the fd lock is held for one
`write(2)` at a time and never across a wait, and the master is closed in one
place, after reader and writer stopped, so a recycled descriptor number is
never touched. Children get `TERM=xterm-256color` and `COLORTERM=truecolor`
unless a profile sets them.

Kill:

- POSIX signals every process group in the child's session (read from
  `/proc/<pid>/stat`; the leader's group where `/proc` is missing) with
  SIGKILL, retries for up to 2 s, and returns True only when the leader has
  been reaped and no other process in that session is still running. EPERM is
  never swallowed.
- Windows captures the process tree first and opens a handle to each process
  (kept only when its creation time predates the snapshot), so a reused PID
  cannot pass for one that died. It holds a handle to the root from spawn
  until the exit is flagged and never addresses a dead root by PID number.
  Every captured process is verified through its handle, also one whose
  parent died during the kill. It runs
  `%SystemRoot%\System32\taskkill.exe /T /F` by absolute path with
  `cwd=%SystemRoot%` (a bare `taskkill` searched the current folder first),
  terminates what survives, and returns False if any captured process is
  still running. No Job Objects: a job would also kill programs started from
  the terminal that taskkill never touched (`code .`, `explorer .`).
- A shell that exited on its own before any kill attempt keeps its jobs:
  `kill()` returns True without touching them (`nohup`), as a terminal
  emulator does. Once a kill of the session has failed, every later `kill()`
  verifies again: POSIX that no live process is left in the session, Windows
  that the survivors of the failed attempt, still held by their handles, have
  exited. A retry can never turn a failure into a success by finding the shell
  already dead.

Bytes: both backends are bytes in, bytes out. On Windows `conpty.py` owns
both pipes (128 KiB each; with the default few KiB the console host blocked
on every write) and passes bytes through untouched; the console host decodes
input as UTF-8 itself. The pseudoconsole comes from the `conpty.dll` and
`OpenConsole.exe` in the pywinpty wheel (the frozen app's `conpty/` folder),
falling back to kernel32's inbox ConPTY without them. Children get
`STARTF_USESTDHANDLES` with null handles, so they never inherit QuickTerm's own
redirected stdout. pywinpty's str API, used before, turned a UTF-8 character
split across two reads into U+FFFD.

## quickterm/pty_base.py

```python
READ_COALESCE_BYTES = 128 * 1024
WRITE_COALESCE_BYTES = 256 * 1024
WRITE_QUEUE_ITEMS = 64

def merge_environment(override: dict[str, str] | None) -> dict[str, str]
def path_value(env: dict[str, str]) -> str | None   # PATH whatever the key's case
class PtyBase: ...                                   # write queue, writer, _post
```

## quickterm/process_usage.py

The only module that walks the OS process table (Toolhelp on Windows,
`/proc` on Linux; empty results where neither exists).

```python
def process_identities() -> list[tuple[int, int]]     # (pid, parent_pid)
def pids_with_children(identities=None) -> set[int]
def descendants(identities, root: int) -> set[int]    # root excluded
def reachable_pids(identities, root_pids: set[int]) -> set[int]
def snapshot_processes(roots=None, identities=None) -> dict[int, ProcessSample]
def summarize_trees(processes, root_pids) -> dict[int, TreeUsage]
def session_process_groups(session_id: int) -> dict[int, int] | None  # POSIX only
```

Windows reuses PIDs quickly and an orphan keeps naming its dead parent, so
`process_identities` keeps a parent link only when the parent is not younger
than the child (creation times; a link whose times cannot be read is kept,
a dropped one reports parent 0). Without that, a new session whose root got
such a PID counted an unrelated orphan as its child and stayed busy forever.

## quickterm/session_manager.py (with scrollback.py, fanout.py, reaper.py)

`session_manager.py` holds the registry, `SessionInfo`/`Session`, busy state
and metrics and the PTY callbacks, and re-exports everything below. The ring
(`ScrollbackRing`: chunks, cap, the clean-front trim, the DEC mode tracker and
string handling) lives in `scrollback.py` with no asyncio or PTY code; the
per-viewer queues (`AttachmentQueue`, `Attachment`, and `Viewers`, whose
`publish()` holds the overflow-to-resync policy) in `fanout.py`; the keep and
reap rules and the claim/kill/release pass (`Reaper`) in `reaper.py`.

```python
QUEUE_MAX_BYTES = 2 * 1024 * 1024      # pending bytes per viewer before a resync
QUEUE_MERGE_BYTES = 128 * 1024         # consecutive chunks merge up to this size
EXITED_UNREAD_RETENTION_S = 24 * 3600  # see reap_idle

class SessionLimitError(RuntimeError)  # spawn would pass max_sessions (HTTP 409)
class SpawnError(ValueError)           # the backend could not start the child (HTTP 400)

@dataclass
class SessionInfo:
    id: str; name: str; profile: str | None
    alive: bool; exit_code: int | None; cols: int; rows: int
    touched: bool = False       # the user typed/pasted into it (client touch frame only)
    retained: bool = False      # explicit detach; keep even if untouched/idle
    workspace: str | None = None  # workspace this session belongs to
    cwd: str | None = None      # folder the process started in
    current_cwd: str | None = None  # last folder the shell reported (OSC 7, OSC 9;9)

class Session:
    info: SessionInfo
    reaping: bool               # the reaper has claimed it; attach() refuses it
    def scrollback_chunks(self) -> tuple[tuple[bytes, ...], int, int]
        # (chunks, cols_at_record, rows_at_record); never joined into one buffer

class SessionManager:
    def __init__(self, loop, scrollback_bytes: int = 512*1024,
                 max_sessions: int = 0) -> None
    def spawn(self, *, name: str | None = None, profile: str | None = None,
              cmd: str, args: list[str] = ..., cwd: str | None = None,
              env: dict[str, str] = ..., cols: int = 120, rows: int = 30,
              workspace: str | None = None) -> SessionInfo      # loop thread
    async def spawn_async(self, **same_kwargs) -> SessionInfo  # PTY built off the loop
    def list(self) -> list[SessionInfo]
    def get(self, sid: str) -> Session | None
    def sync_workspace(self, name: str, session_ids: set[str]) -> None
    def write(self, sid: str, data: bytes) -> None   # input; never sets touched
    def touch(self, sid: str) -> None                # real user input: touched = True
    def resize(self, sid: str, cols: int, rows: int) -> None
    def kill(self, sid: str) -> bool                 # True verified, False survived,
                                                     # KeyError when sid is unknown
    def attach(self, sid: str) -> "Attachment"       # KeyError: unknown or being reaped
    def acknowledge(self, sid: str) -> None          # background output seen, no subscription
    def mark_seen(self, sid: str) -> None            # clear attention; KeyError when unknown
    def session_attention(self, sid: str) -> dict | None  # {kind, text, age_seconds}
    def set_attention_listener(self, cb) -> None     # cb(info, record), loop thread
    def busy_ids(self) -> set[str]                   # sessions whose shell has a child process
    def session_metrics(self) -> tuple[set[str], dict[str, dict]]
    def session_activity(self, sid: str) -> dict[str, int | None]
    def has_attachments(self, sid: str) -> bool
    def attachment_count(self, sid: str) -> int
    def live_count(self) -> int
    def set_max_sessions(self, limit: int) -> None
    def set_scrollback_bytes(self, cap: int) -> None # applies to live rings too
    def reap_idle(self, timeout_s: int, protected: set[str] | None = None) -> list[str]
    def shutdown(self) -> None                       # kill all

class Attachment:
    queue: AttachmentQueue      # await get(), get_nowait() (asyncio.QueueEmpty),
                                # put_nowait(), qsize(), empty()
    overflow_sentinel: object
    overflowed: bool
    def detach(self) -> None
```

- `spawn` and `spawn_async` raise `SessionLimitError` before starting
  anything (in-flight async spawns count against the limit) and `SpawnError`
  when the backend constructor raises `OSError`. A missing command reads
  `command not found: <cmd>. QuickTerm reads PATH when it starts; restart it
  after installing a program.` `spawn_async` registers the session on the loop
  thread even if the awaiting request was cancelled, so no process is ever
  started without a registry entry.
- `kill` counts a backend kill as verified only when it returns exactly `True`.
  A 404 and a 500 must stay distinguishable to clients, hence the `KeyError`.
- Busy has one definition: alive, and the root PID has a direct child in one
  `process_usage.process_identities()` snapshot. `busy_ids` and
  `session_metrics` share it.
- Flow control: each viewer's queue is bounded by bytes, not items.
  Consecutive output chunks merge into items of at most 128 KiB; a viewer with
  more than 2 MiB pending is sent the overflow sentinel, told to reconnect and
  replays the current ring. Terminal bytes are never silently dropped.
- Replay: after any trim the ring never starts inside an escape sequence or a
  UTF-8 character (the front skips forward, bounded at 4 KiB). A front inside
  an OSC, DCS, APC, PM or SOS string of any length (an OSC 52 yank, a sixel
  image) drops through the string's terminator; while an unterminated string
  is still arriving the ring stays empty, so a replay may be the preamble
  alone rather than string payload printed as text. DEC private
  modes are tracked as bytes leave the ring, and `scrollback_chunks()` puts
  one synthesized chunk first that restores those in effect at the ring start:
  cursor keys (1), cursor visibility (25), focus reports (1004), bracketed
  paste (2004), mouse tracking (1000/1002/1003) and encoding (1006/1015), alt
  screen (47/1047/1049). Synchronized output (2026) is never replayed. RIS
  (`ESC c`) clears the tracked state.
- Resizes are kept at their place in the byte stream (`ScrollbackRing.resize`,
  called by `SessionManager.resize` before the PTY resize), and
  `replay_steps()` returns the chunks with a `(cols, rows)` step at each
  resize, plus the size the first step was written at. Resizes with no output
  between them collapse into the last one; one that leaves with the trimmed
  front becomes the start size. `scrollback_chunks()` keeps returning the
  chunks and the current size, for search and export. ConPTY writes each
  byte for the size in effect then, so replaying bytes from several widths at
  one width broke prompts apart; a viewer that resizes where the session did
  reflows exactly as the live one.
- `reap_idle` (every 30 s, from a worker thread) spares a session with a
  viewer attached. It removes an exited session, unless the session was
  retained or touched and still holds background output nobody has seen:
  that one stays until `attach`/`acknowledge` or 24 hours after it ended,
  because the ring is the only copy of a build result or an agent's last
  message. A live session is spared when a saved workspace protects it, or it
  is touched, retained or busy; otherwise it is killed once idle for
  `timeout_s` (0 disables). Each candidate is rechecked and marked `reaping` on
  the loop thread right before its kill, so a session picked up during a slow
  pass survives; a failed kill clears the mark.
- Session ids: full random hex (`uuid4().hex`).
- "Needs you": `quickterm/signals.py` scans every output burst (two
  `bytes.find` calls when a burst holds neither BEL nor `ESC ]`, a small carry
  across bursts, never a per-byte loop) for a BEL that does not end an OSC
  string, OSC 9 notifications (not the ConEmu subcommands 9;1 to 9;12, which
  include progress, the folder and prompt marks), OSC 777 `notify` and OSC 99.
  The latest one becomes the session's attention record
  `Attention(kind="bell"|"notify", text, at)`; an exit becomes `kind="exit"`
  when the session was attached once and typed into or explicitly detached,
  and no viewer is attached. Output never clears attention; `mark_seen` (the
  client, when the pane showing it gains focus or the user opens it from the
  sidebar), a touch, and opening an exited session do. The reaper keeps an
  exited session with attention like one with unread output, and never reaps
  an idle live one that has attention. The same scanner reads OSC 7 and
  OSC 9;9 into `SessionInfo.current_cwd`.

## quickterm/workspace.py

Layout tree (JSON-serializable, shared with the frontend, SAME schema):

```json
{"type": "split", "dir": "h", "ratio": 0.5, "children": [node, node]}
{"type": "pane", "profile": "claude", "cwd": "C:/dev/proj", "session_id": "a1b2c3d4"}
```

Pane nodes may also contain `launch_spec` for system terminals opened without a
saved profile, and profile panes `launch_options: {agent_mode?,
agent_session?, start_command?, args?}`, the options the pane was started
with, so a restart in place or a workspace restore repeats that launch exactly
(an agent "new conversation" pane stays "new", a resumed session resumes the
same id). A legacy `claude_mode` in a stored node is read as `agent_mode`; the
file format is otherwise unchanged. Layouts without it load as "no options".
`session_id` is preferred when restoring. A missing/dead ID becomes an explicit
transcript-free unavailable pane; only a user-selected recovery action may
start a replacement or resume an agent conversation.

```python
@dataclass
class Workspace:
    name: str
    layout: dict   # tree above
    logo: str | None = None
    path: str | None = None   # root folder every session in this workspace starts in
    session_ids: list[str] = field(default_factory=list)  # includes detached
    temporary: bool = False   # disposable scratch-view layout, deleted between runs

def list_workspaces() -> list[str]
def load_workspace(name: str) -> Workspace | None
def save_workspace(ws: Workspace) -> None      # normalizes `path` before writing
def delete_workspace(name: str) -> None
def set_namespace(name: str | None) -> None    # "elevated" = workspaces/elevated/
def layout_session_ids(node: object) -> set[str]   # the one layout-tree walker
def referenced_session_ids() -> set[str]       # every file's layout + session_ids

# folder helpers (also used by config validation and the spawn path)
def normalize_root(value: object) -> str | None      # expands ~/env vars, absolutizes
def resolve_start_dir(root: str | None) -> str | None # the root if it exists, else None
def root_exists(root: str | None) -> bool
```

File names: a lowercase name that needs no sanitizing is stored as
`<name>.json`; anything else gets a digest suffix (`<safe>--<sha256[:10]>.json`)
because NTFS is case-insensitive and `dev`/`Dev` are different workspaces. A
reserved device name before the first dot (`con.txt`, `aux.tools`) gets a
leading underscore, since Windows 10 still maps `con.txt--x.json` to the
console. Older shapes are read and migrated on the next save. A file that
cannot be parsed is quarantined as `<stem>.invalid-<ns>.json` and not listed;
a file is listed only when its stored name leads back to it, so every listed
name can be opened and deleted. `referenced_session_ids` is what the reaper
protects; it raises when a file cannot be read, so the reaper skips that pass
instead of losing protection.

## quickterm/browse.py

```python
MAX_ENTRIES: int = 2000

class BrowseError(Exception):
    missing: bool

def roots() -> list[dict]                       # [{name, path}]
def list_dirs(path: str | None = None) -> dict  # {path, name, parent, dirs, roots, truncated}
```

Directory-only listing behind `GET /api/fs/dirs`. Files are never reported: a
folder picker is not a file browser. Raises `BrowseError` and nothing else, so
a typed path bar cannot produce a traceback; `missing` separates "no such
folder" (→ 404) from "not a folder / cannot be read" (→ 400). Statically
imported by `server.py`, so it needs no `hiddenimports` entry.

## quickterm/windows.py

One backend serves several viewer windows, so something has to say which
window owns which workspace. Two windows on one workspace would both autosave
its layout on every pane change and the loser's panes would disappear without a
word, so a workspace has at most one live owner and a colliding claim FAILS.
There is no force-take.

```python
DEFAULT_TTL_S: float = 150.0   # above Chromium's 1/min timer throttling of hidden pages
DEFAULT_MAX_WINDOWS: int = 32  # the shell document and every view each count
KEEP: object                      # "this call is not about the claim"

class WindowError(Exception):  status: int      # UnknownWindow 404,
class UnknownWindow(WindowError)                # WorkspaceClaimed 409 (.workspace,
class WorkspaceClaimed(WindowError)             # .owner), TooManyWindows 409
class TooManyWindows(WindowError)

@dataclass
class WindowInfo:
    id: str
    workspace: str | None = None   # None = claims nothing
    title: str = ""
    primary: bool = False
    created: float = 0.0           # monotonic, never sent to a client
    last_seen: float = 0.0

def new_window_id() -> str
def as_payload(info: WindowInfo) -> dict          # {id, workspace, title, primary}
def normalize_workspace(value: object) -> str | None   # ValueError on junk
def window_title(base: str, workspace: str | None, *, primary: bool) -> str

class WindowRegistry:
    def __init__(self, *, ttl_s=DEFAULT_TTL_S, max_windows=DEFAULT_MAX_WINDOWS,
                 clock=time.monotonic) -> None
    ttl_s: float
    def register(self, *, window_id=None, workspace=KEEP, title="",
                 primary=False, now=None) -> WindowInfo
    def heartbeat(self, window_id, *, now=None) -> WindowInfo
    def claim(self, window_id, workspace, *, now=None) -> WindowInfo
    def forget(self, window_id, *, now=None) -> bool
    def owner_of(self, workspace, *, now=None) -> WindowInfo | None
    def snapshot(self, *, now=None) -> list[dict]   # payload + idle/age seconds
```

Rules:

- **One live owner per workspace.** A claim that collides raises
  `WorkspaceClaimed` and changes nothing. Re-claiming what you already hold is
  a no-op success, so a page reload cannot 409 against itself. Claiming a
  second workspace releases the first in the same step: a window shows one
  workspace, so it owns one.
- `workspace=None` means "claims nothing" and never collides. A window with no
  claim MUST NOT autosave a layout. The shell document of a native window
  claims nothing. Every workspace view, scratch included, registers on its own
  and claims its workspace; a scratch view claims `scratch-view-<registry id>`.
- Names are compared **exactly**, never case-folded, because `workspace.py`
  stores `dev` and `Dev` as separate files and they are separate workspaces.
- **Liveness is a heartbeat, not a process handle**, because a viewer can be a
  browser tab that dies without a word. An entry older than `ttl_s` expires and
  its workspace is free again; otherwise one crashed window would lock its
  project out of the app for the life of the backend. The TTL is 150 s because
  WebView2, like Chromium, wakes the timers of a page hidden for five minutes
  only once a minute; a native close and a closing page free the claim at
  once, so the long TTL only delays recovery from a window that vanished. Every method prunes
  first, so expiry needs no timer.
- A heartbeat or claim for an unknown or already expired id raises
  `UnknownWindow`. The client must re-register rather than keep autosaving a
  workspace that may now belong to somebody else.
- Exactly one live window is `primary` while any window exists; when it is
  forgotten or expires, the oldest survivor inherits the role. `primary` names
  the native window the Explorer folder handoff and the summon hotkey aim at, so
  only that window's shell should long-poll `GET /api/launches/next`. It says
  nothing about workspaces: inside a window every workspace view is equal.
- Timestamps are `time.monotonic` (a DST or NTP step must not expire every
  window at once) and never leave the process; the wire carries
  `idle_seconds` / `age_seconds` instead.
- Pure and thread-safe: no pywebview import, no I/O, one lock, and callers get
  copies of `WindowInfo` rather than the registry's own records. `server.py`
  imports it statically, so it needs no `hiddenimports` entry.

## quickterm/server.py and quickterm/api/

```python
def create_app(manager: SessionManager, cfg: AppConfig, token: str = "",
               elevated: bool = False, *,
               windows: WindowRegistry | None = None,
               open_window: Callable[[str | None, str | None], str] | None = None,
               notify: Callable[[str, str, str, str | None], None] | None = None,
               rebind_hotkeys: Callable[[AppConfig], None] | None = None,
               suspend_hotkeys: Callable[[bool], None] | None = None) -> FastAPI
def client_host(host: str) -> str      # URL host for a bind address, IPv6 bracketed
```

`server.py` is only the composition root: it builds one `api.context.ApiContext`
(manager, cfg, token, elevated, the window registry, `open_window`, the
Host/Origin allowlists, the launch queue, the inventory cache, the workspace
write lock), installs `api.guard.LocalGuard`, calls `register(app, ctx)` on
every route module and mounts the frontend last. The routes live in
`quickterm/api/`: `sessions`, `launches`, `windows`, `workspaces`, `config`,
`system` (health, profiles, terminal inventory, elevate, update, open, file,
folder browser), `assets`, and `attach` (the WebSocket route, the replay
handshake, the output and input pumps and the close codes). `api.common`
holds the shared request helpers (bounded JSON bodies, `resolve_request`).
Route modules load `workspace`, `config`, `opener`, `update`, `assets`,
`agents`, `ssh_config` and `agent_sessions` through
`importlib.import_module("quickterm.X")` so tests can stub them, and each of
them is listed in `quickterm.spec` hiddenimports.

`create_app` also takes `notify=None`: in the desktop app,
`notify(session_id, name, kind, text)` is called on the loop thread when a
session gains attention. When no QuickTerm window is in the foreground it
flashes the primary window's taskbar button; when every window is hidden in
the tray it shows a tray balloon; at most once per terminal every 30 s. The
window title never changes: `hotkeys.py` finds the window to summon by its
exact title.

`rebind_hotkeys(cfg)` and `suspend_hotkeys(flag)` come from `app.py`'s
hotkey manager and sit on `ApiContext` like `notify`; both are None without
one. `rebind_hotkeys` registers exactly the summon key and the profile keys
`cfg` names and sets `cfg.hotkey_error`; `suspend_hotkeys(True)` releases every
global hotkey until `suspend_hotkeys(False)` or 20 s pass. Both wait for the
hotkey thread, so the routes call them through `asyncio.to_thread`.

`windows` is the registry shared with `app.py`'s native side; omitted, the app
builds a private one (headless, tests). `open_window(workspace, cwd) -> window
id` exists only when a pywebview shell is running; it blocks, so the route
calls it through `asyncio.to_thread`.

Static: serve packaged `quickterm/frontend/` at `/` and its viewer at `/viewer`.
There is no `/docs`, `/redoc` or `/openapi.json`: the schema listed every route
without asking for the token.

### Authentication

Three layers, in `api/guard.py`. The HTTP side runs in a plain ASGI
middleware (`LocalGuard`), not `@app.middleware("http")`, whose wrapped
`receive` hides a client disconnect from `request.is_disconnected()`; the
WebSocket route checks the same rules itself before `accept`.

1. **Host allowlist** (`127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`,
   plus the configured host): defeats DNS rebinding.
2. **Origin allowlist** (`http://` + each allowed host) when an `Origin` header
   is present: defeats cross-origin pages, including WebSockets.
3. **Per-install token** from `auth.py` (`get_or_create_token()`, stored in
   `<config dir>/runtime.token`), delivered to the page in the URL fragment
   `#t=<token>`. HTTP clients send it as the `X-QuickTerm-Token` header
   (`auth.HEADER`), WebSocket clients as the subprotocol `qtauth.<token>`
   (`auth.SUBPROTOCOL_PREFIX`), which the server echoes back. Exempt:
   `GET /api/health`, `GET /api/assets/{id}` (an `<img>` cannot send headers)
   and the static frontend. Every other `/api` route answers 403 without it,
   and new routes are gated by default. `tests/test_routes_auth.py` walks the
   route table to keep it that way.

The Host/Origin guard alone does not stop native local programs; the token
does.

REST (JSON, under `/api`):

| Method | Path | Body → Response |
|---|---|---|
| GET | /api/sessions | → `[SessionInfo + {attachments, busy, usage, activity, attention}]`; `attention` is `{kind: "bell"\|"notify"\|"exit", text, age_seconds}` or null. `busy` is always a boolean; `?metrics=false` still computes it from one process snapshot and skips only the per-process usage sampling, for lightweight sidebar/status polling. `usage` has `{available, working_set_bytes, cpu_percent, process_count, uptime_seconds, scope}`. `activity` has `{idle_seconds, background_output_bytes, background_output_age_seconds}`; background output is counted only after a previously attached viewer detaches and is acknowledged by the next attach. WSL resource scope is explicitly partial. |
| GET | /api/health | → `{app: "quickterm", version}`. No token; the running-instance probe. With `?challenge=<nonce>` (`[A-Za-z0-9_-]{16,64}`, else 400) it adds `proof`, the hex HMAC-SHA256 of the nonce keyed with the token: a local client proves it found this user's QuickTerm before it sends the token, and the proof of a caller-chosen nonce reveals nothing about the token. |
| POST | /api/sessions | `{profile?, cmd?, args?, cwd?, env?, name?, cols?, rows?, start_command?, agent_mode?, agent_session?, claude_mode?, workspace?}` → `SessionInfo` (profile name resolves from config; a bounded `start_command` override supports shell-profile recovery; explicit cmd overrides). `agent_mode` is valid only for a `claude-code` or `codex` profile (400 "agent_mode requires a Claude Code or Codex profile") and must be in that type's mode set. `claude_mode` stays an accepted alias; when both are given and differ, 400 "agent_mode and claude_mode disagree". The legacy messages "claude_mode requires a Claude Code profile" and "claude_mode must be new, continue, resume, or agents" stay byte-identical for `claude_mode`. `agent_session` must match `^[0-9a-fA-F-]{36}$` (400 "agent_session must be a session id") and is valid only with mode null (implies resume), `resume`, or `fork` (codex only), else 400 "agent_session needs resume or fork". Resolved by `launch.resolve` and started with `spawn_async`. 409 when the live-terminal limit is reached; 400 `Terminal "<label>": <reason>` when the folder does not exist (`starting folder does not exist: <cwd>`) or the process cannot start (`command not found: ...`), where label is the profile name, else `name`, else cmd. When the bundled PuTTY tools are present, their directory is appended (never prepended) to the spawned session's `PATH`, so `plink`/`pscp`/`psftp` are callable from every terminal. `ssh`/`sftp` profiles resolve to the OpenSSH or PuTTY argv in the launch.py section; 400 when the chosen client is missing ("OpenSSH client not found. Install it under Settings > Apps > Optional features > OpenSSH Client." for OpenSSH). |
| POST | /api/connections/{name}/open | Opens a saved RDP/VNC profile in its external client, off the event loop. Returns `{pid, profile, type, external: true}`; 404 for an unknown profile, 400 for a terminal profile or unavailable/invalid client. No session is registered and no credentials are stored. Token-gated. |
| PATCH | /api/workspaces/{name} | `{path?, logo?}` metadata-only edit under the workspace write lock. Preserves the latest layout, session ownership and temporary flag; 404 if missing; 400 for an empty body, unknown fields, or invalid metadata. Layout autosaves omit durable-workspace metadata so stale viewers cannot undo a folder/logo edit. |
| PATCH | /api/sessions/{id} | `{name}` → renamed `SessionInfo` |
| POST | /api/sessions/{id}/input | `{text, enter?}` → type into the session from outside (`quickterm send`): the UTF-8 text, plus `\r` when `enter`, goes to the PTY and marks the session touched → 204; 404 unknown id, 409 exited, 400 for a bad body, text over 64 KiB, a lone surrogate or nothing to send, 503 when the input queue is full |
| POST | /api/sessions/{id}/seen | The user has seen what the terminal asked for: clears its attention → 204; 404 for an unknown id |
| POST | /api/sessions/{id}/retain | Mark an explicit detach as user-owned so the untouched-shell reaper cannot end it → `SessionInfo` |
| POST | /api/launches | `{cwd?, profile?, workspace?}`, at least one → the validated item, queued for the existing viewer (Explorer's folder handoff and `quickterm new`/`open`). Unknown keys are ignored. 400 for a bad body or a missing folder, 404 `unknown profile: X` / `no such workspace: X`. The primary window's shell runs the launch loop: a workspace is focused when a view of this window already shows it, else opened as a new view (never switched into another view in place); a profile starts in the given folder or the workspace root, in the named workspace's view or the active one; a folder alone opens a new scratch view there. Route and payload shapes are unchanged from 3.x. |
| GET | /api/launches/next | Long-poll (20 s) and atomically claim one queued handoff → the queued item (`{cwd?, profile?, workspace?}`, as POST /api/launches validated it) or 204 after timeout; `?wait=false` is the nonblocking probe. Exactly one window gets each handoff, so with several windows open only the `primary` window's shell should poll. A waiter whose client has disconnected (a reload, a closed window) never takes an item, and an item taken just as its client left goes back to the front of the queue. |
| GET | /api/windows | → `{ttl_seconds, windows: [{id, workspace, title, primary, idle_seconds, age_seconds}]}`, oldest window first |
| POST | /api/windows | `{id?, workspace?, title?, primary?}` → `{id, workspace, title, primary}`. Announce a window and optionally claim in one step; a server-side id is minted when `id` is absent. Idempotent for a known id (a reload must not collide with its own claim or be counted twice against the limit). `workspace` is three-valued exactly like `path` on PUT /api/workspaces: **absent preserves**, `null` releases, a string claims. 409 on a claimed workspace or too many windows, 400 on a junk name |
| POST | /api/windows/{id}/heartbeat | → `{id, workspace, title, primary}`; **404 when the id is unknown or already expired**, which is the client's signal to re-register instead of carrying on autosaving a workspace it may have lost |
| PUT | /api/windows/{id}/workspace | `{workspace: name\|null}` → `{id, workspace, title, primary}`. 404 unknown window, 400 missing key/junk name, 409 `{detail, error: "workspace_claimed", workspace, owner: {id, workspace, title, primary}}` when another live window holds it. Never merged, never force-taken: both windows would autosave the same layout file |
| DELETE | /api/windows/{id} | Drop a window and free its claim now instead of waiting out the TTL → 204, idempotent (this is a closing page's goodbye and may arrive twice) |
| POST | /api/windows/open | `{workspace?, cwd?}` → `{opened: true, target: "native", window_id}`. Asks the desktop shell for another native window. 409 (same shape as above) when the workspace is already open, so nothing is drawn before the refusal; 400 on a junk name or a missing `cwd`; 500 when the shell refuses. Without a pywebview shell (plain browser, POSIX, tests) it answers **200** `{opened: false, target: "unavailable"}` so the caller degrades to opening the URL itself. The frontend's own routes are the JS bridge and `window.open`; this exists for callers that have neither, above all a second QuickTerm process handing work to the resident one |
| POST | /api/sessions/cleanup | `{session_ids}` → kill disposable sessions → 204; an id that is already gone counts as stopped; 500 when a process survives |
| POST | /api/sessions/kill-all | → attempt every live session → `{killed: int, killed_ids: string[], failed_ids: string[]}`. Partial failure remains HTTP 200 so clients remove only verified kills and keep failures visible for retry. |
| DELETE | /api/sessions/{id} | kill tree → 204; 404 when the registry no longer knows the id (also when `kill` raises `KeyError` because the id vanished during the call), 500 when the process survives. The two are not the same for clients: 500 keeps the pane visible, 404 means there is nothing left to stop and the pane MUST close, or a session the reaper already removed can never be cleared from the layout. `/retain` splits the same way. |
| GET | /api/profiles | → `[Profile]` |
| GET | /api/workspaces | → `[name]` |
| GET | /api/workspaces/{name} | → `Workspace` plus `path_exists: bool` |
| PUT | /api/workspaces/{name} | `{layout, logo?, session_ids?, path?}` → 204. `path`, `logo` and `session_ids` are three-valued: **absent preserves** the stored value (every layout autosave relies on this; an absent `session_ids` keeps the stored list plus the layout's panes), `null` (or `[]` for `session_ids`) clears it, a value sets it. `path` is normalized; its existence is NOT required, so a temporarily missing folder cannot break autosave. 400 on a wrong type or a non-string/oversized/control-character path. Serialized with DELETE under one lock. |
| DELETE | /api/workspaces/{name} | delete the workspace; kill only detached sessions whose live authoritative owner is still this workspace, spare attached or since-moved sessions, and abort on any verified kill failure → 204. Holds the same lock as PUT for the whole load/kill/delete, so an autosave in flight cannot write the deleted workspace back. |
| GET | /api/config | → `{font_family, font_size, theme, custom_theme, logo, default_profile, profiles, snippets, voice_available, scratch_dir, elevated, version, update_check, idle_timeout_s, max_sessions, hotkey_error, launch_error}`. `scratch_dir` is the resolved scratch folder. `hotkey_error` is set when a global hotkey parsed but Windows refused to register it (another program owns it), as `"<binding> is in use by another program"` (several: `"<a>, <b> are in use by other programs"`, a profile key written `"<binding> (<profile>)"`), or null. It reflects the latest registration, at startup or after a live rebind; Settings renders it beside the shortcut field. `launch_error` is the latest autostart or global-hotkey launch failure; the shell shows it in the error banner. |
| GET | /api/config/history | → `[{id, saved_at, summary}]`, newest first: the last 20 configs a save replaced (`<config dir>/history/`, same DPAPI protection as `config.json`; a save that changes nothing adds none). `summary` names the top-level settings that differ from the next newer version, or from the current config for the newest. |
| POST | /api/config/history/{id}/restore | Restore that version through the same path as PUT /api/config (validation, live apply, a new history entry) → 204; 404 for an unknown id, 400 when it no longer validates |
| GET | /api/config/full | → the complete **persisted** `AppConfig`, never the live one: `app.py` rewrites `port` at startup (`--port 0`, and unconditionally for an elevated instance), and Settings PUTs this object straight back. 500 when the persisted config cannot be read, rather than the live values. |
| PUT | /api/config | `AppConfig` object → 204; 400 for anything else. Omitted top-level keys keep their on-disk values, so a partial body cannot wipe profiles or their secrets. Only `port` and `host` need a restart; everything else applies at once, `scratch_dir`, `window` (the next window), `overlay` (the next summon) and `summon_hotkey` included. When `summon_hotkey` or any profile `keybinding` differs from the live config, the route awaits `asyncio.to_thread(ctx.rebind_hotkeys, cfg)`, which re-registers the global hotkeys and sets `hotkey_error`; a save that leaves the keys alone does not rebind. For a field in `cfg.runtime_overrides` (the port of a `--port` or elevated run) a submitted value equal to the running one is treated as unedited and the persisted value is kept, so a stale page cannot write an ephemeral port to disk; any other value, a revert included, is saved. |
| POST | /api/hotkeys/suspend | `{suspended: bool}` → 204; 400 "suspended must be true or false" for any other body. `true` unregisters every global hotkey on the hotkey thread so a Settings key capture records a combination QuickTerm already owns instead of firing it; `false` registers them again, and they come back on their own after 20 s. A no-op without a hotkey manager (browser, POSIX, tests). |
| GET | /api/system/agents | → `{types: [{id, label, executable, available, modes: [{value, label, detail}], default_mode, options: [{key, label, kind: "choice"\|"combo"\|"text"\|"lines"\|"toggle", choices?: [{value, label, detail?}], hint, advanced: bool, placeholder?}]}]}` for `claude-code` and `codex`. Settings generates the agent editor from it and hardcodes no option list. Cached 60 s in `ctx.inventory_cache`; `?fresh=true` rescans. |
| GET | /api/system/ssh-hosts | → `{path, exists, openssh: path\|null, hosts: [{alias, hostname, user, port, identity_file, proxy_jump}]}` from the static `~/.ssh/config` parser (`quickterm/ssh_config.py`), off the loop. |
| GET | /api/system/ssh-hosts/{alias} | → `{alias, hostname, user, port, identity_files: [..], proxy_jump}` from `ssh.exe -G <alias>` (CREATE_NO_WINDOW, 3 s timeout, off the loop), falling back to the parser. 400 when the alias starts with `-` or does not match `^[A-Za-z0-9._@:%-]{1,255}$`; 404 when the parser does not know it and `ssh -G` fails. |
| GET | /api/agent-sessions?type=claude-code\|codex&workspace=<name>&limit=20 | → `{sessions: [{id, title, updated_at, cwd}]}`, newest first, for the workspace folder (or `cwd=<path>` instead of `workspace`). Claude from `~/.claude/projects/<slug>/*.jsonl`, Codex from `$CODEX_HOME/session_index.jsonl` joined with each rollout's `session_meta.cwd`. `limit` is clamped to 1..100. 400 for a bad type, 404 for an unknown workspace; an unreadable store answers `[]`. Off the loop. |
| GET | /api/system/terminals | → detected terminal types and WSL distributions, plus `{id: "codex", label: "Codex CLI", executable, available}`. The `ssh`/`sftp` entries are `{id, label: "SSH"/"SFTP", executable, available, openssh: path\|null, putty: path\|null}`, `available` when either client exists. PuTTY is the bundled tools (`quickterm/putty_tools.py`: frozen `_internal/putty/`, dev `vendor/putty/` via `scripts/fetch_putty.py`), OpenSSH is `%SystemRoot%\System32\OpenSSH\ssh.exe` or `shutil.which`. The launcher lists them as profile-only (a hostless plink just prints usage). `installs` lists shells one step away: on Windows without PowerShell 7, `{id: "powershell-core", label, cmd, args, url}` with `cmd`/`args` a `winget install --id Microsoft.PowerShell --exact --source winget` (no `--accept-*` flag: the user answers in the terminal), or, without winget, `cmd: null` and `url` the GitHub release page. Cached for 60 s; `?fresh=true` scans again (an install terminal just exited). |
| POST | /api/assets | raw image body (≤1 MB) → `{id, url}` |
| GET | /api/assets/{id} | → stored PNG/JPEG/WebP/GIF/SVG/ICO |
| DELETE | /api/assets/{id} | → 204 |
| POST | /api/elevate | same body as POST /api/sessions, `agent_mode` and `agent_session` included → `{launched: true}`. Windows only (else 400). Resolved by `launch.resolve` like an ordinary terminal (an explicit `cwd` wins over the workspace root), then started by a separate elevated QuickTerm through UAC; 500 when the launch fails. |
| GET | /api/search?q=...&limit=... | → `[{session_id, name, workspace, alive, line, text, start}]`: case-insensitive substring search over every session's scrollback as plain text (`quickterm/transcript.py`: escape sequences, OSC 52 payloads and alternate-screen text dropped, carriage-return overwrites and ConPTY repaints resolved). One hit per line, in session then line order; `text` is at most 300 characters around the match, `start` counts code points, `line` is only a hint because xterm wraps lines. `limit` defaults to 200 and is clamped to 1..1000; 400 when `q` is blank or over 1 KiB. Snapshots are taken on the loop, the work runs in a thread. |
| POST | /api/sessions/{id}/export | Write that terminal's scrollback as plain text to `<Downloads or home>/QuickTerm/<name>-<YYYYmmdd-HHMMSS>.txt` (UTC; `-2`, `-3` instead of overwriting) → `{path}`; 404 unknown id, 500 when the write fails. Only on this explicit request does terminal output reach the disk. |
| GET | /api/file?path=... | → `{path, size, truncated, text}`. Read-only file viewer backend. Strips surrounding quotes and expands `~` like `/api/open`. Max 512 KiB read; decode utf-8 `errors="replace"`; 404 if missing, 400 if a directory or unreadable (`cannot read <path>: <reason>`). |
| GET | /api/fs/dirs?path=... | → `{path, name, parent, dirs, roots, truncated}`. Backs the in-app folder browser (`quickterm/browse.py`). One level of sub-**directories** only; files are never reported. `path` defaults to the home folder and accepts `~`/`%VAR%`; the answer is always resolved and absolute. `parent` is `null` at a root (drive, `/`, UNC share), which is when the client offers `roots`: mounted drive letters on Windows, `/` plus home on POSIX. `dirs` are `{name, path, is_git}` sorted case-insensitively; hidden entries (dot prefix, Windows HIDDEN attribute) are skipped, but a `.git` child is reported as `is_git` on its parent row. At most 2000 entries, then `truncated: true`. 404 when the path does not exist, 400 when it is not a directory or cannot be read (permission denied); never a traceback. The scan is blocking and runs via `asyncio.to_thread`. |
| GET | /api/update | → `{current, latest, update_available, url, notes, installable}`. Probes the pinned GitHub repo's latest release (cached 6 h; `?force=true` bypasses). 502 on network failure. |
| POST | /api/update/install | download latest Setup asset, verify against the release's SHA256SUMS.txt, launch installer → `{launched, version}`. Windows only (else 400). |
| POST | /api/open | `{target}` → `{action: "url"\|"opened"\|"revealed"}`. Terminal Ctrl+click. http(s) URLs and allowlisted passive local files open with the OS handler; every other file type is revealed in the file manager, never run (quickterm/opener.py). Other schemes/missing paths → 400/404. With `app` (`explorer` \\| `vscode`), `{target, app}` opens the existing folder `target` in that app → `{action: app}`: unknown app or not a folder → 400, missing folder → 404, VS Code not installed → 404 with a `detail` naming that. VS Code is launched from `Code.exe`, never the `code.cmd` shim (cmd.exe re-parses batch arguments, and the folder comes from an OSC 7 report). |

JSON bodies for session creation, elevation, and full-config updates are capped
at 1 MiB before buffering. API responses default to `Cache-Control: no-store`;
immutable asset responses retain their explicit long-lived cache policy.

WebSocket `/ws/session/{id}`, the attach protocol, in order. Unknown IDs are
rejected with close code `4404`. An **exited** session that is still in the
registry is served in replay-only mode (steps 1-3 below, then
`{"type":"exit","code":N}` and close) and accepts no input. (It used to be
refused with `4410`, which made overflow permanently lossy: the client is told
to reconnect and replay the ring, and if the PTY died around the overflow that
replay could never happen, so the session's final output was unreachable while
still sitting in the ring.) A fresh subscription is drained from the moment it
exists, so output produced during the replay handshake is delivered in order
once the live phase begins instead of overflowing the bounded queue:

1. server → text JSON `{"type":"replay_size","cols":C,"rows":R}` (the size the
   first retained byte was written at)
2. server → binary scrollback frames of at most 128 KiB; after xterm finishes
   parsing each frame, client → text JSON `{"type":"replay_ack"}`. Where the
   session was resized, the server ends the frame and, once it is
   acknowledged, sends text JSON `{"type":"replay_resize","cols":C,"rows":R}`
   (no ack); the client resizes xterm on receipt, which is in stream order
   because every earlier frame is already parsed
3. server → text JSON `{"type":"replay_done"}` (an empty replay keeps the
   legacy empty binary frame but requires no acknowledgement)
4. live phase:
   - server → binary frames: raw PTY output
   - server → text JSON `{"type":"exit","code":N}` then close, on session death
   - client → binary frames: raw keyboard input bytes (written to PTY verbatim)
   - client → text JSON `{"type":"resize","cols":C,"rows":R}`
   - client → text JSON `{"type":"touch"}` on the first real user input of a
     connection (a key, a native paste, a sent snippet or drop). Only this sets
     `SessionInfo.touched`: input frames also carry xterm's automatic replies
     (DA, CPR, focus reports), which must never make a shell look used.
   - unknown control frames are ignored

If a viewer falls behind its bounded queue, the server sends
`{"type":"overflow"}` and closes the socket. The client reconnects and replays
the current bounded scrollback instead of continuing with missing VT bytes.

Close codes:

| Code | Meaning | Client |
|---|---|---|
| 4403 | Host, Origin or token refused, before accept (browsers see an HTTP 403) | stop |
| 4404 | unknown session, or one the reaper is killing | show unavailable |
| 1002 | anything but a text `replay_ack` during the replay handshake, or no ack within 30 s | reconnect |
| 1009 | an input frame over 256 KiB | reconnect |
| 1013 | viewer fell behind (after `{"type":"overflow"}`), or the PTY input queue is full | reconnect and replay, even if the session has exited |
| 1000 | normal close after `{"type":"exit"}` | show the exit bar |

After a replay-only reattach of an exited session the server calls
`manager.acknowledge(sid)`, so the reaper may drop that session's unread
final output once it has been shown.

Client is responsible for replay-then-resize: set xterm to replay size, write
scrollback (resizing at each `replay_resize`), THEN resize to real size and
send resize message.

Server binds 127.0.0.1 by default. Host and Origin allowlists protect the local
HTTP and WebSocket routes against DNS rebinding and cross-origin browser use.

## quickterm/app.py

```python
def main() -> None

class _DesktopApi:
    def pick_folder(self, initial_directory: str = "") -> str | None
    def open_window(self, workspace="", cwd="") -> dict
        # {opened: True, window_id, workspace}
        # {opened: False, error: "workspace_claimed"|"invalid_workspace"|"unavailable"|"failed", ...}
    def window_bounds(self) -> dict | None
        # {"width": int, "height": int} of this window, pywebview logical units

class _ViewerWindows:                       # the native windows this process owns
    def adopt(self, window, window_id) -> None
    def open(self, *, workspace=None, cwd=None) -> str
    def show_all(self) -> None               # tray Open; the overlay when it is on
    def quit_all(self) -> None
    def count(self) -> int

def hotkey_error_text(failed: list[str]) -> str | None
```

### Window size, remembered bounds and the overlay

- `_window_cfg(cfg)` and `getattr(cfg, "overlay", None)` read the 4.0 fields
  with the spec defaults when a config lacks them.
- The primary window opens at `cfg.window.width` x `height`, or, with
  `remember_bounds`, at the bounds in `window_state.json` (x, y, width, height,
  maximized) when `window_state.clamp_to_screens(load(), webview.screens())`
  finds them still overlapping a monitor by at least 64 px both ways. The
  minimum size stays 760 x 480.
- Secondary windows open at the configured size, 32 px down and right of the
  primary when its position is known.
- `_BoundsRecorder` listens to the primary window's `resized`, `moved`,
  `maximized`, `restored` and `minimized` events. The events only set flags
  and restart a 500 ms `threading.Timer`; the timer reads the geometry from
  the window and saves it, so neither the GUI thread nor the event loop ever
  writes the file. A maximized window keeps its last normal bounds plus the
  flag. Nothing is recorded while minimized, while `remember_bounds` is off,
  or while the overlay owns the window.
- The overlay (`quickterm/overlay.py`) is driven by the summon hotkey on the
  hotkey thread and by tray Open on the tray thread. No Win32 call runs on the
  asyncio loop.
- Tray **Open** (`show_all`) drops the primary down as the overlay when
  `overlay.enabled`; with the overlay off, a window still in overlay style is
  restored to its saved style and placement first. A hidden overlay is just a
  hidden primary window, so the close and quit rules below are unchanged.

## quickterm/window_state.py

```python
MIN_VISIBLE = 64
def state_path() -> Path                                # config_dir() / "window_state.json"
def load(path: Path | None = None) -> dict | None       # None when missing or corrupt
def save(bounds: dict, path: Path | None = None) -> None   # atomic, via config.replace_file
def clamp_to_screens(bounds, screens) -> dict | None
```

Bounds are `{x, y, width, height, maximized}` in pywebview logical units, the
space of `create_window(x=, y=, ...)` and `webview.screens()`. Screens are
`{x, y, width, height}` mappings or pywebview `Screen` objects.

## quickterm/overlay.py

ctypes and stdlib only; every entry point is a no-op off Windows. All
geometry is Win32 physical pixels (the monitor work area and `SetWindowPos`
share that space), never pywebview units.

```python
def overlay_rect(work_area: tuple[int, int, int, int], edge: str,
                 width_pct, height_pct) -> tuple[int, int, int, int]
    # work_area is a RECT (left, top, right, bottom); returns (x, y, w, h),
    # centred horizontally, on the top or bottom edge, percentages clamped to
    # 30..100 and 20..100, integer pixels
def enabled(cfg) -> bool
def show_overlay(hwnd: int, cfg) -> None
def hide_overlay(hwnd: int, cfg) -> None
def restore_normal(hwnd: int) -> None
def show_normal(hwnd: int) -> None        # restore_normal, then show and focus
def is_applied(hwnd: int | None = None) -> bool   # None: any window
def applied_windows() -> list[int]
def hold_open(seconds: float = 3.0) -> None
def install_foreground_watcher(get_cfg: Callable[[], Any]) -> bool
def remove_foreground_watcher() -> None
```

- **Show**: `SetForegroundWindow` first, while the hotkey press still grants
  foreground rights. Then the work area of the monitor under the cursor
  (`MonitorFromPoint(GetCursorPos)`), or the primary monitor for
  `monitor: "primary"`. The old `GWL_STYLE` and `WINDOWPLACEMENT` are saved
  once per window; a minimized or maximized window is restored; `WS_CAPTION`
  and `WS_THICKFRAME` are stripped; `SetWindowPos` with `HWND_TOPMOST` (or
  `HWND_NOTOPMOST` without `always_on_top`) and
  `SWP_SHOWWINDOW | SWP_FRAMECHANGED`. A hidden window slides in from its edge
  in 6 steps over about 120 ms when `animate` is on and Windows client-area
  animations are enabled.
- **Hide**: slide back out of the edge, then `SW_HIDE`. The window stays in
  overlay style for the next summon.
- **Restore**: the saved style and placement go back (a maximized window comes
  back maximized) and the window drops `HWND_TOPMOST`.
- **Focus loss**: `install_foreground_watcher` runs on the hotkey thread
  (`HotkeyManager.run_on_thread`), whose message loop delivers the
  out-of-context `EVENT_SYSTEM_FOREGROUND` hook. With `hide_on_blur`, the
  callback hides every visible overlay when the new foreground window belongs
  to another process (PID check through `tray._pid_of`; focus moving into a
  workspace-view iframe is never a loss).
- `hold_open()` makes the watcher ignore foreground changes for 3 s.
  `opener.open_target`, `opener.open_folder` and `elevation.launch` call it,
  because Explorer, VS Code and the UAC prompt take the foreground on purpose.

- Fail fast unless `sys.getwindowsversion().build >= 17763` (Win10 1809).
- Optional positional `path` arg (Explorer "Open QuickTerm here"): if it is a
  directory, a first launch carries `?cwd=<dir>` in the window URL. A later
  ordinary process posts the folder to the authenticated `/api/launches` queue,
  summons the existing native viewer, and exits. The viewer opens it in a new
  scratch view.
- Right after reading its arguments (the launch folder is captured by then),
  Windows changes to the home folder: "Open QuickTerm here" starts the process
  in the folder the user clicked, and CreateProcess and `shutil.which` search
  the current folder before PATH. `NoDefaultCurrentDirectoryInExePath` is
  deliberately not used: as an environment variable it would reach every
  terminal and the app relaunched after an update, and change how cmd.exe runs
  programs from its own folder there.
- load_config → SessionManager → hotkeys thread (summon key, profile keys,
  overlay focus hook) → `create_app` with `rebind_hotkeys` and
  `suspend_hotkeys` → uvicorn (asyncio loop) → native Edge WebView2 viewer. `--port` and an elevated instance record
  `{"port"}` in `cfg.runtime_overrides`. Every client URL (window, running
  instance probe, launch handoff) and the free-port probe follow `cfg.host`,
  bracketing IPv6 (`server.client_host`). The viewer receives `_DesktopApi` as
  its pywebview JS bridge; `pick_folder` opens only an OS folder dialog and returns
  one existing selected directory or `None` on Cancel/failure. It is the
  secondary picker now, offered from inside the in-app folder browser; its
  docstring's claim that "the browser frontend deliberately cannot learn
  arbitrary host paths" no longer holds, because `GET /api/fs/dirs` lists
  directories to any token-holding client. That is a narrowing of what the
  bridge is for, not a new trust boundary: behind the same token
  `GET /api/file` already reads any file and `POST /api/sessions` already
  spawns arbitrary processes.
- An elevated instance calls `workspace.set_namespace("elevated")` before it
  serves or discards scratch, so it never touches the normal instance's files.
- Spawn autostart profiles on startup. Autostart, global hotkeys and the
  elevated instance's first terminal resolve through `launch.resolve` like a
  REST spawn; a failure is logged and stored as `cfg.launch_error` instead of
  being swallowed.
- Clean shutdown: manager.shutdown() on exit.

### Several windows, one backend

The window URL is `http://<client host>:<port>/?<params>#t=<token>`, where the
params are `cwd` (Explorer handoff), `workspace` (the workspace view the shell
opens first), `window` (**the id the shell MUST register with**, so a native
close can free its claims at once instead of waiting out the TTL) and `primary`
(`1` on the one native window the Explorer handoff and the summon hotkey aim
at). The top-level document is the shell; it hosts no workspace itself.

Opening a window: `_DesktopApi.open_window` is the primary route, because the
bridge runs every call on its own thread, which is where pywebview will
actually materialise a window while the GUI loop owns the main thread. It never
raises (a rejected bridge promise would carry a traceback into the page) and a
refused claim is an ordinary `{opened: false}` answer. In a plain browser the
bridge does not exist and `window.open` on the same URL is the whole feature;
`POST /api/windows/open` is for the callers that have neither.

Two lists of windows exist and they are NOT interchangeable. `WindowRegistry`
records what each window CLAIMS and expires on a missed heartbeat.
`_ViewerWindows` records the native shells this process created, and every quit
decision reads that one: a stalled heartbeat must never be read as "the last
window closed".

Close and quit, in the order the checks run:

1. A quit already in progress (tray **Quit**, `begin_update_shutdown`) or
   `_updating`: every window closes. Hiding to tray during an update strands
   Inno Setup at a window that refuses to go away.
2. Another window is still open: the close is allowed and nothing else happens.
   A secondary window is only a viewer, so closing it never stops the backend,
   another window's terminals, or any session; sessions stay backend-owned and
   reattach from whichever window claims their workspace next. Its workspace
   claim is released immediately.
3. Last window, no tray icon (elevated instance, or the icon could not be
   created): real quit. An elevated instance never hides, because a resident
   admin backend visible only in the notification area would be a foot-gun; it
   simply exits when its last window closes rather than on any close.
4. Last window, tray present: hide to tray iff a live session is `touched`,
   `retained`, or busy (`_sessions_worth_keeping`), else quit.

pywebview ends its GUI loop on the LAST window, not the first, so
`webview.start()` returns (and the backend stops) exactly when rule 2 stops
applying. Tray menu: Open / Quit, where Open restores every live window (the
primary as the overlay when that is on) and the summon hotkey also restores a
tray-hidden one. When the window holding the bare
title closes, the oldest survivor is retitled to it, because `hotkeys.py`
summons by exact title match and would otherwise have nothing to aim at.

## quickterm/cli.py

`quickterm <verb>` drives the running app over HTTP with the per-install token
(the port comes from the config, `--port` overrides). `app.main()` checks
`cli.is_command(argv)` first: an argument is a verb only when it is one of the
verbs below and not an existing folder, so Explorer's "Open QuickTerm here"
(which passes a folder path) is unchanged.

```
quickterm ls [--json]                           one line per session
quickterm new [--profile P] [--cwd D] [--workspace W]
quickterm open WORKSPACE
quickterm send SESSION TEXT... [--enter]        id, id prefix or exact name
quickterm --version
```

Every loopback call goes through one opener with no proxy handler (an
intercepting proxy would log the token and every `send`; a corporate one made
a running app look absent), and the token is sent only after `/api/health`
answered a fresh challenge with the right proof (`cli.probe` returns absent,
QuickTerm or impostor). `app.py`'s running-instance probe and Explorer handoff
use the same path.

Exit codes: 0 done; 1 usage error, or a session name that matches nothing or
several (the candidates are listed); 2 not running, something else answering
on the port without a valid proof, or a started app that never came up; 3 the
server refused (its detail is printed) or the request failed after QuickTerm
answered. `new` with no running app starts QuickTerm as a detached process
(`DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` on Windows, a new session on
POSIX, no inherited stdio): a folder alone goes as the positional folder,
anything else as the hidden `--handoff <json>` (a non-empty object of string
`cwd`, `profile`, `workspace`), which the app queues through `/api/launches`
once its backend is up, reporting a refusal as `launch_error`. The CLI waits
up to 20 s for a verified health answer and exits. The frozen build is a GUI-subsystem exe: a verb
attaches to the parent console and writes to `CONOUT$`; with no console it
prints nothing and still exits with the right code. cmd and PowerShell do not
wait for a GUI program, so scripts use `start /wait` in cmd.

## quickterm/launch.py

Every way of starting a terminal resolves it here: POST /api/sessions, POST
/api/elevate, autostart, global hotkeys and the elevated instance's first
terminal. Nothing here touches the session registry, but resolving blocks on
the file system, so async callers run it in a worker thread.

```python
class LaunchError(ValueError):  status: int; label: str | None
@dataclass(frozen=True)
class LaunchSpec:
    cmd: str; args: list[str]; cwd: str | None; env: dict[str, str]
    name: str | None; profile: str | None; label: str
    def spawn_kwargs(self) -> dict

def resolve(cfg, *, profile=None, cmd=None, args=None, env=None, name=None,
            start_command=None, agent_mode=None, agent_session=None,
            claude_mode=None, request_cwd=None,
            workspace_root=None, append_tools=True) -> LaunchSpec
            # claude_mode is the legacy alias of agent_mode
def resolve_profile(prof, cwd=None, *, agent_mode=None,
                    agent_session=None) -> tuple[str, list[str], str | None]
def validate_dir(value: str, label: str | None = None) -> str
def workspace_start(name: str | None) -> str | None
def append_tools_path(env: dict[str, str]) -> dict[str, str]
```

- Folder precedence: `request_cwd`, else `workspace_root`, else None (the
  session manager then uses `default_cwd()`). A folder that does not exist is
  `LaunchError("starting folder does not exist: <value>")`, named after the
  terminal; a workspace whose folder is gone yields None, never an error.
- `resolve_profile` per terminal type: PowerShell 7 and Windows PowerShell run
  the profile's `cmd` (the inventory stores an absolute path because a
  tray-resident app's PATH is stale) or the bare default, with `-NoLogo`, the
  profile's own args, then `-NoExit -Command <start>`; cmd.exe runs its args,
  then `/K <start>`. Arguments go before the start command because both
  shells read the rest of the line after `-Command`/`/K` as the command.
  bash/zsh/fish and Git Bash run `-l`, or `-lc "<start>; exec <shell> -l"`;
  Nushell runs `-e <start>`; WSL gets `-d <distro> --cd <folder or ~>` and no
  Windows process folder; ssh/sftp resolve per client (below). Agent profiles
  need a folder and raise without one.
- The bundled PuTTY tools directory is appended to the child's PATH (its key
  matched case-insensitively), so a user-installed plink still wins.

### SSH and SFTP

`ssh_client` null or `"putty"` keeps the pre-4.0 path: plink/psftp argv
`[-ssh] [-P port] [-i key] [user@]host [remote-command]`. `"openssh"` runs
`%SystemRoot%\System32\OpenSSH\ssh.exe` / `sftp.exe` on Windows, else
`shutil.which("ssh"|"sftp")`:

- ssh: `[-p port] [-i key] [-J jump] <profile args> [user@]host [remote command]`
- sftp: `[-P port] [-i key] [-J jump] <profile args> [user@]host`

When `ssh_host` is an alias from `~/.ssh/config`, ssh applies every directive
of that host itself and explicit profile fields override it. A missing client
raises "OpenSSH client not found. Install it under Settings > Apps > Optional
features > OpenSSH Client.", a 400 on the spawn.

`quickterm/ssh_config.py` is pure: it parses `~/.ssh/config` (one keyword per
line, `keyword value` or `keyword=value`, case-insensitive keywords, `#`
comments, double quotes group an argument, first value wins), follows
`Include` with globbing relative to `~/.ssh` up to depth 8 with a loop guard,
skips `Match` blocks, and keeps only literal `Host` patterns (no `*`, `?` or
leading `!`), de-duplicated. Per alias it returns `{alias, hostname, user,
port, identity_file, proxy_jump}`; unknown fields are null, `identity_file` is
the first entry with `~` expanded, and key files are never read.
`resolve(alias)` runs `ssh.exe -G <alias>` (CREATE_NO_WINDOW, 3 s) and falls
back to the parser.

### Agent profiles

`terminal_type` `claude-code` or `codex`. The mode is `agent_mode` from the
request, else the profile's `agent_mode`, else the type default (claude-code
`continue`, codex `new`). `agents.validate` checks `Profile.agent` on save;
`launch.resolve` stays the only launch path.

Executables: Claude is `profile.cmd`, else `shutil.which("claude")`. Codex is
`profile.cmd`; otherwise on Windows, when `shutil.which("codex")` is the npm
`.cmd` shim, the vendored native exe next to it
(`node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`,
or the arm64 one), else the shim, else `codex`. When the executable ends in
`.cmd` or `.bat`, every argument must be free of `" & | < > ^ % !` and CR/LF,
or resolve raises "<value> contains characters cmd.exe would reinterpret".

Claude argv, in order: mode args, option args, `profile.args`. Every value
flag is written `--flag=value`, because `--add-dir` and `--mcp-config` are
variadic.

| mode | argv |
|---|---|
| new | `[]` |
| continue | `[--continue]` |
| resume | `[--resume]`, or `[--resume, <uuid>]` with `agent_session` |
| agents | `[agents, --cwd, <cwd>]`; only model, permission_mode, effort and agent are emitted |

| `agent` key | kind | argv |
|---|---|---|
| model | combo (opus, sonnet, haiku, best, fable, opusplan, sonnet[1m], opus[1m]; free text `^[A-Za-z0-9._:\[\]-]{1,100}$`) | `--model=<v>` |
| permission_mode | choice: manual, acceptEdits, plan, auto, dontAsk, bypassPermissions | `--permission-mode=<v>` |
| effort | choice: low, medium, high, xhigh, max | `--effort=<v>` |
| session_name | text, one line, at most 100 | `--name=<v>` |
| add_dirs | lines, at most 16 of 1024 | `--add-dir=<d>` per line |
| append_system_prompt | text, advanced, at most 4096 | `--append-system-prompt=<v>` |
| agent | text, advanced, `^[A-Za-z0-9._-]{1,64}$` | `--agent=<v>` |
| mcp_config | text, advanced, at most 1024 | `--mcp-config=<v>` |
| settings | text, advanced, at most 1024 | `--settings=<v>` |
| fork_session | toggle, advanced, only with continue or resume | `--fork-session` |
| verbose | toggle, advanced | `--verbose` |
| ide | toggle, advanced | `--ide` |

Codex argv: mode args, then `--cd <cwd>` (every mode except agents), then the
options, then `profile.args`. The process cwd is the workspace folder too.

| mode | argv |
|---|---|
| new | `[]` |
| continue | `[resume, --last]` |
| resume | `[resume]`, or `[resume, <uuid>]` |
| fork | `[fork]`, or `[fork, <uuid>]` |
| agents | `[agents]`, with no options and no `--cd` |

| `agent` key | kind | argv |
|---|---|---|
| model | combo (models in `$CODEX_HOME/models_cache.json` with `visibility == "list"`; free text, same regex) | `--model <v>` |
| approval | choice: on-request, never | `--ask-for-approval <v>` |
| sandbox | choice: read-only, workspace-write, danger-full-access | `--sandbox <v>` |
| approve_for_me | toggle | `--approve-for-me` |
| bypass | toggle; invalid with approval, sandbox or approve_for_me ("bypass replaces approval and sandbox; clear them first") | `--dangerously-bypass-approvals-and-sandbox` |
| effort | choice: low, medium, high, xhigh, max plus the cache's levels, `^[a-z]{2,16}$` | `--config model_reasoning_effort=<v>` |
| search | toggle | `--search` |
| config_profile | combo (stems of `$CODEX_HOME/*.config.toml`), `^[A-Za-z0-9._-]{1,64}$` | `--profile <v>` |
| add_dirs | lines, as Claude | `--add-dir <d>` per line |
| worktree | toggle, advanced | `--worktree` |
| no_alt_screen | toggle, advanced | `--no-alt-screen` |
| oss | toggle, advanced | `--oss` |
| local_provider | choice, advanced: lmstudio, ollama; requires oss | `--local-provider <v>` |

A launch with `agent_session` becomes `claude --resume <uuid>`,
`codex resume <uuid>` or `codex fork <uuid>`. The session id is stored in the
pane's `launch_options`, so Restart resumes the same conversation. Without an
id, the CLI's own picker is the fallback.

## quickterm/hotkeys.py

ctypes RegisterHotKey in a dedicated thread with a GetMessageW loop. No
`keyboard` package. RegisterHotKey is thread-affine, so every change is a job
queued to that thread and woken with `PostThreadMessageW(WM_APP)`; the caller
waits up to 5 s for it. Call the waiting methods from a worker thread, never
from the asyncio loop once the server runs.

```python
@dataclass
class HotkeyEntry:
    binding: str
    callback: Callable[[], None]
    on_hotkey_thread: bool = False

def parse_binding(binding: str) -> tuple[int, int]     # (modifiers | MOD_NOREPEAT, vk)

class HotkeyManager:
    def __init__(self, loop: asyncio.AbstractEventLoop) -> None
    def register(self, binding, callback, *, on_hotkey_thread=False) -> bool
        # default: callback scheduled via loop.call_soon_threadsafe;
        # on_hotkey_thread=True: called on the hotkey thread itself
    def rebind(self, entries: Iterable[HotkeyEntry | tuple]) -> list[bool]
        # replace every registration, one result per entry; ends a suspension
    def unregister_all(self) -> None
    def suspend(self, seconds: float = 20) -> None   # release all, auto-resume
    def resume(self) -> None
    def run_on_thread(self, fn, *, on_exit=None) -> Any
    def start(self) -> None
    def stop(self) -> None

def summon_window(title: str = "QuickTerm") -> None
def toggle_window(title: str = "QuickTerm", overlay=None) -> None
```

Binding grammar, shared with the Settings key capture (`shortcut_input.js`):

- modifiers, joined with `+` and written in the order ctrl, alt, shift, win:
  `ctrl` (alias `control`), `alt`, `shift`, `win`
- keys: `a`-`z`, `0`-`9`, `f1`-`f24`, `grave` (alias `backtick`), `space`,
  `tab`, `esc`, `enter`, `minus`, `equal`, `comma`, `period`, `slash`,
  `semicolon`, `quote`, `bracketleft`, `bracketright`, `backslash`, `left`,
  `up`, `right`, `down`, `home`, `end`, `pageup`, `pagedown`, `insert`,
  `delete`, `numpad0`-`numpad9`. The named keys map to fixed virtual keys, so
  they mean the same physical key on every layout.
- a single punctuation character from an older config (`ctrl+alt+-`) still
  parses through `VkKeyScanW` under the current layout.

`app.py` registers the summon key with `on_hotkey_thread=True` as
`lambda: toggle_window("QuickTerm", getattr(cfg, "overlay", None))`, so the
live overlay settings are read at press time and the Win32 window work never
runs on the asyncio loop. Profile keys run on the loop and only schedule a
launch; the callback looks its profile up by keybinding at press time, so a
save that edits a profile but keeps its key launches the edited one.
`_GlobalHotkeys.rebind(cfg)` (the server's `rebind_hotkeys`) builds the entries
from `cfg`, calls `HotkeyManager.rebind` and sets `cfg.hotkey_error`;
`_GlobalHotkeys.suspend(flag)` is the server's `suspend_hotkeys`.

Summon and hide, `toggle_window`: find the window titled exactly "QuickTerm"
(EnumWindows). With `overlay.enabled` it hides the drop-down when it is
visible, in overlay style and in front, and otherwise shows it
(`overlay.show_overlay`). Without the overlay it minimizes the window when it
is in front, else restores and focuses it; a window still in overlay style
from before the overlay was turned off goes back to its saved style and
placement first and is shown. `summon_window` (a second process, the CLI)
only ever restores and focuses. Best-effort; degrade silently.

## quickterm/voice/ (parked)

Voice is currently NOT wired up: `_wire_voice` in app.py is a stub and the
Settings tab is hidden, because the hotkey had no capture overlay/feedback and
read as broken. The modules below remain and keep this contract for when a
real overlay exists.

`capture.py`: `Recorder`, start()/stop() -> numpy float32 mono 16 kHz via
sounddevice. `transcribe.py`: `Transcriber(model_size)`, with lazy
`WhisperModel` load on first use, `transcribe(audio) -> str`, language
auto-detect (de/en), VAD filter on.

ALL voice imports guarded: module exposes `voice_available() -> bool`;
missing deps must never break startup. Hotkey toggle: first press start
recording, second press stop → transcribe → `manager.write(focused, text.encode())`.

## frontend/

- `index.html`, `css/`, `js/` (ES modules, no build step), `vendor/` with
  pinned xterm: `@xterm/xterm@6.0.0`, `@xterm/addon-fit@0.11.0`,
  `@xterm/addon-webgl@0.19.0`, `@xterm/addon-web-links@0.12.0`,
  `@xterm/addon-unicode11@0.9.0` (the UMD `lib/*.js` builds and `css/xterm.css`,
  committed). 6.0 is the floor on Windows: the bundled OpenConsole is 1.24,
  and since 1.22 ConPTY does not repaint after a resize, so the terminal must
  reflow as ConPTY does, which 5.x did not.
- The top-level document is the shell (see **Shell and equal views** below);
  each workspace view runs the app described here in its own iframe document.
- `main.js` is the composition root (about 400 lines): it builds the modules
  below in order and hands each the dependencies it uses. State more than one
  of them reads lives in one object from `app_state.js`, read at call time;
  where a module built early calls one built later, `main.js` passes an arrow
  that resolves the later name when it runs. `window_registry.js` (register,
  claim, heartbeat), `launch_loop.js` (the Explorer handoff long poll),
  `workspace_switch.js` and `workspace_actions.js` (moving between, naming,
  saving and deleting workspaces), `autosave.js`, `scratch.js` (adopting and
  leaving scratch), `session_ownership.js` and `layout_sessions.js` (which
  terminals a layout owns), `spawner.js` (which shell and folder a new pane
  gets), `pane_commands.js` (what keys, palette and header do to the focused
  pane), `sidebar.js` (wiring `launcher.js`), `config_sync.js` (re-reading the
  config, `launch_error`), `here.js` (the focused terminal's folder),
  `boot_context.js`, `lifecycle.js` (pagehide), `feedback.js` (the error
  banner and live region), `fonts.js`, `updates.js`.
  `tests/js/main_modules.test.mjs` builds every factory from dependencies
  that throw when called, because `node --check` cannot see a closure
  variable that stopped resolving.
- `panels.js` owns only panel lifecycle and shared controls. Dashboard, help,
  settings sections, and DOM-free helpers live in `panel_*.js` modules. Keep
  new tabs/large sections out of the coordinator.
- `pane_protocol.js` is the DOM-free attach/replay/backpressure state machine
  used by `pane.js`; `node --test tests/js/*.test.mjs` verifies replay gating,
  stale generations, transition to live input, and overflow-driven resync. It
  also owns the once-per-connection `touch` frame (`takeTouch()`): real input
  (a key, a native paste, `sendText`) says so to the server, `onData` and
  `onBinary` never do.
- `windows.js` is the DOM-free half of multi-window ownership: which workspace
  this window may claim, what a refusal means, and the wording the user sees.
  `window_registry.js` holds the effects (register, claim, 5 s heartbeat, `keepalive`
  DELETE on `pagehide`); the decisions live here so they can be unit-tested.
  The rule it exists to enforce: two windows must never own one workspace,
  because the layout autosaves on every pane change and the loser's panes would
  be overwritten in silence.
- `split_tree.js` is the binary split tree under both the panes and the
  workspace views: `insertBeside` (a new leaf takes half of its anchor),
  `removeLeaf` (the split collapses into the sibling), `layoutRects` (pixel
  boxes for every leaf and divider) and `dwindleDir` (cut along the longer
  side, so repeated opens spiral inward like a tiling window manager).
  `pane_move.js` builds its drag surgery on it and serves both kinds of leaf.
  A new terminal with no direction of its own (`Alt+N`, attach, run profile)
  uses `LayoutManager.autoDir`, which is dwindle. Splits, closes, moves and
  rebalances slide: app.css transitions `flex-grow` on the children of a
  split carrying `.sliding`, never during a splitter drag, and
  `prefers-reduced-motion` turns it off.
- **Shell and equal views.** The top-level document of a native window is the
  shell. It hosts no workspace, no LayoutManager, no autosave and no
  terminals. It owns the sidebar, palette, panels, launch loop, global
  settings watcher, theme, update check, setup tour and `launch_error`
  banner, plus the tiled stage of workspace views. Every workspace, scratch
  included, is a same-origin iframe view running the app on one workspace,
  with its own registry id, claim, LayoutManager, autosave, focus ownership
  and heartbeat. There is no primary view.
  - `workspace_views.js` (`window.quicktermViews` in the shell) tiles the
    views. `open(name|null, {anchorWindow?, cwd?, first?}) -> Promise<view|false>`
    resolves once the view's `window.quicktermView` exists; `focusWorkspace`,
    `close`, `viewForWorkspace`, `viewForSession`, `appFor`, `views`,
    `list() -> [{workspace, label, color, active, window}]`, `activate`,
    `nameOf` and `zoom` complete it. `companionUrl(path, workspace, id, token,
    {cwd, first})` builds a view URL (`?workspace=<name>&window=<id>&embedded=1`,
    authentication in `#t=`); the view reserves its registry id first.
  - Views are leaves of a `split_tree.js` tree and share the pane rules: a new
    view takes half of the active view, cut along its longer side; a header
    drag docks it beside another view or swaps the two; each divider drags,
    answers arrow keys and Home/End, and double-clicks to balance, keeping
    15-85 % of its split and at least 160 px per side where there is room;
    **zoom** shows one view alone and again brings the rest back. Every view
    has its own colour. Views are never re-parented: an iframe that moves in
    the DOM reloads, so every view and divider is absolutely positioned and a
    layout change only writes its box, which is also what the slide animation
    transitions. Borders and headers appear from two views up.
  - A view stays on one workspace for its whole life. The sidebar, palette,
    dashboard and launch loop open or focus a view; they never switch a view
    in place. `switchWorkspace` remains for the restore inside a view,
    promoting a scratch to a named workspace (rename in place) and a deleted
    workspace.
  - Opening a workspace already shown in this window focuses its view (zoom
    aware). One claimed by another native window is refused with the existing
    text in `#app-error` and nothing is drawn.
  - Every view has a close button and every close works the same way: wait
    for a successful save, mark every owned terminal retained, release the
    registry entry, remove the iframe. Nothing is killed; a failed save keeps
    the view open. Deleting a workspace that is open closes its view first,
    then calls `DELETE /api/workspaces/{name}`.
  - Closing the last view leaves an empty stage with one centred block, "No
    workspace open. Open one from the sidebar." and a **New scratch** button.
    It is content, not a chrome bar.
  - **New scratch** always opens a new view `scratch-view-<registry id>`
    (`temporary: true`). It never replaces another layout.
  - Arrangement: the shell stores `quickterm.workspaceViews` in localStorage,
    `version: 2`, the split tree of `{workspace, window}` leaves plus the
    active and zoomed view. A v1 arrangement migrates: its `{primary: true}`
    leaf becomes `{workspace: <remembered workspace>}`, or is dropped for
    scratch or a missing name.
  - Shell boot: restore the stored arrangement (release each stored registry
    id, claim again, drop scratch, missing and refused views). With `?cwd=`
    (Explorer "Open QuickTerm here") also open a scratch view there and focus
    it. If nothing was restored, open `quickterm.activeWorkspace` when it still
    exists (read once, for migration), else one scratch view flagged `first=1`.
    Only that first scratch view adopts an existing "Administrator - …"
    session, the elevated first terminal.
  - `window.quicktermChrome` (shell) holds `{palette, panels, saveState(text,
    status), showError, clearError, ownsKeyboard(), refreshSoon(),
    settingsEvents, selectedTerminal, scratchLabels}`. `window.quicktermView`
    (each view) holds `{workspace(), app, suspend, close, syncConfig,
    syncWorkspaces, previewTheme, whenRestored}`. A view app adds
    `killSessionById(id)`, `detachSessionById(id)` and `hereState()`.
  - Keyboard: `keys.js` runs in the shell and in every view. The shell routes
    its actions to the active view's app; Alt+N with no view opens a scratch
    view. Native window focus (summon hotkey, taskbar) lands on the shell,
    which forwards it to the active view's focused pane. Views respect the
    shell's overlays through `parent.quicktermChrome.ownsKeyboard()`.
- Panes: an exited pane shows `[exited · code N]` with a Restart action
  (button, Enter in the pane, "restart terminal" in the palette) when it knows
  its launch (a profile or a launch spec; an attached terminal started
  elsewhere does not). The restart repeats that launch with its
  `launch_options` and keeps the old output above a `[restarted]` mark; on
  Windows the old screen scrolls into the scrollback first, because a new
  ConPTY addresses rows as if the screen were empty. "broadcast input to all
  panes in this workspace" mirrors real input (never xterm's automatic
  replies) to every other live pane in the document; a paste is re-pasted in
  each target so its own bracketed-paste mode frames it. It turns off on a
  workspace switch.
- `menu.js` is the one popover menu behind every chooser in the chrome (the
  terminal picker, the workspace menu). Fixed-position under its anchor,
  clamped inside the viewport (`menuPosition`, pure), it claims the keyboard
  in `focus.js` while open, walks with arrows/Home/End/typeahead
  (`stepIndex`, `typeaheadIndex`, pure), runs on Enter or click, closes on
  Escape, Tab, an outside press, resize or blur, and hands the keyboard back
  through `onClose`. Rows carry a label, a detail line, a hint, a check or a
  colour dot, and optional row actions shown while the row is active.
  `toggleMenu` is for a trigger's click handler: the press that closes an
  open menu does not reopen it.
- The sidebar offers **workspace here** (`hereState()` in `main.js`,
  patched through `launcherView.updateHere` on every status refresh) when
  the focused terminal's folder is outside the current workspace's folder
  or in scratch: a folder that already is a workspace's root offers to open
  that workspace, any other offers to create one named after the folder.
  `createWorkspaceHere()` writes the terminal into the target's layout
  first, retains and detaches it here, then opens or focuses the target's
  view, whose restore attaches it again; a name clash, an invalid folder name or a workspace
  held elsewhere is reported and nothing moves. Folder roots come from one
  `GET /api/workspaces/{name}` per saved workspace, off the boot path.
- Workspace saves are serialized per name in `workspace.js`, with argument
  snapshots taken at invocation. Server workspace PUTs serialize their
  read/preserve-path/write/ownership-sync sequence without blocking the event
  loop. Switching saves the outgoing workspace while its claim is still held,
  then claims the destination before replacing the layout. Concurrent switches
  are refused. On pagehide, the final PUT uses the same save queue with
  `keepalive`, then releases the claim. Unload delivery is best-effort because
  the browser may destroy the document before queued work finishes; explicit
  view close awaits saving before removing its document. Scratch is
  left to the backend idle reaper instead of being unconditionally killed.
- The sidebar footer is built from the `chrome` array the shell passes to
  `initLauncher`, each entry `[label, onClick, shortcut?]`, with the labels
  "new window", "dashboard", "settings" and "help". `launcher.js` maps
  the label to a glyph in `navIcons`; an unmapped label falls back to the
  terminal icon, so a new entry needs one line there as well.
- `render.js` is the keyed reconciler behind every live panel. A refresh must
  patch, never rebuild: the dashboard reloads every 5 s and recreating its DOM
  destroyed half-typed input and the folder picker's captured field. Nodes are
  reused per key and never moved when already in place, because detaching a
  node blurs a focused control inside it.
- `focus.js` decides who owns the keyboard. A pane re-asserts `term.focus()`
  immediately, on a frame, and on a timeout, so an overlay that focuses its own
  control must claim first and release before handing back.
- `document.title = "QuickTerm"` (hotkey summon matches on this).
- Layout tree in JS mirrors the workspace JSON schema exactly.
- Panes: each pane = one xterm.js + one WS. Debounce resize ~50 ms. Use
  `term.write(data, cb)` callbacks for backpressure.
- Focus: 2px theme-accent rail with a compact semantic state dot; inactive
  terminals remain fully readable.
- Chrome: the sidebar is the whole chrome. There is no status bar, no top bar
  and no quick-settings drawer. A lone pane has no header: the layout mounts
  it as the direct child of `#grid` and CSS hides `.pane-tab`/`.pane-actions`
  there. Headers return with a second pane and their actions draw only on
  hover, focus, or while armed. A zoomed pane (mounted in `#zoom-host`) keeps
  its header; its zoom control reads "Show all panes" and stays drawn, the
  palette row reads "show all panes", and the terminal keeps the keyboard.
  Focusing a pane the zoom hides unzooms first. Alt+Z on a lone pane only
  flashes "[only one pane]".
- Sidebar (`launcher.js`). The shell calls `initLauncher(el, {actions, chrome,
  elevated})` once and gets `{update(partialModel), updateHere(here),
  cycleTerminal, mode, setMode, cycleMode}`; every data change goes through
  `update`, which patches groups keyed `group:<key>` and rows keyed
  `session:<id>` with `render.js patchList`. An open kill popover, menu or
  rename input survives the 10 s poll; a popover whose row disappears closes
  itself. One flat list, top to bottom:
  1. The launch row: `+ <choice>` opens a saved terminal, the chooser chevron,
     the gear (terminal manager), the admin shield. The chooser lists
     configured profiles only; detecting a shell never makes it a default or
     adds it to the launch menu. With no saved terminals, the launch action
     opens setup.
  2. A **Workspaces** label with a `+` menu (`menu.js`): **New scratch view**,
     **Workspace here: <name>** when the active view offers it, **Open in new
     window…**.
  3. One group per saved workspace, empty ones included, in case-insensitive
     alphabetical order; scratch groups next, ordered by label; then
     **Unassigned**. A group head is a button with the fold chevron (hidden
     without rows), a colour dot (the view colour when open, hollow when
     closed), the label and the count pill; its title is the folder path, with
     `.warning` when the folder is missing. A click opens or focuses the view;
     Left and Right fold. Hover and focus-within actions: **Close view** (`x`,
     only when open; saves and retains) and a kebab menu with Open in new
     window, Workspace settings (the Dashboard workspace editor) and Delete
     workspace… (confirm popover: "Delete workspace <name>? Detached
     terminals it owns are killed; attached ones keep running."). The
     **active** group adds a second line: the folder name, the **workspace
     here** button when offered, Explorer and VS Code buttons on hover
     (`openFolder`; also Alt+Shift+E / Alt+Shift+C and two palette rows) and
     the one `#sb-save` dot (same id and `data-state` contract, driven by
     `feedback.js`).
  4. The footer: new window, dashboard, settings, help, collapse chevron.

  Order is stable: groups as above, rows by name, then id (`localeCompare`
  with `numeric: true`). State never reorders anything: "needs you" is a chip,
  `.needs-you` on the row and `.has-attention` on the group, plus the rail
  dots. A session's owner is `attached[id] ?? owned[id] ?? session.workspace
  ?? null` (pure `sidebarGroups(sessions, {workspaces, views, attached,
  owned})`). Nothing in the sidebar drags except the width grip. No native
  `<select>` anywhere. Three modes, remembered in `quickterm.sidebarMode`:
  `full` (resizable, 150 to 400 px), `rail` (30 px: plus, one dot per listed
  terminal across all groups, gear, chevron) and `hidden` (nothing;
  `#float-launch` is pinned 12 px from the top over the terminal's left edge,
  `+` opens a terminal, right-click or `›` shows the sidebar; the old float
  drag and `quickterm.floatTop` are gone). Alt+Shift+S cycles the modes.
- Sidebar terminal rows: a state dot, the name, a folder line when the sidebar
  is wide, chips. A click (`activateTerminal(session)` in the shell) focuses
  the view that has the session attached and then the pane; else focuses the
  owner workspace's open view and attaches it there (a finished row through
  `finishedAttachRecord`); else opens the owner workspace's view, whose
  restore attaches it; an Unassigned row attaches into the active view, or
  into a new scratch view when none is open. Every click marks the session
  seen. Hover and focus-within actions: **Detach** (icon `unplug`, title
  "Detach <name>: keeps running"), only while the terminal is attached in a
  view of this window, and **Kill** (`.danger`, icon `stop`, title and
  aria-label "Kill <name>…"), always on a live terminal. Double-click or F2
  renames (`PATCH /api/sessions/{id}`, then `Pane.setTitle`). The context menu
  (right-click, Shift+F10, ContextMenu key) is a `menu.js` menu: Open, Move to
  <active workspace> (live terminals not already in it), Detach (when
  attached), Rename, Kill….
- Sidebar kill. Kill always opens the confirm popover (`confirm_popover.js`,
  `confirmNear(trigger, {message, confirmLabel, action, keyboard, owner,
  onClose})`, placed by the pure `confirmPlacement`) anchored to the row:
  "Kill <name>? This stops its whole process tree.", buttons **Kill** (danger)
  and **Cancel**. A pointer focuses Cancel; the keyboard path (Delete on a
  focused row, the context menu opened from the keyboard) focuses Kill, and
  Enter completes. Escape cancels. While open, the trigger stays visible and
  disabled, the popover is clamped inside the viewport and follows its row
  while the list scrolls, and it claims `focus.js` owner `"sidebar-confirm"`,
  handing focus back to the active view's terminal on close. Only verified
  kills disappear: a 500 keeps the row, shows the server's `detail` in the
  popover and relabels Kill as **Retry**; a 404 counts as gone. The shell's
  `killTerminal(session)` routes it: a view with a pane on the session runs
  `app.killSessionById(id)` (kill, 404 falls through, forget, close the pane,
  autosave); else the owner workspace's open view runs the same
  `app.killSessionById(id)`, so its in-memory ownership drops the id before
  the next autosave; else the shell calls `api.killSession(id)` and
  `removeSessionsFromSavedWorkspaces`. A 500 is thrown back to the popover.
  The pure decisions are `rowAction` and `killRoute` in `shell_routing.js`.
- Dashboard: dense saved-workspace rows, global/current ownership and resource
  statistics, detached-session management, and quick profile launch.
- Workspaces: named workspaces autosave layout and session IDs and restore the
  exact live sessions; the shell's arrangement remembers which views were
  open. Every scratch view uses `scratch-view-<registry id>` with
  `temporary: true`, displayed as `scratch N`, autosaves and survives a view
  close within a run. Startup/shutdown delete the legacy scratch file and
  flagged temporary workspace files, never the scratch folder contents or
  unrelated workspaces. Names `scratch`, `scratch-view-*`, and dot-prefixed
  names are reserved in the user save flow. Promoting scratch saves a normal
  durable workspace in place.
- The sidebar lists every live terminal on the backend in its owner's group.
  Chips appear only for needs you, new output, busy and open elsewhere.
  Dashboard has separate **this workspace** / **all live** statistics plus
  explicit Unassigned ownership, and says "open workspace" for its rows.
- Settings, with no raw JSON editor. Tabs (`settingsTab` ids):
  - `general` "General": appearance, font, default terminal
  - `window` "Window": size presets through `configChoice` (1280×800,
    1440×900, 1600×1000, 1920×1080, Custom W×H), **Use this window's size**
    (`window.pywebview.api.window_bounds()`, else `outerWidth`/`outerHeight`),
    the remember toggle, the Overlay group (enable, edge, width %, height %,
    always on top, hide when focus leaves, monitor, animate) and the summon
    shortcut with a note that overlay mode changes what it does
  - `shortcuts` "Shortcuts": the summon key, every profile's global key in
    one table, and the in-app key reference
  - `connections` "Terminals" (`terminals` is accepted as an alias): master
    and detail
  - `snippets` "Snippets": master and detail
  - `advanced` "Advanced": host, port, scrollback, idle cleanup, limit,
    scratch folder, update check
  - `about` "About"

  `Panels#showSetting(id)`, `Panels#showConfig("terminal"|"snippet",
  name|null)` and `Panels#settingEntries()` are the entry points for the
  palette and search. `Panels#showWorkspace(name)` opens the Dashboard with
  that workspace's folder and logo editor open (the sidebar's "Workspace
  settings"). Every chooser is `configChoice` (a `menu.js` menu);
  `Panels._select` and every native `<select>` are gone. Every field stamps
  `data-setting=<id>`.
- Master and detail (`config_list.js`): on the left a filter input (always
  shown) and one-line rows (dot, name, muted "type · target" or a command
  preview, a problem marker, a dirty marker, hover actions **Open** and
  **Remove** with the confirm popover); on the right the editor of the
  selected item. Rows are patched with `patchList`; typing in the editor
  updates its row through `setText` and never rebuilds the editor; selection
  survives filtering. Below 820 px the detail replaces the list and shows a
  Back button. **Add** is a `menu.js` menu with headings (Shells, Agents,
  Remote, From ~/.ssh/config, Devices, Containers, Desktop) built from
  `CONNECTION_CATALOG`; Codex sits under Agents.
- Terminal editor: name, description, type label, executable or command line;
  then the type's fields; then launch mode, shortcut (capture input) and
  autostart. Arguments (one argv item per line), environment (key/value
  controls) and the start command sit under one **Advanced** disclosure.
  Local terminals expose executable, detected WSL distributions, startup
  command, shortcut and autostart. Serial, Telnet, Docker, Podman,
  Kubernetes, RDP and VNC expose their typed fields. Desktop profiles say Open
  window, terminal profiles Open terminal. The pure helpers `runLine`,
  `profileProblems`, `kindForCommand`, `splitCommandLine`, `joinCommandLine`,
  `takesStartCommand` and `purposeFor` live in `profile_model.js`.
- Agent editor (`claude-code`, `codex`): the fields are generated from
  `GET /api/system/agents`, so the frontend hardcodes no option list. The
  mode is `profile.agent_mode ?? profile.claude_mode ?? (codex ? "new" :
  "continue")`, labelled new "new conversation", continue "continue latest",
  resume "choose session", fork "fork a session" (codex only), agents "agent
  manager". Profiles created here start at `new`. Advanced options sit under
  the Advanced disclosure. The agent executables are detected in the terminal
  inventory but stay profile-only, never generic system shells.
- SSH and SFTP editor: **Host** is free text plus a `menu.js` suggestion list
  of `~/.ssh/config` aliases, each with detail `user@hostname:port`. Choosing
  an alias sets `ssh_host=<alias>` and `ssh_client="openssh"` and fetches
  `GET /api/system/ssh-hosts/{alias}`; the resolved values show as
  placeholders in User, Port, Key and ProxyJump, where an empty field means
  "from ~/.ssh/config". A **Fill from ~/.ssh/config** text button copies them
  into the fields. **Client** chooses OpenSSH or PuTTY and is hidden when only
  one is installed; ProxyJump shows only for OpenSSH; the key hint changes per
  client. A PuTTY profile whose key does not end in `.ppk` offers a **Switch
  to OpenSSH** text button. `ssh` relabels the start command as a remote
  command; `sftp` hides it. The Add menu's "From ~/.ssh/config" heading has
  one row per alias, each creating an ssh profile named after the alias (made
  unique) with `ssh_host=<alias>` and `ssh_client="openssh"`.
- One Save. The footer **Save** persists everything (profiles, snippets,
  settings) through `settingsPatch`; the detail editor's **Save** button and
  Ctrl+S inside the sheet trigger the same save. There is no per-connection
  persistence. Unsaved rows show a dirty marker, and **Open** stays disabled
  for an unsaved or dirty item. Cancel discards the draft. Removal leaves live
  sessions running and is committed by Save. A saved change to the summon key
  or a profile key applies at once (live rebinding); only host and port still
  say they apply after a restart.
- Key capture (`shortcut_input.js`): a button shows the binding as `kbd`
  chips, or "Not set". Click or Enter starts capture ("Press a shortcut… Esc
  cancels, Backspace clears"): it calls `claimFocus("shortcut")`, listens for
  keydown in the capture phase on `window` with `preventDefault` and
  `stopImmediatePropagation`, leaves plain Tab alone, and calls
  `api.suspendHotkeys(true)` (POST /api/hotkeys/suspend) so a combination
  QuickTerm already registered is recorded instead of fired. Finish, blur or
  cancel calls `api.suspendHotkeys(false)` and releases focus; the server
  resumes on its own after 20 s. The pure `bindingFromEvent(e)` ignores lone
  modifiers and returns `{binding, label}` built from `e.code` (layout
  independent), modifiers in the order ctrl, alt, shift, win, in the hotkeys.py
  grammar. `shortcutWarnings(binding, {summon, profiles, selfIndex})` reports
  errors (no ctrl, alt or win; a duplicate of the summon key or another
  profile's key, as `validate_config` does) and warnings (a cold Alt key
  `keys.js` claims; a plain Alt pass-through key such as Alt+V/P/H/0-9/-,
  Alt+B/F). The capture input serves the summon key, every profile
  `keybinding` and the parked voice hotkey. `keys.js` exports one `SHORTCUTS`
  table `[{id, keys, label, group}]`; the Help panel and the Shortcuts tab
  render from it.
- Settings search: a search input tops the tab nav, with a `/` focus hint
  while the sheet is open. While it holds text, the content area shows results
  grouped by tab: settings from `SETTINGS_INDEX` plus a row per terminal and
  snippet in the draft. Choosing one switches tab, scrolls
  `[data-setting=<id>]` into view, focuses its control and flashes it; a
  terminal or snippet result selects its row in the master list. Escape clears
  the box before it closes the sheet.
- Advanced exposes loopback host and stored voice preferences as controls;
  voice capture remains unavailable. A first-run three-step setup tour opens
  only with no configured profiles and no completed-tour flag, and is available
  again from Help.
- Themes: four featured choices stay visible; the catalog groups all remaining
  palettes under Dark, Neon, Soft, Warm, Light, and Custom. Clicking a theme previews
  both application chrome and every open xterm immediately; Cancel restores the
  persisted theme.
- State scope: saved theme/custom palette, font defaults, profiles, snippets,
  default terminal, retention/limits, scratch folder and other config are
  backend-wide. `global_settings.js` publishes a revision-only storage event
  after saves and refreshes on native-window focus; each receiving parent
  reloads config and the workspace catalog into all its views without
  rebroadcasting or rebuilding an open editor. Settings sends only changed
  top-level fields and rejects stale conflicting edits. Unrelated config saves
  never reset pane-local font zoom. Theme preview/cancel covers all views in
  the editing window; a committed theme reaches other native windows.
  Sidebar mode/width, folded groups, launch choice, focused view and view zoom
  belong to the native window. Workspace roots/logos/layout/session ownership
  belong to a workspace. Text zoom, cursor, input, terminal output and terminal
  lifecycle belong to a pane/session. Workspace-catalog changes refresh other
  views without replacing their layouts or moving their terminals.
  Workspace folder/logo controls live in Dashboard's workspace Settings editor,
  separate from global Settings, and commit together on Save. Replaced uploaded
  images are not deleted while a saved config or history entry may reference
  them; cancelling a draft cannot erase the previous logo.
- Font size: Ctrl+±/0 change the focused pane only and are temporary; the
  saved default for every pane lives in Settings. Pane sizing lives on the
  splitter (drag, keyboard, double-click to balance) and Alt+Z zooms.
- Pane rearrangement: drag a pane header onto another pane. The outer 30 %
  band of the target docks the dragged pane on that side (a new split at
  ratio 0.5; the split it left collapses into its sibling), the middle swaps
  the two leaves and keeps every ratio. `pane_move.js` is pure and
  unit-tested; `LayoutManager.movePane` renders and autosaves the result
  through `onLayoutChange` like a split. A drag starts after 6 px of travel,
  so click-to-focus and double-click-to-rename are unchanged; Escape cancels
  it; a lone pane has no header and a zoomed one refuses the drag.
- Closing a pane (detach, kill, kill all) collapses its split into the
  sibling: the tree changes at once, the box slides shut, and the DOM is
  re-rendered when the slide ends. The survivor always gets the space.
- The kill bar (`Pane.confirmAction`): opened from the keyboard (Alt+W, the
  palette) it focuses **Kill**, and Alt+W or Enter again completes it; opened
  from the header button it focuses **Cancel**. Escape cancels from anywhere
  in the pane. Alt+W on a pane without a live terminal flashes a notice.
- Starting folders belong to workspaces, not profiles. An explicit launch
  directory overrides the workspace root; missing or deleted roots fall back
  to the home folder. WSL launches translate Windows roots for `--cd`, and
  use `wsl.exe --cd ~` with no root. The profile startup command runs after
  that location is selected. Every folder field is
  built by the one shared `folderPickerControl(input, options)` in
  `panel_shared.js`, which keeps manual entry and dispatches a bubbling `input`
  event on the field when a folder is picked, so callers need no second
  listener. Cancel preserves the prior value.
- Browse opens the in-app directory browser (`folder_browser.js`, backed by
  `GET /api/fs/dirs`), starting from whatever the field already holds. It works
  in every viewer, including a plain browser tab, so Browse is never disabled.
  The native pywebview dialog is a **secondary** action offered from inside
  that modal, and only where the bridge exists. It stopped being the mechanism
  because it exists only in the installed app and moves focus out of the
  document while it is open.
  Modal contract: it resolves to an absolute path or `null`, claims the
  keyboard through `focus.js` for as long as it is open (a focused pane
  re-asserts `term.focus()` on a rAF *and* a timeout, so an overlay that does
  not claim loses its own input a frame later), and releases on close.
  Keyboard (`folderBrowserAction(key, {ctrl, where})`, pure and unit-tested,
  where `where` is `"path"` / `"row"` / `"other"`): Escape cancels; Ctrl+Enter
  uses the folder you are currently in; Enter in the path bar goes to the typed
  path; Enter or Right descends into the focused row; Left or Backspace goes to
  the parent; Up/Down move between rows and step out of the path bar into the
  list; Home/End jump to the first and last row. Enter on a footer button is
  left to that button, and Left/Right/Backspace stay editing keys in the path
  bar. Rows carry `tabindex="-1"` (roving focus), so Tab cycles the modal's
  controls rather than every folder, and the modal traps Tab itself because the
  panel behind it traps Tab into its own element. "Use this folder" resolves a
  path that was typed but never listed, so a typo shows an error in the modal
  instead of becoming a workspace folder that does not exist.
- Command palette Alt+K: one input, a small kind label per row, fuzzy over
  profiles / actions (new terminal, split h/v, zoom, detach, kill, open folder
  in Explorer / VS Code, open file viewer) / snippets / recent sessions, plus:
  - `open workspace: <name>` → `app.openWorkspace(name)` (replaces "load
    workspace" and "show workspace beside…"), `close workspace view: <name>`
    for open views, `new scratch view`
  - `go to terminal: <name>` for every listed terminal on the backend (hint:
    workspace label and state) → `app.activateTerminal(session)`
  - `kill terminal…`, a sub-mode listing live terminals. Choosing one shows
    "kill <name>? Enter kills, Esc goes back" with the kill row pre-selected,
    because this is a keyboard path; it calls `app.killTerminal(session)` and
    shows a failure inline
  - `setting: <label>` (kind `setting`) from `app.settingEntries()` →
    `app.openSetting(id)`; `edit terminal: <name>` →
    `app.editTerminalConfig(name)`; `edit snippet: <name>` →
    `app.editSnippet(name)`
  - agent rows per agent profile: "<type> new / continue / choose session /
    fork (codex) / agent manager: <profile>", "split agent view: <profile>",
    and `resume <Claude|Codex> session: <title>` for the active workspace,
    filled late from `api.listAgentSessions`
  - prefix filters parsed in `_refilter`: `>` actions, `@` workspaces and
    terminals, `#` settings and configs, `!` snippets; a prefix alone lists
    that kind

  Sub-modes: kill, search, new window. There is no free-text workspace
  prompt, because a typo used to tear the whole layout down silently; saving
  is owned by the Dashboard, which validates the name and shows the error.
  Snippet rows carry the command text and the destination pane, and a
  multi-line snippet is confirmed in the pane before it runs. Pane sizing is
  not duplicated here; it lives on the splitter.
- App object seen by the palette, panels and dashboard (the shell wires it;
  shell members win over the active view's app): `openWorkspace(name)`,
  `loadWorkspace(name)` (alias), `closeWorkspaceView(name)`, `newScratchView()`,
  `openWorkspaces()`, `liveTerminals() -> [{session, workspace, label,
  attachedIn}]`, `activateTerminal`, `killTerminal`, `detachTerminal`,
  `settingEntries`, `openSetting`, `editTerminalConfig`, `editSnippet`,
  `setupTerminals`. Per view, from the spawner: `runAgentMode(profile, mode)`,
  `resumeAgentSession(profile, sessionId)`, `splitAgentView(profile)`, with
  the aliases `runClaudeMode` and `splitClaudeAgentView`.
- Split actions launch the selected terminal choice in the source pane's
  best-known directory. Panes track only OSC 7 and OSC 9;9 shell-integration
  signals, falling back to their launch folder; prompt text is never parsed.
  An OSC 7 `file://<host>/path` is a local path on a non-Windows client
  whatever the host (a POSIX shell names its own machine there); on Windows a
  drive-letter path is local, and only a host other than `localhost` makes a
  UNC path.
  Sidebar Open and Alt+N use the workspace root. Remote and container splits
  also use that root instead of borrowing a shell's signalled directory. An
  agent split (Claude Code or Codex) always uses its workspace's project
  folder and runs a normal conversation (`continue`) when that profile's mode
  is `agents`; the palette's explicit **split agent view: <profile>** opens
  the agent manager (`claude agents --cwd <project>`, `codex agents`).
- Keybindings (in addition to palette; `keys.js SHORTCUTS` is the one table):
  Alt+N opens a new default terminal (a scratch view when no view is open),
  Alt+Shift+Right/Down split (H/V aliases), Alt+Shift+S cycles the sidebar
  (full, rail, hidden), Alt+Z zoom, Alt+D detaches and
  retains the process, Alt+W always opens confirmation before a process-tree
  kill and pane close, Alt+arrows focus move,
  Ctrl+±/0 font size. Plain Alt+V/P/H/0-9/- pass through to the shell
  (Claude Code image paste & model switch, PSReadLine/readline bindings).
  The zoom layer matches only keys that actually produce `+`/`-`/`0`: physical
  codes are never matched on their own, so Ctrl+`]` (vim tag jump) and Ctrl+`/`
  (readline/PSReadLine undo) reach the shell on ANSI layouts.
  Alt+Shift+Left/Up cycle the previous/next new-terminal profile. Ctrl+Left/Right
  remain untouched for PowerShell/readline word navigation.
  Alt+Shift+E / Alt+Shift+C open the focused terminal's folder (its OSC 7
  directory, else its launch folder, else the workspace folder) in Explorer /
  VS Code through `POST /api/open`; plain Alt+E and Alt+C stay with the shell
  (Alt+C is readline's capitalize-word).
- A second ordinary QuickTerm process never creates another native viewer.
  It authenticates to the existing loopback backend, queues an optional Explorer
  folder through `/api/launches`, and restores/focuses the one existing window.
  The primary window's shell atomically claims folder requests and opens each
  in a new scratch view.
- Destructive UI actions use an in-app confirmation placed by the triggering
  control: `confirm_popover.js` (the sidebar calls it directly, and
  `Panels._confirmNear` delegates to it with owner `"confirm"`), or the kill
  bar inside the focused pane for keyboard actions. When a
  pointer opened it, **Cancel** receives focus, so a reflexive Enter on a bar
  the user did not expect can never complete a destructive action; a keyboard
  path (Alt+W, Delete on a sidebar row, the palette) asked for it and focuses
  the destructive button; Escape and the Cancel button also cancel, and
  Escape inside a panel cancels the confirmation before it closes the panel. A
  short-lived pane notice never hides an open confirmation, and an inline
  popover follows its trigger while the panel body scrolls (dismissing itself if
  the trigger leaves the viewport). Application code does not use browser
  `alert`, `confirm`, or `prompt` dialogs.
- Pane title-bar verbs: `×` **detaches** (closes the pane; the terminal keeps
  running), matching what that glyph means in every tabbed application. Killing
  is a separate, visually divided, text-labelled `.danger` control, in the pane
  header and on the sidebar row alike. Detach and kill must never be adjacent
  unlabelled glyphs.
- Clicking an open workspace in the sidebar focuses its view; clicking a
  closed one opens a view. No click on a workspace replaces a layout or kills
  a running terminal; New scratch always opens a separate view.
- One visible failure path: every gesture-triggered error goes to the
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
  for agent profiles, recovery through the agent's own continue
  (`claude --continue`, `codex resume --last`); it is never silently replaced
  under the old terminal identity.
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
- On Windows the terminal gets `windowsPty: {backend: "conpty", buildNumber:
  22621}` and `reflowCursorLine: true`, the pair VS Code uses with its bundled
  conpty.dll. The build number describes the shipped OpenConsole, not the OS;
  any value >= 21376 selects xterm's ConPTY-compatible reflow. Without the
  cursor line reflowing too, a wrapped prompt split on resize and PSReadLine
  redrew it over the output above.
- The scrollbar is xterm's own (VS Code's scrollable element); `app.css`
  keeps its rail visible and hides the thumb when there is nothing to scroll.
  `.xterm-viewport` is only a background layer and must not show a native
  scrollbar.
- On session exit: show `[exited: code N]` bar in pane, keep last frame visible.
- Reconnect with backoff on WS drop.
- File viewer: `viewer.html?path=...`, a separate minimal page. It fetches
  `/api/file`, renders read-only monospace text, same design tokens. Opened
  via palette action ("view file: <path>") with `window.open(..., "_blank",
  "popup,width=900,height=700")`. Hidden by default, with no button in the main
  chrome.
- Design tokens: compact, flat workbench chrome derives restrained semantic
  surfaces and focus colors from the selected palette; terminal ANSI colors
  remain separate. Reduced-motion and forced-colors modes are supported.

## Testing

`tests/` with pytest. Backend units must not require a real browser. PTY tests
spawn `cmd.exe /c echo hi` style short-lived processes. Server tests use
`fastapi.testclient.TestClient` with a stub/real manager. Keep tests fast (<30 s
total). Run: `uv run --no-sync pytest` (env is pre-synced; do NOT run uv sync,
uv add, or uv lock).
