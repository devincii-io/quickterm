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
SmartScreen warning because current release binaries are unsigned. A trusted
Authenticode signature identifies the publisher and lets reputation carry
between releases, but a new signing identity can still receive warnings while
reputation builds; Microsoft Store distribution is the reliable no-warning
path. See [Signing releases](docs/SECURITY.md#smartscreen-and-release-signing).

The installed build uses a normal application folder instead of a
self-extracting one-file executable. One ordinary QuickTerm process and viewer
own the runtime; repeated launches hand work to it instead of duplicating the
Python/WebView runtime in memory. The frozen server also excludes Uvicorn's
unused reloaders and alternative protocol parsers.

QuickTerm opens as its own native desktop window. The installer adds an
optional **Open QuickTerm here** entry to the folder right-click menu (both on
a folder and inside one), which opens a terminal in that directory. When a new
version is published, the app shows an unobtrusive **Update** pill (Settings →
About has the details and a one-click, checksum-verified install). The collapsible
terminal sidebar
detects installed PowerShell, Command Prompt, WSL distributions, Git Bash, and
Nushell installations.
Use the **Admin** action beside **Open** to start the selected terminal in a separate
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
window. Ordinary launches are single-instance: starting QuickTerm again summons
the existing window instead of creating a second viewer with ambiguous session
ownership. Explorer **Open QuickTerm here** securely queues that folder to the
running viewer, switches it to Scratch, and opens the terminal there; the user
can then save or move it deliberately. The sidebar workspace list controls persistence: a named workspace
autosaves its exact split arrangement and live session IDs for reattachment
with in-memory scrollback while those processes are still alive. If a saved
process is gone, QuickTerm restores an explicitly unavailable pane and never
silently starts a replacement shell under the old identity. Claude-oriented
profiles additionally offer explicit **Continue latest** and **Choose session**
recovery actions.
**Scratch** is the disposable mode: the moment you type
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
revealed in Explorer, never launched). **D** / `Alt+D` is a true detach and
keeps the terminal process alive; **×** / `Alt+W` is the distinct destructive
path and always asks before killing the complete process tree.
Files and images can also be dropped onto a pane. QuickTerm inserts shell-safe,
quoted paths without pressing Enter. Its native WebView bridge supplies the
real Explorer path; WSL paths are translated to `/mnt/<drive>/...`, while
remote SSH/SFTP panes refuse a misleading local path. Standard Chromium can
withhold the original desktop path outside that native bridge; in that case
QuickTerm suggests Copy as path plus native `Ctrl+V` instead of pasting a
misleading filename.

## Keys

QuickTerm uses familiar Windows copy, paste, and text-size conventions while
leaving shell/TUI bindings intact. `Ctrl+C` copies when text is selected and
otherwise reaches the terminal as interrupt. `Ctrl+P`, `Alt+V` (Claude Code image paste), `Alt+P` (Claude Code model
switch), `Alt+M`/`Alt+T`/`Alt+O` (Claude modes), `Alt+H` (PSReadLine help), `Alt+0..9`/`Alt+-` (readline digit
arguments), the `Alt+B`/`F` word motions, ...

| Key | Action |
|---|---|
| `Alt+K` | Command palette (profiles, actions, snippets, workspaces, sessions, file viewer) |
| `Alt+N` | Open a new default terminal beside the focused pane |
| `Alt+Shift+Left` / `Alt+Shift+Up` | Cycle previous / next profile used by new terminals |
| `Alt+Shift+Right` / `Alt+Shift+Down` | Split pane to the right / below (`H` / `V` aliases) |
| `Alt+Arrows` | Move focus between panes |
| `Alt+Z` | Zoom focused pane |
| `Alt+D` | Detach pane; the terminal keeps running in the background |
| `Alt+W` | Kill the focused terminal process tree and close its pane (always asks first) |
| `Ctrl+Plus` / `Ctrl+Minus` / `Ctrl+0` | Grow / shrink / reset terminal text size |
| `Ctrl+C` / `Ctrl+V` | Copy selection (or interrupt when none) / paste in a terminal |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Compatible copy / paste aliases |
| `Ctrl+Click` | Open a URL or file path printed in the terminal |
| Drop file/image | Paste its quoted local path without submitting it |
| `Ctrl+Alt+`` ` | Summon/hide the window (global, configurable — also restores from tray) |

Split actions open the currently selected terminal profile in the focused
pane's best-known directory. QuickTerm tracks that directory from OSC 7 and
OSC 9;9 shell-integration signals and otherwise falls back to the pane's launch
folder; it never scrapes prompt text. Sidebar **Open** and `Alt+N` deliberately
keep using the selected profile's configured folder. Claude splits stay bound
to their profile's project and never implicitly open `claude agents`; use
Alt+K → **Split Claude agent view** for an explicit project-scoped manager.

The status bar's **View** drawer exposes reliable `−` / `+` font controls with
an explicit **This pane / All panes** scope, plus width/height controls for the
selected pane, split balancing, focus mode, and a shortcut to full Settings.
Keyboard font shortcuts follow the scope selected there. Pane-only sizes are
temporary; All panes also updates the saved default. Split dividers are wider,
keyboard-adjustable, and can be double-clicked to balance them.

Per-profile global hotkeys (e.g. `Ctrl+Alt+1` → spawn the claude profile) are
set via `keybinding` in the profile config.

Live and background sessions appear directly in the sidebar. Its counter shows
`workspace/global` when they differ, while the status bar spells out the global
total. Dashboard statistics separately show **this workspace** and **all live**;
unowned sessions are labelled **Unassigned** instead of looking like a hidden
workspace. Detailed detached
sessions remain under **Dashboard → Detached sessions** with **Attach**
and **Kill** controls. `Alt+K` only offers sessions from the current workspace;
moving one from another workspace requires the explicit **Attach from another
workspace…** menu. Scratch follows the same ownership rule during the current
run, but Scratch and all of its sessions are discarded when QuickTerm quits.

**Dashboard → Terminal usage** shows the host process tree's current working
set, sampled CPU, process count, and uptime for every live terminal. The status
bar and sidebar use a lightweight lifecycle query and do not continuously take
an OS process snapshot. WSL is labelled **host side only** because Linux
processes inside the WSL VM cannot be attributed reliably to one Windows
terminal. Output produced after a terminal is detached is marked **New output**
with its byte count and age, then acknowledged automatically when you attach it.
Settings can cap live terminals from 1–100; `0` keeps the default
unlimited behavior. Reaching the cap blocks new spawns and never kills an
existing terminal. The dashboard also has a confirmed **Kill all terminals**
action for intentionally stopping every live session. It removes only terminals
the backend verifies as stopped; any failure stays visible and is reported for retry.
Kill confirmations remain visible beside their trigger and are clamped inside
the window, including for sessions near the bottom of a scrolled dashboard.

## Configuration

`%APPDATA%\quickterm\config.json` — created with defaults on first run.
Terminal profiles can be managed from **Settings → Terminals**. Choose
Claude Code, PowerShell 7, Windows PowerShell, Command Prompt, WSL (including a detected
distribution), SSH or SFTP (powered by bundled PuTTY plink/psftp), or a custom
executable. Profiles can also set a starting folder,
an optional command to run inside the shell, environment variables, a global
shortcut and autostart. With no folder configured, Windows shells start in the
Windows user home and WSL starts in the distro's Linux home. A WSL profile can
use Linux paths such as `~/dev`; its startup command runs from that location.
Every local profile folder field keeps direct path entry and adds a native
**Browse** picker in the installed app. WSL can still use a manually entered
Linux path, while Browse can select an absolute Windows folder accepted by
`wsl.exe --cd`.

Claude Code is a first-class project profile rather than a name convention.
Bind it to a project folder and choose **Continue latest**, Claude's native
**session picker**, **new conversation**, or the **background-agent manager**.
The palette also exposes continue, choose-session, and agent-manager actions for
each Claude profile. If its PTY has actually died, the restored pane stays blank
and offers both explicit **Continue latest** and **Choose session** recovery; it
never shows cached terminal history or silently substitutes a new process.

SSH and SFTP profiles take a host, optional port, username and PuTTY `.ppk`
private key; passphrases are never stored — you are prompted in the terminal.
The bundled PuTTY tools are pinned and hash-verified at build time, and their
folder is appended to every terminal's `PATH`, so `pscp`, `plink` and `psftp`
work as commands in any QuickTerm shell (for example
`pscp file.txt user@host:/tmp/`). See `THIRD-PARTY-NOTICES.md` for licenses.

Profile environment values are encrypted at rest with Windows DPAPI and can be
decrypted only by the same Windows account. Existing plaintext profile values
are migrated automatically. They are still inherited by every program launched
inside that terminal, so use a dedicated profile when a credential should have
a narrow scope. On POSIX, QuickTerm relies on `0700`/`0600` directory and file
permissions instead of storing an encryption key beside the data.

The same fields are available through Settings → Advanced. A plaintext config
value written manually remains supported and is protected on the next load:

```json
{"name": "project", "cmd": "wsl.exe", "args": [], "cwd": "~/dev/project",
 "env": {}, "keybinding": "ctrl+alt+1", "autostart": false,
 "terminal_type": "wsl", "wsl_distro": "Ubuntu",
 "start_command": "source .venv/bin/activate"}
```

Snippets, custom themes, global and per-workspace logos, the idle-session
timeout, summon hotkey, port, scrollback size, and font live in the same file.
The full validated 64 KB–64 MB in-memory scrollback range is available in the
normal settings UI and applies to live sessions immediately.
Settings shows four featured color themes and groups the full catalog into
Dark, Neon, Soft, Warm, Light, and Custom sections. The expanded dark catalog
includes low-glare, pastel, blue-black, and true-black palettes. Theme previews
update the whole workbench and every open terminal immediately, then revert on
Cancel.
(A local voice-input mode exists behind `uv sync --extra voice` but is parked
until it gets a proper capture overlay.) Named workspaces are saved under the QuickTerm config directory
and can be switched from the sidebar or dashboard. Terminal output is never
written to disk: scrollback exists only in process memory and is released when
the session is removed. The small rotating log under `logs/` accepts only
warnings/errors, redacts common user-local path prefixes, and never contains
transcripts or session IDs; upgrading once removes legacy verbose rotations.
Only the explicit
`QUICKTERM_DEBUG_IO=1` diagnostic mode records raw terminal input/output and may
contain secrets.

## Security and company use

QuickTerm is designed for local workstation use and can fit a company-managed
Windows environment when its documented controls match that company's policy.
It is not a sandbox, an EDR product, or a compliance certification. Terminals
run arbitrary commands with the signed-in user's permissions, so normal OS
controls, least privilege, application allowlisting, patching, and endpoint
monitoring still apply. See [Security and company deployment](docs/SECURITY.md)
for the implemented boundaries, data handling, tracker accuracy, and an IT
review checklist.

## Development

```
uv sync --all-extras --dev
uv run --no-sync python scripts/check.py
uv run --no-sync pyinstaller --noconfirm --clean quickterm.spec
uv run --no-sync python scripts/smoke_packaged.py
uv build --no-sources
```

Architecture: one backend process owns all PTYs (`pty_session.py` /
`pty_posix.py`, `session_manager.py`); views attach over a binary WebSocket
protocol (`server.py`); the packaged frontend is plain ES modules plus vendored
xterm.js with no Node build step. The pane protocol has headless Node tests, and
the dashboard/settings sections live in focused modules rather than one UI god
class. See `docs/SESSION_MODEL.md` for the tmux-inspired ownership model and
explicit future scope, and `docs/CONTRACTS.md` for binding interfaces.

Run the manual-CI command above before merging changes. Release artifacts
are built locally: the Windows application folder, per-user installer,
portable archive, Python distributions, generated notes, and SHA-256 checksums.
After every frozen build, the packaged smoke command starts an isolated copy,
spawns a real ConPTY, verifies authenticated attach/replay/live I/O and exit,
and exercises the dynamically imported open/update routes.
Release history is consolidated in `CHANGELOG.md` and on GitHub Releases.

MIT licensed.
