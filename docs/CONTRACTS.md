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
- Windows serializes each environment value of the agent settings
  (`AppConfig.agents[...].env`) and of a workspace (`Workspace.env`, its
  startup items' `env`) as a current-user DPAPI object
  (`{"protected":"dpapi-v1","data":"..."}`); the in-memory/API shape
  remains `dict[str, str]`. Plaintext legacy values migrate on load. POSIX
  config/token storage uses user-only permissions (`0700` directory, `0600`
  files).

## quickterm/config.py

```python
# Saved terminal profiles (the `Profile` dataclass, `AppConfig.profiles`,
# connection types, per-profile hotkeys and autostart) are gone since 4.5;
# see "Workspace locations, no saved terminals (4.5)".

@dataclass
class AgentProfile:                 # one agent's settings as the launch code takes them
    name: str                       # the kind: "claude-code" | "codex"
    cmd: str                        # executable override, "" finds the CLI on PATH
    terminal_type: str              # same as name
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    agent_mode: str | None = None
    agent: dict[str, str] = field(default_factory=dict)  # typed agent options, allowlisted per type

@dataclass
class Snippet:
    name: str
    text: str                   # exact keystrokes, ending in the "\r" that runs the command
    description: str = ""       # one line: what it does and when to reach for it.
                                # Optional and defaulted.

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
class NotificationsConfig:
    needs_you: str = "notify"       # "off" | "flash" | "notify"
    finished: str = "flash"         # same values
    sound: bool = False

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
    update_auto_download: bool = True       # a found update downloads in the background
    summon_hotkey: str = "ctrl+alt+grave"   # summon/hide; with the overlay, the drop-down
    scratch_dir: str = ""                   # "" = <system temp>/QuickTerm/scratch
    shell: str = "powershell"               # powershell | cmd | git-bash | wsl | wsl:<distro> | "" (POSIX)
    agents: dict[str, AgentSettings] = ...  # always both "claude-code" and "codex"
    snippets: list[Snippet] = ...
    voice: VoiceConfig = ...
    window: WindowConfig = ...
    overlay: OverlayConfig = ...
    notifications: NotificationsConfig = ...
    keep_awake: str = "agents"              # "agents" | "always" | "off"

@dataclass
class AgentSettings:                        # how Claude Code or Codex starts
    cmd: str = ""; args: list[str] = []; agent_mode: str | None = None
    agent: dict[str, str] = {}; env: dict[str, str] = {}   # env DPAPI-protected at rest

def agent_profile(cfg, kind) -> AgentProfile  # the settings as the launch code takes them
def migrate_agents(raw: dict, notes=None) -> dict   # the 4.3 migration, pure; config_from_dict
                                            # runs it when "agents" is missing
def migrate_profiles(raw: dict) -> tuple[dict, dict[str, str], dict[str, list[str]], int]
                                            # the 4.5 migration, pure: the config without
                                            # "profiles", {SSH profile name: destination},
                                            # {name: [what could not be carried]}, count removed
def ssh_destination(profile: dict) -> str | None   # ssh://user@host:port with a port, else [user@]host
def config_dir() -> Path
def default_cwd() -> str
def scratch_root(configured: str = "") -> str
def config_from_dict(raw: dict) -> AppConfig  # ignores keys that are not fields ("profiles")
def validate_config(cfg: AppConfig) -> None
def load_config() -> AppConfig               # a migrating load copies the file to
                                            # config.pre-4.3.json / config.pre-4.5.json (once
                                            # each), points workspaces at the migrated SSH
                                            # destinations, saves at once and writes its
                                            # notes to migration-notice.txt
def take_migration_notice() -> str | None   # those notes, prefixed, read once and deleted;
                                            # only a backend calls it (app.take_migration_notice
                                            # logs them and sets launch_error, the banner)
def save_config(cfg: AppConfig) -> None      # keeps config.prev.json
def validate_environment(env: object) -> dict[str, str]
def protect_environment(env) -> dict         # DPAPI-sealed values (workspace env uses it too)
def unprotect_value(value) -> str
def replace_file(source, target) -> None     # os.replace, retried on Windows sharing errors
def read_text(path) -> str                   # read, retried the same way
```

`app.py` sets two attributes on the live `AppConfig` that are not dataclass
fields and are never persisted: `runtime_overrides: set[str]` (the fields it
overrode for this run only, today `{"port"}` for `--port` and an elevated
instance) and `launch_error: str | None` (the latest failure of the elevated
first terminal or a queued launch, or the migration notice). `hotkey_error`
follows the same pattern.

Saving validates runtime-facing field types (font family, update toggles,
agent settings, snippets, shortcut) so a malformed JSON config cannot reach
launcher or spawn code and fail there. Nothing in the config holds a folder;
the workspace root is checked when a session actually spawns. Passphrases and
passwords are never stored; ssh prompts interactively inside the terminal.

Migration and validation added in 4.0:

- A 4.0 to 4.4 config's profiles carried `claude_mode`; `migrate_agents`
  reads it as `agent_mode` when it turns an agent profile into agent
  settings.
- A shortcut that 3.x's `parse_binding` cannot parse (`minus`, `left`,
  `numpad1`, `pagedown`, ...; `config.legacy_binding_ok`) is written as
  `summon_hotkey_v4`, with `summon_hotkey: ""` in the legacy field. 3.x
  raised on such a name and replaced the whole config with the defaults; now
  a downgrade only loses that shortcut. `config_from_dict` prefers the `_v4`
  value when it is a non-empty string.
- `window`, `overlay` and `notifications` are parsed with `_parse`, like
  `voice`. Messages follow the existing style: `Window width must be between
  760 and 16384`, `Overlay edge must be top or bottom`.
- `agent_mode` must be in the type's mode set or null. claude-code accepts
  `new | continue | resume | agents` (null means `continue`); codex accepts
  `new | continue | resume | fork | agents` (null means `new`).
- `agent` keys must belong to the type's allowlist ("unknown agent option:
  <key>"), values are strings without NUL, and only `add_dirs` may hold
  newlines. Choices come from their sets with `""` meaning unset; toggles are
  `"true"`, `"false"` or `""`. Errors read `<Claude Code|Codex>: <error>`.

Superseded in 4.5: the 4.0 rules for profile `ssh_*` fields, the PuTTY
client, and the typed `connection` fields of telnet, serial, container, RDP
and VNC profiles. Those profiles no longer exist; an SSH workspace names an
OpenSSH destination (see "Workspace locations, no saved terminals (4.5)").

Environment overrides are limited to 256 pairs / 256 KiB and reject non-string
pairs, empty names, `=`, control characters, NUL values, and names that collide
case-insensitively. Both PTY backends merge the validated override over the
QuickTerm process environment with `pty_base.merge_environment`: on Windows the
merge is case-insensitive (an override `Path` replaces the inherited `PATH`
and keeps its own spelling); on POSIX `TERM=xterm-256color` and
`COLORTERM=truecolor` are set before the override, so only an override
changes them. What makes up the override (agent settings, workspace, the
terminal's own) is in "Workspace setup" (4.5 wave 2).

### Where a session starts

A workspace IS a folder. The resolution order for a new session's directory is
fixed and applies to every spawn path:

1. an explicit `cwd` in the request (Explorer handoff, a split inheriting the
   source pane's directory), which always wins;
2. otherwise the workspace root (`Workspace.path`); a root that no longer
   exists degrades to step 3, never to an error;
3. `default_cwd()`.

Neither the agent settings nor a startup item hold a folder, so there is no
third source and no way for one to point somewhere the workspace does not.

`default_cwd()` prefers the user's home directory, then the process cwd, never
the install directory, which is where a frozen exe's `os.getcwd()` would
otherwise land. `SessionManager.spawn` applies it and records the result on
`SessionInfo.cwd`, so every PTY backend receives a concrete folder and every
client can show where a terminal actually opened.

`scratch_root(configured)` is the disposable scratch workspace's folder:
`AppConfig.scratch_dir` when set, else `<system temp>/QuickTerm/scratch`. It is
created on demand, reused across runs, and its contents are never deleted by
QuickTerm. Scratch terminals start there rather than in the user's home folder.

Claude Code and Codex need a project folder and carry none, so the
workspace root is the only source. `agents.resolve` raises when nothing
resolves, which surfaces as a 400 on the spawn rather than a config-save
error.

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
unless the launch environment sets them.

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
{"type": "pane", "profile": "claude-code", "cwd": "C:/dev/proj", "session_id": "a1b2c3d4"}
```

`profile` on a pane is `"claude-code"`, `"codex"` or absent (a shell); a
layout saved before 4.5 may still name a removed saved terminal; starting
such a pane again answers 404 `unknown profile`. Pane nodes may also contain `launch_spec`
for system terminals opened by command, and agent panes `launch_options:
{agent_mode?, agent_session?, args?}`, the options the pane was started
with, so a restart in place or a workspace restore repeats that launch exactly
(an agent "new conversation" pane stays "new", a resumed session resumes the
same id). A `start_command` stored by 4.4 or earlier is ignored by the
backend since 4.5. A legacy `claude_mode` in a stored node is read as
`agent_mode`; the file format is otherwise unchanged. Layouts without it load
as "no options".
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
    host: str | None = None   # the location: None this PC, "wsl:<distro>", or an SSH
                              # destination; away from this PC `path` is POSIX
    env: dict[str, str] = field(default_factory=dict)   # DPAPI-sealed in the file (4.5)
    startup: list[dict] = field(default_factory=list)   # "Start with" items (4.5)

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
def normalize_host(value: object) -> str | None         # "wsl:<distro>", an SSH destination, or None
def normalize_remote_root(value: object) -> str | None  # "/..." or "~" or "~/...", kept as typed
def normalize_folder(value: object, host: str | None) -> str | None
def location_kind(host: str | None) -> str              # "local" | "wsl" | "ssh"
def wsl_distro(host: str | None) -> str | None

# workspace setup (4.5 wave 2)
def validate_env(value: object) -> dict[str, str]       # ValueError says why not
def validate_command(value: object) -> str | None       # one line, at most 4096 characters
def validate_startup(value: object) -> list[dict]       # each item with all seven keys
```

Only a WSL or SSH workspace's file carries `"host"`, and only a workspace
with a setup carries `"env"` and `"startup"`; a local file without them
reads as it did before. A remote folder is never resolved against this
computer, and NUL, line breaks and other control characters are refused
because it goes into a remote shell command.

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
`system` (health, terminal inventory, locations, elevate, update, open, file,
folder browser), `board` (the derived workspace board), `assets`, `usage` (agent usage limits), and `attach` (the WebSocket route, the replay
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
one. `rebind_hotkeys` registers exactly the summon key `cfg` names and sets `cfg.hotkey_error`; `suspend_hotkeys(True)` releases every
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
| POST | /api/sessions | `{profile?, cmd?, args?, cwd?, env?, name?, cols?, rows?, agent_mode?, agent?, agent_session?, claude_mode?, workspace?, shell?, prompt?, command?}` → `SessionInfo` (no profile and no cmd starts the configured shell, or `shell` when given (4.3), or in a WSL or SSH workspace that location's shell; `profile` is `claude-code` or `codex` and resolves from the agent settings, any other name is 404 `unknown profile: X` (4.5); explicit cmd overrides). `agent_mode` is valid only for a `claude-code` or `codex` profile (400 "agent_mode requires a Claude Code or Codex profile") and must be in that type's mode set. `agent` (4.5) is an object of agent options merged over the saved ones for this launch only and validated with the same allowlist (400 "agent requires a Claude Code or Codex profile" without one). `command` (4.5) is one line a plain shell runs once before its prompt (at most 4096 characters, no line breaks; 400 "command is for a plain shell and takes no profile, cmd or args" otherwise); under cmd it is refused when it holds `"`, `&`, `|`, `<`, `>`, `^`, `%` or `!` (400 "the command contains characters cmd.exe would reinterpret"). `env` follows the workspace env rules of the 4.5 wave 2 section (400 `invalid env: <reason>`). Environment, later wins: the agent settings' env, the named workspace's env, the request's `env`, and QuickTerm's own variables last (session manager). In WSL the workspace and request names are appended to `WSLENV`, for an agent also the agent settings' names except `PATH`; over SSH the workspace and request variables are exported, POSIX-quoted, by the remote command and the agent settings' env is not sent. `claude_mode` stays an accepted alias; when both are given and differ, 400 "agent_mode and claude_mode disagree". The legacy messages "claude_mode requires a Claude Code profile" and "claude_mode must be new, continue, resume, or agents" stay byte-identical for `claude_mode`. `agent_session` must match `^[0-9a-fA-F-]{36}$` (400 "agent_session must be a session id") and is valid only with mode null (implies resume), `resume`, or `fork` (codex only), else 400 "agent_session needs resume or fork". `prompt` (4.3) is the agent's first message, passed as its last positional argument (also over SSH): a string of at most 16000 characters, no NUL, not starting with `-`, without `"` (Windows PowerShell 5.1 splits a native argument at an embedded quote), valid only for a `claude-code` or `codex` profile without `cmd`/`args` and not in the `agents` mode; blank means none; 400 with the reason otherwise. Under the `cmd` shell a prompt with characters cmd.exe re-parses fails the spawn like any such argument, and under the `cmd` shell or through a `.cmd`/`.bat` agent a prompt over 7000 characters is refused (400 `prompt is too long for cmd.exe: at most 7000 characters`; cmd.exe ends a command line at 8191). On an SSH host the prompt's lines are joined with ` | `, since a line break cannot be quoted through every remote shell. Resolved by `launch.resolve` and started with `spawn_async`. 409 when the live-terminal limit is reached; 400 `Terminal "<label>": <reason>` when the folder does not exist (`starting folder does not exist: <cwd>`) or the process cannot start (`command not found: ...`), where label is the agent's name, else `name`, else cmd. `start_command` (4.4 shell-profile recovery) is no longer read. |
| PATCH | /api/workspaces/{name} | `{path?, logo?, host?, env?, startup?}` metadata-only edit under the workspace write lock. Preserves the latest layout, session ownership and temporary flag; 404 if missing; 400 for an empty body, unknown fields, or invalid metadata. `env` and `startup` (4.5) follow PUT: absent keeps, `null` clears, a value replaces. Layout autosaves omit durable-workspace metadata so stale viewers cannot undo a folder/logo edit. |
| PATCH | /api/sessions/{id} | `{name}` → renamed `SessionInfo` |
| POST | /api/sessions/{id}/input | `{text, enter?}` → type into the session from outside (`quickterm send`): the UTF-8 text, plus `\r` when `enter`, goes to the PTY and marks the session touched → 204; 404 unknown id, 409 exited, 400 for a bad body, text over 64 KiB, a lone surrogate or nothing to send, 503 when the input queue is full |
| POST | /api/sessions/{id}/seen | The user has seen what the terminal asked for: clears its attention → 204; 404 for an unknown id |
| POST | /api/sessions/{id}/retain | Mark an explicit detach as user-owned so the untouched-shell reaper cannot end it → `SessionInfo` |
| POST | /api/launches | `{cwd?, profile?, workspace?}`, at least one → the validated item, queued for the existing viewer (Explorer's folder handoff and `quickterm new`/`open`). `profile` is `claude-code` or `codex`. Unknown keys are ignored. 400 for a bad body or a missing folder, 404 `unknown profile: X` / `no such workspace: X`. The primary window's shell runs the launch loop: a workspace is shown when a view of this window already has it open, else opened as a new view (never switched into another view in place); an agent starts in the given folder or the workspace root, in the named workspace's view or the shown one; a folder alone starts a terminal there in the window's scratch view. Route and payload shapes are unchanged from 3.x. |
| GET | /api/launches/next | Long-poll (20 s) and atomically claim one queued handoff → the queued item (`{cwd?, profile?, workspace?}`, as POST /api/launches validated it) or 204 after timeout; `?wait=false` is the nonblocking probe. Exactly one window gets each handoff, so with several windows open only the `primary` window's shell should poll. A waiter whose client has disconnected (a reload, a closed window) never takes an item, and an item taken just as its client left goes back to the front of the queue. |
| GET | /api/windows | → `{ttl_seconds, windows: [{id, workspace, title, primary, parent, idle_seconds, age_seconds}]}`, oldest window first |
| POST | /api/windows | `{id?, workspace?, title?, primary?, parent?}` → `{id, workspace, title, primary, parent}`. Announce a window and optionally claim in one step; a server-side id is minted when `id` is absent. Idempotent for a known id (a reload must not collide with its own claim or be counted twice against the limit). `workspace` is three-valued exactly like `path` on PUT /api/workspaces: **absent preserves**, `null` releases, a string claims. `parent` is the shell window's id for an embedded workspace view; once set it stays. Forgetting a window (DELETE, a native close) forgets every entry whose `parent` it is, and only an entry without a parent is ever primary. 409 on a claimed workspace or too many windows, 400 on a junk name |
| POST | /api/windows/{id}/heartbeat | → `{id, workspace, title, primary}`; **404 when the id is unknown or already expired**, which is the client's signal to re-register instead of carrying on autosaving a workspace it may have lost |
| PUT | /api/windows/{id}/workspace | `{workspace: name\|null}` → `{id, workspace, title, primary}`. 404 unknown window, 400 missing key/junk name, 409 `{detail, error: "workspace_claimed", workspace, owner: {id, workspace, title, primary}}` when another live window holds it. Never merged, never force-taken: both windows would autosave the same layout file |
| DELETE | /api/windows/{id} | Drop a window and free its claim now instead of waiting out the TTL → 204, idempotent (this is a closing page's goodbye and may arrive twice) |
| POST | /api/windows/open | `{workspace?, cwd?}` → `{opened: true, target: "native", window_id}`. Asks the desktop shell for another native window. 409 (same shape as above) when the workspace is already open, so nothing is drawn before the refusal; 400 on a junk name or a missing `cwd`; 500 when the shell refuses. Without a pywebview shell (plain browser, POSIX, tests) it answers **200** `{opened: false, target: "unavailable"}` so the caller degrades to opening the URL itself. The frontend's own routes are the JS bridge and `window.open`; this exists for callers that have neither, above all a second QuickTerm process handing work to the resident one |
| POST | /api/sessions/cleanup | `{session_ids}` → kill disposable sessions → 204; an id that is already gone counts as stopped; 500 when a process survives |
| POST | /api/sessions/kill-all | → attempt every live session → `{killed: int, killed_ids: string[], failed_ids: string[]}`. Partial failure remains HTTP 200 so clients remove only verified kills and keep failures visible for retry. |
| DELETE | /api/sessions/{id} | kill tree → 204; 404 when the registry no longer knows the id (also when `kill` raises `KeyError` because the id vanished during the call), 500 when the process survives. The two are not the same for clients: 500 keeps the pane visible, 404 means there is nothing left to stop and the pane MUST close, or a session the reaper already removed can never be cleared from the layout. `/retain` splits the same way. |
| GET | /api/workspaces | → `[name]` |
| GET | /api/workspaces/{name} | → `Workspace` plus `path_exists: bool`, `git` and `host`, with `env` (decrypted, for the settings editor; the only route that returns the values) and `startup` (4.5). For a WSL or SSH workspace both `path_exists` and `git` come from the last background check and never wait for one (unknown counts as present, git as null until the first answer). |
| POST | /api/workspaces/remote-check | `{host, path}` → `{ok, message}`: `test -d <path>` through `ws_exec` at a WSL or SSH location (batch-mode OpenSSH, no profile). `message` is what wsl or ssh printed, or "<path> is not a folder on <host>" when `test -d` exits 1. 400 for a missing or invalid host or a bad folder; a missing ssh or wsl.exe answers `ok: false` with the reason. |
| PUT | /api/workspaces/{name} | `{layout, logo?, session_ids?, path?, host?, env?, startup?}` → 204. `host` is three-valued like `path` and names a location (`wsl:<distro>` or an SSH destination, 4.5; 400 with the reason otherwise); with a host, `path` is read as a POSIX folder there. `path`, `logo` and `session_ids` are three-valued: **absent preserves** the stored value (every layout autosave relies on this; an absent `session_ids` keeps the stored list plus the layout's panes), `null` (or `[]` for `session_ids`) clears it, a value sets it. `env` and `startup` (4.5) are the same: absent keeps, `null` clears, a value replaces. `path` is normalized; its existence is NOT required, so a temporarily missing folder cannot break autosave. 400 on a wrong type or a non-string/oversized/control-character path. Serialized with DELETE under one lock. |
| DELETE | /api/workspaces/{name} | delete the workspace; kill only detached sessions whose live authoritative owner is still this workspace, spare attached or since-moved sessions, and abort on any verified kill failure → 204. Holds the same lock as PUT for the whole load/kill/delete, so an autosave in flight cannot write the deleted workspace back. |
| GET | /api/board | → `{workspaces: {name: {status, reason, since, git, pr}}}`, derived (4.5 wave 2, "The board sorts itself"); `quickterm/board.py`, answered from its cache without waiting for git or gh. |
| GET | /api/config | → `{font_family, font_size, theme, custom_theme, logo, shell, agents, snippets, voice_available, scratch_dir, elevated, version, update_check, update_auto_download, idle_timeout_s, max_sessions, hotkey_error, launch_error}`. `scratch_dir` is the resolved scratch folder. `hotkey_error` is set when the summon key parsed but Windows refused to register it (another program owns it), as `"<binding> is in use by another program"`, or null. It reflects the latest registration, at startup or after a live rebind; Settings renders it beside the shortcut field. `launch_error` is the latest failure of the elevated first terminal or a queued launch, or the one-time migration notice; the shell shows it in the error banner. |
| GET | /api/config/history | → `[{id, saved_at, summary}]`, newest first: the last 20 configs a save replaced (`<config dir>/history/`, same DPAPI protection as `config.json`; a save that changes nothing adds none). `summary` names the top-level settings that differ from the next newer version, or from the current config for the newest. |
| POST | /api/config/history/{id}/restore | Restore that version through the same path as PUT /api/config (validation, live apply, a new history entry), except the new-shortcut rule `validate_new_bindings`: its keys were accepted when it was saved, and a 3.x plain key such as `f12` must not refuse a recovery → 204; 404 for an unknown id, 400 when it no longer validates |
| GET | /api/config/full | → the complete **persisted** `AppConfig`, never the live one: `app.py` rewrites `port` at startup (`--port 0`, and unconditionally for an elevated instance), and Settings PUTs this object straight back. 500 when the persisted config cannot be read, rather than the live values. |
| PUT | /api/config | `AppConfig` object → 204; 400 for anything else, including a summon key without Ctrl, Alt or Win that is not already saved ("Summon shortcut needs Ctrl, Alt or Win", `config.validate_new_bindings`; a 3.x plain key on disk stays accepted so load and unrelated saves work). The footer Save refuses the same through `settingsProblems(draft, {baseline})`. Omitted top-level keys keep their on-disk values, so a partial body cannot wipe the agent settings or their secrets. Only `port` and `host` need a restart; everything else applies at once, `scratch_dir`, `window` (the next window), `overlay` (the next summon) and `summon_hotkey` included. When `summon_hotkey` differs from the live config, the route awaits `asyncio.to_thread(ctx.rebind_hotkeys, cfg)`, which re-registers the summon key and sets `hotkey_error`; a save that leaves the keys alone does not rebind. For a field in `cfg.runtime_overrides` (the port of a `--port` or elevated run) a submitted value equal to the running one is treated as unedited and the persisted value is kept, so a stale page cannot write an ephemeral port to disk; any other value, a revert included, is saved. |
| POST | /api/hotkeys/suspend | `{suspended: bool}` → 204; 400 "suspended must be true or false" for any other body. `true` unregisters every global hotkey on the hotkey thread so a Settings key capture records a combination QuickTerm already owns instead of firing it; `false` registers them again, and they come back on their own after 20 s. A no-op without a hotkey manager (browser, POSIX, tests). |
| GET | /api/locations | → `{locations: [{id, kind, label, detail, browse}]}`: This PC, each installed WSL distribution, each concrete Host alias in `~/.ssh/config` (4.5, "Workspace locations"). Starts no distribution and opens no connection. |
| GET | /api/system/agents | → `{types: [{id, label, executable, available, modes: [{value, label, detail}], default_mode, options: [{key, label, kind: "choice"\|"combo"\|"text"\|"lines"\|"toggle", choices?: [{value, label, detail?}], hint, advanced: bool, placeholder?}]}]}` for `claude-code` and `codex`. Settings generates the agent editor from it and hardcodes no option list. Cached 60 s in `ctx.inventory_cache`; `?fresh=true` rescans. |
| GET | /api/system/ssh-hosts | → `{path, exists, openssh: path\|null, hosts: [{alias, hostname, user, port, identity_file, proxy_jump}]}` from the static `~/.ssh/config` parser (`quickterm/ssh_config.py`), off the loop. |
| GET | /api/system/ssh-hosts/{alias} | → `{alias, hostname, user, port, identity_files: [..], proxy_jump}` from `ssh.exe -G <alias>` (CREATE_NO_WINDOW, 3 s timeout, off the loop), falling back to the parser. 400 when the alias starts with `-` or does not match `^[A-Za-z0-9._@:%-]{1,255}$`; 404 when the parsed ssh_config has no literal `Host` entry for it (`ssh -G` exits 0 for any name and prints defaults, so it runs only for a known alias). |
| GET | /api/agent-sessions?type=claude-code\|codex&workspace=<name>&limit=20 | → `{sessions: [{id, title, updated_at, cwd}]}`, newest first, for the workspace folder (or `cwd=<path>` instead of `workspace`). Claude from `~/.claude/projects/<slug>/*.jsonl`, titled by the last `custom-title` (`/rename`, `--name`), else the last `ai-title`, else the first prompt. Codex from `$CODEX_HOME/session_index.jsonl` joined with each rollout's `session_meta` (first 8 KB only), titled by `thread_name`, else the first message the user typed (bounded read; AGENTS.md and `<...>` context blocks skipped), else `session <last 12 id characters>` (UUIDv7 ids share their leading timestamp), listing interactive threads only: no `parent_thread_id`, and `source` absent, `cli` or `vscode` (subagent threads and `exec` runs are hidden, as Codex's own picker hides them). `limit` is clamped to 1..100. 400 for a bad type, 404 for an unknown workspace; an unreadable store answers `[]`. Off the loop. |
| GET | /api/system/terminals | → detected terminal types and WSL distributions, plus `{id: "codex", label: "Codex CLI", executable, available}`. Since 4.5 there are no `ssh`/`sftp` entries and no PuTTY; where a workspace can live is `GET /api/locations`. `installs` lists shells one step away: on Windows without PowerShell 7, `{id: "powershell-core", label, cmd, args, url}` with `cmd`/`args` a `winget install --id Microsoft.PowerShell --exact --source winget` (no `--accept-*` flag: the user answers in the terminal), or, without winget, `cmd: null` and `url` the GitHub release page. `shells` (4.3) is `[{value, label, available}]`: PowerShell and Command Prompt always on Windows, Git Bash when installed, one `wsl:<distro>` per listed distribution; on POSIX one entry `""` named after `$SHELL`. The 4.3 section calls this route the terminal options inventory. Cached for 60 s; `?fresh=true` scans again (an install terminal just exited). |
| POST | /api/assets | raw image body (≤1 MB) → `{id, url}` |
| GET | /api/assets/{id} | → stored PNG/JPEG/WebP/GIF/SVG/ICO |
| DELETE | /api/assets/{id} | → 204 |
| POST | /api/elevate | same body as POST /api/sessions, `agent_mode` and `agent_session` included → `{launched: true}`. Windows only (else 400). Resolved by `launch.resolve` like an ordinary terminal (an explicit `cwd` wins over the workspace root), then started by a separate elevated QuickTerm through UAC; 500 when the launch fails. |
| GET | /api/search?q=...&limit=... | → `[{session_id, name, workspace, alive, line, text, start}]`: case-insensitive substring search over every session's scrollback as plain text (`quickterm/transcript.py`: escape sequences, OSC 52 payloads and alternate-screen text dropped, carriage-return overwrites and ConPTY repaints resolved). One hit per line, in session then line order; `text` is at most 300 characters around the match, `start` counts code points, `line` is only a hint because xterm wraps lines. `limit` defaults to 200 and is clamped to 1..1000; 400 when `q` is blank or over 1 KiB. Snapshots are taken on the loop, the work runs in a thread. |
| POST | /api/sessions/{id}/export | Write that terminal's scrollback as plain text to `<Downloads or home>/QuickTerm/<name>-<YYYYmmdd-HHMMSS>.txt` (UTC; `-2`, `-3` instead of overwriting) → `{path}`; 404 unknown id, 500 when the write fails. Only on this explicit request does terminal output reach the disk. |
| GET | /api/file?path=... | → `{path, size, truncated, text}`. Read-only file viewer backend. Strips surrounding quotes and expands `~` like `/api/open`. Max 512 KiB read; decode utf-8 `errors="replace"`; 404 if missing, 400 if a directory or unreadable (`cannot read <path>: <reason>`). |
| GET | /api/fs/dirs?path=... | → `{path, name, parent, dirs, roots, truncated}`. Backs the in-app folder browser (`quickterm/browse.py`). One level of sub-**directories** only; files are never reported. `path` defaults to the home folder and accepts `~`/`%VAR%`; the answer is always resolved and absolute. `parent` is `null` at a root (drive, `/`, UNC share), which is when the client offers `roots`: mounted drive letters on Windows, `/` plus home on POSIX. `dirs` are `{name, path, is_git}` sorted case-insensitively; hidden entries (dot prefix, Windows HIDDEN attribute) are skipped, but a `.git` child is reported as `is_git` on its parent row. At most 2000 entries, then `truncated: true`. 404 when the path does not exist, 400 when it is not a directory or cannot be read (permission denied); never a traceback. The scan is blocking and runs via `asyncio.to_thread`. |
| GET | /api/update | → `{current, latest, update_available, url, notes, installable}`. Probes the pinned GitHub repo's latest release (cached 6 h; `?force=true` bypasses). 502 on network failure. When the result is installable, `update_check` and `update_auto_download` are on, the platform is Windows and this is not the elevated instance, it also starts (or joins) the background download. |
| GET | /api/update/status | → `{state, version, received, total, error, notes_url, can_restart}`; `state` is `idle`, `available`, `downloading`, `verifying`, `ready`, `installing`, `installed` or `failed`. `installed` means Setup returned 0 but this backend was kept (the hand-over was declined); the card then says "QuickTerm v<version> is installed. Restart QuickTerm to use it." and offers Restart now only when `can_restart` is true. Always `idle` in the elevated instance. |
| POST | /api/update/download | starts or joins the background download of the Setup asset (streamed, SHA-256 checked against SHA256SUMS.txt) → 204. 400 when no installable update exists, on POSIX, or in the elevated instance; 502 when the check behind it fails. |
| POST | /api/update/install | requires `ready`; writes the hand-over script, opens it and the installer with read sharing only (no writer, rename or delete until Setup is over), re-verifies both through those handles, starts Setup `/SILENT` through the script (which starts the installed launcher only when Setup returned 0), and only then stands the backend down (`pty_host.begin_update()`) → `{launched, version}`. The backend waits for the script's process (at most 30 minutes); if it is still running afterwards, exit code 0 (hand-over declined) gives `installed` and removes the installer, while a non-zero code (Setup failed, UAC cancelled) or the timeout goes back to `ready`, or to `failed` with "Setup did not finish" when the file no longer matches. 409 when not ready or when the re-check fails (state becomes `failed`); 400 on POSIX or in the elevated instance; 500 when Setup cannot be started. |
| POST | /api/update/restart | requires `installed` with a known launcher; starts the installed `QuickTerm.exe` (found before Setup ran), which replaces this backend at once when no terminal is busy or touched and asks otherwise, as after any install → `{started}`. 409 otherwise; 400 on POSIX or in the elevated instance; 500 when it cannot be started. |
| POST | /api/open | `{target}` → `{action: "url"\|"opened"\|"revealed"}`. Terminal Ctrl+click. http(s) URLs and allowlisted passive local files open with the OS handler; every other file type is revealed in the file manager, never run (quickterm/opener.py). Other schemes/missing paths → 400/404. With `app` (`explorer` \\| `vscode`), `{target, app}` opens the existing folder `target` in that app → `{action: app}`: unknown app or not a folder → 400, missing folder → 404, VS Code not installed → 404 with a `detail` naming that. VS Code is launched from `Code.exe`, never the `code.cmd` shim (cmd.exe re-parses batch arguments, and the folder comes from an OSC 7 report). |

Removed in 4.5: `GET /api/profiles`, `POST /api/connections/{name}/open`
(saved terminals and connection launchers) and `PUT /api/board/{name}` (the
board sorts itself). The right panel (`/api/ws/...`), git info, usage and
agent-event routes are described in their own sections below.

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
  maximized) when `window_state.clamp_to_screens(load(), _screen_list())`
  finds them still overlapping a monitor by at least 64 px both ways. The
  minimum size stays 760 x 480. `_screen_list()` iterates `webview.screens`
  (a module property holding a list proxy in pywebview 6) and only calls it
  when it cannot be iterated (older releases).
- Secondary windows open at the configured size, 32 px down and right of the
  primary when that position still meets a screen (`clamp_to_screens`); a
  minimized primary reports about -32000 and the offset is dropped. The elevated "QuickTerm -
  Administrator" window shares `%APPDATA%`, so it opens at the configured size
  and records no bounds.
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
MIN_LOGICAL_SIZE = (760, 480)   # equals app.MIN_WINDOW_SIZE
def overlay_rect(work_area: tuple[int, int, int, int], edge: str,
                 width_pct, height_pct,
                 min_size: tuple[int, int] = (0, 0)) -> tuple[int, int, int, int]
    # work_area is a RECT (left, top, right, bottom); returns (x, y, w, h),
    # centred horizontally, on the top or bottom edge, percentages clamped to
    # 30..100 and 20..100, then raised to min_size (never past the work
    # area); x and y are computed for that final size, integer pixels
def enabled(cfg) -> bool
def show_overlay(hwnd: int, cfg) -> None
def hide_overlay(hwnd: int, cfg, *, hand_back: bool = True) -> None
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
  `monitor: "primary"`. The foreground window before the summon is remembered
  when it belongs to another process. The old `GWL_STYLE` (without
  `WS_MAXIMIZE`/`WS_MINIMIZE`; that state lives in the placement) and
  `WINDOWPLACEMENT` are saved once per window; a minimized or maximized window
  is restored; `WS_CAPTION` and `WS_THICKFRAME` are stripped; the size is at
  least `MIN_LOGICAL_SIZE` scaled by `GetDpiForWindow / 96`, because Windows
  clamps `SetWindowPos` to the window's minimum track size; `SetWindowPos` with `HWND_TOPMOST` (or
  `HWND_NOTOPMOST` without `always_on_top`) and
  `SWP_SHOWWINDOW | SWP_FRAMECHANGED`. A hidden window slides in from its edge
  in 6 steps over about 120 ms when `animate` is on and Windows client-area
  animations are enabled.
- **Hide**: slide back out of the edge, then `SW_HIDE`. The window stays in
  overlay style for the next summon. A hidden window stays the foreground
  window, so with `hand_back` (the summon key) the remembered window gets the
  foreground back, or the shell window when it is gone. The focus-loss path
  passes `hand_back=False`.
- **Restore**: a window flagged minimized or maximized is `SW_RESTORE`d first,
  then the saved style and placement go back (a maximized window comes back
  maximized) and the window drops `HWND_TOPMOST`.
- The summon toggle (`hotkeys.toggle_window`) only looks at this process's
  windows (`_quickterm_windows(title, own_process=True)`): it restyles what it
  finds, and another instance also has a window titled "QuickTerm". The
  second-launch `summon_window` handoff still looks across processes.
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
  summons the existing native viewer, and exits. The viewer starts a terminal
  there in its scratch view.
- Right after reading its arguments (the launch folder is captured by then),
  Windows changes to the home folder: "Open QuickTerm here" starts the process
  in the folder the user clicked, and CreateProcess and `shutil.which` search
  the current folder before PATH. `NoDefaultCurrentDirectoryInExePath` is
  deliberately not used: as an environment variable it would reach every
  terminal and the app relaunched after an update, and change how cmd.exe runs
  programs from its own folder there.
- load_config → SessionManager → hotkeys thread (summon key, overlay focus
  hook) → `create_app` with `rebind_hotkeys` and
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
- The elevated instance's first terminal resolves through `launch.resolve`
  like a REST spawn; a failure is logged and stored as `cfg.launch_error`
  instead of being swallowed. (Autostart profiles and per-profile global
  hotkeys went with the profiles in 4.5.)
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
quickterm new [claude-code|codex] [--cwd D] [--workspace W]   (--profile removed in 4.5)
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
`cwd`, `profile` (the agent), `workspace`), which the app queues through `/api/launches`
once its backend is up, reporting a refusal as `launch_error`. The CLI waits
up to 20 s for a verified health answer and exits. The frozen build is a GUI-subsystem exe: a verb
attaches to the parent console and writes to `CONOUT$`; with no console it
prints nothing and still exits with the right code. cmd and PowerShell do not
wait for a GUI program, so scripts use `start /wait` in cmd.

## quickterm/launch.py

Every way of starting a terminal resolves it here: POST /api/sessions, POST
/api/elevate, POST /api/launches (through the launch loop) and the elevated
instance's first terminal. Nothing here touches the session registry, but
resolving blocks on the file system, so async callers run it in a worker
thread.

```python
class LaunchError(ValueError):  status: int; label: str | None
@dataclass(frozen=True)
class LaunchSpec:
    cmd: str; args: list[str]; cwd: str | None; env: dict[str, str]
    name: str | None; profile: str | None; label: str
    agent: str | None          # "claude" | "codex": add the hooks
    wrap: shells.Wrap | None   # the shell an agent runs inside
    terminal_type: str | None  # a plain shell launch's pane type
    remote: RemoteLaunch | None  # an SSH workspace's terminal
    shell: str | None          # integrated shell (PowerShell, cmd, Git Bash)
    wsl: str | None            # the distribution of a WSL workspace's terminal
    command: str | None        # what a plain shell runs first
    def spawn_kwargs(self) -> dict

def resolve(cfg, *, profile=None, cmd=None, args=None, env=None, name=None,
            claude_mode=None, agent_mode=None, agent_session=None,
            request_cwd=None, workspace_root=None, shell=None, prompt=None,
            remote=None, command=None, workspace_env=None,
            agent_options=None) -> LaunchSpec
            # claude_mode is the legacy alias of agent_mode
def find_profile(cfg, name) -> AgentProfile  # "claude-code" | "codex", else 404
def workspace_target(name) -> RemoteTarget | None   # a WSL or SSH workspace's host and folder
def workspace_env(name) -> dict[str, str]    # the workspace's variables (decrypted)
def validate_dir(value: str, label: str | None = None) -> str
def workspace_start(name: str | None) -> str | None
```

- Folder precedence: `request_cwd`, else `workspace_root`, else None (the
  session manager then uses `default_cwd()`). A folder that does not exist is
  `LaunchError("starting folder does not exist: <value>")`, named after the
  terminal; a workspace whose folder is gone yields None, never an error.
- Superseded in 4.5: `resolve_profile` and its per-terminal-type argv for
  saved profiles, `start_command`, and appending the bundled PuTTY tools to
  PATH. Agents resolve through `agents.resolve(prof, folder, mode=,
  session=, prompt=)`, which raises without a folder; a plain shell through
  `shells.interactive`.
- No profile and no `cmd` (and no `args`) starts the shell: the request's
  `shell` when given (validated like the config value; it cannot be combined
  with `profile` or `cmd`), else `cfg.shell`, through `shells.interactive`
  (PowerShell `-NoLogo`, cmd bare, Git Bash and POSIX `-l`, WSL
  `[-d <distro>] --cd <folder or ~>`). With a `command` (4.5) the shell runs
  it once and stays: PowerShell `-NoLogo -NoExit -Command <command>`, cmd
  `/k "<command>"` (refused when it holds `" & | < > ^ % !`), Git Bash and
  POSIX `-lc "eval '<command>'; exec <shell> -l"`, WSL `--exec bash -lc` the
  same way. The session is named after the shell
  ("PowerShell") unless the request names it. `shells.program` resolves
  PowerShell to `pwsh.exe` on PATH or under Program Files, else
  `powershell.exe`; a missing Git Bash or WSL is a 400. For PowerShell, cmd
  and Git Bash the spec also carries `shell=<value>` (`LaunchSpec.shell`,
  passed as the `shell` keyword of `SessionManager.spawn`/`spawn_async`),
  and the session manager adds the shell integration (below).
- A WSL or SSH workspace (`remote`, from `workspace_target`) starts there:
  see "Workspace locations, no saved terminals (4.5)".
- Shell integration (Windows, local terminals only; `shells.INTEGRATED`).
  `SessionManager._build` applies it to a plain shell launch (`shell=`) and
  to an agent wrap in the same shells; WSL, POSIX and SSH are unchanged.
  Each prompt reports the folder as
  `ESC ] 9 ; 9 ; <Windows path> ESC \` (unquoted):
  - PowerShell: argv `-NoLogo -NoExit -Command <boot>`, where `<boot>` is
    `& ([ScriptBlock]::Create($env:QUICKTERM_PS_INIT))` in FullLanguage mode
    and only `Remove-Item Env:QUICKTERM_PS_INIT` under Constrained Language
    Mode (which refuses ScriptBlock.Create with an error); an agent wrap puts
    `<boot>` and a line break before its own `-Command` text. The script in
    `QUICKTERM_PS_INIT` (`shells.ps_integration`) removes that variable,
    then replaces `prompt` with one that runs the original prompt first and
    writes the report with `[Console]::Write` when the location is a
    FileSystem one. The profile still loads (no `-NoProfile`), and an inline
    `-Command` is not subject to the execution policy. Where hooks are on
    (not elevated, curl usable, a safe hooks folder:
    `agent_hooks.shell_hooks`), it also defines global `claude` and `codex`
    functions, unless the profile already defined a function of that name,
    which then stays as it is and gets no hooks. Each resolves the program (`Get-Command -CommandType
    Application`, first hit) on every call and runs it with the static
    `--settings=<hooks>/claude-settings.json` after the user's arguments, or
    with Codex's `-c notify=...` before them. The arguments pass through
    untouched when the first one is a subcommand in `shells.CLAUDE_PLAIN` /
    `shells.CODEX_PLAIN`, when Claude gets the user's own `--settings`, and
    when the program is a .cmd/.bat that may not get them (always for Codex,
    for Claude when the path holds a character cmd.exe re-reads). Without a
    program the function steps aside so PowerShell runs the name itself.
    QuickTerm's own agent launch calls the exe by path and never reaches
    these functions. Such a session counts as an agent shell for clearing
    agent state once the shell has no child left.
  - cmd: `PROMPT=$E]9;9;$P$E\` followed by the user's own `PROMPT` (from the
    launch env, else QuickTerm's), or `$P$G`. The argv is unchanged.
  - Git Bash: `PROMPT_COMMAND` (the user's own from the environment, then
    `shells.GIT_BASH_PROMPT_COMMAND`), which turns `/c/x` into `C:\x` and
    asks `pwd -W` for anything else. A bashrc that sets its own
    `PROMPT_COMMAND` replaces it; then nothing is reported.
- `profile` `"claude-code"` or `"codex"` names the agent from `cfg.agents`,
  with the request's `agent` options merged over the saved ones for that
  launch; the session's `profile` is the kind and its name "Claude Code" or "Codex". An agent launch carries
  `wrap = shells.Wrap(<effective shell>, <its program>, "claude"|"codex")`;
  `SessionManager._build` adds the hooks to the agent's argv first (none for
  WSL) and then wraps it with `shells.wrap` (the argv per shell is in 4.3,
  "One shell"). cmd's text after `/k` is passed verbatim by
  `conpty.command_line` only in that form (the one argument after `/c` or
  `/k` already in a pair of quotes); every other cmd.exe line keeps
  list2cmdline. Every word of the cmd wrap is refused when it holds
  `" & | < > ^ % !` or CR/LF. In PowerShell, a word that is empty, holds a
  double quote, or holds whitespace and ends in a backslash switches the
  `-Command` text to a form that checks how PowerShell passes native
  arguments: the legacy way (Windows PowerShell 5.1, pwsh before 7.3) gets
  the C-runtime command line in `$env:QUICKTERM_AGENT_ARGS` and runs
  `& '<exe>' --% %QUICKTERM_AGENT_ARGS%`, which passes it untouched; 7.3 and
  later get `& '<exe>' @('<arg>',...)`. Otherwise it is `& '<exe>' '<arg>'...`. Codex's `-c notify` value is
  a TOML array of literal strings (`['...','...']`), so it holds no double
  quote. WSL runs the bare CLI name through `--exec`, so no shell of the
  distribution reads the words, and passes the workspace folder argument as
  `.`.
- A wrapped session whose shell has no child process left loses its agent
  state at the next busy snapshot, since Codex reports no end. For a wrapped
  agent in Git Bash, busy is judged from the shell at the end of the chain
  of only-child MSYS shells under the launcher (`process_usage.shell_at_prompt`);
  a plain Git Bash shell keeps the launcher's reading. POST /api/elevate
  wraps an agent the same way before it hands the spec over.
- `SessionInfo.agent_shell` (in `GET /api/sessions`) is the wrap's shell value,
  or null. A WSL agent reports no state and its processes are out of sight,
  so the WSL wrap prints `ESC ] 7770 ; quickterm-agent-exit BEL` after the
  agent (`shells.AGENT_EXIT_PRINTF`). The pane swallows that OSC and treats
  a WSL agent as present from launch until it arrives: the Shift+Enter
  newline and the activity label hold until then.

### SSH and SFTP

Superseded in 4.5: ssh and sftp profiles, plink/psftp and the PuTTY client
are gone. SSH is reached only as a workspace location, with OpenSSH
(`%SystemRoot%\System32\OpenSSH\ssh.exe` on Windows, else
`shutil.which("ssh")`, `ssh_config.openssh_path`) and the destination as
`~/.ssh/config` reads it. A missing client raises "OpenSSH client not found.
Install it under Settings > Apps > Optional features > OpenSSH Client.", a
400 on the spawn.

`quickterm/ssh_config.py` is pure: it parses `~/.ssh/config` (one keyword per
line, `keyword value` or `keyword=value`, case-insensitive keywords, `#`
comments, double quotes group an argument, first value wins), follows
`Include` with globbing relative to `~/.ssh` up to depth 8 with a loop guard
(the Host state before an Include comes back after the file, and the Host
lines of a file included inside a block that does not apply never match, as
OpenSSH's readconf does), skips `Match` blocks, and keeps only literal `Host` patterns (no `*`, `?` or
leading `!`), de-duplicated. Per alias it returns `{alias, hostname, user,
port, identity_file, proxy_jump}`; unknown fields are null, `identity_file` is
the first entry with `~` expanded, and key files are never read.
`resolve(alias)` runs `ssh.exe -G <alias>` (CREATE_NO_WINDOW, 3 s) and falls
back to the parser.

### Terminals of a workspace on an SSH host (as built, 4.3; updated for 4.5)

`api/common.resolve_request` reads `launch.workspace_target(name)` and hands
it to `launch.resolve(..., remote=RemoteTarget(host, path))`. Without an
explicit `cmd`, a plain terminal or an agent becomes `LaunchSpec(cmd=ssh,
args=..., remote=RemoteLaunch(...))` (a `wsl:` host goes to the WSL path of
the 4.5 section instead); a request `shell` is ignored there (the shell
setting does not apply on a host). 4.3 built the ssh options from an SSH
profile (`launch.openssh_args`); since 4.5 they are only `-t <destination>`,
and `ws_exec.ssh_argv` builds the background calls.

- ssh options: `-t`, the destination, then one remote command. Port, key,
  ProxyJump and the rest come from `~/.ssh/config`. Every folder and
  argument is POSIX-quoted (`ws_exec.posix_quote`, which refuses NUL and
  line breaks); a leading `~` stays unquoted so the host expands it.
- Plain: `cd <folder>; [export NAME=<value>; ...] exec "$SHELL" -l`, with
  the workspace's and the request's env exported first (4.5). With a
  `command`: `cd <folder>; [exports] "${SHELL:-/bin/sh}" -lc '<command>';
  exec "$SHELL" -l`. The remote-capable profiles of 4.3 are gone.
- Agent: the CLI name (or the settings' `cmd` when it is a POSIX path) with
  the same arguments as a local launch, run through `"${SHELL:-/bin/sh}" -lc`
  so the login PATH applies, then `exec "$SHELL" -l`.
- With hooks (an agent, and the backend has a hook port and token),
  `SessionManager._build` rebuilds the argv with the session id:
  `-o ExitOnForwardFailure=no -R /tmp/quickterm-<16 hex>.sock:127.0.0.1:<port>`
  before the target, and `exec sh -c '<script>'` that cds, turns echo off,
  prints `ESC ] 7770 ; quickterm-hook ; <nonce> BEL`, reads lines until one
  contains `<nonce>:` (anything typed before it is dropped) and keeps what
  follows as `QUICKTERM_HOOK_TOKEN`, exports it with `QUICKTERM_SESSION_ID`
  and `QUICKTERM_HOOK_SOCKET`, traps `EXIT HUP TERM` to remove the socket,
  posts `{"agent", "event": "quickterm-agent-start", "payload": {}}`, runs the
  agent, posts `quickterm-agent-exit`, then runs the login shell (not
  `exec`, so the trap runs). Before all that the script prints
  `ESC ] 7770 ; quickterm-ready ; <nonce> BEL`: ssh has logged in. The
  session manager types `<nonce>:<token>` and Enter into the PTY the first
  time the hook marker appears in its output and never again. From the
  ready marker until that answer, at most 10 s counted from the ready
  marker, input to that session is held in one queue, in order, escape
  sequences and paste included, and follows the answer; past 64 KiB the
  queue goes out at once, still in order. Only xterm's replies to the
  device-attributes and cursor-position queries (`ESC [ ? ... c`,
  `ESC [ n ; m R`) pass at once. Input before the ready marker (a password
  or a host-key answer at ssh's prompt) is never held. The token so reaches the host only through the
  terminal's input; it is in no argv on either side and in no file, and the
  `QUICKTERM_DEBUG_IO` input log shows it as `<hook token>`
  (`PtyBase.write_secret`).
- `quickterm-agent-start` sets an idle state of that agent unless it already
  reported one; `quickterm-agent-exit` sets `agent` to null, for Claude and
  Codex alike. They exist because the process check sees only ssh here. A
  remote session's `GET /api/sessions` item carries `host` (the SSH
  destination; null locally and in WSL), and the frontend's `agentPresent` judges a remote
  agent pane by `agent` alone, so Shift+Enter stops sending ESC CR once the
  agent has left.
- Claude's hooks are one inline `--settings` (no status line); each command
  is `[ -S "$QUICKTERM_HOOK_SOCKET" ] && command -v curl ... && { exec 4<&0;
  printf 'X-QuickTerm-Hook-Token: %s\n' "$QUICKTERM_HOOK_TOKEN" | curl
  --unix-socket "$QUICKTERM_HOOK_SOCKET" -sS -m 2 -o /dev/null -H @- -H
  'Content-Type: application/json' --data-binary @/dev/fd/4
  "http://127.0.0.1:<port>/api/sessions/$QUICKTERM_SESSION_ID/agent-event?agent=claude"; }; exit 0`.
  The URL names the backend's port so the Host header passes the guard. A
  launch that passes its own `--settings` gets no hooks (the file lives on
  the host). Codex gets `-c notify=["sh","-c",<same with --data-binary "$1">,"quickterm-notify"]`
  only when the local Codex config has no notify.
- `SessionInfo.cwd` of a remote session is the folder on the host; the ssh
  process itself starts in the home folder here.

### Agent profiles

Since 4.3 these are the agent settings (`cfg.agents`, launched as profile
`"claude-code"` or `"codex"`; `config.agent_profile` hands them to the launch
code as an `AgentProfile`, and `profile` below means that object). There
are no saved profiles since 4.5. The mode is `agent_mode` from the request (a
startup item sends its own), else the settings' `agent_mode`, else the type default
(claude-code `continue`, codex `new`). A request's `agent` options are
merged over the settings' for one launch. `agents.validate` checks the
options on save and on every launch; `launch.resolve` stays the only
launch path. `GET /api/system/agents` serves each option's `flag` too, for the
command line Settings shows.

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
  `delete`, `numpad0`-`numpad9`. Letters and digits are `VK_<char>`, which
  Windows places by layout (Settings records the letter the layout prints).
  The named punctuation keys (`grave` through `backslash`) are physical
  positions: each has a set-1 scan code that `MapVirtualKeyW(scan,
  MAPVK_VSC_TO_VK_EX)` turns into the virtual key under the current layout,
  with the US virtual key as the fallback off Windows. The other named keys
  map to fixed virtual keys.
- a single punctuation character from an older config (`ctrl+alt+-`) still
  parses through `VkKeyScanW` under the current layout.

`app.py` registers the summon key with `on_hotkey_thread=True` as
`lambda: toggle_window("QuickTerm", getattr(cfg, "overlay", None))`, so the
live overlay settings are read at press time and the Win32 window work never
runs on the asyncio loop. The summon key is the only global hotkey since 4.5
(per-profile keys went with the profiles). `_GlobalHotkeys.rebind(cfg)` (the server's `rebind_hotkeys`) builds the entries
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

## quickterm/usage.py and quickterm/statusline_chain.py

The backend half of the sidebar's usage line (the 4.3 section below has the
shapes). Both modules are stdlib only.

```python
# usage.py
CLAUDE_EVENT = "QuickTermRateLimits"
class ClaudeLimits:                          # one per app, on app.state
    def attach_file(self, path) -> None      # blocking; load, then save there
    def record(self, rate_limits) -> bool    # False keeps the previous numbers
    def needs_save(self) -> bool             # windows differ from the file
    def save(self) -> None                   # blocking; writes only a change
    def snapshot(self) -> dict | None        # the "claude" value of GET /api/usage
def claude_usage_file() -> Path              # <config dir>/claude-usage.json
class CodexReader:                           # one per app, on app.state
    def read(self) -> dict | None            # blocking; the "codex" value
def read_rollout_tail(path, tail=256 * 1024) -> dict | None

# statusline_chain.py
FLAG = "--statusline"
def run(argv: list[str]) -> int             # argv ignored; always 0
def user_command(status: dict) -> str | None
```

- `ClaudeLimits.record` keeps `five_hour` and `seven_day` windows whose
  `used_percentage` is a number; `resets_at` may be epoch seconds or an ISO
  string. A report with no such window changes nothing.
- The running backend (`app._serve`) attaches `claude_usage_file()` once
  at start, off the loop: a valid file is the snapshot until Claude reports
  again, a missing or broken one starts empty. The agent-event route saves
  through `asyncio.to_thread` only when `needs_save()`, that is when a
  window's `used_percent` or `resets_at` changed; the file is
  `{"windows": [...], "updated_at": <epoch s>}`, written atomically, and its
  `updated_at` is the time of the last change. `create_app` alone keeps the
  numbers in memory, so app tests never touch the config folder.
- `CodexReader` walks `<CODEX_HOME or ~/.codex>/sessions` for
  `rollout-*.jsonl`, takes the newest by mtime and falls back to the next
  two when the newest has no limits yet (a session that just started). A
  window without `resets_at` but with `resets_in_seconds` (older Codex)
  counts from the event's timestamp. Answers are cached by path and mtime.
- `GET /api/usage` (`api/usage.py`) reads Codex through `asyncio.to_thread`.
  The agent-event route answers a `QuickTermRateLimits` event from `claude`
  by storing the numbers (404 for an unknown session) and never calls
  `SessionManager.agent_event`.
- `agent_hooks` adds `statusLine` to the same `--settings` file as the hooks,
  so it follows every rule for when hooks are added. Frozen, the command is
  `"<exe>" --statusline`; from source it is `"<python>" -P -c "<import
  statusline_chain and run>" --statusline`, because importing the whole app
  takes over a second and Claude runs the command on every status update.
  A `--settings` value of the agent settings' own that sets `statusLine` keeps it
  for that launch, and that launch reports no Claude numbers.
- `statusline_chain.run` resolves the user's command itself from
  `<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json`, then
  `<project>/.claude/settings.json` and `settings.local.json`, where the
  project is the status JSON's `workspace.project_dir`, else its `cwd`. It
  never reads QuickTerm's merged file, skips a command that carries
  `--statusline` and mentions QuickTerm, and sets
  `QUICKTERM_STATUSLINE_CHAIN=1` for the child; a chain started with that
  variable set does nothing. On Windows the command runs in Git Bash
  (`CLAUDE_CODE_GIT_BASH_PATH`, else next to `git` on PATH), as Claude Code
  runs it, else in the platform shell; it gets 10 s. The post runs on a
  thread while the user's command runs, and the chain waits for it at most
  2 s after printing.

## frontend/

- `index.html`, `css/`, `js/` (ES modules, no build step), `vendor/` with
  pinned xterm: `@xterm/xterm@6.0.0`, `@xterm/addon-fit@0.11.0`,
  `@xterm/addon-webgl@0.19.0`, `@xterm/addon-web-links@0.12.0`,
  `@xterm/addon-unicode11@0.9.0`, `@xterm/addon-search@0.16.0` (the release
  published with xterm 6.0.0; its MIT licence is `vendor/addon-search.LICENSE`)
  (the UMD `lib/*.js` builds and `css/xterm.css`, committed; since 4.5 `.gitignore`
  ignores only the root `/vendor/`, so a new file here needs no `git add -f`). 6.0 is the floor on Windows: the bundled OpenConsole is 1.24,
  and since 1.22 ConPTY does not repaint after a resize, so the terminal must
  reflow as ConPTY does, which 5.x did not.
- The top-level document is the shell (see **Shell and the stage** below);
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
- `panels.js` owns only panel lifecycle and shared controls. The workspace
  board (`panel_dashboard.js`, its pure model in `board_model.js`), workspace
  settings (`panel_workspace.js`), help, settings sections, and DOM-free
  helpers live in their own modules. Keep
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
- `split_tree.js` is the binary split tree under the panes of a workspace:
  `dwindleDir` (cut along the longer side, so repeated opens spiral inward
  like a tiling window manager) and the tree helpers `pane_move.js` builds
  its drag surgery on. Workspace views are not tiled (see **Shell and the
  stage** below).
  A new terminal with no direction of its own (`Alt+N`, attach, an agent row)
  uses `LayoutManager.autoDir`, which is dwindle. Splits, closes, moves and
  rebalances slide: app.css transitions `flex-grow` on the children of a
  split carrying `.sliding`, never during a splitter drag, and
  `prefers-reduced-motion` turns it off.
- **Shell and the stage.** The top-level document of a native window is the
  shell. It hosts no workspace, no LayoutManager, no autosave and no
  terminals. It owns the sidebar, palette, panels, launch loop, global
  settings watcher, theme, update check, setup tour and `launch_error`
  banner, plus the stage, which shows one workspace view at a time. Every
  workspace, scratch included, is a same-origin iframe view running the app
  on one workspace, with its own registry id, claim, LayoutManager,
  autosave, focus ownership and heartbeat. There is no primary view.
  - `workspace_views.js` (`window.quicktermViews` in the shell; the stored
    list of open workspaces, its parsing, the one-time migration and the
    restore plan live in `open_views.js` and are re-exported) owns the
    stage. `open(name|null, {cwd?, first?}) -> Promise<view|false>` shows
    that workspace, opening it first when it is not open, and resolves once
    the view's `window.quicktermView` exists; `focusView`, `focusWorkspace`,
    `focusSession`, `cycle(delta)`, `close`, `viewForWorkspace`,
    `scratchView`, `viewForSession`, `appFor`, `views`, `active` (the shown
    view), `list() -> [{workspace, label, color, active, window}]`,
    `activate`, `nameOf`, `ready`, `whenReady`, `restoreSaved` and
    `releaseLeftovers` complete it. `companionUrl(path, workspace, id,
    token, {cwd, first})` builds a view URL
    (`?workspace=<name>&window=<id>&embedded=1`, authentication in `#t=`);
    the view reserves its registry id first.
  - The stage shows exactly one view, at the full stage rect: no view
    header, no frame, no close or maximize button on the view, no divider,
    no view drag. Every view element is absolutely positioned with `inset:
    0` and appended to the stage once; an iframe that moves in the DOM
    reloads, so showing another workspace only toggles `.shown` on the
    elements. A hidden view keeps its box (`visibility: hidden`, never
    `display: none`, so xterm keeps its size), is `inert`, is suspended, and
    is told `quicktermView.setHidden(true)`, so its panes drop WebGL after
    the 5 s grace. A view still booting learns it from `ready()`.
  - A view stays on one workspace for its whole life. The sidebar, palette,
    workspace board and launch loop show a view, opening it when needed; they
    never switch a view in place. `switchWorkspace` remains for the restore
    inside a view, promoting a scratch to a named workspace (rename in
    place) and a deleted workspace.
  - Opening a workspace already open in this window shows its view. One
    claimed by another native window is refused with the existing text in
    `#app-error` and nothing is drawn.
  - Closing is on the sidebar row's close button and in the palette. Every
    close works the same way: wait for a successful save, mark every owned
    terminal retained, release the registry entry, remove the iframe.
    Nothing is killed; a failed save keeps the view open and shown. Closing
    the shown view shows the most recently shown remaining one. Deleting a
    workspace that is open closes its view first, then calls `DELETE
    /api/workspaces/{name}`.
  - Closing the last view leaves an empty stage with one centred block, "No
    workspace open. Open one from the sidebar." and a **New scratch** button.
    It is content, not a chrome bar.
  - Scratch: one scratch view per window, `scratch-view-<registry id>`
    (`temporary: true`), labelled `scratch`. **New scratch**, the sidebar's
    **Scratch** and the palette's **open scratch** show it, opening it when
    it is not open. A closed scratch view gives its label back, so terminals
    it kept are listed as `scratch <id>`.
  - Persistence: the primary window stores `quickterm.openViews.v1` in
    localStorage, `{"version":1,"open":[<name or "" for scratch>...],
    "shown":<same or null>}`, in opening order, written on every open,
    close and switch. A second window neither restores nor writes it. On
    the first boot after 4.2 the tiling record `quickterm.workspaceViews`
    (version 2, or version 1 with a 3.x `{primary: true}` leaf that becomes
    the remembered workspace) is read once for its leaves in tree order,
    its active leaf becoming `shown`, and removed.
  - Shell boot: release every registry entry a previous page of this window
    left under `parent: <this window>` (`releaseLeftovers`; their goodbye on
    pagehide rarely leaves in time, and the registry would refuse the new
    claims for the TTL). Then restore the stored list: claim each workspace
    in order, drop missing and refused ones, show the stored shown one (else
    the first). "Missing" needs a workspace list: when `GET /api/workspaces`
    failed at boot every stored workspace counts as existing and its own
    claim and restore decide, so one failed request never persists an empty
    list. With `?cwd=` (Explorer "Open QuickTerm here") start a terminal at
    that folder in the scratch view, opening the scratch view there first
    when it is not open. If nothing was restored, open
    `quickterm.activeWorkspace` when it still exists (read once, for
    migration), else the scratch view flagged `first=1`. Only that first
    scratch view adopts an existing "Administrator - …" session, the
    elevated first terminal.
  - `window.quicktermChrome` (shell) holds `{palette, panels, saveState(text,
    status), showError, clearError, ownsKeyboard(), refreshSoon(),
    settingsEvents, selectedTerminal, scratchLabels, launcherView (getter),
    windowId (getter, the shell's registry id), onConfigSaved(),
    onWorkspacesChanged(), deleteWorkspace(name)}`. `onConfigSaved()` and
    `onWorkspacesChanged()` are how Settings or Workspace settings reaches
    every other view; `deleteWorkspace(name)` closes this window's view of it
    first (its on-screen terminals are taken out of the file, so the server
    spares them as unassigned), then calls DELETE /api/workspaces/{name}, and
    throws `{detail}` on failure. Every view registers with
    `parent: windowId`. `window.quicktermView`
    (each view) holds `{workspace(), app, suspend, setHidden, close,
    syncConfig, syncWorkspaces, previewTheme, whenRestored}`. A view app adds
    `killSessionById(id)`, `detachSessionById(id)` and `hereState()`.
  - Keyboard: `keys.js` runs in the shell and in every view. The shell routes
    its actions to the shown view's app; Alt+N with no view opens the scratch
    view. Native window focus (summon hotkey, taskbar) lands on the shell,
    which forwards it to the shown view's focused pane. A pointer press or a
    focus inside a view releases its suspension only while it is the shown
    one. Views respect the shell's overlays through
    `parent.quicktermChrome.ownsKeyboard()`. Next and previous workspace walk
    the open ones in sidebar order (saved workspaces by name, scratch last)
    and wrap; since 4.3 they are also Alt+PageDown/PageUp. The keys that
    concern the window (Ctrl+Shift+1..9, Alt+PageDown/PageUp, Ctrl+Tab and the
    release of Ctrl) are answered by the shell: it passes them to its own
    `initKeys`, and a view's `keys.js` reaches the same functions through
    `parent.quicktermChrome.windowKeys` (`showWorkspace(n)`,
    `cycleWorkspace(delta)`, `recentTerminals(delta)`, `ctrlReleased()`).
    `recentTerminals` answers false when nothing is listed or a shell overlay
    holds the keyboard, and keys.js then leaves the key alone. Alt+Shift+n
    counts the workspace groups the sidebar draws (`sidebar.groups()`,
    `workspaceSlots` in workspace_views.js): saved workspaces and the open
    scratch view, never Unassigned or a closed scratch's leftovers; a sidebar
    not grouped by workspace counts the open views instead. The shell records
    the focused terminal on every `quicktermChrome.refreshSoon()`
    (`recent_terminals.js`, at most 8) and draws the list (`switcher.js`,
    focus owner `"switcher"`).
- Panes: an exited pane shows `[exited · code N]` with a Restart action
  (button, Enter in the pane, "restart terminal" in the palette) when it knows
  its launch (an agent or a launch spec; an attached terminal started
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
  that workspace, any other offers to create one named after the folder
  (`folderWorkspaceName` in `here.js`: characters a name cannot hold become
  dashes, a taken name gets " 2", " 3"...). The offer is the inline
  "make <name> a workspace" line under the active head and the first row of
  the Workspaces "+" menu. `createWorkspaceHere()` writes the terminal into
  the target's layout first, retains and detaches it here, then opens or
  focuses the target's view, whose restore attaches it again; a workspace
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
  left to the backend idle reaper instead of being unconditionally killed:
  closing a scratch view (`lifecycle.closeView`) retains and keeps in its
  file only the terminals that are busy, `touched`, retained, typed into in
  this view (`pane.userWrote`) or unknown (also when `GET /api/sessions`
  fails); an idle untouched shell loses its leaf and its id there, is not
  retained, and `reap_idle` collects it after `idle_timeout_s`. A named
  workspace's view retains every terminal it owns.
- The sidebar footer is built from the `chrome` array the shell passes to
  `initLauncher`, each entry `[label, onClick, shortcut?]`, with the labels
  "workspace board", "settings", "help" and "right panel". `launcher.js` maps
  the label to a glyph through `NAV_ICONS` in `sidebar_model.js`; an
  unmapped label falls back to the terminal icon, so a new entry needs one
  line there as well.
- `render.js` is the keyed reconciler behind every live panel. A refresh must
  patch, never rebuild: the workspace board reloads every 5 s, and recreating
  the old dashboard's DOM destroyed half-typed input and the folder picker's
  captured field. Nodes are
  reused per key and never moved when already in place, because detaching a
  node blurs a focused control inside it.
- `focus.js` decides who owns the keyboard. A pane re-asserts `term.focus()`
  immediately, on a frame, and on a timeout, so an overlay that focuses its own
  control must claim first and release before handing back.
  `WorkspaceViews.focusView(view)` asks it too: while any shell owner holds
  the keyboard it only shows the view and keeps it as `pendingFocus`,
  and the overlay's own hand-back focuses it. In the shell any claim stands
  the plain Alt actions down (`paletteOpen: () => focusOwners().length > 0`),
  and the palette and panel toggles (shell and view) first close an open
  `menu.js` menu and confirmation box (`"replaced"`).
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
- Sidebar (`launcher.js` builds the DOM; `sidebar_model.js` holds its pure
  model: modes, width, groups, row states, the "+" menu rows
  (`newTerminalMenu`, `defaultShellRow`, `chosenRow`) and their storage,
  re-exported from `launcher.js`). `cycleTerminal` opens the "+" menu since
  4.3; `newTerminalChoice()` is the row "+" starts, or null while that is
  the configured shell, and a view's Alt+N asks it through
  `state.launcherView`. Each view app answers `noteSessions(list)` from the
  sidebar's poll, so an agent pane knows when its agent has left the shell
  (`pane.agentGone`: no Shift+Enter newline, no working label). The shell calls `initLauncher(el, {actions, chrome,
  elevated})` once and gets `{update(partialModel), updateHere(here),
  cycleTerminal, newTerminalChoice, nextNeedsYou, mode, setMode, cycleMode}`;
  every data change goes through
  `update`, which patches groups keyed `group:<key>` and rows keyed
  `session:<id>` with `render.js patchList`. An open kill popover, menu or
  rename input survives the 10 s poll; a popover whose row disappears closes
  itself. One flat list, top to bottom:
  1. The launch row: one split button, `+ <choice>` and the menu chevron
     (see "The "+" menu"). The administrator terminal and the terminal
     settings are rows of that menu, not buttons of their own.
  2. A **Workspaces** label with three buttons: search (`actions.search`,
     opens the palette on `@`) and the view menu (`menu.js`, see below)
     draw on hover or focus only (a filtered view keeps its tinted button
     drawn), and a `+` menu that always shows: **Make <name> a workspace**
     or **Open <name>** when the shown view offers workspace here,
     **New workspace…** (`new_workspace.js`: the in-app folder browser
     starts at `suggestedWorkspaceFolder()`, never the scratch folder; the
     chosen folder becomes a workspace named after it with an empty layout
     and its view opens; a folder that already is a local workspace's opens
     that one), **New workspace on host…**, a separator, **Scratch** (shows
     the window's scratch view, opening it when needed) and **Open in new
     window…**. The palette has "new workspace…" too.
  3. One group per saved workspace in case-insensitive alphabetical order;
     scratch groups next, ordered by label; then **Unassigned**. By default
     a workspace with no listed terminal that is not open in this window is
     hidden (`visibleGroups(groups, view)`), and a **Show N empty workspaces**
     line under the list turns the view's `empty` option on. A group head is
     a button with the fold chevron (always drawn: down while its rows show,
     right when folded or empty), a colour dot (the workspace's colour when open,
     hollow when closed), the label and the count pill (hidden at 0); its
     rows hang under it on a guide line. Its title is the folder path, with
     `.warning` when the folder is missing. A click shows the workspace on the
     stage, opening it when needed; the **active** group is the shown one and
     its head is highlighted (raised surface, accent edge, `aria-current`).
     Left and Right fold. Hover and focus-within actions: **Close** (`x`,
     only when open; saves and retains) and a kebab menu with Open in
     Explorer and Open in VS Code (a local workspace: the shown one at the
     focused terminal's folder, `openFolder`, also Alt+Shift+C and two
     palette rows; any other at its own folder, `openWorkspaceFolder`), Open
     in new window, Workspace settings (folder, logo and saved layout preview in
     its own small sheet, `Panels#showWorkspace`) and Delete
     workspace… (confirm popover: "Delete workspace <name>? Detached
     terminals it owns are killed; attached ones keep running."). The
     **active** group keeps one head row: the folder name after the label
     (hidden when it equals the label), the one `#sb-save` dot after the
     count (same id and `data-state` contract, driven by `feedback.js`).
     Only the **workspace here** button takes a line below the head, and
     only while it is offered. A terminal row is one line too: past `SIDEBAR_WIDE_AT`
     its folder follows the name, and under a workspace only when it differs
     from the workspace folder (for scratch, from where the terminal
     started). Two terminals of one name in one group are told apart by a
     number ("PowerShell", "PowerShell 2") in the order they were started
     (the index in `GET /api/sessions`, which lists them that way), so a
     new one gets the next number and the activity sort never moves it.
  4. The footer: workspace board, settings, help, right panel, centred, and
     the collapse chevron on the right edge.

  The view menu (per window, `quickterm.sidebarView`, normalised by
  `normalizeView`): **Show** empty workspaces (default off) and finished
  terminals (default on; a finished terminal with an open attention always
  shows), **Group by** workspace (default) or nothing (one `flat` group named
  Terminals whose rows name their workspace), **Sort by** name (default) or
  recent activity, and **Reset view**. A non-default view tints the button.

  With the default sort, order is stable: groups as above, rows by name
  (`localeCompare` with `numeric: true`), then start order. Recent activity is opt-in
  and orders rows, then groups, by `activity.idle_seconds` (busy and
  attention count as now, finished last). Under the default sort, state
  never reorders anything: "needs you" is a chip,
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
  into the scratch view when none is open. Every click marks the session
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
  Enter or Alt+W completes (the box opens with `acceptsAltW`, and the shell's
  key layer calls `acceptConfirm()` before it stands down for an overlay; a
  sheet's confirmation box never takes Alt+W). Escape cancels; Tab
  stays between Kill and Cancel. In rail mode the row's actions have no box,
  so the row itself is the trigger. While open, the trigger stays visible and
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
  `removeSessionsFromSavedWorkspaces` removes the whole leaf
  (`layout_sessions.withoutSessionLeaf`, collapsing its split), the same tree
  a closed pane leaves in an open view; a bare `{profile}` leaf would be
  restored as a template and spawn a new process. A file that cannot be
  edited is retried once and then named in `#app-error`. Moving a terminal
  out of a closed workspace still only strips the id
  (`removeSessionFromLayout`). Deleting a workspace releases its on-screen
  terminals in one save and aborts before the DELETE when that save fails.
  The pure decisions are `rowAction` and `killRoute` in `shell_routing.js`.
- Kill all (the palette's kill list: "kill all terminals…", shown with two or
  more live terminals, then a confirmation row with the kill selected) is a
  shell member, `killAllSessions()` in
  `shell_routing.js`, whichever view is active. Only the backend's
  `killed_ids` travel: the sidebar forgets those rows at once, every view of
  the window runs `app.dropKilledSessions(ids)` (close the panes on them,
  forget them, autosave), and then `removeSessionsFromSavedWorkspaces` edits
  every saved workspace file, including the ones open in a view (that view's
  debounced autosave also leaves the killed terminals out, so either write
  may land last). `failed_ids` stay visible everywhere and the confirmation
  says how many. The verified ids also go to the app's other native windows
  (`localStorage["quickterm.killedSessions"]`, whose storage event reaches
  only them), where `dropKilledEverywhere(ids)` closes and
  forgets them in every view without another backend call.
- Workspace board (the panel view still named `"dashboard"`, Alt+G, the footer
  button and the palette's "workspace board"): since 4.5 the six derived
  columns of "The board sorts itself" (4.5 wave 2); the 4.3 four-column
  board with drag and `PUT /api/board/{name}` is superseded. Scratch is never
  a card. A card's terminals are the live sessions whose owner
  (`liveTerminals()`, the sidebar's rule) is that workspace; a workspace
  `GET /api/board` does not name waits in Idle. A card whose status changes
  keeps its node and slides to its new column. The search box sits in the
  panel head (`Panels#headTools`); Escape clears it first, then closes the
  board. Cards: Enter or Space shows the workspace, Up and Down walk a
  column, Left and Right go to the nearest column that has a card. No card
  moves by hand.
- Workspaces: named workspaces autosave layout and session IDs and restore the
  exact live sessions; the shell's arrangement remembers which views were
  open. The window's scratch view uses `scratch-view-<registry id>` with
  `temporary: true`, displayed as `scratch`, autosaves and survives a view
  close within a run. Startup/shutdown delete the legacy scratch file and
  flagged temporary workspace files, never the scratch folder contents or
  unrelated workspaces. Names `scratch`, `scratch-view-*`, and dot-prefixed
  names are reserved in the user save flow. Promoting scratch saves a normal
  durable workspace in place.
- The sidebar lists every live terminal on the backend in its owner's group.
  Chips appear only for needs you, new output, busy and open elsewhere.
  Per-terminal CPU and memory are the sidebar footer's Resources popover.
- Settings, with no raw JSON editor. Tabs (`settingsTab` ids, `SETTINGS_TABS`
  in `settings_index.js`):
  - `general` "General": color theme (opens the theme switcher), font, text
    size, shell, notifications, keep awake
  - `window` "Window": size presets through `configChoice` (1280×800,
    1440×900, 1600×1000, 1920×1080, Custom W×H), **Use this window's size**
    (`window.pywebview.api.window_bounds()`, else `outerWidth`/`outerHeight`),
    the remember toggle, the Overlay group (enable, edge, width %, height %,
    always on top, hide when focus leaves, monitor, animate) and the summon
    shortcut with a note that overlay mode changes what it does
  - `shortcuts` "Shortcuts": the summon key and the in-app key reference
  - `agents` "Agents" (4.5): Claude Code and Codex, one row each with the
    resulting command line, expanding to the option editor and their
    environment. The old ids `connections` and `terminals` open this tab
    (`settingsTabId`).
  - `snippets` "Snippets": master and detail
  - `advanced` "Advanced": host, port, scrollback, idle cleanup, limit,
    scratch folder, update check
  - `about` "About"

  `Panels#showSetting(id)`, `Panels#showConfig("snippet", name|null)` (any
  other kind opens Agents) and `Panels#settingEntries()` are the entry points
  for the palette and search. `Panels#showWorkspace(name)` opens the
  `"workspace"` sheet for that workspace (the sidebar's "Workspace
  settings"): location, folder, Environment, Start with, logo and the saved
  layout's preview, with Cancel, **Save and start them** and Save. Every chooser is
  `configChoice` (a `menu.js` menu); `Panels._select` and every native
  `<select>` are gone. Every field stamps `data-setting=<id>`.
- Master and detail (`config_list.js`) serves the snippets since 4.5: on the
  left a filter input (always shown) and one-line rows (name, a command
  preview, a problem marker, a dirty marker, hover action **Remove** with
  the confirm popover); on the right the editor of the selected item. Rows
  are patched with `patchList`; typing in the editor updates its row through
  `setText` and never rebuilds the editor; selection survives filtering.
  Below 820 px the detail replaces the list and shows a Back button.
- Superseded in 4.5: the `connections` "Terminals" tab, the terminal editor
  (executable, arguments, start command, shortcut, autostart, connection
  fields), the SSH and SFTP editor with its client choice and the
  "From ~/.ssh/config" Add rows, `profile_model.js` and
  `panel_connections.js`.
- Agent types, modes, mode labels (`AGENT_MODE_LABELS`), `agentModeOf(profile,
  type = profile.terminal_type)` and the arguments a mode adds (`modeArgs`)
  exist once, in `agent_profile.js`; Settings, the sidebar's terminal
  choices, the palette and the workspace Start with list import them from
  there.
- Agent editor (`claude-code`, `codex`, Settings > Agents and each agent item
  of a workspace's Start with list): the fields are generated from
  `GET /api/system/agents`, so the frontend hardcodes no option list. The
  mode is `settings.agent_mode ?? (codex ? "new" : "continue")`, labelled
  new "new conversation", continue "continue latest", resume "choose
  session", fork "fork a session" (codex only), agents "agent manager".
  Advanced options sit under the Advanced disclosure.
- One Save. The footer **Save** persists everything (agents, snippets,
  settings) through `settingsPatch`; Ctrl+S inside the sheet triggers the
  same save. Unsaved rows show a dirty marker. Cancel discards the draft. A
  saved change to the summon key applies at once (live rebinding); only host
  and port still say they apply after a restart.
- Key capture (`shortcut_input.js`): a button shows the binding as `kbd`
  chips, or "Not set". Click or Enter starts capture ("Press a shortcut… Esc
  cancels, Backspace clears"): it calls `claimFocus("shortcut")`, listens for
  keydown in the capture phase on `window` with `preventDefault` and
  `stopImmediatePropagation`, leaves plain Tab alone, and calls
  `api.suspendHotkeys(true)` (POST /api/hotkeys/suspend) so a combination
  QuickTerm already registered is recorded instead of fired. Finish, blur or
  cancel calls `api.suspendHotkeys(false)` and releases focus; the server
  resumes on its own after 20 s. The pure `bindingFromEvent(e)` ignores lone
  modifiers and returns `{binding, label}`, modifiers in the order ctrl, alt,
  shift, win, in the hotkeys.py grammar. A letter is the one the active layout
  prints on the pressed key (`navigator.keyboard.getLayoutMap()`, US reading
  without it), because hotkeys.py registers `VK_<letter>`, which Windows places
  by layout; Ctrl+Alt is AltGr, so `e.key` cannot tell. Digits, F-keys,
  numpad and named keys come from `e.code`; named punctuation (`grave`,
  `minus`, `equal`, `comma`, `period`, `slash`, `semicolon`, `quote`,
  `bracketleft`, `bracketright`, `backslash`) is a physical position that
  hotkeys.py resolves through its set-1 scan code with
  `MapVirtualKeyW(scan, MAPVK_VSC_TO_VK_EX)`, and its chip shows what the
  layout prints there (ß, not -, on QWERTZ). The button's accessible name is
  `<label>: <binding | "Not set" | the capture prompt>`.
  `shortcutWarnings(binding)` reports errors (no ctrl, alt or win, flagged
  `modifier: true`) and warnings (a cold Alt key `keys.js` claims; a plain
  Alt pass-through key such as Alt+V/P/H/0-9/-, Alt+B/F). The capture input
  serves the summon key and the parked voice hotkey. `keys.js` exports one `SHORTCUTS`
  table `[{id, keys, label, group}]`; the Help panel and the Shortcuts tab
  render from it.
- Settings search: a search input tops the tab nav, with a `/` focus hint
  while the sheet is open. While it holds text, the content area shows results
  grouped by tab: settings from `SETTINGS_INDEX` plus a row per snippet in
  the draft. Choosing one switches tab, scrolls `[data-setting=<id>]` into
  view, focuses its control and flashes it; a snippet result selects its row
  in the master list. Escape clears the box before it closes the sheet.
- Advanced exposes loopback host and stored voice preferences as controls;
  voice capture remains unavailable. A first-run three-step setup tour opens
  until it was finished or skipped once (`quickterm.setupComplete` in
  localStorage), and is available again from Help.
- Themes (4.5): 54 themes plus Custom. Settings > General shows the current
  theme as a miniature that opens the theme switcher (`theme_switcher.js`,
  rules in `theme_switcher_model.js`), as does the palette's "color theme…"
  row. The switcher is a centred sheet of miniatures grouped Dark, Light and
  Custom, with a search. Moving the selection (arrows, typing, the pointer)
  previews the theme on the whole window and every view by setting the
  root styles; Enter or a click saves it and the sheet stays open; Escape
  or Cancel goes back to the theme it opened on; Done keeps the selected
  card. Nothing is saved by a preview. The superseded 4.4 picker (four
  featured choices, Dark, Neon, Soft, Warm groups) is gone.
- State scope: saved theme/custom palette, font defaults, agent settings, snippets,
  default terminal, retention/limits, scratch folder and other config are
  backend-wide. `global_settings.js` publishes a revision-only storage event
  after saves and refreshes on native-window focus; each receiving parent
  reloads config and the workspace catalog into all its views without
  rebroadcasting or rebuilding an open editor. Settings sends only changed
  top-level fields and rejects stale conflicting edits. Unrelated config saves
  never reset pane-local font zoom. Theme preview/cancel covers all views in
  the editing window; a committed theme reaches other native windows.
  Sidebar mode/width, folded groups, launch choice, the open and shown workspaces
  belong to the native window. Workspace roots/logos/layout/session ownership
  belong to a workspace. Text zoom, cursor, input, terminal output and terminal
  lifecycle belong to a pane/session. Workspace-catalog changes refresh other
  views without replacing their layouts or moving their terminals.
  Workspace folder/logo controls live in the Workspace settings sheet,
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
- Starting folders belong to workspaces, not to the agent settings or a
  startup item. An explicit launch directory overrides the workspace root;
  missing or deleted roots fall back to the home folder. WSL launches
  translate Windows roots for `--cd`, and use `wsl.exe --cd ~` with no root.
  A startup item's shell command runs after that folder is selected. Every folder field is
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
  new-terminal rows (`new terminal: <shell or agent>`) / actions (new
  terminal, split h/v, zoom, detach, kill, open folder in Explorer / VS
  Code, open file viewer, color theme…, run workspace setup, new
  workspace…) / snippets / recent sessions, plus:
  - `open workspace: <name>` → `app.openWorkspace(name)` (replaces "load
    workspace" and "show workspace beside…"; its hint says `shown` or
    `open`), `close workspace: <name>` for open views, `next workspace` and
    `previous workspace` (`app.cycleWorkspace(±1)`, a shell member) while
    two or more are open, `open scratch`
  - `go to terminal: <name>` for every listed terminal on the backend (hint:
    workspace label and state) → `app.activateTerminal(session)`
  - `kill terminal…`, a sub-mode listing live terminals. Choosing one shows
    "kill <name>? Enter kills, Esc goes back" with the kill row pre-selected,
    because this is a keyboard path; it calls `app.killTerminal(session)` and
    shows a failure inline
  - `setting: <label>` (kind `setting`) from `app.settingEntries()` →
    `app.openSetting(id)`; `edit snippet: <name>` → `app.editSnippet(name)`
    (the 4.4 `edit terminal: <name>` rows went with the saved terminals;
    `app.editTerminalConfig` now opens Settings > Agents)
  - agent rows per agent: "<Claude Code|Codex> new / continue / choose
    session / fork (codex) / agent manager", "split agent view: <agent>",
    and `resume <Claude|Codex> session: <title>` for the active workspace,
    filled late from `api.listAgentSessions`. `agentSessionTarget(app)` in
    `palette_items.js` picks the folder: a named workspace by name, a scratch
    view (or no view) by `cwd`, the view's `agentSessionFolder()` (the folder
    it was opened on, else the scratch root), which is also where
    `resumeAgentSession` starts the agent
  - prefix filters parsed in `_refilter`: `>` actions, `@` workspaces and
    terminals, `#` settings and configs, `!` snippets; a prefix alone lists
    that kind

  Sub-modes: kill (with "kill all terminals…"), search, new window, save
  workspace as. There is no free-text prompt that opens or loads a
  workspace, because a typo used to tear the whole layout down silently.
  "save workspace as…" names the shown layout through `saveWorkspace(name,
  folder)`: a scratch layout passes `suggestedWorkspaceFolder()`, a named one
  keeps its folder, an existing other workspace's name is refused instead of
  overwritten, and a refusal shows as a row under the input with the typed
  name kept.
  Snippet rows carry the command text and the destination pane, and a
  multi-line snippet is confirmed in the pane before it runs. Pane sizing is
  not duplicated here; it lives on the splitter.
- App object seen by the palette and the panels (the shell wires it;
  shell members win over the shown view's app): `openWorkspace(name)`,
  `loadWorkspace(name)` (alias), `closeWorkspaceView(name)`, `newScratchView()`
  (shows the scratch view), `cycleWorkspace(delta)`,
  `openWorkspaces()`, `liveTerminals() -> [{session, workspace, label,
  attachedIn}]`, `activateTerminal`, `killTerminal`, `killAllSessions`,
  `detachTerminal`,
  `settingEntries`, `openSetting`, `editTerminalConfig`, `editSnippet`,
  `setupTerminals`. Per view, from the spawner: `runAgentMode(profile, mode)`,
  `resumeAgentSession(profile, sessionId)`, `splitAgentView(profile)`,
  `agentSessionFolder()`, with the aliases `runClaudeMode` and
  `splitClaudeAgentView`. Per view, from the pane commands:
  `dropKilledSessions(ids)` for the shell's kill-all.
- Split actions start the configured shell (4.3) in the source pane's
  best-known directory. Panes track only OSC 7 and OSC 9;9 shell-integration
  signals, falling back to their launch folder; prompt text is never parsed.
  An OSC 7 `file://<host>/path` is a local path on a non-Windows client
  whatever the host (a POSIX shell names its own machine there); on Windows a
  drive-letter path is local, and only a host other than `localhost` makes a
  UNC path.
  Sidebar Open and Alt+N use the workspace root. Remote and container splits
  also use that root instead of borrowing a shell's signalled directory. An
  agent launch (Claude Code or Codex) always uses its workspace's project
  folder; the palette's explicit **split agent view** opens the agent
  manager (`claude agents --cwd <project>`, `codex agents`).
- Keybindings (in addition to palette; `keys.js SHORTCUTS` is the one table):
  Alt+N opens a new default terminal (a scratch view when no view is open)
  in the focused pane's `bestKnownCwd()` when that lies inside the workspace
  folder (`sameFolderCwd` in spawner.js), else in the workspace folder,
  Alt+Shift+Right/Down split (H/V aliases), Alt+Shift+S cycles the sidebar
  (full, rail, hidden), Alt+Z zoom, Alt+D detaches and
  retains the process, Alt+W always opens confirmation before a process-tree
  kill and pane close, Alt+arrows focus move,
  Ctrl+±/0 font size. Plain Alt+V/P/H/0-9/- pass through to the shell
  (Claude Code image paste & model switch, PSReadLine/readline bindings).
  The zoom layer matches only keys that actually produce `+`/`-`/`0`: physical
  codes are never matched on their own, so Ctrl+`]` (vim tag jump) and Ctrl+`/`
  (readline/PSReadLine undo) reach the shell on ANSI layouts.
  Alt+Shift+Left/Up open the "+" menu (4.4; there is no choice to cycle
  since every row starts its terminal). Ctrl+Left/Right
  remain untouched for PowerShell/readline word navigation.
  Alt+Shift+C opens the focused terminal's folder (its OSC 7 directory, else
  its launch folder, else the workspace folder) in VS Code through
  `POST /api/open`; Explorer is the palette row and the sidebar button.
  Alt+Shift+E toggles the right panel (4.3), also while the panel or its file
  view holds the keyboard. Plain Alt+E and Alt+C stay with the shell (Alt+C
  is readline's capitalize-word).
  Ctrl+Shift+F in a pane opens its find field (`pane_find.js`, focus owner
  `"pane-find"`, claimed only while the field has focus, so a click back into
  the terminal leaves the matches marked and the terminal focused). Ctrl+Tab
  is the recent-terminals list; Ctrl+Shift+1..9 and Alt+PageDown/PageUp are
  the workspace keys (see the shell's keyboard notes).
- A second ordinary QuickTerm process never creates another native viewer.
  It authenticates to the existing loopback backend, queues an optional Explorer
  folder through `/api/launches`, and restores/focuses the one existing window.
  The primary window's shell atomically claims folder requests and opens each
  in the window's scratch view.
- Destructive UI actions use an in-app confirmation placed by the triggering
  control: `confirm_popover.js` (the sidebar calls it directly, and
  `Panels._confirmNear` delegates to it with owner `"confirm"`), or the kill
  bar inside the focused pane for keyboard actions. When a
  pointer opened it, **Cancel** receives focus, so a reflexive Enter on a bar
  the user did not expect can never complete a destructive action; a keyboard
  path (Alt+W, Delete on a sidebar row, the palette) asked for it and focuses
  the destructive button; Escape and the Cancel button also cancel, and
  Escape inside a panel cancels the confirmation before it closes the panel,
  except while its action runs (`closeConfirm(reason)` refuses a busy box;
  `{force: true}` is only for a surface that is going away). Panels ask
  `confirmIsOpen()` instead of tracking a copy of the box. A
  short-lived pane notice never hides an open confirmation, and an inline
  popover follows its trigger while the panel body scrolls (dismissing itself if
  the trigger leaves the viewport). Application code does not use browser
  `alert`, `confirm`, or `prompt` dialogs.
- Pane title-bar verbs: `×` **detaches** (closes the pane; the terminal keeps
  running), matching what that glyph means in every tabbed application. Killing
  is a separate, visually divided, text-labelled `.danger` control, in the pane
  header and on the sidebar row alike. Detach and kill must never be adjacent
  unlabelled glyphs.
- Clicking an open workspace in the sidebar shows its view; clicking a
  closed one opens a view and shows it. No click on a workspace replaces a
  layout or kills a running terminal; New scratch shows the window's one
  scratch view and never replaces another layout.
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
  translation; a pane whose terminal type is `ssh` or `sftp` refuses
  misleading local paths. A browser that withholds
  the native path produces an explicit Copy-as-path/Ctrl+V hint rather than a
  fake basename. Native Ctrl+V/Ctrl+Shift+V remains the ordinary
  PowerShell-friendly paste path.
- Pane focus is reasserted after creation, attach, and replay completion only
  while that pane is still selected; a late callback may never steal focus from
  a pane the user subsequently selected. Closing a full-screen Settings,
  workspace board, Help, or similar panel returns focus to the selected terminal
  before considering the control that originally opened the panel.
- Workspace restore attaches only matching live session IDs. A missing process
  restores as a transcript-free unavailable pane with explicit replacement and,
  for agents, recovery through the agent's own continue
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
- `js/usage_footer.js` and `css/usage.css`: the usage line. `launcher.js`
  calls `mountUsageFooter(el, {signal, handBack, actions, mode, groups})` once
  and the module owns the rest. The line asks `GET /api/usage` and
  `GET /api/sessions` (with metrics) 1.5 s after boot and then every 60 s,
  only while the sidebar is full and the document visible; the resources
  popover asks `/api/sessions` every 5 s while open. Both popovers are
  `role="dialog"`, claim the keyboard as `"usage"` in `focus.js`, close on
  Escape, Tab, an outside press, a window resize or blur, and toggle on a
  second press of their trigger; Escape hands the keyboard back to the
  terminal. Arrow keys move between the terminal rows. Lists patch through
  `render.js`. The model functions (`footerParts`, `agentSummary`,
  `usageBlocks`, `resourceRows` and the formatters) are pure and exported.

## Agent state, git worktrees and the PTY host (4.2, frozen 2026-10-24)

Frozen before the 4.2 round so the backend and frontend parts can be built in
parallel. Changing anything here goes through the integrator.

### Agent state from hooks

Every PTY QuickTerm spawns gets three environment variables:

```
QUICKTERM_SESSION_ID=<session id>
QUICKTERM_PORT=<backend port>
QUICKTERM_HOOK_TOKEN=<hook token>
```

The hook token is random per backend start and is accepted by exactly one
route, so a program in a terminal does not get the full API token from its
environment:

```
POST /api/sessions/{sid}/agent-event
  header X-QuickTerm-Hook-Token: <hook token>   (the normal X-QuickTerm-Token also works)
  body   {"agent": "claude" | "codex", "event": "<hook event name>", "payload": {...raw hook JSON...}}
  -> 204; 404 unknown sid; 401 bad or missing token; 400 malformed body; body capped at 256 KiB

POST /api/sessions/{sid}/agent-event?agent=claude|codex
  body   the raw hook JSON alone; the event comes from `hook_event_name` (Claude) or `type` (Codex)
```

The bare form exists because Codex's `notify` passes its JSON as the last
argument, which curl can only send as the whole body. Only this route answers
401; every other route keeps 403, and the hook token is refused there.

Transport: Claude gets one command hook per event, marked `async: true`, that
runs `%SystemRoot%\System32\curl.exe -K <config>` from
`%APPDATA%/quickterm/hooks/`; the configs read the three variables and stdin,
so one static set serves every terminal. Claude's `"type": "http"` hooks
cannot put an env var into the URL. Two `--settings` flags do not merge (the
last wins), so the agent settings' own `settings` option is read, QuickTerm's hooks are
appended, and the result is written to `hooks/claude-settings-<hash>.json` and
passed as the only `--settings`; unreadable user settings leave the launch
without hooks. Codex gets `-c notify=[curl, -K, codex-notify.curl,
--data-binary]` before any subcommand. A per-launch `notify` replaces the
user's, so when `config.toml` sets one (a list of strings) the launch gets
`notify=[<this program>, --codex-notify, <their argv>...]` instead:
`codex_notify.py` (handled first in `app.main`) starts their program with the
JSON as Codex would, then posts it to `?agent=codex`; it always exits 0. A
`notify` that cannot be read or is not a list of strings gets no hook. Codex hooks
are not used: each must be trusted in `/hooks` before it runs. No hooks in
the elevated backend, a backend whose `host` is not `127.0.0.1`, `localhost`
or `0.0.0.0` (the configs post to 127.0.0.1), or when `curl --version` is
older than 8.3 (`--variable`, `--expand-*`; checked once off the loop). Hook
files are written under a lock with unique temp names; the 8 most recently
used `claude-settings-<hash>.json` are kept. A SessionStart with source
`compact` keeps the state; the other sources reset it to idle. No hooks for
`agents` mode, a `.cmd`/`.bat` Codex shim, an explicit `cmd` or `args` in the
request, or elevated terminals. `LaunchSpec.agent` ("claude" | "codex" | None)
carries the choice to `SessionManager._build`, which adds the arguments there
because the session id exists only at that point.

Hook events run as separate processes and can arrive out of order: an event
that would move the state back from a more final one within 1 s (a tool event
after "waiting", anything after "done") is dropped.

Claude Code agents launched through `launch.resolve` get QuickTerm's hooks
for that launch only (never by editing the user's `~/.claude/settings.json`).
Codex gets the equivalent through its per-launch config. A hook that runs
without `QUICKTERM_SESSION_ID` does nothing and exits 0.

`GET /api/sessions` items gain one field:

```
"agent": null | {
  "kind": "claude" | "codex",
  "state": "working" | "waiting" | "done" | "failed" | "idle",
  "prompt": str | null,      # last user prompt, clean_text, <= 200 chars
  "message": str | null,     # last assistant message, clean_text, <= 200 chars
  "tool": str | null,        # tool running now while working, else null
  "subagents": [{"id": str, "type": str | null, "description": str | null, "age_seconds": int}],
  "age_seconds": int         # since the last state change
}
```

Claude events map to states: SessionStart idle; UserPromptSubmit working
(sets prompt, clears message); PreToolUse and PostToolUse working (tool);
PermissionRequest and a permission Notification waiting; Stop done (message);
StopFailure failed; SubagentStart adds and SubagentStop removes a subagent;
SessionEnd sets `agent` back to null. Codex's turn-complete notification is
done (message). `mark_seen` turns done and failed into idle; typing never
changes the state. The process exiting sets `agent` to null. "waiting" also
raises the existing attention with kind `"notify"` when nothing else did.

### Worktrees removed (4.3, decided 2026-10-25)

The user does not want worktree features. 4.3 removes everything below that
creates, lists or nests worktrees: `POST /api/workspaces/worktree`,
`quickterm/worktree.py`, the "new worktree..." palette row and row-menu entry
with its setup command, and the nesting of worktree workspaces under their
main checkout in the sidebar and on the board. `git_info` keeps `branch`,
`head`, `worktree` and `main_path`: a workspace whose folder is a linked
worktree is an ordinary workspace, listed like any other, and only says what
it is: its row and board card show the branch followed by a muted
`worktree` word, with the main checkout's folder in the tooltip. A workspace
is local or on an SSH host; nothing else. Workspace names may still contain `/`, so
the name routes stay `{name:path}`. The 4.2 text that follows is kept as
history.

### Git info and worktree workspaces

Git facts come from reading `.git` (a folder, or a `gitdir:` file for a
worktree) and `HEAD`; listing never starts a `git` process.

```
git_info := null | {
  "branch": str | null,       # null on a detached HEAD
  "head": str | null,         # short sha when detached
  "worktree": bool,           # a linked worktree, not the main checkout
  "main_path": str | null     # the main checkout's folder when worktree is true
}

POST /api/git/info  {"paths": [str, ...]}   (at most 256)
  -> {"<path as sent>": git_info, ...}

GET /api/workspaces/{name}  gains  "git": git_info   (for its path)

POST /api/workspaces/worktree
  {"from": "<workspace name>", "branch": "<new branch>", "base": "<ref>"?}
  -> 201 {"workspace": "<new workspace name>", "path": str,
          "setup": null | {"command": str, "source": str}}
  -> 400 bad branch name, the workspace has no git folder; 404 unknown workspace;
     409 the branch or the target folder already exists
```

The worktree goes to `<parent of main checkout>/<repo folder>-<branch slug>`
and runs `git worktree add -b <branch> <path> [<base>]` off the event loop. The
new workspace is named `<from>/<branch slug>`, its `path` the new folder, its
layout empty. `setup` is the first match of uv.lock `uv sync`,
package-lock.json `npm ci`, pnpm-lock.yaml `pnpm install`, yarn.lock
`yarn install`, poetry.lock `poetry install`; the backend never runs it. The
frontend opens the new workspace's view, starts the default terminal there
and types `command` followed by Enter, so the user sees it run. Removing a
worktree is not part of this round.

Beyond the codes above: an existing branch, target folder or workspace name
is 409 before git runs, and any other `git worktree add` failure is 500 with
git's last stderr line. A worktree made from a linked worktree still lands
next to the main checkout; the default base is the source checkout's HEAD.
Workspace names may contain `/`, so the name routes are `{name:path}`
(Starlette decodes `%2F` before routing).

### Frontend for agent state and worktrees

- Terminal rows: working pulses (the busy look), waiting has the needs-you
  halo, done a ring, failed a red dot; the tooltip carries prompt, tool,
  message and subagent count; running subagents are muted, non-focusable
  lines under the row. Looking at a done or failed terminal marks it seen.
- Relative idle time ("now", "5m") after the name on hover or focus only.
- Alt+J focuses the next terminal that needs you (waiting, attention, done
  or failed and unseen) in sidebar order and wraps.
- The `@` palette, with nothing typed, ranks needs-you, done and failed,
  working, then the rest; once typed, the match leads and rank breaks ties.
- Workspace rows show the branch (detached `@sha`) unless it repeats the
  name; worktree workspaces sit under their main checkout. Git info is one
  batched `POST /api/git/info` 1.5 s after the folders arrive, then every 60 s.
- "new worktree..." is a palette row and a row-menu entry for git
  workspaces, with the branch typed in the palette; the setup command goes
  through `POST /api/sessions/{id}/input`.
- Shift+Enter in a Claude Code or Codex pane sends `ESC CR` (ConPTY turns it
  into Alt+Enter, both CLIs' newline); other panes are unchanged.
- A pane in a hidden view, or covered by a zoomed pane, drops its WebGL addon
  5 s after it was hidden and loads a new one when shown; buffer and
  WebSocket stay. The shell tells each view through
  `window.quicktermView.setHidden(hidden)`.

### The PTY host

The process that owns the PTYs (the backend: server, session manager,
hotkeys, tray) and the process that shows the window are separate. Closing
or restarting the window process, and installing an update, leave the backend
and its terminals running; the next window attaches to it on the same port
with the same token, through the existing attach and replay. The HTTP and WS
interfaces above do not change. An update replaces the program files, so the
backend runs from a copy of the program that the installer does not lock;
an update that changes the backend itself restarts it only when no terminal is
busy or touched, otherwise it asks, and the new backend takes over the next
time the old one has nothing to keep. Restoring scrollback after a reboot is
not part of this round.

As built (`pty_host.py`), one program has three roles chosen by `app.main()`:

- **launcher** (`QuickTerm.exe`, no role flag): finds the backend through the
  verified probe or starts it detached, asks it for a window
  (`POST /api/host/summon`) and exits. A launcher of another, not older,
  frozen build first calls `POST /api/host/retire`.
- **backend** (`--serve`): server, sessions, global hotkeys and tray, which
  must work while no window exists. Frozen, it runs from
  `%LOCALAPPDATA%\QuickTerm\host\<version>-<hash>\QuickTerm-host.exe`
  (`QUICKTERM_HOST_DIR` overrides the root). The renamed exe keeps Setup's
  `taskkill /IM QuickTerm.exe` away from it. The running build plus one more
  are kept; a copy whose exe cannot be deleted is in use and stays. The
  `.complete` marker records the copy's file count and total size, and a copy
  that no longer matches is copied again; a copied backend that exits before
  it answers the probe is discarded and the backend starts once from the
  install folder. The elevated instance starts the installed `QuickTerm.exe`
  of the same build (an all-users install from Inno's uninstall key first,
  then the copy's `.source`), never the user-writable copy; without one it
  fails with 500. Uninstall asks before it stops the current user's
  processes, and leaves other users' backends running from their copies.
- **viewer** (`--viewer`): every pywebview window, one process, a child of the
  backend, driven by JSON lines on its stdin/stdout (commands open, show,
  quit; events ready, adopted, closed, opened). The backend dying closes the
  pipe and the windows. Closing the last window ends the viewer; the backend
  then applies the close-to-tray rule (a live session touched, retained or
  busy keeps it in the tray, else it exits; elevated or tray-less, it exits).
  A crashed viewer's workspace claims are freed at once.

```
GET  /api/host          -> {build, version, pid, viewer_pid, ...} which backend this is
POST /api/host/summon   {"cwd"?: str} -> show the windows, or start the viewer
POST /api/host/retire   {"force"?: bool} -> 202 leaving; 409 naming busy or touched terminals
```

A refused retire marks the old backend superseded: it leaves once it has no
window and nothing at risk, and is not asked again. Uvicorn's graceful
shutdown is bounded to 3 s, so terminals stop promptly after the port closes.
Each role logs to its own file (`quickterm.log`, `viewer.log`,
`launcher.log`).

## One workspace at a time, and one shell (4.3, frozen 2026-10-25)

Frozen before the 4.3 round so the stage part and the shell part can be built
in parallel. The model: the sidebar lists the workspaces, the content
area shows exactly one of them, and every terminal starts in the user's shell.
Changing anything here goes through the integrator.

### The stage shows one workspace

- The content area shows exactly one workspace view, full size: no view
  header, no coloured frame, no maximize or close button on the view, no
  divider, no view drag, dock or swap. A lone workspace looks the same as
  today's single view minus its frame.
- Clicking a workspace row in the sidebar shows that workspace. If it is not
  open yet it opens; if it is open it becomes the shown one. The previously
  shown view stays loaded but hidden (`display: none` is not allowed: hidden
  views keep their box and use `visibility: hidden` plus `inert`, so xterm
  keeps its size), and `window.quicktermView.setHidden(true)` is called on
  it so its panes drop WebGL after the 5 s grace, as in 4.2.
- Iframes are never re-parented (they would reload). Every view is absolutely
  positioned at the full stage rect.
- "Open" means loaded in this window. The sidebar marks open workspaces (as
  today) and highlights the shown one. Closing stays on the sidebar row's
  close button and the palette; closing the shown view shows the most recently
  shown remaining one, or the empty stage.
- Scratch: one scratch view per window, labelled `scratch`. "Open QuickTerm
  here" from Explorer opens a terminal at that folder in the scratch view
  (opening the scratch view first if needed) instead of a new scratch view.
- Persistence: localStorage key `quickterm.openViews.v1` holds
  `{"version":1,"open":[<workspace name or "" for scratch>...],"shown":<same>}`
  for the primary window, written on every open, close and switch. On first
  boot after the upgrade, the old tiling arrangement key is read once for its
  leaves (open list, in tree order; the active leaf becomes `shown`), then
  removed.
- Keys: the existing shortcuts that moved focus between views move to the
  next and previous open workspace in sidebar order. Shortcuts that only made
  sense for tiling (swap, move, resize a view) are removed from keys.js, the
  help panel and the palette.
- Every member in `SHELL_MEMBERS` keeps its name and meaning; `activeApp()` is
  the shown view's app.

### One shell

- Config gains `shell: str`, default `"powershell"`. Allowed values:
  `"powershell"` (`pwsh.exe` when found on PATH, else `powershell.exe`),
  `"cmd"`, `"git-bash"`, `"wsl"` (default distribution) and `"wsl:<distro>"`
  (name as listed by the inventory). On POSIX the only value used is `""`,
  meaning the login shell from `$SHELL`; a Windows value there falls back to
  `""`. Unknown values fail validation with `shell must be one of ...`.
  Existing configs without the key load as `"powershell"`.
- `GET /api/system/terminals` (the inventory) keeps its shape and adds
  `"shells": [{"value": "...", "label": "PowerShell"|"Command Prompt"|"Git Bash"|"WSL: <distro>", "available": bool}]`.
  Git Bash and WSL entries appear only when installed.
- A new terminal with no profile (the "+" button's main click, the
  new-terminal hotkey, `quickterm new` without a profile) starts `shell` in
  the workspace folder.
- Claude Code and Codex run inside the shell. The PTY's program is the shell,
  started so it runs the agent command once and then stays interactive:
  - PowerShell: `-NoLogo -NoExit -Command & '<exe>' '<arg>'...` with every
    single quote doubled inside the quoted words.
  - cmd: `/k` followed by the command line built with
    `subprocess.list2cmdline`, guarded by the existing batch-shim guard.
  - Git Bash: `-lc "<posix-quoted command>; exec bash -l"` (the existing
    start-command pattern).
  - WSL: `wsl.exe [-d <distro>] --cd <folder> --exec bash -lc "<command>; exec bash -l"`
    with the Linux `claude`/`codex` on that distro's PATH. Agent hooks are
    skipped for WSL (the Windows curl and env do not reach it); the agent
    then reports no state, as an agent launched outside QuickTerm does.
    (Superseded in 4.5 for WSL workspaces: their agents report through
    Windows `curl.exe` by WSL interop, see "Workspace locations".)
  - POSIX: `$SHELL -lc "<command>; exec $SHELL -l"`.
- The session keeps `terminal_type` `"claude-code"` / `"codex"` and the
  agent's label, so agent state, Shift+Enter, the sidebar chips, resume and
  kill behave as in 4.2. Hook env vars and the `--settings` / `-c notify`
  arguments are still added to the agent command, not to the shell.
  When the agent exits, the pane stays open at the shell prompt; the session's
  agent state returns to none.
- The agent settings' own `cmd` override still names the agent executable;
  it is wrapped in the shell the same way.

### The "+" menu

Superseded in 4.5: saved terminals no longer appear in this menu, and it
has no "Terminal settings…" row. Its rows are the available shells, Claude
Code and Codex, and "As administrator" (`newTerminalMenu` in
`sidebar_model.js`); in a WSL or SSH workspace the first row is "Shell in
<location>" and there is no administrator row.

The sidebar's new-terminal button:

- Main click (and Alt+N): the row picked last in its menu, a new terminal in
  `shell` until another row is picked (`chosenRow(menu, key)`; the key is
  `quickterm.newTerminalChoice` in localStorage, per machine, and is cleared
  when the configured shell itself is picked). A remembered row the menu no
  longer has (a remote workspace has no local shells, a deleted profile)
  falls back to `shell`. A shell starts in the focused terminal's folder as
  before; an agent or saved terminal starts as from its menu row.
- Its menu (menu.js, no native select), in this order: one row per entry of
  `shells` that is available ("PowerShell", "Command Prompt", "Git Bash",
  "WSL: Ubuntu"...), "default" under the configured one; a separator;
  "Claude Code" and "Codex" when installed; then the user's saved profiles
  other than the built-in ones, if any; a separator; "As administrator"
  with the choice as its detail (local shells, agents and saved terminals,
  not in the admin instance and not on an SSH host; a second pick while the
  first request is in flight does nothing, so a double click raises one UAC
  prompt); "Terminal settings…". The check marks
  the row "+" starts. Picking a row starts it at once and makes it the "+"
  choice. The old "SAVED TERMINALS" heading goes.
- The palette's new-terminal items list the same entries.
- Settings gets one "Shell" row (menu.js picker over `shells`) that writes
  `shell`.

### Agents are settings, profiles are for special terminals (added 2026-10-25)

Superseded in 4.5: the profiles this section kept (SSH, SFTP, connection
types, `custom`, shells with a start command) are gone too, and so is the
save-time rejection below. The agent settings and the 4.3 migration stay
as written. See "Workspace locations, no saved terminals (4.5)".

Shells and agents stop being profiles. Profiles remain only for terminals that
need their own target or command: SSH, SFTP, the other connection types
(telnet, serial, docker, podman, kubernetes, rdp, vnc), `custom`, and a shell
profile that carries a `start_command` (for example "PowerShell running
`npm run dev`").

- Config gains `agents: {"claude-code": AgentSettings, "codex": AgentSettings}`
  where `AgentSettings` holds exactly what an agent profile held for the
  launch: `cmd` (executable override, may be empty), `args`, `agent_mode`,
  `agent` (the option dict validated by `agents.validate`), `env`. Both keys
  always exist (empty defaults). Settings gets an "Agents" section:
  one row per agent showing the resulting command line, expanding to
  the existing option editor (the fields from `GET /api/system/agents`).
- Launching Claude Code or Codex (the "+" menu, the palette, the CLI
  `quickterm new claude-code|codex`, an exited-pane restart, a resume from the
  sidebar or palette) uses these settings; a launch may still pass a one-off
  mode or session id as today.
- Migration on load, once, with the pre-migration file copied to
  `config.pre-4.3.json` next to `config.json` before the first save:
  - the first `claude-code` profile and the first `codex` profile (config
    order) become `agents[...]`; every agent profile is removed;
  - a shell profile (`powershell-core`, `windows-powershell`, `cmd`,
    `git-bash`, `wsl`, `bash`, `zsh`, `fish`, `nushell`, or a type inferred as
    one) without a `start_command` is removed, since the "+" menu covers it;
  - a shell profile whose `start_command`'s first word is `claude`, `claude.exe`,
    `codex` or `codex.exe` is removed; when no agent profile of that kind
    exists it becomes `agents[...]` with the start command's other words as
    `args`, its `env`, and `agent_mode` `"new"` (added at the integrator's
    request with the review fixes);
  - every other profile stays unchanged;
  - `default_profile` is dropped; `shell` takes over (default `"powershell"`).
- A saved profile of a removed kind is rejected on save with
  `profiles are for connections and custom commands; set the shell or the agents instead`.
- The profile editor offers only the kept types and only their fields.

### Agent usage and resources in the sidebar footer (added 2026-10-25)

Agent usage and a resource view. QuickTerm has
no status bar, so both live in one quiet line at the bottom of the sidebar
(full mode only; the rail and hidden modes show nothing new), each opening a
menu.js-style popover.

- Footer line: `✳ 32% · 4d` for Claude (the higher of the 5 h and 7 d used
  percent, with the time until that window resets) and `◎ 0% · 29d` for
  Codex, each only when its data exists, followed by the total memory of all
  QuickTerm terminals (`2.2 GB`). No line at all when none of the three exists.
- Usage popover: per agent, each window (Claude: 5 hours, 7 days; Codex:
  primary and secondary, named from `window_minutes`) with used percent, a
  thin bar and "resets in 4d 14h"; plus "updated 3m ago". Read-only.
- Resources popover: open workspaces, then their terminals, each with CPU and
  memory, from the existing `GET /api/sessions` metrics (`usage`), polled
  every 5 s only while the popover is open; total at the top. Clicking a
  terminal shows its workspace and focuses it. Nothing else (no disk scan, no
  clean-up).

Backend:

- `GET /api/usage` (full API token) returns
  ```
  {"claude": {"windows": [{"id": "five_hour"|"seven_day", "used_percent": float,
                           "resets_at": epoch_s|null}], "updated_at": epoch_s} | null,
   "codex":  {"windows": [{"id": "primary"|"secondary", "used_percent": float,
                           "window_minutes": int|null, "resets_at": epoch_s|null}],
              "plan": str|null, "updated_at": epoch_s} | null}
  ```
- Claude's numbers come from Claude Code's status line input
  (`rate_limits.five_hour` / `rate_limits.seven_day`, each with
  `used_percentage` and `resets_at`). QuickTerm's per-launch `--settings` file
  sets `statusLine` to its own command, `<QuickTerm> --statusline`, which
  reads the JSON from stdin, POSTs
  `{"hook_event_name": "QuickTermRateLimits", "rate_limits": {...}}` to
  `/api/sessions/{sid}/agent-event` with the hook token (same route, token and
  2 s no-proxy timeout as `codex_notify.py`), then runs the user's own
  `statusLine.command` from their merged Claude settings (user, then project,
  then local) with the same stdin and prints its stdout unchanged. With no
  user status line it prints nothing. It always exits 0 and never blocks the
  status line longer than the user's own command plus 2 s. The backend keeps
  only the latest Claude numbers (not per session), and stores them in
  `claude-usage.json` in the config folder when they change, so a restart
  still shows them. A `claude` typed in a QuickTerm PowerShell terminal gets
  the same settings file (shell integration, above), so it reports too.
  `agent_events` ignore this event for agent state.
- Codex's numbers come from the newest `rollout-*.jsonl` under
  `~/.codex/sessions` (respecting `CODEX_HOME`): the last line with
  `"rate_limits"` in a `token_count` event, read from the end of the file
  (at most the last 256 KB), cached by file path and mtime. Never written.
- Nothing is sent off the machine, and no credentials are read.
  Superseded in 4.6 (below): the backend also reads the sign-ins themselves.

### Every account's limits (4.6, 2026-10-25)

- `usage_accounts.py` finds every Claude Code and Codex sign-in on this
  computer: Claude's `~/.claude.json` with `~/.claude/.credentials.json`,
  every `CLAUDE_CONFIG_DIR`-style folder (the process env, the agent
  settings' env, `~/.claude-*` holding `.claude.json`/`.credentials.json`);
  Codex's `~/.codex/auth.json`, `CODEX_HOME`, `~/.codex-*`; the same under
  `/root` and `/home/*` of every running WSL distribution
  (`\\wsl.localhost\<distro>`; a stopped one is never read). SSH hosts are
  not searched: limits are per account, so an account also signed in here
  covers its use over SSH, and one signed in only on a host is not shown.
  Only local launches carry the status line today, so reports come from
  `local`; the per-origin keys are ready for WSL and SSH reports.
- Sign-ins are grouped by account (Claude `oauthAccount.accountUuid`, Codex
  `chatgpt_account_id` from the `id_token` claims, else the email), so one
  account in several places is one entry listing every place.
- Claude's windows, newest first wins: the usage route Claude Code itself
  calls (`GET https://api.anthropic.com/api/oauth/usage`, `Authorization:
  Bearer <access token>`, `anthropic-beta: oauth-2025-04-20`) at most every
  120 s per account and 600 s after a failure; a status-line report from a
  place where that account is signed in (`ClaudeLimits` now keeps one per
  origin: `local`, `wsl:<distro>`, `ssh:<destination>`); Claude Code's own
  `cachedUsageUtilization`. The token is read for the one request and
  dropped: never stored, logged, returned or refreshed, and a sign-in that
  has expired is left to Claude Code with the note "sign-in expired; open
  Claude Code to renew it". `usage_online` (config, Settings > Agents, default
  true) turns the request off. Windows come from the answer's `limits` list
  (`session` 5 hours, `weekly_all` 7 days, `weekly_scoped` 7 days · <model>),
  else its `five_hour`/`seven_day`/`seven_day_opus`/`seven_day_sonnet`.
- Codex's windows come from each home's newest rollout, as above.
- `GET /api/usage` adds `"accounts": [{"agent": "claude"|"codex", "key",
  "email", "organization", "plan", "where": [str], "windows": [{"id",
  "label", "used_percent", "resets_at"}], "updated_at", "source": "live" |
  "status line" | "Claude Code" | "session log" | null, "note"?}]`, and
  `claude`/`codex` become the account closest to a limit (the footer line),
  falling back to the 4.4 values. The handler never waits: a background
  thread refreshes when the answer is older than 30 s, and only the real
  backend turns discovery on (`app.py`), so app tests never read this
  computer's sign-ins. A status-line report from a place with no sign-in
  found here is its own entry, "on <host>" for an SSH destination.
- The usage popover shows one block per account (agent and plan, email and
  places, each window with its bar and reset, "updated 1m ago · from status
  line" when not live, and the note) and asks again every 10 s while open.

### Workspace board replaces the dashboard (added 2026-10-25)

Superseded in 4.5 wave 2: the columns are derived, not dragged. The four
columns, the drag and Alt+Left/Right moves, `board.json` and
`PUT /api/board/{name}` below are gone; see "The board sorts itself". What
moved to the sidebar menu and the palette stays there.

A workspace board, in place of today's dashboard panel (the same sidebar
footer button and palette entry open it; the button's tooltip becomes
"Workspace board").

- Four columns: Todo, In progress, In review, Done, each with its count.
  Every saved workspace is one card in exactly one column. A card shows the
  workspace name, its repo and branch (from the 4.2 git info), and its live
  terminals as lines with the agent state dot and label, subagent lines
  under an agent as in the sidebar.
- Drag a card to another column to set its status (pointer drag with the
  same feel as the sidebar; keyboard: focus a card, Alt+Left/Right moves it
  one column). Click a card to show that workspace and close the board.
  A search field at the top filters cards by name, repo and branch.
  Empty columns say "Empty". No pins, no per-column "+" button, no settings.
- Everything the old dashboard did that the board does not cover (workspace
  rename, delete, folder change, layout preview) moves to the workspace row's
  menu in the sidebar or the palette if it is not there already; nothing is
  lost silently. Name what moved in the report.
- Status store: `%APPDATA%\quickterm\board.json`,
  `{"version": 1, "status": {"<workspace name>": "todo"|"in-progress"|"in-review"|"done"}}`,
  written atomically (temp file plus replace) under a lock. Not in the
  workspace files, so layout autosave can never overwrite it.
  A workspace without an entry is "in-progress". Renaming a workspace moves
  its entry; deleting removes it.
- `GET /api/board` returns `{"status": {...}}` for existing workspaces only.
  `PUT /api/board/{name:path}` with `{"status": "<one of the four>"}` sets it;
  404 for an unknown workspace, 400 for an unknown status.

### Workspaces on an SSH host (added 2026-10-25)

Superseded in 4.5: `host` is an SSH destination, not a profile name; the
ssh options come from `~/.ssh/config`; "new workspace on host…" became the
one "New workspace…" dialog; the "+" menu lists no custom profiles. The
agent hooks over the forwarded socket and the git cache stand. See
"Workspace locations, no saved terminals (4.5)".

People code on a remote machine over SSH. A workspace can live there, and it
works the same way a local one does: the "+" menu, Claude Code and Codex with
agent state, Shift+Enter, the sidebar branch, the board.

- A workspace gains `host: str | null`: the name of an SSH profile using the
  OpenSSH client. `path` is then a POSIX path on that host. `null` means
  local, so every existing workspace is unchanged. A PuTTY profile cannot back a
  workspace: `remote workspaces need an OpenSSH profile`.
- Creating one: "new workspace on host…" in the palette and in the sidebar
  "+" (next to the local "new workspace"), asking for the host (menu of
  OpenSSH profiles) and the folder (text, checked with
  `ssh -o BatchMode=yes <profile args> <host> test -d <path>`; a failed check
  says what ssh printed and still lets the user save).
- Every terminal of a remote workspace is an OpenSSH session with `-t`, the
  profile's port/user/key/ProxyJump, and a remote command that `cd`s into
  the folder (POSIX-quoted) and then:
  - plain terminal: `exec "$SHELL" -l`;
  - Claude Code / Codex: runs the agent command with the agents settings, then
    `exec "$SHELL" -l`, so exiting the agent leaves the remote shell. The
    `shell` setting does not apply on a remote host.
  - The "+" menu of a remote workspace lists "Shell on <host>", Claude Code,
    Codex and the user's custom profiles that make sense remotely (none of the
    local shells or WSL).
- Agent state over SSH: the session's ssh gets
  `-R <remote socket>:127.0.0.1:<backend port>` with a Unix socket
  `/tmp/quickterm-<random 16 hex>.sock` (sshd creates it owner-only by
  default, StreamLocalBindMask 0177) and `-o ExitOnForwardFailure=no`, so a
  server without stream forwarding still opens the shell, just without
  agent state. The remote command exports `QUICKTERM_SESSION_ID`,
  `QUICKTERM_HOOK_TOKEN` and `QUICKTERM_HOOK_SOCKET`, and removes the socket
  file when the shell exits. Claude gets its hooks as an inline
  `--settings '<json>'` whose commands are POSIX `curl --unix-socket
  "$QUICKTERM_HOOK_SOCKET" -sS -m 2 -H @- ... http://localhost/api/sessions/$QUICKTERM_SESSION_ID/agent-event`
  with the token read from the environment, never written into the command
  line or a file. No curl on the host means no agent state, nothing else.
  Codex gets the same through `-c notify=[...]` only when the user's local
  Codex config has no notify of its own (QuickTerm cannot read the remote
  config before the launch); the status line chain is not used remotely.
  The hook token never leaves through anything but the forwarded socket and
  the session's environment.
- Git: the branch and repo for the sidebar and board come from
  `ssh -o BatchMode=yes ... git -C <path> rev-parse --abbrev-ref HEAD --show-toplevel --git-common-dir`,
  cached 60 s per workspace and run off the request path; failure means no
  branch shown.
- Windows' OpenSSH has no ControlMaster, so each terminal is its own
  connection. Key or agent auth is expected; with a password, each terminal
  asks in the terminal itself, and the background git call fails quietly
  (BatchMode).
- The sidebar row of a remote workspace shows `@<host>` after its name in
  the muted colour; nothing else changes.

### Workspace locations, no saved terminals (4.5, frozen 2026-10-25)

Devin: "neuen Workspace in SSH, neuen Workspace in WSL, halt neuen Workspace
in Location" and "wir sollten auch gar keine Terminals haben". A workspace
lives at a location (this PC, a WSL distribution, an SSH host) and works
the same at each one. Saved terminals (profiles) go entirely. This section
replaces the profile parts of "Workspaces on an SSH host" above.

Locations
- `Workspace.host` (JSON `host`, field name unchanged) names the location:
  - `null`: this PC. `path` is a Windows folder (`normalize_root`).
  - `"wsl:<distro>"`: a WSL distribution; the name follows the
    `shells._DISTRO` rule. `path` is a POSIX path there (`/...`, `~`, `~/...`,
    `normalize_remote_root`).
  - any other string: an SSH destination as OpenSSH reads it: a
    `~/.ssh/config` Host alias, `[user@]hostname`, or
    `ssh://[user@]hostname[:port]`. No leading `-`, no whitespace, no control
    characters, at most 200 characters. Port, key, ProxyJump and the rest come
    from `~/.ssh/config`; QuickTerm stores nothing else. `path` is POSIX.
- `workspace.location_kind(host) -> "local" | "wsl" | "ssh"` and
  `workspace.wsl_distro(host) -> str | None` are the one place that reads it.
- `ws_exec.run(ws, argv, ...)` keeps its signature and works for all three:
  local as today; WSL as `wsl.exe -d <distro> --cd <path> --exec <env prefix>
  <argv>` (no shell reads the words); SSH as `<openssh ssh> <batch options>
  <destination> <cd ...&& quoted argv>`. `ws_files.HostFolder`, git info,
  the right panel and the board therefore work in WSL as they do over SSH.
  No profile is looked up anywhere (`ws_exec.find_profile` goes).
- Terminals: a plain terminal in a WSL workspace is `wsl.exe -d <distro>
  --cd <path>` (the distribution's login shell; the `shell` setting does not
  apply); in an SSH workspace `ssh -t <destination> "cd <path>; exec
  \"$SHELL\" -l"` as before. Claude Code and Codex in WSL run through the
  existing WSL wrap (`--cd <path> --exec bash -lc "<cli> ...; <exit marker>;
  exec bash -l"`, the CLI from the distribution's PATH); over SSH as before,
  with the forwarded-socket hooks. Agent state for a WSL agent goes through
  Windows `curl.exe` via WSL interop with `WSLENV` carrying
  `QUICKTERM_PORT/QUICKTERM_SESSION_ID/QUICKTERM_HOOK_TOKEN`, if that works on
  this machine; otherwise WSL agents keep the exit marker only, and the
  report says so. The "+" menu of a WSL or SSH workspace lists "Shell in
  <location label>", Claude Code and Codex.
- An administrator terminal is refused in a WSL or SSH workspace (400), as it
  is on an SSH host today.
- `GET /api/locations` (token-gated) -> `{"locations": [entry, ...]}`, entry
  `{"id": str | null, "kind": "local"|"wsl"|"ssh", "label": str,
  "detail": str | null, "browse": str | null}`, in this order: This PC
  (`id: null`, `browse: null`), one per installed WSL distribution from the
  cached inventory (`id: "wsl:<d>"`, `label: "WSL: <d>"`, `browse:
  "\\\\wsl.localhost\\<d>\\home"`), one per concrete Host alias in
  `~/.ssh/config` (`id: "<alias>"`, `label: "<alias>"`, `detail:
  "[user@]hostname"` when the config names them). It starts no distribution
  and opens no connection.
- `GET /api/fs/dirs?path=` also lists `\\wsl.localhost\<d>\...` and
  `\\wsl$\<d>\...`; when such a path is unreachable because the distribution
  is stopped, it starts it once (`wsl.exe -d <d> --exec true`, off the loop,
  20 s timeout) and lists again. The frontend turns a chosen
  `\\wsl.localhost\<d>\a\b` (or `\\wsl$\...`) into `/a/b` for `path`.
- `POST /api/workspaces/remote-check {host, path}` -> `{ok, message}` checks a
  WSL or SSH folder (`test -d`), shape unchanged.
- `PUT /api/workspaces/{name}` takes `host` as above; a bad one is a 400 with
  the reason.

No saved terminals
- `AppConfig.profiles` goes. Loading an older config drops `profiles` once,
  writing `config.pre-4.5.json` next to it first, and turns every workspace
  whose `host` named an SSH profile into that profile's destination
  (`ssh://user@host:port` when it had a port, else `[user@]host`). A
  profile's key or ProxyJump cannot be carried; the migration notice
  (`take_migration_notice`) names those hosts and says to put them in
  `~/.ssh/config`.
- The agents stay settings (`AppConfig.agents`) and still launch as
  `profile: "claude-code" | "codex"` in `POST /api/sessions`, `/api/elevate`,
  `POST /api/launches` and `quickterm new`; any other profile name is a 404
  `unknown profile`. A plain terminal is a request without `profile`.
- Gone with the profiles: `GET /api/profiles`, `profiles` in `GET
  /api/config` and in `PUT /api/config`, the connection types (ssh, sftp,
  telnet, serial, docker, podman, kubernetes, rdp, vnc, custom, shell with a
  start command) and their launchers (`connections.py`, desktop
  connections), per-profile global hotkeys and autostart, the bundled PuTTY
  tools (`putty_tools.py`, `scripts/fetch_putty.py`, `vendor/putty`, the
  spec and installer entries, the PuTTY part of THIRD-PARTY-NOTICES.md), and
  any secret storage that only connections used. `GET
  /api/system/ssh-hosts` stays (the locations use `ssh_config.py`).
- Frontend: no "Terminals and connections" settings, no saved-terminal rows
  in the "+" menu or the palette, no connection labels on rows. "New
  workspace…" (sidebar "+" and palette) opens one dialog: Location (a
  `menu.js` menu over `/api/locations`, plus "Other SSH host…" to type a
  destination), Folder (Browse for This PC and WSL through the in-app folder
  browser; typed for SSH), the name prefilled from the folder and editable,
  and Create. WSL and SSH folders are checked with `remote-check` first; a
  failed check shows its message and a second Create saves anyway. "New
  workspace on host…" and its palette host steps go; the dialog covers them.
  A WSL workspace's head shows `WSL: <d>` where an SSH one shows `@<host>`.

### Workspace setup and a board that sorts itself (4.5 wave 2, frozen 2026-10-25)

Devin: "the workspace setup can start agents and terminals with specific
configuration ... with envs" and "make the workspace dashboard actually make
sense, it should move based on status and the status should make sense".
Saved terminals are gone (above); what they were good for moves into the
workspace.

Workspace setup
- A workspace gains `env: {NAME: value}` and `startup: [item, ...]` (JSON
  keys of the same name; absent means `{}` and `[]`, so every existing file
  is unchanged). `PUT` and `PATCH /api/workspaces/{name}` treat both like
  `path`: absent preserves, `null` clears, a value replaces. `GET
  /api/workspaces/{name}` returns them, `env` in plaintext for the settings
  editor; no other route or log line carries the values.
- `env`: names `[A-Za-z_][A-Za-z0-9_]*` of at most 255 characters, at most
  64 entries, each value at most 8 KB without NUL; names starting
  `QUICKTERM_` and `WSLENV` are refused in any case, and two names that
  differ only in case are refused (`workspace.validate_env`). Values are stored encrypted at rest with the same DPAPI store the
  agent settings' env uses (`secret_store`), never in plaintext in the
  workspace file. Every terminal of the workspace gets them: locally in the
  PTY environment, in WSL also listed in `WSLENV`, over SSH exported by the
  remote command before the shell (values are then visible to the host's
  process list; the settings say so for an SSH workspace). QuickTerm's own
  variables always win.
- `startup` item: `{"kind": "shell" | "claude-code" | "codex", "name": str |
  null, "shell": str | null, "command": str | null, "agent_mode": str | null,
  "agent": {} | null, "env": {} | null}`, at most 8 items. `shell` is for `shell`
  only: which installed shell it starts on this PC (a config `shell` value:
  `powershell`, `cmd`, `git-bash`, `wsl:<distro>`), null for the configured
  one; in a WSL or SSH workspace the location's login shell starts
  regardless. A `cmd` item's command is checked at save with the cmd rule
  below. `command` is for `shell` only: the
  shell runs it and then stays at its prompt (PowerShell `-NoExit -Command`,
  cmd `/k`, bash `-lc "...; exec bash -l"`, WSL and SSH the same way).
  `agent_mode` and `agent` are the agent launch options with the same
  allowlist as Settings > Agents (`agents.py`); `env` adds to and overrides
  the workspace `env` for that one terminal.
- `POST /api/sessions` gains `command` (plain shell only, as above), `env`
  (per terminal, same rules) and `agent` (an object of agent options merged
  over the saved Settings > Agents options for this launch only, then
  validated with the same allowlist; only with `profile` `claude-code` or
  `codex`), and keeps `agent_mode` and `shell`; the workspace `env` is added by the
  backend from the workspace named in the request. A startup item becomes
  exactly such a request.
- `command` is one line (no CR, LF or NUL), at most 4096 characters. Under
  cmd it goes verbatim after `/k` and is refused when it holds any of
  `" & | < > ^ % !` (400 "the command contains characters cmd.exe would
  reinterpret"), the rule the agent wrap applies to its arguments. Bash, Git
  Bash, WSL and SSH run it through `eval` in a login shell, so it is read as
  typed.
- Environment merge order, later wins: the agent settings' `env` (Settings >
  Agents), then the workspace `env`, then the terminal's own `env` (the
  startup item's or the request's); QuickTerm's own variables
  (`QUICKTERM_*`) are set last by the session manager.
  In WSL the workspace and terminal names are appended to `WSLENV` so they
  reach Linux, and for an agent the agent settings' names too (not `PATH`).
  Over SSH the workspace and terminal variables are exported by the remote
  command, each value POSIX-quoted, and the agent settings' `env` is not
  sent to the host. A value with a line break cannot be quoted there, so
  saving one on an SSH workspace is refused (400 "Over SSH a variable
  cannot contain a line break."). Values never go on any other command line
  and are never logged. A hand-edited bad entry drops only itself on load.
- Background checks (the folder check, git info, the board's git status)
  skip a WSL workspace whose distribution is not running
  (`ws_exec.asleep`, from `wsl.exe --list --running`, cached 15 s), so a
  stopped distribution stays stopped until a terminal opens there.
- When it runs: a workspace view that opens with no saved panes (a new
  workspace), or with a non-empty `startup` and none of its terminals alive,
  starts its `startup` items in order, each in its own pane placed the usual
  way; with no items it starts one plain shell, as today. A dead saved
  layout without a `startup` list is restored as before, with its Restart
  and Resume offers. A startup pane's saved launch keeps its `shell` and
  `command` (never its variables), so a restart after a reload repeats
  them; a restart in the same session repeats the whole item. The
  workspace's sidebar menu row "Start <names>" (`startupMenuLabel`: up to
  three names, then "+N"; hidden without a list) and the palette row "start
  the Start with terminals" start the items again next to what is open
  (4.6; was "Run setup").
- UI: the workspace settings sheet shows the location and folder, an
  Environment section (name/value rows, values masked until focused) and a
  "Start with" list (type menu, name, command for a shell, agent mode and
  options for an agent through the existing agent fields, per-terminal env),
  plus "Save and start them" (4.6; was "Run setup now"). The new-workspace dialog offers "Start with": Shell,
  Claude Code, Codex (any combination; default Shell), which fills
  `startup`.

The board sorts itself
- The column is derived, never dragged. `GET /api/board` ->
  `{"workspaces": {name: {"status", "reason", "since", "git", "pr"}}}`,
  where `status` is the first that holds of:
  1. `needs-you`: a terminal of the workspace has an open attention, or an
     agent is `waiting` (permission or question) or its last turn `failed`
     unseen;
  2. `working`: an agent of the workspace is `working`;
  3. `in-review`: the branch has an open pull request (draft included);
  4. `changes`: uncommitted changes, or commits not pushed / not in a pull
     request yet;
  5. `done`: the branch's pull request was merged and nothing is
     uncommitted;
  6. `idle`: none of these (no terminal, or everything clean and quiet).
  `reason` is one short line saying why ("Claude waits for permission",
  "3 files changed · 2 commits not pushed", "PR #12 open · checks passing",
  "PR #12 merged"). `since` is when the status last changed (epoch seconds),
  `git` `{branch, dirty, ahead, behind}` or null, `pr` `{number, state,
  checks, url}` or null. As built: `dirty` is the count of changed files
  (int); `ahead` and `behind` count against the upstream, or with no
  upstream `ahead` is the commits past the base branch and `behind` null;
  `pr.state` is `open | draft | merged | closed`; `pr.checks` is `passing |
  failing | pending | null` (failing wins over pending over passing). A
  closed pull request leaves the workspace `idle` with the reason
  "PR #<n> closed".
- Facts and cost: agent states and attention come from the session manager
  (free). Git comes from one `git status --porcelain=v2 --branch` per
  workspace (`ws_exec`, so WSL and SSH work), cached 30 s and refreshed off
  the loop; the board never waits for a refresh, it answers from the cache
  and the next poll shows the new state. The pull request comes from the
  same `gh` call the right panel uses, cached 120 s per workspace (with the
  base branch and the commits past it), and only for a branch that is not
  the base branch and a GitHub remote. Scratch is
  never a card.
- `PUT /api/board/{name}` and `board.json` statuses go (the file is ignored
  and removed once). The board shows the six columns in that order, each
  with its one-line meaning; a card moves by itself when its status
  changes (with the usual slide), shows the reason line, its terminals and
  agents as today, and a click shows the workspace. No drag, no
  Alt+Left/Right moves.

### Themes and the window frame (4.5, as built)

- `themes.js` ships 54 themes (dark and light) plus Custom. A theme may name
  an optional `selection` colour (its own selected-row colour); without it
  the terminal's selection colour stands in. `chromeTokens(id, custom)`
  derives every chrome token, including `--surface-active` (selected rows:
  menus, the palette, the active Settings tab, the shown workspace card)
  and `--term-bg`, `--term-fg`, `--term-scrollbar`, `--term-scrollbar-hover`
  and `--term-scrollbar-active` (what frames the xterm canvas and its
  scrollbar). Every text token is held at 4.5:1 on `--bg`, `--surface`,
  `--field`, `--surface-raised`, `--surface-soft` and `--surface-active`.
  The `:root` block of `app.css` equals `chromeTokens("graphite")`
  (`tests/js/chrome_theme.test.mjs`).
- `applyChromeTheme` writes the tokens as root styles and, in the top
  window only, calls `window.pywebview.api.set_frame_colors({caption, text,
  border, light})` (`--bg`, `--text`, `--line-strong`), queued until
  `pywebviewready`. `_DesktopApi.set_frame_colors` hands them to
  `quickterm/window_frame.py`, which sets `DWMWA_USE_IMMERSIVE_DARK_MODE`,
  `DWMWA_CAPTION_COLOR`, `DWMWA_TEXT_COLOR` and `DWMWA_BORDER_COLOR` on every
  top-level window of the viewer process titled "QuickTerm" or
  "QuickTerm - ...". Each attribute is best effort (Windows 10 takes only
  dark mode); bad colours return false, nothing raises into the page.
- The theme switcher (`theme_switcher.js`) previews by setting the root
  styles of the shell and every view and saves only when a theme is applied
  (Enter or a click); while it is open it puts its preview back when the
  window re-reads the saved config.

### Round 2: more agent and git features (added 2026-10-25)

Picked from a survey of agent IDEs, minus what QuickTerm already
had. UX rule for all of it: nothing new is visible until it is needed. No
status bar, no badges, no toolbar rows; a panel that is closed takes no space.

#### Running a command in a workspace's folder

`quickterm/ws_exec.py` is the one way backend code runs a program in a
workspace's folder, local or on its SSH host:

```python
def run(ws: Workspace, argv: list[str], *, timeout: float = 10.0,
        input: str | None = None) -> subprocess.CompletedProcess[str]
def exists(ws: Workspace) -> bool
```

Local: `subprocess.run(argv, cwd=ws.path, ...)` with `CREATE_NO_WINDOW`,
text mode, UTF-8, no shell. Remote: OpenSSH with `-o BatchMode=yes` and the
destination (the profile's args until 4.5), the remote command
`cd <path> && <argv POSIX-quoted>`; WSL through `wsl.exe -d <d> --cd <path>
--exec` (4.5).
Git info, the right panel and the board use it. The
integrator commits a local-only version first; the remote part owns it after.

#### The right panel

One panel on the right of the content area, closed by default. Alt+Shift+E
(also the palette, "files", "changes", "pull request") opens or closes it;
its width is dragged at its left edge and remembered per machine; it belongs
to the window, and it always shows the shown workspace. Three icon tabs at
its top, nothing else in that row: Files, Changes, Pull request.

- **Files**: the workspace folder as a lazy tree (one level per request),
  folders first, natural sort, gitignored entries dimmed and listed after,
  `.git` hidden. New and modified files tinted with the theme's git colours.
  A filter field on top searches names (whole tree, `git ls-files` plus
  untracked, falling back to a walk capped at 20000 entries); a "Contents"
  toggle searches file contents with `git grep -n -I` (or a capped walk
  without git) and lists `path:line  text`. Click a file (or a search
  result) to open it in the file view. Alt+click pastes its quoted path into
  the focused terminal (the same rules as a file drop). Right click: open,
  paste path into terminal, copy path, copy relative path, open in editor,
  reveal in Explorer (local only).
- **File view**: opens over the stage like the diff (terminals stay loaded
  behind it), one file at a time; opening another replaces it, Esc closes.
  Head: the path relative to the workspace, a "Changes" toggle (shown when
  git reports the file modified; it switches to the diff view of that file),
  and "Open in editor" (VS Code through `code` when it is on PATH, else the
  Windows default program via the existing `POST /api/open`; remote
  workspaces: hidden). Body: read-only text with line numbers and syntax
  colours from highlight.js (vendored, the common-languages build, licence
  next to it, colours mapped to theme tokens), Ctrl+F find with match count,
  `Ctrl+G` go to line, the clicked search result's line scrolled into view
  and marked. Files over 2 MB or binary (a NUL in the first 8 KB) show
  "binary file" or "file too large (N MB)" with "Open in editor"; images
  (png, jpg, gif, webp, svg as an image) show the image. No editing in
  QuickTerm.
  `GET /api/ws/{name:path}/file?path=` → `{"text"|null, "binary":bool, "size":int, "image_url"?:str, "language":str|null}`
  with the same path rules as the other routes; `image_url` is a token-free
  same-origin URL valid for that file only.
- **Changes** (source control, kept small):
  - Head: the branch, `→ <upstream or origin default branch>`, commits
    ahead/behind (`↑1 ↓0`) and the branch's added lines against its base
    (`+220`).
  - A commit message field (two lines, grows to six) and one primary button
    whose label follows the state: "Stage all" while nothing is staged,
    "Commit" while something is staged and a message is typed, "Push" (or
    "Publish branch" without upstream) when the branch is ahead and nothing
    is staged, "Pull" when only behind. Its menu holds the other actions:
    commit and push, amend (asks first when the commit is already pushed),
    pull, push. Ctrl+Enter in the message field commits. No force push.
    Hook failures and git errors show their output under the button with
    "Fix with Claude" (a new Claude Code terminal in the workspace with the
    error, the message and the staged files, told not to bypass hooks, commit
    or push).
  - Sections, each collapsible with its count: Staged, Changes (with
    Untracked), and Committed on branch (files changed between the merge base
    with the base branch and HEAD). Rows show the file name, its folder dimmed,
    `+n -m` and the status letter. Hover actions per row: stage / unstage,
    discard (asks with the existing confirm popover). Section actions: stage
    all, unstage all, discard all (asks).
  - Clicking a file opens the diff over the stage (the terminals stay
    loaded behind it, like the board): unified by default with a side-by-side
    toggle, theme-token colours, line numbers, prev/next change arrows and
    `n`/`p` keys, the file path in the head, Esc closes. At most 5000 lines,
    then "diff too large" with the line count.
- **Pull request**: the PR of the workspace's branch via the `gh` CLI
  (`gh pr view --json number,title,state,isDraft,url,mergeStateStatus,reviewDecision,headRefName,baseRefName`,
  `gh pr checks --json name,state,bucket,link,workflow,startedAt,completedAt`).
  Shows `#249  OPEN`, the title, checks grouped failing / pending / passing
  with their names and a link each, and a merge split button
  (merge commit / squash / rebase, from what the repo allows; hidden for
  draft, closed or conflicting PRs; asks before merging). A failing check
  expands to the tail of its log (`gh run view <id> --log-failed`, last 200
  lines). "Fix with Claude" on a failing check (and on the group) opens a
  new Claude Code terminal in the workspace with a prompt naming the failed
  checks, their links and the log tails, telling it to fix the cause and not
  to push or merge. Without `gh` or without a PR it says so in one line with
  the command to run (`gh auth login`, `gh pr create`). Refreshes every 30 s
  while visible, never while closed.
- Remote workspaces: Files and Changes work through `ws_exec`; Pull request
  runs `gh` locally against the repo's remote URL read through `ws_exec`
  (`git remote get-url origin`), so `gh` needs no install on the host.
- API (full token), all scoped to a saved workspace by name:
  `GET /api/ws/{name:path}/files?dir=<rel>` → `{"entries":[{"name","dir":bool,"ignored":bool,"git":"M"|"A"|"?"|null}]}`;
  `GET /api/ws/{name:path}/files/search?q=&contents=0|1` → `{"results":[{"path","line":int|null,"text":str|null}],"truncated":bool}`;
  `GET /api/ws/{name:path}/changes` → `{"branch","upstream","base","ahead","behind","branch_added","files":[{"path","group":"staged"|"changes"|"untracked"|"committed","status","added","removed"}]}`;
  `GET /api/ws/{name:path}/diff?path=&group=staged|changes|committed` → `{"text","truncated","lines"}`;
  `POST /api/ws/{name:path}/changes` `{"action":"stage"|"unstage"|"discard","paths":[...]}`;
  `POST /api/ws/{name:path}/git` `{"action":"commit"|"amend"|"push"|"pull"|"publish","message":str|null}` → `{"ok":bool,"output":str}`
  (commit runs the repo's hooks; the output is git's, trimmed to 20000 chars);
  `GET /api/ws/{name:path}/pr` → `{"gh": "ok"|"missing"|"unauthenticated", "pr": {...}|null, "checks": [...]}`;
  `GET /api/ws/{name:path}/pr/log?run=<id>` → `{"text"}`;
  `POST /api/ws/{name:path}/pr/merge` `{"method":"merge"|"squash"|"rebase"}`.
  Every `path`/`dir` is relative, normalised, and refused (400) if it leaves
  the workspace folder or names `.git`.

#### Agents

- **Agents tab on the board**: the board panel gets two tabs, "Workspaces"
  and "Agents". Agents: columns Needs you, Working, Done, Idle (Idle hidden
  behind a "show idle" toggle in the column row). One card per agent session:
  agent icon and label, the last prompt (`You …`, one line), the start of the
  agent's last answer (two lines), workspace and branch, PR number when the
  right panel knows one, time since the last event, subagents folded under a
  "N subagents" line. Click: show that terminal. Search filters by text.
  A session with no event for 30 minutes and not waiting counts as Idle.
  A parent whose subagent waits for permission counts as Needs you.
- Backend: the agent-event route stores per session `last_prompt`
  (UserPromptSubmit `prompt`, first 300 chars) and `last_answer` (from the
  Stop hook's `last_assistant_message` when present, else the last assistant
  text in `transcript_path`, read from the end, first 300 chars) and
  `last_event_at`; `GET /api/sessions` includes them under `agent`. Codex:
  the notify payload's `input-messages` last entry and `last-assistant-message`.
- **Pane title follows the agent's conversation**: a pane with no manual
  title shows the agent session's own title (Claude's `customTitle`/summary or
  Codex's thread name, as `agent_sessions.py` already reads them), refreshed
  on Stop events. A manual rename wins.
- **Finished and needs-you notifications**: a finished turn (Stop / Codex
  notify) of an agent whose terminal is not on screen raises the same
  balloon or taskbar flash as "needs you" today. Settings → Notifications:
  "When an agent needs you" and "When an agent finishes", each Off / Flash /
  Notify (default Notify and Flash), and "Sound" On/Off (default Off; plays
  the Windows notification sound via `winsound.MessageBeep`).
- **Keep awake**: config `keep_awake: "agents"|"always"|"off"`, default
  `"agents"`: while any agent session is working, the backend holds
  `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` (display may
  sleep) and releases it when none is. Settings row under General.
- **Palette**: "copy resume command" for an agent terminal
  (`claude --resume <id>` / `codex resume <id>`, with the folder) and on
  each "resume … session" row as a secondary action (Shift+Enter).

#### Terminal and keys

- **Find in terminal**: Ctrl+Shift+F in a pane opens a small find field at
  the pane's top right (no bar across the pane): match count `3/17`, Enter
  and Shift+Enter next and previous, Alt+C case, Alt+R regex, Esc closes and
  hands the keyboard back. Uses the official `@xterm/addon-search` vendored
  like the other addons (exact version matching xterm 6, licence file next
  to it). The palette's "search all terminals" stays.
- **Reset terminal**: palette row for the focused pane; writes the reset
  sequence locally (`term.reset()` plus the mode resets of `RESTART_RESET`)
  without touching the process.
- **Copy terminal text**: palette row; copies the pane's whole buffer as
  plain text (trailing blank lines trimmed, capped at 2 MB) to the clipboard.
- **New terminal in the same folder**: Alt+N and the "+" main click open
  in the focused pane's `bestKnownCwd()` when it lies inside the workspace
  folder; otherwise the workspace folder as today.
- **Workspace keys**: Ctrl+Shift+1..9 shows the nth workspace in sidebar order
  (match `code` Digit1..9 with Ctrl and Shift, so the layout's shifted symbol
  does not matter; changed from Alt+Shift after review, which took readline's
  M-! M-@ M-$ completion bindings); Alt+PageDown / Alt+PageUp next and previous open
  workspace. Added to AGENTS.md's claimed keys and the help panel.
- **Recent terminals**: Ctrl+Tab opens a small centred list of the last 8
  focused terminals across workspaces (most recent first, current one second
  selected), Tab / Shift+Tab move while Ctrl is held, releasing Ctrl shows
  that terminal; Esc cancels. The order is frozen while the list is open.
  A single Ctrl+Tab tap therefore flips between the last two.

### Agents round 2, as built (added 2026-10-25)

What the "Agents" part of round 2 settled beyond the frozen text above.

`GET /api/sessions` items: `agent` gains, beside the 4.2 fields,

```
"last_prompt":  str | null,   # first 300 chars, control characters out, whitespace collapsed
"last_answer":  str | null,   # same; cleared by the next UserPromptSubmit
"last_event_at": str,         # ISO 8601 UTC, "2026-10-25T12:00:00Z"
"event_age_seconds": int,     # the same moment as an age, for the card
"board": "needs-you" | "working" | "done" | "idle",
"conversation_id": str | null,  # Claude session_id or Codex thread-id, [0-9A-Za-z_-]{1,100}
"cwd": str | null,            # the folder the hook payload names
"title": str | null           # the conversation's own title
```

and each subagent gains `"waiting": bool` (a PermissionRequest or permission
Notification carrying its `agent_id`, cleared by its next tool event or its
SubagentStop).

- Every Claude event the state machine knows stamps `last_event_at`, except a
  straggler it drops, a compaction SessionStart and a non-permission
  Notification (Claude's `idle_prompt` is not activity). Codex: each
  `agent-turn-complete`.
- `board`: "needs-you" while the state is waiting or any subagent waits,
  however long; else "idle" after 30 minutes without an event; else
  "working" for working; "done" for done or failed, and for an idle agent
  that finished a turn (seen turns stay in Done until the 30 minutes pass);
  else "idle". The frontend also puts an agent terminal with `attention` in
  Needs you.
- On `Stop` and `agent-turn-complete` the route reads, off the loop, the
  transcript's last 256 KB when the hook carried no `last_assistant_message`
  (only an absolute path ending in `.jsonl`), and the title: Claude's last
  `custom-title`, else its last `ai-title` or `summary` (never the first
  prompt); Codex's `thread_name` from `session_index.jsonl`. Claude writes a
  new conversation's `ai-title` just after its first Stop hook, so a turn
  that finds no title looks again after 3 and 10 seconds.
- The session's `name` follows `agent.title` until `PATCH
  /api/sessions/{sid}` names it; when the agent goes (SessionEnd, the agent
  leaving the shell) an unnamed session gets its spawn name back. Panes show
  the polled name unless they carry a typed title.
- Notifications: the attention listener also hears kind `"done"` (never
  stored as attention). `notify(sid, name, kind, text, mode=, sound=)`;
  config `notifications: {"needs_you": "off"|"flash"|"notify" = "notify",
  "finished": ... = "flash", "sound": bool = false}`. "On screen" is
  QuickTerm's window in front: nothing then. Flash flashes the visible
  primary window; Notify also shows the tray notification, or only that when
  every window is in the tray. Balloons are silent (`NIIF_NOSOUND`); Sound
  plays `MessageBeep(MB_ICONASTERISK)` once. Throttled per session and kind,
  30 s.
- Keep awake: config `keep_awake: "agents"|"always"|"off"`. "agents" holds
  while any live session's agent state is `working` (not the 30-minute
  rule: a long tool run is still work). `SessionManager` calls
  `SetThreadExecutionState` on the loop thread only, on agent events, agent
  exits, a Settings save and a 15 s tick, and releases on `shutdown()`.
- Palette: "copy resume command: <terminal>" rows (quiet, listed once
  something is typed) and a `secondary` action on resume rows run by
  Shift+Enter. The line is `Set-Location -LiteralPath '<folder>'; <cmd>` for
  PowerShell, `cd /d "<folder>" && <cmd>` for cmd (no folder when it holds a
  `"`), `cd '<folder>' && <cmd>` otherwise.
- The board remembers its tab (`quickterm.boardTab`) and the idle toggle
  (`quickterm.boardShowIdle`) in localStorage. No PR number on the cards yet;
  `GET /api/board` now carries the one the right panel last saw (below).

### The right panel, as built (added 2026-10-25)

What the frozen "The right panel" part left open, as implemented.

- Modules: `ws_files.py` (path rules, `LocalFolder`, `HostFolder`,
  `folder_for`), `ws_git.py`, `ws_pr.py`, routes in `api/ws.py`; frontend
  `right_panel.js` (frame, tabs, width, overlay host), `rp_files.js`,
  `rp_changes.js`, `rp_pr.js`, `file_view.js`, `diff_view.js`,
  `right_panel_model.js` (pure), `rp_dom.js`, `ws_api.js`,
  `css/right_panel.css`, `vendor/highlight.min.js` (highlight.js 11.11.1,
  common build, `vendor/highlight-LICENSE.txt`).
- Path rules (`ws_files.clean_rel`): backslashes read as slashes, `.` and
  empty parts dropped, `..` folded and refused when it climbs out; refused
  are a leading `/` or `\` (UNC too), a drive letter, any `:` (alternate
  data streams), control characters, a part that is all dots or spaces, and
  any part that is `.git` as Windows reads it (`.GIT`, `.git.`, and its 8.3
  short name `GIT~1`, any `git~<digits>`). The local reader then follows
  links (`realpath`, junctions included) and refuses a result outside the
  folder or inside `.git`; every path handed to git (stage, unstage,
  discard, diff) is resolved that way first for a local workspace. On a host
  the same check runs in the host's shell (`realpath -e`). Git gets paths
  with `--literal-pathspecs`.
- No program a repository's config names runs on the panel's reads: every
  git call passes `-c core.fsmonitor=false -c diff.external=`, every diff
  `--no-ext-diff --no-textconv`. Every read first lists the filter drivers
  (`git config --name-only --get-regexp '^filter\.'`, which runs nothing)
  and passes `-c filter.<x>.clean= -c filter.<x>.smudge= -c
  filter.<x>.process= -c filter.<x>.required=false` for each, so git reads
  the content unfiltered (a file a filter stores as a pointer can then show
  as changed). Stage, discard, commit, push and pull keep the filters, since
  they store or check out what the filters make; commit runs the hooks, and
  push and pull run theirs as git always does.
- Reads: a local workspace is read directly (`LocalFolder`, the one place
  for direct reads); a workspace with `host` through `ws_exec` (one POSIX
  script per request). On a host, images read as binary (no local file to
  serve), "Open in editor" and "Reveal in Explorer" are hidden (501 if
  called), untracked files carry no `+n`, and the contents search without
  git is one `grep -rnIiF` there.
- Extra answers: `GET /api/ws/{name}/changes` is 409 `not a git repository`
  outside one, 503 when git is missing, 502 when the host is unreachable.
  `files` and `committed` are each capped at 5000 entries, and the answer
  adds `"truncated": bool`. `GET .../files` adds `"truncated"` when a folder
  holds more than 5000 entries; the name search reads at most 100000 paths
  and `git grep` stops at 20 matches per file. Without an
  upstream, `ahead` counts the commits since the merge base with `base` and
  `behind` is 0. `base` is origin's default branch (`origin/HEAD`), else
  `origin/main`, `origin/master`, `main`, `master`.
- `GET /api/ws/{name}/file`'s `image_url` is
  `/api/assets/ws-file/<random key>`: GET under `/api/assets/` is token-free
  (an `<img>` cannot send the token), the key names one file for an hour
  (at most 256 keys), and the answer carries `Content-Security-Policy:
  ... sandbox` and `nosniff`. `tests/test_routes_auth.py` names the route.
- `POST /api/ws/{name}/changes` and `/git` answer `{"ok", "output"}`; git's
  output keeps its last 20000 characters. Stage is `git add -A`, unstage
  `git restore --staged` (`git rm --cached` before the first commit), discard
  `git restore --worktree` for tracked files and `git clean -f` for untracked
  ones (never ignored files). Pull is `--ff-only`; publish pushes `HEAD` with
  `-u` to `origin`, else the only remote, and answers `ok: false` on a
  detached HEAD or a remote name outside `[A-Za-z0-9_][A-Za-z0-9._/-]*`.
  Commit runs the hooks with a 300 s limit, push and pull 120 s.
- `POST /api/ws/{name}/open` `{"path", "app": "editor"|"explorer"}` (added):
  editor runs Code.exe (never the `code.cmd` shim) on the file, else the
  default program through `opener.open_target`; explorer opens the
  containing folder.
- `GET /api/ws/{name}/pr` adds `"reason"` (why `pr` is null) and, on the PR,
  `merge_methods` from `gh repo view`; each check adds `run_id` and `job_id`
  parsed from its link; the PR carries `headRefOid`. A folder outside git
  answers `reason: "not a git repository"` without asking gh. `GET
  .../pr/log` takes an optional `job`. `gh` runs on this machine with
  `-R <host>/<owner>/<repo>` from the branch's upstream remote, else
  `origin`, else `upstream`, else the push remote, else the first GitHub
  remote (4.6; before, only `origin`), through `ws_exec` with the home
  folder. The branch and every remote setting are read in two git calls
  (`rev-parse --is-inside-work-tree --symbolic-full-name HEAD` and one
  `config --null --get-regexp`); insteadOf, pushInsteadOf and pushurl apply
  as in git, credentials in a URL are dropped, `ssh.github.com` and
  `www.github.com` mean github.com, and an SSH alias is resolved through
  `~/.ssh/config` (the distribution's own in WSL; by name only for an SSH
  workspace). `reason` is one of: "not a git repository", "git could not
  be asked: <why>", "this repository has no remote", "<remote> is a folder,
  not a GitHub repository", "<remote> is on <host>; pull requests are shown
  for GitHub repositories", "no branch checked out", "the branch has no
  commits yet", "no pull request for this branch", or gh's own message with
  credentials scrubbed. The base branch is found with one `for-each-ref`
  and the branch's commits with `diff --raw --numstat <base>...HEAD`. The PR is found with `gh pr list --head=<branch> --state all`
  (an open one wins over older ones), never `gh pr view <branch>`, which
  reads an all-digit branch as a PR number; a branch starting with `-` has
  no PR. `POST .../pr/merge` takes `{"method", "number", "head_sha"}`, the PR
  the confirmation showed: 400 without them, 409 when the branch's PR is now
  another one or has a newer head, and `gh pr merge` gets
  `--match-head-commit <head_sha>`.
- The scratch view: the reserved name `.scratch` (no saved workspace can
  take it, names starting with a dot are refused) maps to the configured
  `scratch_dir`, else `<temp>/QuickTerm/scratch`, with the same path rules.
  Outside git, Changes and Pull request say "Not a git repository.".
- `GET /api/board` adds `"pr": {"<workspace>": {"number", "state", "url"}}`:
  the PR the right panel last saw for that workspace, in memory only.
- Frontend: `quickterm.rightPanel.v1` in localStorage holds `{width, tab}`
  (width clamped to 240 px and 60% of the window); `quickterm.diffLayout.v1`
  the diff layout; `quickterm.rightPanelMode` the mode (full, rail, hidden;
  default hidden). `#app` always has three columns (sidebar.css:
  `--sidebar-col`, the stage, `--rp-col`), 0px for a hidden side, so every
  mode change on either side is the same `grid-template-columns` slide. Each
  side keeps its own width pinned to its inner edge while its column moves
  (`justify-self`, `#app` clips), so nothing reflows, and turns `visibility:
  hidden` once the slide ends; hidden from the rail keeps the rail's layout
  (`sidebar-collapsed` stays set; `rp-mode-was-rail`). The body carries
  `rp-mode-full|rail|hidden`. The right rail is the three tab icons with
  dots (Changes: the tree has changes; Pull request: the checks' colour) and
  polls Changes and Pull request for them. Alt+Shift+E and the left footer's
  "right panel" icon (`aria-pressed` while the panel shows, also in the left
  rail) open to full and close from full; the chevron steps full and rail,
  as the left one does. The terminals refit once, on the grid's
  `transitionend` (or 260 ms without one). Full refreshes the visible tab on
  open, on a tab click, on window focus and on a timer (Files and Changes
  10 s, Pull request 30 s); hidden polls nothing. It follows the shown workspace through the
  shell's `refresh`. A poll tick is skipped while the last one waits, a
  Files poll re-lists the tree but does not rerun a search, and the file
  view's Changes toggle reuses the Changes tab's answer while it is under
  10 s old. A Changes action (and its output, its Fix with Claude) belongs
  to the workspace it ran in; a switch meanwhile neither frees that
  workspace's button nor shows the result elsewhere. While the keyboard is in the
  panel it is a focus owner (`right-panel`), the file view and diff
  `rp-viewer`; Esc in either hands the keyboard back to the shown terminal.
  The shell member `showRightPanel(tab)` backs the palette rows;
  `quicktermChrome.windowKeys.toggleRightPanel` backs the key.
- Fix with Claude: `POST /api/sessions` with `profile: "claude-code"`,
  `agent_mode: "new"`, `prompt` and the workspace, then the terminal is
  attached in that workspace's view (scratch: `cwd` is the scratch folder).
  The prompt swaps `"` for `'` and keeps each log's tail so the whole fits
  16000 characters; when the spawn fails on cmd.exe it is built again for
  7000 characters, logs trimmed first, and sent with newlines and cmd's
  special characters flattened.

### Both sidebars slide and look the same (added 2026-10-25)

The left sidebar and the right panel are one design, mirrored.

- **Modes**: both have full, rail and hidden. The left keeps Alt+Shift+S and
  its stored mode; the right panel's mode is stored per machine the same way
  (`quickterm.rightPanelMode`, try/catch), default hidden. Alt+Shift+E on
  the right: hidden or rail goes to full, full goes to hidden (the key opens
  and closes; the chevron steps through rail).
- **Rail**: the same width token (`--sidebar-rail`) on both sides. The right
  rail shows the three tab icons stacked (files, changes, pull request);
  a click opens the panel full on that tab. Its icons carry the same small
  state dots the left rail uses where there is something to say (Changes:
  a dot when the tree has changes; Pull request: the check state colour).
- **Look**: same surface token, a 1px line on the inner edge only, the same
  header row height as the left's top row, the same icon-button component
  and size, the same footer row height. A collapse chevron sits in the
  outer bottom corner of each footer (left: bottom right of the left
  sidebar, pointing left; right: bottom left of the right panel, pointing
  right). It steps full, rail, hidden like the left one does today.
- **Show button**: the left sidebar's footer icon row gains a "right panel"
  toggle (a panel-right icon) beside board, settings and help, highlighted
  while the panel is not hidden. In the left rail it is one of the rail's
  footer icons too. With both sidebars hidden, the keys and the palette
  bring them back (the existing floating "+" stays as it is).
- **Motion**: both slide with the same transition (the left's current
  duration and easing), the panel's content does not reflow during the
  slide (fixed inner width, clipped), `prefers-reduced-motion` turns it
  off, and the terminals refit once when the transition ends (not on every
  frame).
- **Resize**: both full widths are dragged on the inner edge with the same
  grip look and stored per machine.

### Updates download in the background, with a progress card (added 2026-10-25)

Today an update is a quiet "up" pill that opens Settings > About, where
"Install" blocks on one request while the whole installer downloads, then
starts Setup with its full wizard. 4.3 replaces that flow:

- **Download**: when the update check finds a newer installable release and
  `update_auto_download` (new config bool, default true) is on, the backend
  downloads the Setup asset in the background: streamed in chunks to a file
  in a fresh `quickterm-update-*` temp folder, SHA-256 computed while it
  streams, then checked against the release's `SHA256SUMS.txt`. The trust
  model stays exactly as in update.py: https only, the pinned repo's release
  payload, the allowed GitHub hosts re-checked after redirects, the size caps,
  no install without a matching checksum. One download at a time per backend;
  a second request joins the running one. With the setting off, the card
  offers "Download".
- **State**: `GET /api/update/status` → `{"state": "idle"|"available"|"downloading"|"verifying"|"ready"|"installing"|"failed", "version": str|null, "received": int, "total": int|null, "error": str|null, "notes_url": str|null}`.
  `POST /api/update/download` starts or joins the download (204; 400 when no
  installable update exists, on POSIX, or in the elevated instance).
  `POST /api/update/install` requires `ready`, re-verifies the file's hash,
  then hands over exactly as `download_and_run` does today (stand-down via
  `pty_host.begin_update()`, detached Setup), with Setup's `/SILENT` flag so
  only its progress window shows (UAC still asks for an all-users install).
  409 when not ready. The old one-shot `download_and_run` path is removed or
  becomes download + install.
- **Card**: a small card at the bottom right of the window (over the stage,
  above the terminals, 320 px wide at most, theme tokens, short slide-in, not
  in the elevated instance, not when `update_check` is off):
  - downloading: title "Downloading update", "QuickTerm v4.3.1 is
    downloading.", a "Release notes" link (opens `notes_url` through the
    existing `POST /api/open`), a thin progress bar and "Downloading… 30%"
    (or the size so far when the total is unknown); a "–" button top right.
  - ready: title "Update ready", "QuickTerm v4.3.1 is ready to install. Your
    terminals keep running.", "Release notes", buttons "Install now"
    (primary) and "Later".
  - available with auto download off: "Update available", "QuickTerm v4.3.1
    is available.", "Release notes", "Download" and "Later".
  - failed: "Update failed", the error in one line, "Retry" and "Later".
  - "–" collapses the card into the sidebar footer pill, which then shows the
    percentage while downloading ("30%"), "up" when ready, and reopens the
    card on click. "Later" hides the card until the next app start or the
    next version; the pill stays.
  - The card polls `/api/update/status` every 500 ms while downloading or
    verifying, never otherwise. Esc on the focused card collapses it;
    keyboard focus goes back to the terminal (focus.js).
- **Settings > About** keeps "Check for updates", shows the same state in
  words with the same actions, and gains the "Download updates
  automatically" switch.

## Testing

`tests/` with pytest. Backend units must not require a real browser. PTY tests
spawn `cmd.exe /c echo hi` style short-lived processes. Server tests use
`fastapi.testclient.TestClient` with a stub/real manager. Keep tests fast (<30 s
total). Run: `uv run --no-sync pytest` (env is pre-synced; do NOT run uv sync,
uv add, or uv lock).

### Side by side workspaces and a files panel that slides over (4.7, frozen 2026-10-25)

Devin asked for several workspaces on screen at once again, with the files
panel hidden by default, sliding over the terminals when opened and hiding
by itself. The old 4.0 tiled views (view headers, coloured frames, view
drag and dock, dividers) stay gone; this is a small, quiet split.

Stage
- The stage shows 1 to 4 workspaces side by side as columns, left to right
  in the order they were added. One shown workspace fills the window as in
  4.6. Views are never moved in the DOM (an iframe that moves reloads): the
  stage is a CSS grid and each shown view gets its column through
  `grid-column`; hidden views keep `visibility: hidden` and `inert` as now.
- `WorkspaceViews` gains `shown` (an ordered list, at most 4) next to
  `active` (the column with the keyboard, always one of `shown`).
  `show(view)` keeps today's meaning: that workspace alone. `addShown(view)`
  adds a column (the oldest non-active column leaves when 4 are shown),
  `removeShown(view)` takes one out (the view stays open and running, as a
  hidden view does today). The open-views store keeps `shown` so a reload
  or restart restores the split.
- Each column has a one-line header only when 2 or more are shown: the
  workspace's colour dot, name, branch, its state dot (the same states as
  the sidebar), and `×` (remove from the split, never close or kill). The
  active column's header is marked with the accent; the others are muted.
  Clicking anywhere in a column makes it active. With one column there is
  no header (as today).
- Columns are resized by dragging the 1 px gutter between them (min 320 px
  each); widths are fractions saved with `shown`. Double-click a gutter to
  make all columns equal.
- Sidebar: click a workspace shows it alone (unchanged); Ctrl+click (and
  the card's ⋮ menu "Show side by side") adds it as a column, or removes it
  when already shown. Shown workspaces get a filled colour dot; the active
  one also the card highlight. Palette rows: "show side by side: <name>"
  for every workspace not shown, "show alone" for the active one.
- Keys: `Ctrl+Alt+Left` / `Ctrl+Alt+Right` move the keyboard to the column
  left or right (they reach the focused pane of that column). Alt+PgUp/PgDn
  and Ctrl+Shift+1..9 keep showing one workspace alone. `Alt+Z` zooms a pane
  inside its column only.
- Scratch can be a column like any workspace. A window opens with one
  column, as today.

Files panel (the right panel)
- Hidden by default. Opening it (`Alt+Shift+E`, the sidebar footer icon,
  the palette rows, a tab's rail icon) slides it in over the right edge of
  the stage, above the terminals (an overlay with a shadow; the terminals
  do not resize). It shows the active column's workspace and follows the
  active column.
- It hides by itself when the keyboard or a click goes back to a terminal,
  on Escape, and when the active column changes to a workspace with no
  folder. A pin button in its header keeps it open (it still overlays);
  the pin is remembered per window. `Alt+Shift+E` toggles it either way.
- The rail mode (icons only) and the pushed layout are removed; the
  overlay's width is resizable as now (`clampPanelWidth`), and remembered.
- Opening it gives it the keyboard (focus.js claim), hiding it hands the
  keyboard back to the pane that had it.

Not in scope: dragging panes between columns, more than 4 columns, rows.

As built (2026-10-25)
- Modules: `stage_columns.js` (pure: the `{shown, active}` rules, widths,
  the grid template, the stored split), `stage_chrome.js` (column headers
  and gutters, plain elements in the stage grid). `WorkspaceViews` gains
  `shown`, `fractions`, `toggleShown`, `removeShown`, `showAlone`,
  `stepColumn`, `takeColumn`, and `open(name, {beside: true})`; there is no
  separate `addShown`, `open(..., {beside})` and `toggleShown` cover it.
  `activate(view, {alone})`: a view that is already a column only takes the
  keyboard, any other is shown alone.
- Deviation: a plain sidebar click on a workspace that is already a column
  moves the keyboard there and keeps the split, so one stray click does not
  undo a split built with Ctrl+click. On any other workspace it shows it
  alone, as written. Alt+PgUp/PgDn and Ctrl+Shift+1..9 always show alone.
- An added column takes the keyboard. A removed column that had it hands it
  to its left neighbour (the new first column when it was the first).
  Widths reset to equal whenever the set of columns changes.
- Record: `quickterm.openViews.v1` keeps version 1 and `shown` (the column
  with the keyboard) and adds `split` (names in column order) and `widths`
  (fractions, 3 decimals), written only with 2+ columns. A bad `split` is
  dropped on its own (bad names skipped, past 4 cut, mismatched widths made
  equal); the record still opens. Widths come back only when every column
  did.
- Headers are 24px: colour dot, name, branch, state dot (attention, failed,
  done, busy, new output; nothing when quiet), and `×` on hover. The active
  one has full-strength text and a 2px accent underline. Inside a column
  without the keyboard the focused pane loses its accent bar
  (`body.view-suspended`), so one pane in the window wears it. Ctrl+Alt+
  Left/Right are claimed only with 2+ columns; at the edge nothing moves.
- Sidebar: a group carries `shown`. While 2+ columns show, an open
  workspace that is not on screen keeps only its colour's ring; with one
  column the dots are as before. The ⋮ row reads "Show side by side" or
  "Remove from side by side" and is first in the menu. Palette: "show side
  by side: <name>" for each saved workspace not on screen and for an open
  scratch, "show alone" with 2+ columns.
- Files panel: appended to the stage, absolutely positioned on its right
  edge (z-index above the columns, `--shadow-md`), slid with `transform`
  (.14s, off under reduced motion). `#app` has two columns now
  (`--rp-col`, `rp-mode-*`, the rail, the footer and its chevron are gone;
  `quickterm.rightPanelMode` is no longer read). The header holds the three
  tabs, the pin and a close button. Body classes: `rp-open`, `rp-pinned`.
  The pin is `sessionStorage["quickterm.rightPanelPinned"]`; a pinned panel
  reopens after a reload of that window without taking the keyboard.
- Auto-hide: every pointerdown or window focus in a shown view's document
  reaches `takeColumn`, which calls `onTouch`, which hides an unpinned panel
  (`panelHides` in right_panel_model.js). A window blur was not enough: when
  the keyboard is already in a view, a click in another column blurs
  nothing in the shell. A file view or diff open from the panel keeps it.
  Escape hides an unpinned panel and hands the keyboard back; pinned, it
  only hands it back. The no-folder hide runs when the column's workspace
  record arrives without a path. Opening focuses the tab, or its button
  when the tab has nothing to focus yet.
