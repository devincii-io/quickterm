# QuickTerm

A local terminal workspace: split panes, named workspaces, persistent
sessions, quick-launch profiles, and WSL integration. Everything stays on
your computer. No Electron, accounts, or telemetry.

## Install

### Windows application

Download `QuickTerm-v*-Setup.exe` from the
[latest release](https://github.com/devincii-io/quickterm/releases/latest) and
run it. The per-user installer adds Start Menu and Desktop shortcuts,
supports in-place upgrades, and includes an uninstaller. It does not require
administrator access. A portable `.zip` is also available.

Windows may show a SmartScreen warning because current release binaries are
unsigned. A trusted Authenticode signature identifies the publisher and lets
reputation carry between releases. Even then a new signing identity can warn
until that reputation builds. Microsoft Store distribution is the most
reliable no-warning path. See
[Signing releases](docs/SECURITY.md#smartscreen-and-release-signing).

The installed build uses a normal application folder instead of a
self-extracting one-file executable. One QuickTerm process and viewer own the
runtime; repeated launches hand work to that process instead of duplicating the
Python/WebView runtime in memory. The frozen server also drops Uvicorn's unused
reloaders and alternative protocol parsers.

QuickTerm opens as its own native desktop window. The installer adds an
optional **Open QuickTerm here** entry to the right-click menu, both on a folder
and inside one. It opens a terminal in that directory. When a new
version is published, the app shows a small **Update** pill; Settings → About
has the details and a one-click, checksum-verified install. On first run,
the setup tour opens the terminal and connection manager. Detected shells
populate its setup forms; only saved configurations appear under **+**.
Choose local PowerShell, Command Prompt, WSL, Git Bash, Nushell, another shell,
Claude Code, Codex, or a remote connection. The palette offers to install missing
PowerShell 7: winget runs in a new terminal, where you answer its prompts
yourself; without winget, the download page opens. The shield beside **+** starts the
selected terminal in a separate UAC-approved window. Both the
window and the session are labeled `Administrator`.

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
ownership. Explorer **Open QuickTerm here** queues that folder to the running
viewer over the authenticated local API, which opens a new scratch view with a
terminal in that folder. You can then save or move it deliberately.

**A workspace is a folder.** Give a workspace the directory you work in and
every terminal it opens starts there, so switching workspace switches project.
Set or change the folder and logo from Dashboard's workspace Settings editor.
Browse uses the in-app folder browser, with a native picker also available.
Terminal profiles carry no folder of their own, so one "Claude Code" or
"PowerShell" profile is usable in every project and none of them can point
somewhere you cannot see. A folder that has been moved or deleted is reported
in the Dashboard and sidebar rather than silently failing the next terminal.

The sidebar is the whole interface: there is no status bar and no header on
a lone pane. `Alt+Shift+S` cycles it through full, a 30 px rail of state dots,
and hidden; hidden leaves a small **+** over the terminal's left edge. The
sidebar is one list in a fixed order: every saved workspace alphabetically,
empty ones included, then scratch views, then **Unassigned**, each with its
terminals sorted by name. State never reorders it; a terminal that needs you
gets a chip instead. The active workspace has a second line with its folder,
the save dot and two buttons that open the focused terminal's folder in
Explorer or VS Code (`Alt+Shift+E` / `Alt+Shift+C`). A named workspace
autosaves its exact split arrangement and live session IDs for reattachment
with in-memory scrollback, for as long as those processes are alive. If a
saved process is gone, QuickTerm restores an explicitly unavailable pane and
never starts a replacement shell under the old identity. Claude Code and Codex
profiles also offer explicit **Continue latest** and **Choose session**
recovery actions.

Every workspace opens as its own view in the window, and there is no main
workspace. Click a workspace in the sidebar, use **open workspace** in
`Alt+K`, or the **+** beside the Workspaces label for a new scratch view. A
workspace that is already open gets the focus; otherwise the new view takes
half of the active view, cut along its longer side, the way a tiling window
manager places a window, and there is no limit on how many you open. Every
view has its own colour, terminal splits and autosave, and one sidebar serves
all views of a native window. Drag a view's header onto another view to dock
it on that side or swap the two, drag a divider (or use its arrow keys) to
resize, **zoom** to see one view alone, and **close** (on the view, or
**Close view** on the workspace in the sidebar) to save that workspace and
leave its terminals running. Closing the last view leaves an empty area with
a **New scratch** button. The arrangement of named workspaces is restored
after a restart; disposable scratch views are not. A workspace's menu in the
sidebar offers Open in new window, Workspace settings and Delete workspace.

`Alt+N` places a new terminal the same way: it takes half of the focused pane
along its longer side, so repeated presses spiral inward instead of stacking
slivers, and every split, close and rebalance slides into place.

When the focused terminal has `cd`'d somewhere outside the workspace's
folder, the sidebar offers **workspace here: <folder>**. One click makes that
folder a workspace named after it, moves the terminal into it and opens its
view; if the folder already is a workspace's root the offer reads
**open <name>** and takes the terminal along instead.

**Scratch** is a temporary workspace. It opens in a throwaway folder under your
system temp directory and autosaves during the current run. Each additional
scratch view gets its own identity and layout; opening one never replaces
another view. Closing a scratch view keeps its busy terminals and the ones you
typed into running; idle untouched shells are left to the idle cleanup.
Quitting the application ends the backend and discards temporary layouts. QuickTerm does
not delete the scratch folder's contents. Naming a scratch in the Dashboard offers the folder the focused terminal
is actually in, so a shell you `cd`'d into your project suggests that project,
never the temp folder.

Closing the window does not end your work. If any terminal you have typed into
is still open, or any shell still has a running child process (an SSH session, a
dev server), QuickTerm hides to the system tray and keeps everything alive.
Click the tray icon or press the summon hotkey to bring it back, or
right-click → **Quit** to exit for real. If only untouched shells are open,
closing the window quits and frees the memory. Terminal I/O is streamed with
coalesced reads and writes end to end, so a noisy build renders fast without
making typing lag.

URLs and file paths printed in a terminal are clickable. Hold **Ctrl** and
click to open them with your default browser or file handler; executables are
revealed in Explorer, never launched. **×** / `Alt+D` is a true detach and
keeps the terminal process alive. The separate **Kill** button and `Alt+W` are
the destructive path, and always ask before killing the whole process tree.
Every live terminal in the sidebar has **Detach** and **Kill** on hover or
keyboard focus too. Kill asks in a small box beside the row: after a click,
Cancel has the focus; after the `Delete` key, Kill has it and Enter confirms.
A failed kill keeps the row and offers Retry.
Files and images can also be dropped onto a pane. QuickTerm inserts shell-safe,
quoted paths without pressing Enter. Its native WebView bridge supplies the
real Explorer path; WSL paths are translated to `/mnt/<drive>/...`, while
remote SSH/SFTP panes refuse a misleading local path. Standard Chromium can
withhold the original desktop path outside that native bridge. In that case
QuickTerm suggests Copy as path plus native `Ctrl+V` instead of pasting a
misleading filename.

## Command line

The same `quickterm` command drives the running app:

```
quickterm ls [--json]                  list terminals: id, name, workspace, state, folder
quickterm new [--profile NAME] [--cwd DIR] [--workspace NAME]
quickterm open WORKSPACE               open or focus that workspace's view
quickterm send SESSION TEXT... [--enter]
quickterm --version
```

`new` opens a terminal in the running app, or starts the app with it. Without
`--cwd` a profile starts in the workspace's folder and a plain `new` starts in
the folder you typed it in. `send` types into the session whose id starts with
SESSION or whose name is exactly SESSION; `--enter` presses Enter after it.
Every verb takes `--port N` when the app does not run on the configured port.

Exit codes: 0 done, 1 usage error or a SESSION that matches no session or
several (the candidates are listed), 2 QuickTerm is not running, or something
else answers on its port, 3 the app refused the request or it failed after
QuickTerm answered (the reason is printed). `quickterm new` with no app
running starts QuickTerm in the background and returns once it is up. The installed `QuickTerm.exe` is
a windowed program, so `cmd` and PowerShell do not wait for it: use
`start /wait quickterm ls` in cmd, or pipe it (`quickterm ls | Out-Host`) in
PowerShell, to read the output and the exit code in order.

## Keys

QuickTerm uses familiar Windows copy, paste, and text-size conventions while
leaving shell and TUI bindings intact. `Ctrl+C` copies when text is selected
and otherwise reaches the terminal as interrupt. `Ctrl+P`, `Alt+V` (Claude Code
image paste), `Alt+P` (Claude Code model switch), `Alt+M`/`Alt+T`/`Alt+O`
(Claude modes), `Alt+H` (PSReadLine help), `Alt+0..9`/`Alt+-` (readline digit
arguments) and the `Alt+B`/`F` word motions all pass through untouched.

| Key | Action |
|---|---|
| `Alt+K` | Command palette (profiles, actions, snippets, workspaces, terminals, settings, file viewer); `>` `@` `#` `!` narrow it to actions, workspaces and terminals, settings and configs, or snippets |
| `Alt+G` / `Alt+S` / `Alt+I` | Open or close the Dashboard / Settings / Help panel |
| `Alt+N` | Open a new default terminal in half of the focused pane, cut along its longer side |
| `Alt+Shift+Left` / `Alt+Shift+Up` | Cycle previous / next profile used by new terminals |
| `Alt+Shift+Right` / `Alt+Shift+Down` | Split pane to the right / below (`H` / `V` aliases) |
| `Alt+Shift+S` | Sidebar: full, rail, hidden |
| `Alt+Shift+E` / `Alt+Shift+C` | Open the focused terminal's folder in Explorer / VS Code |
| `Alt+Arrows` | Move focus between panes |
| `Alt+Z` | Zoom focused pane |
| `Alt+D` | Detach pane; the terminal keeps running in the background |
| `Alt+W` | Kill the focused terminal process tree and close its pane (always asks first) |
| `Ctrl+Plus` / `Ctrl+Minus` / `Ctrl+0` | Grow / shrink / reset terminal text size |
| `Ctrl+C` / `Ctrl+V` | Copy selection (or interrupt when none) / paste in a terminal |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Compatible copy / paste aliases |
| `Ctrl+Click` | Open a URL or file path printed in the terminal |
| Drop file/image | Paste its quoted local path without submitting it |
| Drag a pane header | Move the pane: an edge of another pane docks it there, the middle swaps the two |
| `Ctrl+Alt+`` ` | Summon/hide the window, or slide the overlay in and out (global, configurable, also restores from tray) |
| `/` in Settings | Search every setting, terminal and snippet |
| `Delete` / `F2` on a sidebar row | Kill the terminal (asks first, Kill focused) / rename it |
| `Shift+F10` on a sidebar row | Row menu: Open, Move to the active workspace, Detach, Rename, Kill |

Split actions open the currently selected terminal profile in the focused
pane's best-known directory. QuickTerm tracks that directory from OSC 7 and
OSC 9;9 shell-integration signals and otherwise falls back to the pane's launch
folder. It never scrapes prompt text. Sidebar **Open** and `Alt+N` open in the
workspace folder instead. Claude Code and Codex splits stay bound to their
workspace project, and a split of an agent-manager pane starts a normal
conversation; use Alt+K → **split agent view** for an explicit project-scoped
manager.

`Ctrl+±` changes the focused pane's text size for this session and `Ctrl+0`
puts it back; the saved default for every pane is in Settings. Split dividers
are wide, keyboard-adjustable, and can be double-clicked to balance them.

Per-terminal global hotkeys, such as `Ctrl+Alt+1` to launch Claude Code, are
set in the terminal's editor or in **Settings → Shortcuts**, which also lists
the summon key and the in-app keys. A shortcut field records the keys you
press; while it records, QuickTerm's global hotkeys pause, so a key it
already uses is recorded instead of fired. A new global shortcut needs Ctrl,
Alt or Win, and QuickTerm warns when it would take an Alt key from your shell
or agent. A changed shortcut works as soon as you save; a key another program
holds is reported beside the field.

Every live terminal appears in the sidebar, grouped by the workspace that owns
it, as a state dot and a name; double-click a row (or `F2`) to rename it.
Clicking a row focuses the terminal where it is shown, opens its workspace when
that is closed, or moves an **Unassigned** terminal into the active view.
Dashboard statistics show **this workspace** and **all live** separately;
unowned sessions are labelled **Unassigned** instead of looking like a hidden
workspace. Detailed detached sessions stay under **Dashboard → Detached
sessions** with **Attach** and **Kill** controls. In `Alt+K`, **go to
terminal** reaches any live terminal and **kill terminal…** lists them for a
confirmed kill from the keyboard. Taking a terminal from another workspace into
this view is the explicit **move terminal here…** action. Scratch follows the
same ownership rule during the current run, but Scratch and all of its sessions
are discarded when QuickTerm quits.

**Dashboard → Terminal usage** shows the host process tree's current working
set, sampled CPU, process count, and uptime for every live terminal. The
sidebar uses a cheap liveness query and do not continuously take an OS
process snapshot. WSL is labelled **host side only**, because Linux processes
inside the WSL VM cannot be attributed reliably to one Windows terminal. Output
produced after a terminal is detached is marked **New output** with its byte
count and age, then acknowledged automatically when you attach it. Settings can
cap live terminals from 1 to 100; `0` keeps the default unlimited behavior.
Reaching the cap blocks new spawns and never kills an existing terminal. The
dashboard also has a confirmed **Kill all terminals** action for intentionally
stopping every live session. It removes only terminals the backend verifies as
stopped; any failure stays visible and is reported for retry. Kill
confirmations stay visible beside their trigger and are clamped inside the
window, including for sessions near the bottom of a scrolled dashboard.

## Configuration

`%APPDATA%\quickterm\config.json` is created with defaults on first run.
Manage saved configurations in **Settings → Terminals**: a filterable list
with the editor beside it, where rows mark problems and unsaved changes.
**Add** offers Claude Code, Codex, PowerShell 7, Windows PowerShell, Command
Prompt, WSL, Git Bash, Bash, Zsh, Fish, Nushell, or any custom executable.
Typed forms also cover SSH/SFTP through OpenSSH or the bundled PuTTY tools,
Telnet, serial consoles, Docker, Podman, Kubernetes, Remote Desktop and VNC.
Remote desktops open external client windows rather than terminal panes.
Settings has the tabs General, Window, Shortcuts, Terminals, Snippets,
Advanced and About, a search box above them, and one **Save** (also
`Ctrl+S`) that stores every change. A profile sets a command to run inside the shell,
environment variables, a global shortcut and autostart. It has no folder: the
workspace you launch it from supplies that, which is what makes one profile
usable in every project. Set the workspace folder in the Dashboard. With no workspace folder at all, Windows shells
start in the Windows user home and WSL in the distro's Linux home.

Claude Code and Codex are agent profile types rather than name conventions.
An agent opens in the folder of the workspace you launch it from, and its
launch mode is **new conversation**, **continue latest**, **choose session**
(the CLI's own picker), the **agent manager**, or for Codex also **fork a
session**. Typed options come from QuickTerm's list for each CLI: model,
permission mode or approval and sandbox, effort, extra folders and more, with
the rarer ones under Advanced. The palette offers every mode of every agent
profile, and lists the workspace folder's recent conversations as **resume
Claude session: <title>** or **resume Codex session: <title>**; a restart of
such a pane resumes the same conversation. If an agent's PTY has died, the
restored pane stays blank and offers both explicit **Continue latest** and
**Choose session** recovery. It never shows cached terminal history or
silently substitutes a new process. When Codex is installed through npm,
QuickTerm starts its native `codex.exe` rather than the `.cmd` shim.

SSH and SFTP profiles take a host, optional port, username and private key,
and run through either Windows' OpenSSH client or the bundled PuTTY tools. New
profiles use OpenSSH when it is installed; profiles from 3.x keep PuTTY.
QuickTerm reads the host aliases in `~/.ssh/config`: **Add** lists them under
**From ~/.ssh/config**, the Host field suggests them, and picking one shows
the user, port, key and ProxyJump that OpenSSH resolves for it. **Fill from
~/.ssh/config** copies those values into the form. OpenSSH profiles can set a
ProxyJump and need an OpenSSH key; PuTTY needs a `.ppk` key. Passphrases are
never stored; you are prompted in the terminal.
The bundled PuTTY tools are pinned and hash-verified at build time, and their
folder is appended to every terminal's `PATH`, so `pscp`, `plink` and `psftp`
work as commands in any QuickTerm shell (for example
`pscp file.txt user@host:/tmp/`). See `THIRD-PARTY-NOTICES.md` for licenses.

Profile environment values are encrypted at rest with Windows DPAPI and can be
decrypted only by the same Windows account. Existing plaintext profile values
are migrated automatically. Every program launched inside that terminal still
inherits them, so use a dedicated profile when a credential should have a
narrow scope. On POSIX, QuickTerm relies on `0700`/`0600` directory and file
permissions instead of storing an encryption key beside the data.

Configuration fields have controls in Settings; no JSON editing is required.
Server binding and stored voice preferences are under Advanced. Voice capture
is currently unavailable. Arguments are entered one per line and environment
variables as name/value rows. Profiles have no starting-folder field.

**Settings → Window** sets the default window size, from presets, custom
values or **Use this window's size**. QuickTerm remembers the last size and
position in `window_state.json` unless you turn that off, and restores them
only when they still fit on a monitor. The same tab turns on the drop-down
overlay: the summon key then slides the window in from the top or bottom edge
of the monitor under the cursor (or the primary monitor), at the width and
height you set, and slides it out again. It can stay on top and hide when
another program takes the focus. Changes to the window size, the overlay and
every shortcut apply without a restart; only host and port need one.

Snippets, custom themes, the app logo, idle-session timeout, summon hotkey,
port, scrollback size, and font defaults live in the app configuration.
Workspace folders, logos, layouts and terminal ownership live in workspace
files. Sidebar mode, width, selected launch configuration and focus belong to
the native window. Text zoom is temporary and belongs to a pane.
The full validated 64 KB to 64 MB in-memory scrollback range is available in
the normal settings UI and applies to live sessions immediately. Settings shows
four featured color themes and groups the full catalog into Dark, Neon, Soft,
Warm, Light, and Custom sections. The expanded dark catalog includes low-glare,
pastel, blue-black, and true-black palettes. Theme previews update the whole
window and its terminals immediately, then revert on Cancel. Saving updates
other native windows. Settings sends only changed fields and reports conflicting
edits from another window instead of silently overwriting them. Changing an
unrelated setting preserves pane-local text zoom.

Named workspaces are saved under the QuickTerm config directory and can be
opened from the sidebar, the palette or the dashboard. Terminal output is never written to
disk: scrollback exists only in process memory and is released when the session
is removed. The small rotating log under `logs/` accepts only warnings and
errors, redacts common user-local path prefixes, and never contains transcripts
or session IDs. Upgrading once removes legacy verbose rotations. Only the
explicit `QUICKTERM_DEBUG_IO=1` diagnostic mode records raw terminal input and
output, and it may contain secrets.

## Security and company use

QuickTerm is designed for local workstation use and can fit a company-managed
Windows environment when its documented controls match that company's policy.
It is not a sandbox, an EDR product, or a compliance certification. Terminals
run arbitrary commands with the signed-in user's permissions, so normal OS
controls still apply: least privilege, application allowlisting, patching, and
endpoint monitoring. See [Security and company deployment](docs/SECURITY.md)
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
xterm.js with no Node build step. The pane protocol has headless Node tests,
and the dashboard and settings sections live in focused modules rather than one
UI god class. See `docs/SESSION_MODEL.md` for the tmux-inspired ownership model
and planned scope, and `docs/CONTRACTS.md` for the binding interfaces.

Run the manual-CI command above before merging changes. Release artifacts are
built locally: the Windows application folder, per-user installer, portable
archive, Python distributions, generated notes, and SHA-256 checksums. After
every frozen build, the packaged smoke command starts an isolated copy, spawns
a real ConPTY, verifies authenticated attach, replay, live I/O and exit, and
exercises the dynamically imported open and update routes. Release history is
consolidated in `CHANGELOG.md` and on GitHub Releases.

MIT licensed.
