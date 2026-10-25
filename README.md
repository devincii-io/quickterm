# QuickTerm

A terminal workspace for Windows: one sidebar, workspaces that are folders on
this PC, in WSL or on an SSH host, terminals that keep running when the window
closes, and Claude Code and Codex with their state in view. Everything stays
on your computer. No Electron, accounts or telemetry.

## Install

### Windows application

Download `QuickTerm-v*-Setup.exe` from the
[latest release](https://github.com/devincii-io/quickterm/releases/latest) and
run it. The per-user installer adds Start Menu and Desktop shortcuts, upgrades
in place and includes an uninstaller. It needs no administrator rights. A
portable `.zip` is also published.

Windows may show a SmartScreen warning because the release binaries are
unsigned. See
[Signing releases](docs/SECURITY.md#smartscreen-and-release-signing).

The installer can add **Open QuickTerm here** to Explorer's right-click menu,
on a folder and inside one. New versions download in the background; a card
in the sidebar offers to install and restart.

### From source

Requires Python 3.12+ and [uv](https://docs.astral.sh/uv/). Windows 10 1809+
uses ConPTY; Linux uses the POSIX PTY backend.

```
uv sync
uv run quickterm
```

The backend listens on `127.0.0.1:8620`. Starting QuickTerm again brings the
running window back instead of starting a second copy.

## Workspaces

A workspace is a folder and its terminals. The window shows one workspace at a
time; the sidebar lists them all, and the others keep running behind the one
on screen. Each workspace is a card in the sidebar with its terminals inside.

**New workspace…** in the Workspaces **+** menu (or the palette, `Alt+K`)
asks where:

- **This PC**: a Windows folder, chosen in the folder browser.
- **WSL**: a folder in one of your WSL distributions, browsed through
  `\\wsl.localhost`. Its terminals open the distribution's shell in that
  folder.
- **SSH host**: a host from `~/.ssh/config`, or any `user@host` you type,
  and a folder there. Its terminals are SSH sessions that start in that
  folder. Port, key and jump host come from `~/.ssh/config`.

The workspace is named after its folder. Files, changes and the pull request
in the right panel, the branch in the sidebar and the board work the same at
every location.

**Scratch** is a throwaway workspace in a temp folder. `cd` into a project in
a scratch terminal and the sidebar offers **make <folder> a workspace**,
which moves the terminal into the new workspace. PowerShell, Command Prompt
and Git Bash report their folder at each prompt, which is how QuickTerm
follows a `cd`.

A workspace remembers its split layout and its terminals. Closing the window
leaves the terminals running in the background; QuickTerm stays in the tray
while any of them holds work.

### Workspace setup

**Workspace settings** in a workspace's **⋮** menu holds its setup:

- **Environment**: variables every terminal of the workspace gets. Values
  are encrypted on disk and masked until you click into them. In an SSH
  workspace they are set on the host by the command ssh runs, where other
  users of that machine can see them.
- **Start with**: up to eight terminals the workspace starts with, in
  order, each in its own pane: a shell, optionally running one command
  first (`npm run dev`), Claude Code or Codex with their own options, each
  with its own extra variables.

A workspace that opens with nothing running starts its Start with list.
**Run setup** in the **⋮** menu, the palette (`run workspace setup`) and
the settings sheet (**Run setup now**) starts it again next to what is
open. The New workspace dialog fills the list from its **Start with**
toggles: Shell, Claude Code, Codex.

A shell in the list can use any shell installed on this PC (PowerShell,
Command Prompt, Git Bash, a WSL distribution) or the one from Settings >
General. In a WSL or SSH workspace every shell is that location's own.

Variables apply in this order, later wins: Settings > Agents, the
workspace, the terminal's own. Settings > Agents variables are not sent to
an SSH host.

## Terminals and agents

The **+** at the top of the sidebar starts a terminal in your shell
(PowerShell unless Settings > General names another: Command Prompt, Git Bash
or a WSL distribution). Its arrow starts another shell, Claude Code or Codex,
and **+** remembers that pick. In a WSL or SSH workspace it starts that
location's shell. There are no saved terminal configurations: the shell is a
setting and the agents are settings.

Claude Code and Codex run inside the shell, so leaving the agent leaves you at
a prompt in the same folder. Settings > Agents holds their options (model,
permissions, effort and more, read from the installed CLI). The sidebar shows
each agent's state: working, waiting for you, done or failed. `Alt+J` jumps
to the next terminal that needs you. A `claude` or `codex` you type yourself
in a QuickTerm PowerShell reports its state the same way. The sidebar footer
shows Claude and Codex usage and the memory your terminals use.

Splits place themselves: a new pane takes half of the focused one along its
longer side. `×` on a pane detaches it and the terminal keeps running; kill
is a separate action that always asks first.

## Right panel and board

`Alt+Shift+E` opens the right panel for the shown workspace: its files (click
to read, Alt+click to paste the path), its git changes with stage, commit,
push and pull, and the branch's pull request with its checks.

`Alt+G` opens the workspace board. It sorts itself: each workspace is a
card in the first column that applies, and moves on its own when that
changes.

| Column | Means |
|---|---|
| Needs you | An agent asks, or a terminal rang |
| Working | An agent is busy |
| In review | The branch has an open pull request |
| Changes | Uncommitted or unpushed work |
| Done | The pull request was merged |
| Idle | Nothing running, nothing to ship |

Each card says why it is where it is ("3 files changed · 2 commits not
pushed", "PR #12 open · checks passing") and lists its terminals; click it
to show the workspace. The Agents tab lists every agent session.

## Command line

The same `quickterm` command drives the running app:

```
quickterm ls [--json]                         list terminals: id, name, workspace, state, folder
quickterm new [claude-code|codex] [--cwd DIR] [--workspace NAME]
quickterm open WORKSPACE                      show that workspace
quickterm send SESSION TEXT... [--enter]
quickterm --version
```

`new` opens a terminal in the running app, or starts the app with it. `send`
types into the session whose id starts with SESSION or whose name is exactly
SESSION. Every verb takes `--port N`.

Exit codes: 0 done, 1 usage error or an ambiguous SESSION, 2 QuickTerm is not
running, 3 the app refused the request. The installed `QuickTerm.exe` is a
windowed program, so `cmd` and PowerShell do not wait for it: use
`start /wait quickterm ls` in cmd, or `quickterm ls | Out-Host` in PowerShell.

## Keys

QuickTerm takes only Alt combinations your shell does not use, plus a few
Ctrl keys. `Ctrl+C` copies a selection and otherwise interrupts; `Alt+V`,
`Alt+P`, `Alt+B`/`Alt+F`, `Alt+0..9` and other shell and agent keys pass
through.

| Key | Action |
|---|---|
| `Alt+K` | Command palette: actions, workspaces, terminals, settings, snippets |
| `Alt+N` | New terminal (what **+** starts) |
| `Alt+Shift+Right` / `Alt+Shift+Down` | Split right / below |
| `Alt+Shift+Left` / `Alt+Shift+Up` | Open the new-terminal menu |
| `Alt+Arrows` | Move focus between panes |
| `Alt+Z` | Zoom the focused pane |
| `Alt+D` | Detach the pane; the terminal keeps running |
| `Alt+W` | Kill the focused terminal (asks first; a second `Alt+W` confirms) |
| `Alt+J` | Next terminal that needs you |
| `Alt+G` / `Alt+S` / `Alt+I` | Workspace board / Settings / Help |
| `Alt+Shift+S` | Sidebar: full, rail, hidden |
| `Alt+Shift+E` | Right panel |
| `Alt+Shift+C` | Open the focused terminal's folder in VS Code |
| `Ctrl+Shift+1..9` | Show the nth workspace in the sidebar |
| `Alt+PageDown` / `Alt+PageUp` | Next / previous open workspace |
| `Ctrl+Tab` | Recent terminals (release Ctrl to choose) |
| `Ctrl+Shift+F` | Find in the terminal |
| `Ctrl+Plus` / `Ctrl+Minus` / `Ctrl+0` | Terminal text size |
| `Ctrl+Alt+`` ` | Summon or hide the window (global, configurable) |

## Configuration

`%APPDATA%\quickterm\config.json` is created on first run; every field has a
control in Settings (General, Window, Shortcuts, Agents, Snippets, Advanced,
About), with a search box (`/`). Workspaces live in the `workspaces` folder
next to it. Settings > Window sets the window size and the drop-down overlay
that the summon key slides in from a screen edge. There are 54 themes plus
a custom one: the theme row in Settings > General, or **color theme…** in
the palette, opens a switcher that previews each theme on the whole window
as you move through it and applies it on Enter or a click. On Windows 11
the title bar follows the theme too.

Terminal output is never written to disk: scrollback lives in memory and goes
with the session. The log under `logs/` keeps only warnings and errors.
`QUICKTERM_DEBUG_IO=1` records raw terminal I/O for debugging and may contain
secrets.

## Security and company use

QuickTerm is built for local workstation use. It is not a sandbox: terminals
run commands with your own permissions. The server binds to `127.0.0.1` and
every request needs a per-install token. See
[Security and company deployment](docs/SECURITY.md).

## Development

```
uv sync --all-extras --dev
uv run --no-sync python scripts/check.py
uv run --no-sync pyinstaller --noconfirm --clean quickterm.spec
uv run --no-sync python scripts/smoke_packaged.py
uv build --no-sources
```

One backend process owns every PTY; windows attach over a WebSocket; the
frontend is plain ES modules with vendored xterm.js and no Node build.
`AGENTS.md` describes the architecture and the rules, `docs/CONTRACTS.md` the
interfaces, `CHANGELOG.md` the release history.

MIT licensed.
