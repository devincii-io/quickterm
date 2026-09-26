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
    summon_hotkey: str = "ctrl+alt+grave"   # quake-style summon/hide
    scratch_dir: str = ""                   # "" = <system temp>/QuickTerm/scratch
    default_profile: str = ""
    profiles: list[Profile] = ...
    snippets: list[Snippet] = ...
    voice: VoiceConfig = ...

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
non-empty `ssh_host`. Passphrases and passwords are never stored; plink and
psftp prompt interactively inside the terminal.

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

Claude Code profiles need a project folder and cannot carry one, so the
workspace root is the only source. `launch.resolve_profile` raises when nothing
resolves, which surfaces as a 400 on the spawn rather than a config-save error.
Autostart and global hotkeys have no workspace, so a Claude Code profile there
fails the same way and the failure is reported as `launch_error`.

## quickterm/pty_session.py and quickterm/pty_posix.py

One PTY each: ConPTY through pywinpty on Windows, `pty.fork` elsewhere. Both
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
- **Watcher**: exit detection follows the process, not EOF. Windows waits on
  the process handle (winpty's EOF lags about 8 s); POSIX owns `waitpid`,
  because a background job that inherited the terminal keeps the slave open
  after the shell is gone. After the exit the reader drains until the PTY has
  been quiet 0.15 s (at most 1 s), then `on_exit` is posted exactly once,
  after the final output.

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

Bytes: the POSIX backend is bytes in, bytes out. pywinpty's API is str, so the
ConPTY backend re-encodes reads and decodes writes as UTF-8, and that round
trip is lossy: pywinpty decodes each read separately and drops NULs, so a
character split across two reads becomes U+FFFD, and input bytes that are not
valid UTF-8 reach the child as U+FFFD. Only owning the ConPTY pipes would fix
it.

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
saved profile, and profile panes `launch_options: {claude_mode?,
start_command?, args?}`, the options the pane was started with, so a restart
in place or a workspace restore repeats that launch exactly (a Claude "new
conversation" pane stays "new"). Layouts without it load as "no options". `session_id` is preferred when restoring. A missing/dead ID
becomes an explicit transcript-free unavailable pane; only a user-selected
recovery action may start a replacement or resume a Claude conversation.

```python
@dataclass
class Workspace:
    name: str
    layout: dict   # tree above
    logo: str | None = None
    path: str | None = None   # root folder every session in this workspace starts in
    session_ids: list[str] = field(default_factory=list)  # includes detached

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
DEFAULT_MAX_WINDOWS: int = 12
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
  claim MUST NOT autosave a layout. A window that wants exclusive Scratch
  claims the name `scratch` like any other workspace.
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
  forgotten or expires, the oldest survivor inherits the role. `primary` is who
  the Explorer folder handoff and the summon hotkey aim at, so only the primary
  window should long-poll `GET /api/launches/next`.
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
               open_window: Callable[[str | None, str | None], str] | None = None) -> FastAPI
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
Route modules load `workspace`, `config`, `opener`, `update` and `assets`
through `importlib.import_module("quickterm.X")` so tests can stub them.

`create_app` also takes `notify=None`: in the desktop app,
`notify(session_id, name, kind, text)` is called on the loop thread when a
session gains attention. When no QuickTerm window is in the foreground it
flashes the primary window's taskbar button; when every window is hidden in
the tray it shows a tray balloon; at most once per terminal every 30 s. The
window title never changes: `hotkeys.py` finds the window to summon by its
exact title.

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
| POST | /api/sessions | `{profile?, cmd?, args?, cwd?, env?, name?, cols?, rows?, start_command?, claude_mode?, workspace?}` → `SessionInfo` (profile name resolves from config; a bounded `start_command` override supports shell-profile recovery; `claude_mode` is limited to `new`, `continue`, `resume`, or `agents` and only applies to a `claude-code` profile; explicit cmd overrides). Resolved by `launch.resolve` and started with `spawn_async`. 409 when the live-terminal limit is reached; 400 `Terminal "<label>": <reason>` when the folder does not exist (`starting folder does not exist: <cwd>`) or the process cannot start (`command not found: ...`), where label is the profile name, else `name`, else cmd. When the bundled PuTTY tools are present, their directory is appended (never prepended) to the spawned session's `PATH`, so `plink`/`pscp`/`psftp` are callable from every terminal. `ssh`/`sftp` profiles resolve to plink/psftp argv (`[-ssh] [-P port] [-i key] [user@]host [remote-command]`); 400 if the tools are missing. |
| PATCH | /api/sessions/{id} | `{name}` → renamed `SessionInfo` |
| POST | /api/sessions/{id}/input | `{text, enter?}` → type into the session from outside (`quickterm send`): the UTF-8 text, plus `\r` when `enter`, goes to the PTY and marks the session touched → 204; 404 unknown id, 409 exited, 400 for a bad body, text over 64 KiB, a lone surrogate or nothing to send, 503 when the input queue is full |
| POST | /api/sessions/{id}/seen | The user has seen what the terminal asked for: clears its attention → 204; 404 for an unknown id |
| POST | /api/sessions/{id}/retain | Mark an explicit detach as user-owned so the untouched-shell reaper cannot end it → `SessionInfo` |
| POST | /api/launches | `{cwd?, profile?, workspace?}`, at least one → the validated item, queued for the existing viewer (Explorer's folder handoff and `quickterm new`/`open`). Unknown keys are ignored. 400 for a bad body or a missing folder, 404 `unknown profile: X` / `no such workspace: X`. The primary window's launch loop shows a workspace alone (focusing it if this window or a tiled view already shows it, else switching through the claim rules), starts a profile in the given folder or the workspace root, in the named workspace or the current one, and opens a folder alone in scratch as before. |
| GET | /api/launches/next | Long-poll (20 s) and atomically claim one queued handoff → the queued item (`{cwd?, profile?, workspace?}`, as POST /api/launches validated it) or 204 after timeout; `?wait=false` is the nonblocking probe. Exactly one window gets each handoff, so with several windows open only the `primary` one should poll. A waiter whose client has disconnected (a reload, a closed window) never takes an item, and an item taken just as its client left goes back to the front of the queue. |
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
| GET | /api/config | → `{font_family, font_size, theme, custom_theme, logo, default_profile, profiles, snippets, voice_available, scratch_dir, elevated, version, update_check, idle_timeout_s, max_sessions, hotkey_error, launch_error}`. `scratch_dir` is the resolved scratch folder. `hotkey_error` is set when a global hotkey parsed but Windows refused to register it (another program owns it); Settings renders it beside the shortcut field. `launch_error` is the latest autostart or global-hotkey launch failure; the primary window shows it in the error banner. |
| GET | /api/config/history | → `[{id, saved_at, summary}]`, newest first: the last 20 configs a save replaced (`<config dir>/history/`, same DPAPI protection as `config.json`; a save that changes nothing adds none). `summary` names the top-level settings that differ from the next newer version, or from the current config for the newest. |
| POST | /api/config/history/{id}/restore | Restore that version through the same path as PUT /api/config (validation, live apply, a new history entry) → 204; 404 for an unknown id, 400 when it no longer validates |
| GET | /api/config/full | → the complete **persisted** `AppConfig`, never the live one: `app.py` rewrites `port` at startup (`--port 0`, and unconditionally for an elevated instance), and Settings PUTs this object straight back. 500 when the persisted config cannot be read, rather than the live values. |
| PUT | /api/config | `AppConfig` object → 204; 400 for anything else. Omitted top-level keys keep their on-disk values, so a partial body cannot wipe profiles or their secrets. `port`, `host` and `summon_hotkey` need a restart and are not applied live; everything else, `scratch_dir` included, applies at once. For a field in `cfg.runtime_overrides` (the port of a `--port` or elevated run) a submitted value equal to the running one is treated as unedited and the persisted value is kept, so a stale page cannot write an ephemeral port to disk; any other value, a revert included, is saved. |
| GET | /api/system/terminals | → detected terminal types and WSL distributions. Includes `ssh`/`sftp` entries backed by the bundled PuTTY tools (`quickterm/putty_tools.py`: frozen `_internal/putty/`, dev `vendor/putty/` via `scripts/fetch_putty.py`); `available: false` when absent (e.g. pip installs). The launcher lists them as profile-only (a hostless plink just prints usage). |
| POST | /api/assets | raw image body (≤1 MB) → `{id, url}` |
| GET | /api/assets/{id} | → stored PNG/JPEG/WebP/GIF/SVG/ICO |
| DELETE | /api/assets/{id} | → 204 |
| POST | /api/elevate | same body as POST /api/sessions → `{launched: true}`. Windows only (else 400). Resolved by `launch.resolve` like an ordinary terminal (an explicit `cwd` wins over the workspace root), then started by a separate elevated QuickTerm through UAC; 500 when the launch fails. |
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
scrollback, THEN resize to real size and send resize message.

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

class _ViewerWindows:                       # the native windows this process owns
    def adopt(self, window, window_id) -> None
    def open(self, *, workspace=None, cwd=None) -> str
    def show_all(self) -> None
    def quit_all(self) -> None
    def count(self) -> int
```

- Fail fast unless `sys.getwindowsversion().build >= 17763` (Win10 1809).
- Optional positional `path` arg (Explorer "Open QuickTerm here"): if it is a
  directory, a first launch carries `?cwd=<dir>` in the window URL. A later
  ordinary process posts the folder to the authenticated `/api/launches` queue,
  summons the existing native viewer, and exits. The viewer opens it in Scratch.
- Right after reading its arguments (the launch folder is captured by then),
  Windows changes to the home folder: "Open QuickTerm here" starts the process
  in the folder the user clicked, and CreateProcess and `shutil.which` search
  the current folder before PATH. `NoDefaultCurrentDirectoryInExePath` is
  deliberately not used: as an environment variable it would reach every
  terminal and the app relaunched after an update, and change how cmd.exe runs
  programs from its own folder there.
- load_config → SessionManager → hotkeys thread → uvicorn (asyncio loop) →
  native Edge WebView2 viewer. `--port` and an elevated instance record
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
params are `cwd` (Explorer handoff), `workspace` (what this window should open
and claim), `window` (**the id this window MUST register with**, so a native
close can free its claim at once instead of waiting out the TTL) and `primary`
(`1` on the one window the Explorer handoff and the summon hotkey aim at).

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
applying. Tray menu: Open / Quit, where Open restores every live window and the
summon hotkey also restores a tray-hidden one. When the window holding the bare
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
            start_command=None, claude_mode=None, request_cwd=None,
            workspace_root=None, append_tools=True) -> LaunchSpec
def resolve_profile(prof, cwd=None) -> tuple[str, list[str], str | None]
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
  Windows process folder; ssh/sftp resolve to plink/psftp argv. Claude Code
  needs a folder and raises without one.
- The bundled PuTTY tools directory is appended to the child's PATH (its key
  matched case-insensitively), so a user-installed plink still wins.

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

`capture.py`: `Recorder`, start()/stop() -> numpy float32 mono 16 kHz via
sounddevice. `transcribe.py`: `Transcriber(model_size)`, with lazy
`WhisperModel` load on first use, `transcribe(audio) -> str`, language
auto-detect (de/en), VAD filter on.

ALL voice imports guarded: module exposes `voice_available() -> bool`;
missing deps must never break startup. Hotkey toggle: first press start
recording, second press stop → transcribe → `manager.write(focused, text.encode())`.

## frontend/

- `index.html`, `css/`, `js/` (ES modules, no build step), `vendor/` with
  pinned xterm: `@xterm/xterm@5.5.0`, `@xterm/addon-fit@0.10.0`,
  `@xterm/addon-webgl@0.18.0`, `@xterm/addon-web-links@0.11.0` (js+css committed).
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
- `workspace_views.js` tiles any number of workspaces into one window. The
  primary view is this document; every other view is a same-origin iframe
  running the same app on another workspace. Views are leaves of a
  `split_tree.js` tree and share the pane rules: a new view takes half of the
  view that asked, cut along its longer side; a header drag docks it beside
  another view or swaps the two; each divider drags, answers arrow keys and
  Home/End, and double-clicks to balance, keeping 15–85% of its split and at
  least 160 px per side where there is room; **zoom** shows one view alone
  and again brings the rest back. Every view has its own colour, and the
  sidebar's workspace menu marks a workspace shown in another view with that
  colour (choosing it focuses the view). Views are never re-parented: an
  iframe that moves in the DOM reloads, so every view and divider is
  absolutely positioned and a layout change only writes its box, which is
  also what the slide animation transitions. The sidebar's **workspace
  beside**, the palette's **show workspace beside…**, the workspace menu's
  row action and the foreign terminal's **show … beside** choice all open
  one, from inside a view too (`window.parent.quicktermViews` owns the
  tiling; a view names itself to it by its own `window`). A view reserves its
  own registry ID before loading `?workspace=<name>&window=<id>&embedded=1`;
  authentication stays in `#t=`. It never changes the primary document's
  sessionStorage window ID or remembered workspace, and never consumes
  Explorer launch requests. Each document has its own LayoutManager, focus
  ownership, autosave and heartbeat. A workspace already claimed elsewhere
  remains unavailable, and one already shown in this window is focused
  instead of opened twice. Borders and headers appear only with two or more
  views. Closing a view waits for a successful save and marks every owned
  terminal retained before releasing its registry entry and removing it;
  save failures keep the view open. The primary, non-embedded window stores
  the arrangement in localStorage (`quickterm.workspaceViews`: the split tree
  of `{primary}` and `{workspace, window}` leaves, the active and the zoomed
  view) and rebuilds it after its own workspace restored: each view's stored
  registry id is released first (the previous page's iframe still holds its
  claim), then claimed again; scratch, missing and refused views are dropped.
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
  first, retains and detaches it here, then switches, so the restore
  attaches it again; a name clash, an invalid folder name or a workspace
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
- The sidebar footer is built from the `chrome` array `main.js` passes to
  `initLauncher`, each entry `[label, onClick, shortcut?]`. `launcher.js` maps
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
- Sidebar (`launcher.js`), top to bottom: `+ <choice>` opens a terminal, the
  chevron beside it opens a `menu.js` menu over Personal profiles, System
  shells and the built-in Claude choices (`claude:continue|new|resume`, the
  CLI plus one flag, no profile needed); the workspace row is a menu button
  (scratch, every saved workspace with its folder, the ones shown in another
  view marked in that view's colour, a **show beside** row action, the
  **workspace here** offer when applicable, **new scratch**), with the folder
  under it, the **workspace here** button when the focused terminal is
  elsewhere, two buttons that open the focused terminal's folder in Explorer
  / VS Code (`onOpenFolder`; also Alt+Shift+E / Alt+Shift+C and two palette
  rows) and the `#sb-save` dot beside it; the terminal list; five icons
  (workspace beside, new window, dashboard, settings, help) and the collapse
  chevron. No native `<select>` anywhere in the sidebar. Double-click on a
  terminal row renames it (`onRenameSession` → `PATCH /api/sessions/{id}`,
  then `Pane.setTitle`). Three modes, remembered in `quickterm.sidebarMode`:
  `full` (resizable, 150 to 400 px), `rail` (30 px: plus, one dot per terminal,
  gear, chevron) and `hidden` (nothing; `#float-launch` sits over the
  terminal's left edge, its handle drags it up and down, `+` opens a terminal,
  right-click or `›` shows the sidebar). Alt+Shift+S cycles the modes.
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
- The terminal list shows every live terminal on the backend, grouped by the
  owning workspace (yours first and unheaded when it is the only group). A row
  is a state dot and a name; chips appear only for new output, busy and open
  elsewhere. The list's tooltip carries `<n> in <workspace> · <total> live`.
  Dashboard has separate **this workspace** / **all live** statistics plus
  explicit Unassigned ownership.
- Settings: tabbed General/Terminals/Snippets/Advanced/About editor. Nothing configurable is a bare
  name plus a value: profiles and snippets each carry a `description`, and every row shows name,
  description and a compact line of what it actually runs. Terminal profiles are grouped by
  `terminal_type`; both lists gain a filter box over name/description/command at six items or more.
  Each editor opens with a sentence about what that kind of thing is. Per-item problems (no name,
  duplicate name, no command, no executable, no SSH host, bad environment) are marked at the item;
  the footer validation in `panels.js` `_settings()` remains the backstop that refuses the save.
  Empty states name a thing worth making rather than reporting that the list is empty.
  Terminal profiles expose shell type,
  detected WSL distributions, start command, shortcut, and autostart without requiring JSON.
  `ssh`/`sftp` profiles add Host/Port/Username/Private key (`.ppk`);
  `ssh` relabels start command as a remote command; `sftp` hides it.
  `claude-code` exposes native launch modes: new,
  continue latest (`--continue`), choose a session (`--resume`), or open the
  background-agent manager (`claude agents`). Its executable is detected in the
  terminal inventory but is profile-only rather than a generic system shell.
- Themes: four featured choices stay visible; the catalog groups all remaining
  palettes under Dark, Neon, Soft, Warm, Light, and Custom. Clicking a theme previews
  both application chrome and every open xterm immediately; Cancel restores the
  persisted theme.
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
- Starting folders are shell-native: blank Windows profiles use the Windows
  user home and blank WSL profiles use `wsl.exe --cd ~`. WSL profile folders
  are passed through `--cd` and may be Linux paths such as `~/dev`; the profile
  startup command runs after that location is selected. Every folder field is
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
- Command palette Alt+K: fuzzy over profiles / actions (new terminal, split h/v,
  zoom, detach, kill, open folder in Explorer / VS Code, open file viewer) /
  snippets / recent sessions. Workspaces
  are offered ONLY as enumerated `load workspace: <name>` rows. There is no
  free-text workspace prompt, because a typo used to tear the whole layout down
  silently; saving is owned by the Dashboard, which validates the name and shows
  the error. Snippet rows carry the command text and the destination pane, and a
  multi-line snippet is confirmed in the pane before it runs. Pane sizing is not
  duplicated here; it lives on the splitter.
- Split actions launch the selected terminal choice in the source pane's
  best-known directory. Panes track only OSC 7 and OSC 9;9 shell-integration
  signals, falling back to their launch folder; prompt text is never parsed.
  An OSC 7 `file://<host>/path` is a local path on a non-Windows client
  whatever the host (a POSIX shell names its own machine there); on Windows a
  drive-letter path is local, and only a host other than `localhost` makes a
  UNC path.
  Sidebar Open and Alt+N keep the selected profile's configured folder. A
  Claude split always uses its project folder and substitutes a normal
  conversation when that profile's default mode is `agents`; the palette's
  explicit **Split Claude agent view** runs `claude agents --cwd <project>`.
- Keybindings (in addition to palette): Alt+N opens a new default terminal,
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
  layout is the separate, confirmed "new scratch" action. No click on a row
  drawn as "current" may kill a running terminal.
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
