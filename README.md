# QuickTerm

A calm, local terminal workspace: split panes, named workspaces, persistent
sessions, quick-launch profiles, and WSL integration. Everything stays on
your computer. No Electron, accounts, or telemetry.

## Install

### Windows application

Download `QuickTerm-v*-Setup.exe` from the
[latest release](https://github.com/devincii-io/quickterm/releases/latest) and
run it. The per-user installer adds Start Menu and Desktop shortcuts,
supports in-place upgrades, and includes an uninstaller. It does not require
administrator access. A portable `.zip` is also available. Windows may show a
SmartScreen warning until release binaries are code-signed.

The installed build uses a normal application folder instead of a
self-extracting one-file executable. Multiple QuickTerm windows share that
runtime on disk, avoiding a separate temporary extraction and its startup cost
for every process.

QuickTerm opens as its own native desktop window. The installer adds an
optional **Open QuickTerm here** entry to the folder right-click menu (both on
a folder and inside one), which opens a terminal in that directory. When a new
version is published, the app shows an unobtrusive **Update** pill (Settings →
About has the details and a one-click, checksum-verified install). The launcher
detects installed PowerShell, Command Prompt, WSL distributions, Git Bash, and
Nushell installations.
Use the **Admin** button beside **Open** to start the selected terminal in a separate
UAC-approved window; both the window and session are labeled `Administrator`.

### From source

Requires Python 3.12+ and [uv](https://docs.astral.sh/uv/). Windows 10 1809+
uses ConPTY; Linux uses the native POSIX PTY backend.

## Run

```
uv sync
uv run quickterm
```

The backend starts on `127.0.0.1:8620` and opens a chromeless browser app
window. The workspace selector controls persistence: a named workspace
autosaves its exact split arrangement and live session IDs for reattachment
with full scrollback. **Scratch** is the disposable mode: the moment you type
into a scratch layout it starts autosaving as the special `scratch` workspace
(replacing the previous one), survives closing the window during a run, and is
deleted for good when the app quits.

Closing the window is smart about your work: if any terminal you have typed
into or any shell with a running child process is still active (an SSH session,
a dev server, ...), QuickTerm hides
to the system tray and keeps everything alive — click the tray icon (or press
the summon hotkey) to bring it back, right-click → **Quit** to exit for real.
If only untouched shells are open, closing the window simply quits and frees
the memory. Terminal I/O is streamed with coalesced reads/writes end to end,
so heavy output (builds, logs) renders fast without making typing laggy.

URLs and file paths printed in a terminal are clickable: hold **Ctrl** and
click to open them with your default browser or file handler (executables are
revealed in Explorer, never launched). Detaching a pane whose shell is running
something (an SSH session, a build, Claude Code, ...) asks for a second press
before detaching, so one stray keystroke can't lose running work.

## Keys

QuickTerm only claims Alt combos that nothing inside the terminal wants.
Everything shells and TUIs actually bind passes through untouched: `Ctrl+C`,
`Ctrl+P`, `Alt+V` (Claude Code image paste), `Alt+P` (Claude Code model
switch), `Alt+H` (PSReadLine help), `Alt+0..9`/`Alt+-` (readline digit
arguments), the `Alt+B`/`F` word motions, ...

| Key | Action |
|---|---|
| `Alt+K` | Command palette (profiles, actions, snippets, workspaces, sessions, file viewer) |
| `Alt+Shift+Right` / `Alt+Shift+Down` | Split pane to the right / below (`H` / `V` aliases) |
| `Alt+Arrows` | Move focus between panes |
| `Alt+Z` | Zoom focused pane |
| `Alt+W` | Detach pane (session stays in this workspace; asks twice if something is running) |
| `Alt+Shift+Plus` / `Alt+Shift+Minus` / `Alt+Shift+0` | Grow / shrink / reset terminal text size |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy selection / paste in a terminal |
| `Ctrl+Click` | Open a URL or file path printed in the terminal |
| `Ctrl+Alt+`` ` | Summon/hide the window (global, configurable — also restores from tray) |

The status bar's **View** drawer exposes reliable `−` / `+` font controls with
an explicit **This pane / All panes** scope, plus width/height controls for the
selected pane, split balancing, focus mode, and a shortcut to full Settings.
Keyboard font shortcuts follow the scope selected there. Pane-only sizes are
temporary; All panes also updates the saved default. Split dividers are wider,
keyboard-adjustable, and can be double-clicked to balance them.

Per-profile global hotkeys (e.g. `Ctrl+Alt+1` → spawn the claude profile) are
set via `keybinding` in the profile config.

Detached sessions appear under **Dashboard → Detached sessions** with **Attach**
and **Kill** controls. `Alt+K` only offers sessions from the current workspace;
moving one from another workspace requires the explicit **Attach from another
workspace…** menu. Scratch follows the same ownership rule during the current
run, but Scratch and all of its sessions are discarded when QuickTerm quits.

## Configuration

`%APPDATA%\quickterm\config.json` — created with defaults on first run.
Terminal profiles can be managed from **Settings → Terminals**. Choose
PowerShell 7, Windows PowerShell, Command Prompt, WSL (including a detected
distribution), or a custom executable. Profiles can also set a starting folder,
an optional command to run inside the shell, environment variables, a global
shortcut and autostart. With no folder configured, Windows shells start in the
Windows user home and WSL starts in the distro's Linux home. A WSL profile can
use Linux paths such as `~/dev`; its startup command runs from that location.

The same fields are available in the config file:

```json
{"name": "project", "cmd": "wsl.exe", "args": [], "cwd": "~/dev/project",
 "env": {}, "keybinding": "ctrl+alt+1", "autostart": false,
 "terminal_type": "wsl", "wsl_distro": "Ubuntu",
 "start_command": "source .venv/bin/activate"}
```

Snippets, custom themes, global and per-workspace logos, the idle-session
timeout, summon hotkey, port, scrollback size, and font live in the same file.
Settings shows four featured color themes and groups the full catalog into
Dark, Soft, Warm, Light, and Custom sections. Theme previews update the whole
workbench and every open terminal immediately, then revert on Cancel.
(A local voice-input mode exists behind `uv sync --extra voice` but is parked
until it gets a proper capture overlay.) Named workspaces are saved under the QuickTerm config directory
and can be switched from the app bar or dashboard. Logs rotate under `logs/` in
that directory.

## Development

```
uv sync --all-extras --dev
uv run ruff check quickterm tests
uv run pytest -q
uv build --no-sources
```

Architecture: one backend process owns all PTYs (`pty_session.py` /
`pty_posix.py`, `session_manager.py`); views attach over a binary WebSocket
protocol (`server.py`); the packaged frontend is plain ES modules plus vendored
xterm.js with no Node build step. See `plan.md` and `docs/CONTRACTS.md`.

Run the verification commands above before merging changes. Release artifacts
are built locally: the Windows application folder, per-user installer,
portable archive, Python distributions, generated notes, and SHA-256 checksums.

MIT licensed.
