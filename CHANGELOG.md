# Changelog

Release history is also available on the [GitHub Releases page](https://github.com/devincii-io/quickterm/releases).

## QuickTerm 4.7.0

Released 2026-10-25.

- Up to four workspaces side by side. **Ctrl+click** a workspace in the
  sidebar, or **Show side by side** in its **⋮** menu, adds it as a column;
  a plain click on a shown one moves the keyboard there. Columns get a
  one-line header (name, branch, state, `×`) only when there are two or
  more; drag the gap to resize, double-click it for equal widths,
  `Ctrl+Alt+Left` / `Ctrl+Alt+Right` to move between them. The split comes
  back after a reload. `×` takes a workspace out of the split; its
  terminals keep running.
- The files panel is hidden by default and slides over the terminals
  instead of pushing them aside. It shows the active column's workspace
  and hides again when you click or type in a terminal or press Escape; the
  pin keeps it open. The icon rail is gone.

## QuickTerm 4.6.0

Released 2026-10-25.

### Usage limits for every account

- The usage popover lists every Claude Code and Codex account signed in on
  this computer and in running WSL distributions, one block per account
  with its plan, email and where it is signed in. The same account in
  several places is one block.
- Claude's limits are current without a Claude running in QuickTerm:
  QuickTerm asks Anthropic with Claude Code's own sign-in, at most every
  two minutes, and shows model-scoped weekly limits too. The token is not
  stored or refreshed. Settings > Agents > Usage limits turns this off;
  the status line and Claude Code's last `/usage` still answer then.
- Limits belong to the account, so the same account used in WSL or over
  SSH shows once with its current numbers. An account signed in only on an
  SSH host is not shown.
- Status-line reports are kept per place, so a report no longer lands on
  the wrong account.
- The footer shows the account closest to a limit; the open popover
  refreshes every 10 seconds.

### Right panel and workspaces

- New terminals show their prompt about ten times sooner: 0.3 s instead of
  3.4 s for a WSL shell and 0.6 s instead of 5 s for PowerShell, and Claude
  Code and Codex start without the same wait. ConPTY waited for an answer
  to its startup question that the window could not give in time; the
  backend now answers it.
- The Pull request tab says why there is no pull request: no remote, a
  remote that is a folder or on another host (Azure DevOps, GitLab), a
  detached HEAD, or git not answering. It finds GitHub through the branch's
  upstream, `upstream`, the push remote or any GitHub remote, and through
  SSH aliases and `insteadOf` rules.
- Each refresh starts fewer git processes (Pull request 2 instead of up to
  7, Changes 7 instead of up to 12), which matters most over SSH and WSL.
- A slow or failing git keeps the last listing or result on screen with a
  note; folders show a spinner while they load, in the right panel and the
  folder browser. Git reads may take 30 seconds.
- "Run setup" is now a menu row that names what it starts ("Start dev
  server, Claude Code") and only appears when the workspace has a Start
  with list.

## QuickTerm 4.5.0

Released 2026-10-25.

QuickTerm 4.5 makes the workspace the one thing you set up. A workspace
lives on this PC, in WSL or on an SSH host, and can carry its own
environment variables and the terminals it starts with. Saved terminal
configurations are gone. The board sorts workspaces by what is happening
in them, and the window, title bar included, follows one of 54 themes.

### Workspaces at a location

- **New workspace…** (the Workspaces "+" menu or the palette) asks where:
  This PC, a WSL distribution, or an SSH host from `~/.ssh/config` or one
  you type (`user@host`, `ssh://user@host:port`). Port, key and jump host
  come from `~/.ssh/config`. Folders on this PC and in WSL are chosen in the
  folder browser; a WSL folder under `\\wsl.localhost` starts a stopped
  distribution once. WSL and SSH folders are checked before the workspace
  is saved.
- Terminals of a WSL workspace open the distribution's shell in its folder,
  and Claude Code and Codex there report their state through Windows
  `curl.exe`. Files, changes, the pull request, the branch and the board
  work the same in WSL as over SSH.
- Explorer, VS Code and "make this folder a workspace" stay with folders on
  this PC. An administrator terminal is refused in a WSL or SSH workspace.

### No saved terminals

- Saved terminal profiles are removed: connection types (SSH, SFTP,
  Telnet, serial, Docker, Podman, Kubernetes, RDP, VNC, custom commands),
  per-terminal shortcuts and autostart, and the Terminals settings tab.
  The shell is a setting and Claude Code and Codex are settings, as before.
- Settings tabs are General, Window, Shortcuts, Agents, Snippets, Advanced
  and About.
- The bundled PuTTY tools are no longer shipped.
- A 4.4 config is migrated once: it is copied to `config.pre-4.5.json`, a
  workspace on an SSH profile now connects to that profile's destination,
  one on a WSL profile opens in that distribution, one on any other saved
  terminal opens on this PC, and a notice in the window says what could
  not be carried (a private key, ProxyJump, extra arguments, environment
  variables, a start command, a bad port).
- `quickterm new --profile` is removed; `quickterm new claude-code|codex`
  stays. `GET /api/profiles` and the connection route are gone; `GET
  /api/locations` lists where a workspace can live.

### Workspace setup

- Workspace settings (the workspace's "⋮" menu) hold environment variables
  that every terminal of the workspace gets. Values are encrypted at rest
  and masked until you focus them. On an SSH host they are exported by the
  remote command, and the settings say that other users of that host can
  see them.
- **Start with** lists up to eight terminals: a shell with an optional
  one-line command, Claude Code or Codex with their own options, each with
  its own variables. A workspace that opens with nothing running starts
  them, each in its own pane. **Run setup** (the "⋮" menu, the palette and
  the settings sheet) starts them again next to what is open.
- A shell in Start with can use any shell installed on this PC
  (PowerShell, Command Prompt, Git Bash, a WSL distribution) or the one from
  Settings. Restarting such a terminal repeats its shell and command.
- The new-workspace dialog has Start with toggles: Shell, Claude Code and
  Codex (Shell on by default).
- A workspace whose terminals are all gone and that has no Start with list
  still comes back with its saved panes and their Restart and Resume
  offers.
- Variables apply in this order, later wins: Settings > Agents, the
  workspace, the terminal's own, then QuickTerm's own.

### The board sorts itself

- Every workspace sits in one of six columns, by what holds first: Needs
  you, Working, In review, Changes, Done, Idle. The card says why ("3 files
  changed · 2 commits not pushed", "PR #12 open · checks passing") and
  moves by itself when that changes.
- Dragging cards, Alt+Left/Right moves and the stored `board.json` are
  gone; the old file is removed once.

### Themes

- 54 themes, 33 of them new. Settings > General and the
  palette's "color theme…" open a switcher that stays open and previews
  the whole window as you move through it; Enter or a click applies,
  Escape goes back.
- Selected rows wear each theme's own selection colour, and the pane around
  the terminal and its scrollbar take the terminal's colours.
- On Windows 11 the title bar and window border follow the theme.

### Fixes

- Git calls over SSH with environment options no longer fail with exit
  127: the `env` options now come before the variable assignments.
- A terminal's own variables now add to the agent's variables from
  Settings instead of replacing them.
- Claude Code and Codex in WSL now get the variables from Settings >
  Agents (except `PATH`).
- Background folder, git and board checks no longer start a stopped WSL
  distribution.
- A dropped file path is mapped into WSL in a WSL workspace and refused in
  an SSH workspace, whatever shell Settings names.
- The window content no longer slides sideways when focus reaches the
  hidden right panel.

## QuickTerm 4.4.0

Released 2026-10-25.

QuickTerm 4.4 makes the sidebar easier to use. You can make a workspace
from any folder, the new-terminal button remembers what you picked, and
there are fewer buttons. Each workspace is a card. PowerShell, Command
Prompt and Git Bash tell QuickTerm which folder they are in, and a
`claude` or `codex` you type yourself shows its state and usage like one
QuickTerm started.

### Workspaces

- The Workspaces "+" menu has **New workspace…**. Choose a folder and the
  workspace is created with the folder's name and opens with a terminal
  there. Choosing a folder that already belongs to a workspace opens that
  workspace. The palette (Alt+K) has "new workspace…" too.
- `cd` into a project in a scratch terminal and the sidebar offers to make
  that folder a workspace, taking the terminal along. The offer is also the
  first row of the "+" menu. A name that is already taken gets a number
  ("acme 2") instead of an error.
- Each workspace is a card around its name and its terminals. The one on
  screen is raised and edged in the accent colour.
- Two terminals with the same name in one workspace read "PowerShell" and
  "PowerShell 2", numbered in the order they were started.

### New terminals

- The "+" at the top starts what you picked last from its arrow menu:
  another shell, Claude Code, Codex or a saved terminal. Alt+N does the
  same. Until you pick something it starts your shell from Settings.
- That menu also holds **As administrator** and **Terminal settings…**, so
  the row is one button with an arrow.

### Fewer buttons

- Find and the view menu beside "Workspaces" appear when you point at the
  header; only "+" is always shown.
- Explorer and VS Code moved from a workspace's hover buttons into its "⋮"
  menu, where they no longer cover the folder name.
- The footer's new-window icon is gone. "Open in new window…" is in the
  Workspaces "+" menu and the palette.
- The first-start tour describes one workspace at a time and ends in your
  terminal.

### Shells and agents

- PowerShell, Command Prompt and Git Bash report their folder at every
  prompt (OSC 9;9), so the sidebar, the new-terminal folder and "workspace
  here" follow a `cd`. Your profile still loads, and your own prompt
  function still draws the prompt.
- In PowerShell, a `claude` or `codex` you type yourself gets QuickTerm's
  hooks: the sidebar shows its state, and Claude's usage appears in the
  footer next to Codex's. Subcommands such as `claude mcp` and your own
  `--settings` pass through untouched, and a `claude` function from your
  profile stays yours.
- Claude's last usage numbers are kept in `claude-usage.json` in the
  QuickTerm settings folder, so the footer shows them right after a
  restart.
- Under Constrained Language Mode (AppLocker, WDAC) PowerShell starts
  without an error; QuickTerm leaves its integration out there.

### Fixes

- The right panel refuses a path through a folder link that Windows will
  not follow instead of failing with an error.
- Creating a workspace stops with a message when the workspace list
  cannot be read, instead of risking overwriting one of the same name.

## QuickTerm 4.3.0

Released 2026-10-25.

QuickTerm 4.3 is simpler to look at and does more around your agents. The
window shows one workspace at a time, every terminal starts in your shell
(PowerShell unless you choose another), and Claude Code and Codex run
inside it. A workspace can live on an SSH host. A right panel shows the
workspace's files, changes and pull request, the board tracks workspaces
and agents, and updates download in the background.

### One workspace at a time

- The window shows one workspace, the one you clicked in the sidebar, at
  full size. Workspaces are no longer tiled side by side: no view headers,
  no coloured frames, no maximize or close buttons on a view, no dividers,
  no dragging views around.
- The other open workspaces stay open behind it with their terminals
  running, and come back instantly when you click them. The shown one is
  highlighted in the sidebar.
- Close a workspace with the x on its sidebar row or from the palette.
  Closing the one on screen shows the one you looked at before it.
- The palette has **next workspace** and **previous workspace**, in sidebar
  order.
- Each window has one scratch workspace, called `scratch`. Explorer's "Open
  QuickTerm here" opens a terminal in it instead of a new scratch view.
- The open workspaces and the one on screen come back after a restart. The
  first start after the update brings back the workspaces you had tiled.

### One shell, and agents inside it

- Every new terminal starts in one shell, PowerShell unless you pick another
  in Settings > General > Shell: Command Prompt, Git Bash or a WSL
  distribution. PowerShell 7 is used when it is installed.
- Claude Code and Codex run inside that shell. When the agent exits, the
  terminal stays open at the shell prompt in the same folder instead of
  closing. The agent's state in the sidebar clears when it exits (in
  PowerShell, Command Prompt and Git Bash; WSL reports none, see below).
  Codex's hooks work in Windows PowerShell 5.1 and Command Prompt too.
- The "+" button starts the shell. Its menu lists every installed shell,
  then Claude Code and Codex, then your saved terminals, then Terminal
  settings. Each row starts its terminal at once. Alt+Shift+Left and
  Alt+Shift+Up open this menu. The palette lists the same entries.
- Claude Code and Codex are now settings, not saved terminals: Settings >
  Terminals has an Agents section with one row each, showing the command it
  runs and opening into the options. `quickterm new claude-code` and
  `quickterm new codex` start them from the command line.
- Saved terminals are for connections (SSH, SFTP, containers, serial,
  remote desktops), custom commands and shells with a start command.
- Your settings move over once when 4.3 first starts: the first Claude Code
  and the first Codex terminal become the agent settings. A shell that only
  started an agent (such as `codex --yolo`) becomes that agent's settings,
  arguments included, when there is no agent terminal of that kind. Plain
  shell terminals are removed. The previous file is kept as
  `config.pre-4.3.json` next to `config.json`, and a notice on the first
  start names every terminal that was removed or lost a shortcut or its
  autostart. Restoring an older version from the settings history moves it
  over the same way. Workspaces that still name a removed terminal open the
  shell there and say so, and a dead Claude or Codex pane still offers to
  continue or choose a session.
- In WSL the agent runs from the distribution's own PATH and reports no
  state to the sidebar. Its arguments reach bash as they are, so text such
  as `$(...)` in a prompt is never run. Shift+Enter adds a newline while the
  agent runs and is Enter again at the bash prompt once it has exited.

### Workspaces on an SSH host

A workspace can now live on a machine you reach over SSH. Choose "new
workspace on host" in the palette or in the Workspaces "+" menu, pick one of
your SSH terminals that uses OpenSSH and type the folder there; QuickTerm
checks the folder over ssh and saves it even when the check fails. Its row
in the sidebar and its card on the board show `@host`. Every terminal it
opens is an ssh session that starts in that folder, and the "+" menu offers
the shell on the host, Claude Code, Codex and the saved commands that make
sense there. Claude Code and Codex run on the host and still report their
state, through a socket that the session's ssh forwards back. The sidebar
shows the branch, read with git over ssh about once a minute. Key or agent
sign-in works best: each terminal is its own connection, and the background
calls never ask for a password.

### Files, changes and the pull request

- Alt+Shift+E opens a panel on the right of the window for the workspace on
  screen, with three tabs: Files, Changes and Pull request. The palette has
  rows for each, and the left sidebar's footer has a right panel button.
- The panel works like the left sidebar: full, a rail of icons, or hidden.
  The chevron in its footer folds it to the rail, where Changes has a dot
  while the tree has changes and Pull request takes the colour of its
  checks. Both sides look the same and slide in and out the same way. Drag
  the panel's left edge to resize it; QuickTerm remembers the width and the
  mode. Hidden, it takes no space. Opening the focused terminal's folder in
  Explorer, which Alt+Shift+E did before, stays in the palette and on the
  sidebar's folder button.
- Files shows the workspace folder as a tree. Files git ignores are dimmed
  and listed last, new and changed files are tinted and marked. The filter
  field searches file names, or file contents with Contents switched on.
  Click a file to read it over the terminals, with line numbers and syntax
  colours from your theme; Ctrl+F finds text, Ctrl+G goes to a line, Escape
  closes it. Alt+click pastes the file's quoted path into the focused
  terminal; right click has copy path, open in editor and reveal in Explorer.
- Changes shows the branch, what it is measured against, commits ahead and
  behind and the lines added on the branch. One button stages all, commits,
  pushes, publishes the branch or pulls, depending on the state; its menu
  holds commit and push, amend (asking first when the commit is already
  pushed), pull and push. Ctrl+Enter in the message commits. Files are listed
  under Staged, Changes and Committed on branch, each with stage, unstage and
  discard. Click one to see its diff, unified or side by side, with n and p
  for the next and previous change.
- When a commit hook or git fails, its output shows under the button with
  Fix with Claude, which opens Claude Code in the workspace with the error,
  the message and the staged files, told not to bypass hooks, commit or push.
- Pull request shows the branch's pull request through the GitHub CLI: its
  number, state and title, its checks grouped into failing, pending and
  passing, the log tail of a failing check, and a merge button with the
  methods the repository allows. Fix with Claude on failed checks opens
  Claude Code with their names, links and logs. Without the GitHub CLI or
  without a pull request it says so in one line with the command to run.
  Only a pull request from the repository the branch pushes to counts; a
  fork's pull request with the same branch name is not shown.
- Reading files, changes and diffs never runs a program named in the
  repository's git config (fsmonitor, diff textconv, filter drivers).
  Staging, committing, pushing and pulling run the filters as git does. A
  file a filter stores in another form, such as a Git LFS pointer, can
  therefore show as changed once its timestamp changes.
- Files and Changes work for workspaces on an SSH host too; the pull request
  is read with the GitHub CLI on this computer. The scratch view shows its
  own folder; outside a git repository Changes and Pull request say so.
- Starting Claude Code or Codex through the API can now carry a first
  prompt.

### Workspace board

- The dashboard is now a workspace board (Alt+G, the same sidebar button).
  Every saved workspace is a card in one of four columns: Todo, In progress,
  In review and Done. A card shows the repository and branch and the
  workspace's live terminals with their agent state and running subagents.
- Drag a card to another column, or focus it and press Alt+Left or
  Alt+Right. Click a card to show that workspace. The search field next to
  the title filters by name, repository and branch.
- The columns are kept in `board.json` next to the settings, so saving a
  layout never moves a card. A workspace you have not placed sits in In
  progress, and deleting a workspace removes its card.
- What the dashboard did besides that moved: a workspace's folder, logo and
  layout preview are in Workspace settings in its sidebar menu; naming the
  current layout is **save workspace as…** in the palette; stopping every
  terminal is **kill all terminals…** in the palette's kill list. Per
  terminal memory and CPU are in the sidebar footer's resources popover,
  and detached terminals are rows in the sidebar.

### Agents on the board

- The workspace board has a second tab, Agents. Every Claude Code and Codex
  session is one card in Needs you, Working or Done, with what you last
  asked, the start of the last answer, its workspace and branch, and how
  long ago it last did something. Subagents fold under one line. Agents
  that have been quiet for 30 minutes move to Idle, which stays behind a
  slim toggle at the end of the row until you open it. A card whose
  subagent waits for a permission counts as needing you. Click a card to
  show its terminal; the search box filters by anything a card says.
- A pane without a name of your own takes the conversation's title once
  Claude Code or Codex has given it one, and gives it back when the agent
  exits. A name you type still wins.
- A finished turn now gets your attention like a question does, but only
  while QuickTerm is not in front. Settings > General > Notifications and
  sleep sets each of the two to Off, Flash (the taskbar button) or Notify
  (also a Windows notification), with Notify for questions and Flash for
  finished turns at first, and a switch for the notification sound.
- Keep awake, in the same group: while an agent works, QuickTerm keeps
  Windows from going to sleep (the screen may still turn off) and lets it
  sleep again when none does. It can also hold always or never.
- The palette copies the command that resumes an agent's conversation, in
  its folder and for your shell: "copy resume command" for a running agent,
  and Shift+Enter on any "resume ... session" row.

### Agent usage and resources

- The bottom of the full sidebar shows one quiet line: how much of Claude's
  and Codex's usage limits is used, with the time until that window resets,
  and the memory all terminals take. Clicking the agents opens each limit
  window with a bar and its reset time; clicking the memory lists the open
  workspaces and their terminals with CPU and memory, and a click on a
  terminal shows it.
- Claude's numbers come from the status line of Claude Code sessions started
  in QuickTerm. Your own status line keeps showing as before. Codex's
  numbers are read from its session logs on this computer. Nothing is sent
  anywhere and no credentials are read.

### Terminal and keys

- Ctrl+Shift+F finds text in the focused terminal. A small field opens in
  the pane's top right corner and shows the match count, such as 3/17.
  Enter and Shift+Enter jump to the next and previous match, Alt+C toggles
  match case, Alt+R regular expressions, and Escape closes it and returns
  you to the terminal. The palette's search across all terminals is still
  there.
- Ctrl+Tab lists the last eight terminals you used, across workspaces. Keep
  Ctrl down, press Tab or Shift+Tab to move, and let go to show that
  terminal; Escape cancels. One quick Ctrl+Tab flips between the last two.
- Ctrl+Shift+1 to Ctrl+Shift+9 show the first to ninth workspace in the
  sidebar, on any keyboard layout. Alt+PgDn and Alt+PgUp show the next and
  previous open workspace.
- Alt+N and the + open the new terminal in the folder of the terminal you
  are in, as long as that folder is inside the workspace. Elsewhere they
  open in the workspace folder as before.
- New palette rows: **reset terminal** clears the screen and leftover modes
  of the focused terminal without touching the program in it, **copy
  terminal text** copies its whole text (up to 2 MB), and **find in
  terminal** opens the find field.

### Updates in the background

- A new version now downloads in the background as soon as QuickTerm finds
  it. A small card at the bottom right of the window shows the progress,
  and once the installer is downloaded and its checksum matches, it offers
  Install now. Setup then runs with only its progress window, your
  terminals keep running, and QuickTerm starts again when Setup is done.
- The minus button or Later folds the card into the sidebar footer, where
  the percentage or "up" stays visible; a click opens the card again.
- Settings > About shows the same state with the same actions and has a new
  switch, Download updates automatically. With it off, the card offers a
  Download button instead.

### No more worktree creation

- **new worktree...** and its setup command are gone, and worktree
  workspaces no longer sit under their main checkout: every workspace is a
  folder on this computer or on an SSH host. A workspace whose folder is a
  git worktree is listed like any other and says `worktree` after its branch;
  its tooltip names the main checkout.

### Fixes

- A QuickTerm started from inside a Claude Code session no longer passes
  that session's markers to its terminals. Claude there took itself for a
  subagent and switched transcript saving off, so its pane had no title
  and could not be resumed.
- Git and the GitHub CLI never stop for a password prompt in the
  background, and use the workspace's repository even when QuickTerm's
  own environment names another one.
- An administrator terminal is refused on a workspace on an SSH host,
  where it would only have elevated the local ssh client.

## QuickTerm 4.2.0

Released 2026-10-25.

### Terminals outlive the window

- Closing the window, a crash of the window, restarting QuickTerm and
  installing an update no longer end your terminals. A background process
  owns them, keeps the tray icon and the global hotkeys, and the next window
  attaches to it with the scrollback intact.
- An update takes over at once when no terminal is busy or typed into;
  otherwise it asks, and the old terminals keep running until they are done.

### Agent state

- Claude Code and Codex started from QuickTerm report what they are doing.
  A terminal's dot shows working, waiting for you, done or failed; its
  tooltip shows the last prompt, the tool running now and the last answer;
  running subagents appear as lines under it. Nothing is written to your own
  Claude or Codex settings.
- **Alt+J** jumps to the next terminal that needs you.
- In the palette's `@` list, terminals that need you come first. The sidebar
  order does not change.
- Hovering a terminal row shows how long it has been quiet.
- When your Codex `config.toml` has a `notify` program of its own, it still
  runs: QuickTerm starts it with the same message and then reports the turn.

### Worktrees

- **new worktree...** in the palette, or in a git workspace's menu, creates a
  branch in its own folder next to the checkout, opens it as a workspace and
  types the setup command (`uv sync`, `npm ci`, ...) into a local shell there.
- Workspace rows show their branch, and worktrees sit under their main
  checkout.

### Terminals

- Shift+Enter in Claude Code and Codex is a new line in the prompt.
- Terminals in a workspace you cannot see release their GPU renderer after a
  few seconds and get it back when shown.

## QuickTerm 4.1.1

Released 2026-10-04.

### Sidebar

- A workspace with one terminal takes two rows instead of four. The active
  workspace's folder name and save dot sit on its row, and the Explorer and
  VS Code buttons appear there on hover next to **Close view** and the
  menu. The line under a workspace is used only for the **workspace here**
  offer, while it is offered.
- A terminal row is a single line. Its folder follows the name, and under a
  workspace only when the terminal has left the workspace's folder (in
  scratch, the folder it started in).
- The footer icons are centred; the collapse arrow stays on the right.

## QuickTerm 4.1.0

Released 2026-10-04.

### Sidebar

- Workspaces with no terminal that are not open are hidden. A **Show N
  empty workspaces** line under the list brings them back.
- A view button next to search sets what the list shows: empty workspaces,
  finished terminals (a finished one that still asks for you always shows),
  grouping by workspace or one list of terminals, and sorting by name or by
  recent activity. **Reset view** goes back to the default. The button is
  tinted while the view differs from the default, and the choice is kept
  per window.
- Workspaces are proper rows: an arrow that folds their terminals (pointing
  right when there is nothing inside), the view color and the name. A
  count shows only when there is something to count.
- Terminals hang under their workspace on a guide line; the active
  workspace's line is in its accent.
- The search button opens the palette already narrowed to workspaces and
  terminals (`@`).

### Palette

- Opening the palette selects the first row. Before, rows that arrive a
  moment later (saved workspaces, agent sessions) pushed the first row to
  the bottom and left it selected, so Enter could close a workspace view.
- Workspaces are listed in the same order as the sidebar, ignoring case.

## QuickTerm 4.0.0

Released 2026-10-04.

### Workspaces and sidebar

- A window no longer has a main workspace. Every workspace, scratch
  included, opens as its own view with its own layout, autosave and close
  button. Closing any view saves it and keeps its terminals running. Closing
  the last one leaves an empty area with a **New scratch** button.
- Opening a workspace that is already on screen focuses its view. Otherwise
  the new view takes half of the active one. The sidebar, the palette, the
  Dashboard, `quickterm open` and Explorer's **Open QuickTerm here** open or
  focus a view and never swap the workspace inside one. **Open QuickTerm
  here** opens a new scratch view in that folder.
- The sidebar is one list in a fixed order: every saved workspace in
  alphabetical order, empty ones included, then scratch views, then
  Unassigned. Terminals are sorted by name. A terminal that needs you gets a
  chip and keeps its place.
- Click a workspace to open or focus it. On hover it offers **Close view**
  and a menu with Open in new window, Workspace settings and Delete
  workspace. The active workspace shows its folder, the Explorer and VS Code
  buttons and the save dot on a second line.
- Every live terminal row has **Detach** and **Kill** on hover or keyboard
  focus. Kill asks in a small box beside the row. After a click, Cancel has
  the focus; after the Delete key, Kill has it and Enter confirms. A failed
  kill keeps the row, shows the reason and offers Retry.
- Right-click, Shift+F10 or the menu key on a row offers Open, Move to the
  active workspace, Detach, Rename and Kill. Double-click or F2 renames.
- Clicking a terminal focuses it where it is shown, opens its workspace when
  that is closed, or moves an Unassigned terminal into the active view.
- Removed: the "Main window" row, the colored view navigation, the
  "workspace beside" footer button and the strip of terminal choices. The
  floating **+** in hidden mode no longer drags; it sits 12 px from the top.
- A view keeps its color across restarts. Closing a scratch view keeps only
  the terminals that are busy or that you typed into. Idle untouched shells
  are left to the idle cleanup, so they no longer keep QuickTerm in the tray.
- **Kill all terminals** in the Dashboard closes the killed panes in every
  view of every native window.

### Agents: Claude Code and Codex

- Codex is a terminal type next to Claude Code, under Agents in
  Settings > Terminals > Add. Both use one launch mode setting: new
  conversation, continue latest, choose session and agent manager. Codex
  also has fork a session. Claude Code profiles keep their 3.x mode.
- Agent profiles have typed options. Claude Code: model, permission mode,
  effort, session name and extra folders, and under Advanced an extra system
  prompt, agent, MCP config, settings file, fork when resuming, verbose and
  connect IDE. Codex: model (suggested from Codex's model cache), approval,
  sandbox, approve for me, bypass approvals and sandbox, reasoning effort,
  web search, config profile and extra folders, and under Advanced worktree,
  inline mode, local model and local provider.
- The palette lists the workspace folder's recent conversations as "resume
  Claude session: <title>" and "resume Codex session: <title>". Restarting
  such a pane resumes the same conversation. Scratch views list the
  conversations of their own folder. Codex subagent and background threads
  are left out, and a Claude session renamed with /rename shows that name.
- The palette has a row for every mode of every agent profile, plus "split
  agent view". Splitting an agent manager pane starts a normal conversation
  in the workspace folder. A restored agent pane whose process is gone
  offers Continue latest and Choose session for both agents.
- When Codex is installed through npm, QuickTerm starts its native
  `codex.exe` instead of the `.cmd` shim. For an agent started through a
  `.cmd` or `.bat` file, QuickTerm refuses arguments that cmd.exe would
  reinterpret.

### SSH

- SSH and SFTP profiles can use the Windows OpenSSH client next to the
  bundled PuTTY tools. New profiles pick OpenSSH when it is installed.
  Existing profiles keep PuTTY.
- QuickTerm reads host aliases from `~/.ssh/config`. It follows Include and
  skips Match blocks and wildcard hosts. Settings > Terminals > Add has a
  "From ~/.ssh/config" heading with one entry per alias, and the Host field
  suggests aliases. Picking one shows the resolved user, port, key and
  ProxyJump as placeholders. **Fill from ~/.ssh/config** copies them into
  the fields.
- OpenSSH profiles take a ProxyJump. QuickTerm refuses a `.ppk` key with
  OpenSSH, a ProxyJump with PuTTY, and a host or user that starts with "-".
  Without an OpenSSH client the error names the Windows optional feature to
  install. A PuTTY profile whose key is not a `.ppk` offers **Switch to
  OpenSSH**.

### Settings

- Settings has seven tabs: General, Window, Shortcuts, Terminals, Snippets,
  Advanced and About. The update notification switch moved to Advanced.
- Terminals and Snippets show a filterable list with the editor beside it.
  Rows mark problems and unsaved changes. **Add** is a menu grouped into
  Shells, Agents, Remote, From ~/.ssh/config, Devices, Containers and
  Desktop. In a window narrower than 820 px the editor replaces the list and
  has a Back button.
- One Save stores everything. The footer button, Ctrl+S in Settings and the
  Save button in each editor do the same thing. "Save connection" is gone,
  and Open stays disabled until a terminal is saved.
- The terminal editor shows name, description and command first, then the
  fields of its type, then launch mode, shortcut and autostart. Arguments,
  environment and the start command are under Advanced.
- No native drop-down list is left. Every choice opens a QuickTerm menu.

### Shortcuts and search

- Shortcut fields record the keys you press. Esc cancels, Backspace clears.
  Global hotkeys pause while a field records, so a key QuickTerm already
  uses is recorded instead of fired. Letters follow your keyboard layout.
- A changed summon key or terminal shortcut works as soon as you save, with
  no restart. A key that another program holds is reported beside the field
  and in the Save message. Only host and port still need a restart.
- A new global shortcut needs Ctrl, Alt or Win. QuickTerm warns about Alt
  keys it uses itself and about the Alt keys shells and agents use.
- The Shortcuts tab lists the summon key, every terminal's shortcut and the
  in-app keys. Help shows the same key list.
- A search box at the top of Settings (press `/` to reach it) finds any
  setting, terminal or snippet, opens its tab and highlights the field.
  Escape clears the box before it closes Settings.
- The palette (Alt+K) adds "open workspace", "close workspace view", "new
  scratch view", "go to terminal", "setting", "edit terminal", "edit
  snippet" and "kill terminal" rows. "kill terminal" lists the live
  terminals; Enter on one asks once more, Escape goes back.
- Palette prefixes narrow the list: `>` actions, `@` workspaces and
  terminals, `#` settings and terminal configs, `!` snippets.
- "load workspace" and "show workspace beside" became "open workspace".
  "attach from another workspace" is now "move terminal here".

### Window and overlay

- Settings > Window sets the default window size, from presets or custom,
  or from **Use this window's size**. QuickTerm remembers the last size and
  position unless you turn that off, and restores them only when they still
  fit on a monitor. New windows open at the configured size, offset from
  the first one.
- An optional drop-down overlay turns the summon key into a toggle. The
  window slides in from the top or bottom edge of the monitor under the
  cursor, or of the primary monitor, at the width and height you set. It
  stays on top and hides when another program takes the focus; both are
  settings. Turning the overlay off restores the normal window at the next
  summon.
- The overlay stays open while QuickTerm opens a link, a folder or an
  elevated terminal. Tray **Open** shows the overlay when it is on.
- Sidebar and Settings text keeps at least 4.5:1 contrast on every surface,
  and the sidebar marks focus and state in Windows high contrast mode.

### Themes

- The built-in themes are replaced by 20 schemes taken from their upstream
  sources: Graphite (the house theme, still the default), Catppuccin Mocha
  and Latte, Tokyo Night, Storm and Day, Rosé Pine and Rosé Pine Dawn,
  Kanagawa Wave, Dragon and Lotus, Gruvbox Dark and Light, Everforest and
  Everforest Light, Nord, Dracula, GitHub Dark and Light, and Carbonfox.
  Seven of them are light.
- The sidebar, Settings and menus take their colors from each theme's own
  editor palette, not only from the terminal. Status colors and the colors
  of workspace views come from the theme's ANSI hues.
- The theme chooser in Settings > General is a menu grouped into Dark, Light
  and Custom. Every row shows the theme's accent and eight ANSI colors on
  its background.
- Graphite keeps its sidebar colors. Its terminal colors were rebuilt so
  each row of the ANSI palette has one even lightness.
- Every color in the stylesheets comes from a theme token. Tests check text
  contrast in every theme and fail on a color literal outside the theme
  definitions.

### Upgrading from 3.x

- `config.json` upgrades in place. `claude_mode` becomes `agent_mode`.
  Claude Code profiles also keep writing `claude_mode`, so 3.x still knows
  their mode after a downgrade.
- 3.x cannot read some shortcuts 4.0 records, for example Ctrl+Alt+Minus or
  Ctrl+Alt+Left. 4.0 saves such a key under a field only 4.0 reads and
  leaves the old field empty. After a downgrade 3.x loses that one shortcut
  instead of resetting the whole configuration.
- A 3.x shortcut without Ctrl, Alt or Win still loads and works. The
  settings history in Settings > About can still restore a version that
  holds one. Only new shortcuts need a modifier.
- SSH profiles from 3.x keep PuTTY. PuTTY hosts and user names with spaces
  still load; the rule against whitespace applies to OpenSSH profiles only.
- The stored view arrangement is converted once. The 3.x main workspace
  comes back as an ordinary view. Scratch views are not restored after a
  restart, as before.
- A config that names a removed theme opens with the closest new one, for
  example One Dark as Tokyo Night Storm and Monokai as Dracula. The stored
  name is kept until you pick another theme.
- `window_state.json` in `%APPDATA%\quickterm` is new and optional. QuickTerm
  ignores it when it is damaged.

### Verification limits

- Real Claude Code and Codex processes were started from Settings and
  killed from the sidebar. No SSH connection was opened: `~/.ssh/config`
  aliases were read and resolved with `ssh -G`, and the argument lists are
  covered by tests.
- The recent conversation lists read files that Claude Code and Codex keep
  for themselves. A CLI update can change their format; the list is then
  empty, and the CLI's own session picker still works.
- The overlay was summoned, hidden on focus loss and turned off on one
  Windows 11 desktop with one 1920x1080 monitor, from the source build.
  The packaged build was checked through its HTTP API. Several monitors
  and high-DPI scaling were not tested.
- Windows release binaries remain unsigned and can trigger SmartScreen.

## QuickTerm 3.13.0

Released 2026-10-03.

### Windows and workspaces

- Each native window has one sidebar, command palette and settings sheet.
  Workspace views share that sidebar and keep their own terminal layouts.
  Colored view navigation identifies the active workspace separately from
  the native window.
- New scratch views have independent temporary workspace identities. Opening
  another scratch no longer replaces the workspace you are using. Closing a
  view saves its layout and keeps its terminals running.
- Workspace folder and logo edits preserve the latest layout and terminal
  ownership. Layout autosaves cannot undo newer metadata edits.

### Terminal and connection setup

- A setup tour introduces windows, workspace views and terminals. Save a
  terminal configuration before launching it; detected shells populate setup,
  not the sidebar's launch menu.
- Typed forms cover local shells, WSL, Claude Code, custom commands, SSH/SFTP,
  Telnet, serial consoles, Docker, Podman, Kubernetes, Remote Desktop and VNC.
  Desktop connections open their own client windows and never create PTYs.
- Configure arguments, environment variables, shortcuts and autostart in
  forms. The raw JSON editor is removed.

### Settings

- Saved themes, font defaults, terminals, connections, snippets and app
  preferences refresh other native windows. Sidebar state stays per window;
  text zoom stays per pane until the saved font default changes.
- Settings saves send only changed fields and reject conflicting stale edits.
  Cancelling a logo draft no longer deletes a previously saved image.
- The Windows kill regression test launches a detached base interpreter and
  waits for its PID. Python's virtual-environment launcher can no longer
  terminate the intended survivor through its own job object.

### Verification limits

- Remote hosts, container engines, serial hardware and desktop servers were
  not connected during release verification. Their launch arguments and
  validation are covered by tests; real connections remain UNVERIFIED.
- Windows release binaries remain unsigned and can trigger SmartScreen.

## QuickTerm 3.12.0

### Resizing

- Text no longer breaks apart after you resize a pane or the window. The
  terminal (now xterm.js 6.0) rewraps lines exactly as the Windows console
  does, so a wrapped prompt stays in one piece and PowerShell no longer
  redraws it over the output above.
- Reopening a window or coming back to a workspace replays each terminal at
  every size it went through, so its history comes back as it was instead of
  scrambled.
- The terminal scrollbar is xterm's own now; its rail stays visible, and it
  shows no handle while there is nothing to scroll.

### Terminals

- QuickTerm talks to the Windows console directly instead of through
  pywinpty. Characters no longer turn into "?" boxes when they arrive split
  across two reads, an exit shows at once, and the app is about 5 MB smaller.
- Without PowerShell 7, the list under **+** and the palette offer to
  install it. winget runs in a new terminal, where you answer its prompts
  and the administrator request yourself; without winget, the download page
  opens. Afterwards PowerShell 7 is in the list.
- Settings > Default terminal lists every detected shell, so Git Bash, WSL
  or Command Prompt can be the default without a profile. **+** switches to
  the new default as soon as you save.

### Known issue

- A prompt exactly as wide as the pane, followed by a resize, can still make
  PowerShell redraw it one row too high.

## QuickTerm 3.11.0

### Terminals that need you

- A background terminal that rings the bell or sends a notification (Claude
  Code and Codex do this when they wait for an approval or finish a turn)
  gets a "needs you" dot in the sidebar, sorted to the top of its group, with
  the message in the tooltip. It clears when you look at that terminal or
  type into it. A detached terminal that finishes while you are away gets the
  same mark.
- When no QuickTerm window is in front, the taskbar button flashes; when
  QuickTerm is hidden in the tray, a tray balloon names the terminal. At most
  once per terminal every 30 seconds.
- The sidebar shows each terminal's current folder, not only the one it
  started in, and it now shows "busy" again.
- A finished terminal whose output you have not read stays in the sidebar as
  a dimmed row; opening it shows the final output.

### Panes

- An exited terminal has a Restart button; Enter in the exited pane or
  "restart terminal" in the palette does the same. The old output stays above
  a `[restarted]` line, and the restart repeats the pane's own launch, Claude
  mode included.
- "broadcast input to all panes in this workspace" in the palette sends what
  you type to every live pane, like tmux's synchronize-panes. It stops on a
  workspace switch or from the palette.
- "search all terminals..." in the palette searches every terminal's
  scrollback and jumps to the hit.
- "save terminal output" writes a terminal's scrollback as plain text to
  Downloads\QuickTerm.

### Workspaces and settings

- Workspaces tiled side by side come back after a restart or a reload.
- Settings > Terminals shows a profile as a name, a command and an optional
  start command; everything else is under "More".
- Settings > About lists the last 20 saved settings and restores any of them.
- Ctrl+_ (readline's undo) and Ctrl+Insert reach the terminal again; only
  keys that really type +, - or 0 zoom the text.

### Command line

- `quickterm ls`, `quickterm new [--profile] [--cwd] [--workspace]`,
  `quickterm open WORKSPACE` and `quickterm send SESSION TEXT [--enter]`
  drive the running app. See the README.

### Fixes

- The Explorer handoff poll no longer retries hundreds of times a second
  when the server refuses it.
- Bash, Zsh and Fish profiles keep their own arguments; the dashboard names
  Git Bash, Nushell, Bash, Zsh and Fish profiles correctly.
- Menus opened in Settings draw above the sheet.
- Moving a Claude pane into a new workspace keeps its launch mode.

### Under the hood

- The server is split into route modules (`quickterm/api/`), the session
  manager into ring, fan-out and reaper modules, and the frontend's
  2,300-line `boot()` into about twenty modules composed by `main.js`.
  Nothing about the wire protocol changed.

## QuickTerm 3.10.0

Fixes for the 55 issues filed by the September audit (#9 to #63).

### Terminals that stay usable under load

- On Linux, pasting a lot into a busy program froze every pane, the REST API
  and the WebSocket until the program read its input. The writer no longer
  holds the terminal while it waits.
- Fast output (`yes`, a big build) made the Linux viewer reset and replay the
  terminal hundreds of times a second. Output is now collected into large
  chunks as on Windows, and a viewer is only resynchronised once it is 2 MiB
  behind instead of eight reads behind. The throughput benchmark went from
  failing every run to about 55 MB/s.
- Re-opening a terminal after its scrollback wrapped could print stray
  characters and switch off modes set at startup. Replay now never starts in
  the middle of an escape sequence or a character, and restores bracketed
  paste, the alternate screen, mouse reporting and cursor modes, so a long
  Claude Code session keeps working after a reload or a workspace switch.

### Kill, exit and cleanup

- On Linux, killing a terminal now ends every job in it, including background
  jobs, and a shell that exits while a background job still holds the
  terminal is reported as exited at once.
- A kill that fails leaves the terminal able to take input.
- On Windows, a kill is only reported as done when every process of the tree
  is gone.
- The idle reaper rechecks each terminal right before it stops it, so a
  terminal you open or type into during a cleanup pass survives.
- A detached terminal that finishes while you are away keeps its final output
  until you open it (up to 24 hours).
- Automatic replies from the terminal (cursor position, focus reports) no
  longer count as typing, so an untouched shell can be cleaned up and no
  longer keeps QuickTerm in the tray.

### Starting terminals

- A missing program now says which terminal and which command failed, with a
  hint that QuickTerm reads PATH when it starts, instead of "Internal Server
  Error".
- PowerShell and Command Prompt profiles use the executable the inventory
  found and keep their own arguments. Git Bash and Nushell profiles run their
  start command.
- Autostart and global-hotkey profiles resolve exactly like terminals started
  from the sidebar, get the PuTTY tools on PATH, and report a failure in the
  error banner instead of failing silently.
- A profile that sets `Path` now really replaces PATH on Windows.
- Linux terminals always advertise `TERM=xterm-256color` and truecolor.
- On Windows, QuickTerm no longer runs a `taskkill.exe` or shell planted in
  the folder "Open QuickTerm here" was used on.

### Workspaces, windows and settings

- "Open QuickTerm here" within 20 seconds of a reload is no longer lost.
- Deleting a workspace while an autosave is running no longer brings it back.
- A partial settings save no longer wipes profiles and their secrets, and
  every save keeps the previous file as `config.prev.json`.
- Changing the port back to its old value now sticks.
- A hidden or minimized window keeps its workspace claim.
- An administrator window keeps its own workspaces and no longer deletes the
  normal window's scratch layout.
- A corrupt workspace file is set aside as `*.invalid-*.json` instead of
  becoming an entry that cannot be opened or deleted. Workspace names such as
  `con.txt` save on Windows 10.
- A workspace autosave without a logo no longer clears the logo.
- Settings > General has a Scratch folder field.
- Splits on Linux open in the pane's real folder instead of a `\\host\path`
  UNC path.

## QuickTerm 3.9.1

### Closing a pane gives its space back

- Closing a pane in a split (Alt+D, the × button, Alt+W, kill all) left
  the layout broken since 3.9.0: when the first pane went, the splitter took
  two thirds of the window and the survivor kept one third; when the second
  went, a stale splitter and a header stayed on the lone survivor. Neither a
  resize nor waiting repaired it, only the next split did. The leave
  animation now collapses the element it was meant to and redraws the tree
  when it ends.

### Zoom you can see and leave

- Alt+Z dropped the keyboard: the zoomed pane lost focus and the next
  keystrokes went nowhere. The terminal keeps focus now.
- The zoomed pane keeps its header. Its zoom control turns into ▣ "Show
  all panes" and stays visible without hover; the palette row reads "show
  all panes" while zoomed. Alt+Z on a lone pane says "[only one pane]"
  instead of changing nothing visible.
- Focusing a hidden pane while zoomed, from the sidebar or with Alt+arrows,
  shows every pane again first instead of putting the keyboard into a
  terminal you cannot see.

### Kill from the keyboard

- Alt+W opens the kill bar with **Kill** focused; Alt+W or Enter again
  kills, Escape cancels. Clicking Kill in the header still puts Cancel first.
- Escape cancels the bar from anywhere in the pane, not only while one of its
  buttons has focus.
- Alt+W on a pane with no running terminal says so.

## QuickTerm 3.9.0

### Tile as many workspaces as you want

- Workspace views are leaves of the same split tree as terminal panes. A
  new view takes half of the view you asked from, cut along its longer side,
  so repeated opens spiral inward the way a tiling window manager places
  windows. There is no limit on how many you open.
- Drag a view by its header onto another view to dock it on that side or
  swap the two. Dividers drag, answer the arrow keys and Home/End, and
  double-click to balance. **zoom** shows one view alone; **close** saves it
  and leaves its terminals running.
- Every view has its own colour. Opening one works from inside a view too:
  the sidebar footer, `Alt+K`, the tile action on a workspace menu row, or
  **show … beside** under a terminal that belongs to another workspace.
- Views slide into place. An iframe that moves in the DOM reloads, so views
  are never re-parented; a layout change writes their boxes and the
  transition on the box is the animation.

### Menus instead of native selects

- The terminal picker and the workspace row are QuickTerm's own menus. The
  workspace menu shows each workspace's folder, marks the ones shown in
  another view with that view's colour (choosing one focuses the view), and
  tiles any other beside the current one from a hover action. Menus walk
  with the arrows and typeahead, and hand the keyboard back to the terminal.

### A workspace from the folder you are in

- When the focused terminal sits outside the workspace folder, the sidebar
  offers **workspace here: <folder>**. One click makes the folder a
  workspace named after it, moves the terminal into it and switches there.
  A folder that already is a workspace's root offers **open <name>** and
  takes the terminal along.

### New terminals tile too

- `Alt+N` cuts the focused pane along its longer side, and splits, closes,
  moves and rebalances slide instead of jumping. Splitter drags never
  animate, and `prefers-reduced-motion` turns the motion off.

## QuickTerm 3.8.0

- Show two workspaces in one window from the sidebar or Alt+K. Each view has
  a colored border and workspace name, with a draggable divider, vertical
  stacking, and hide/show controls. Closing the second view saves its layout
  and leaves terminals running.
- Serialize workspace saves so older writes cannot replace a newer layout.
  Finish the outgoing save before transferring its workspace claim, and reject
  overlapping workspace switches.
- Window close no longer unconditionally kills unassigned scratch terminals.
  Safe idle cleanup remains the backend reaper's responsibility.
- Final page-exit saves use the autosave queue, so a pending older snapshot
  cannot arrive afterward. Closing the second view marks its terminals retained,
  including untouched shells in named workspaces.
- Quitting while a viewer's WebSocket is already closing no longer interrupts
  server shutdown with a duplicate-close error.

## QuickTerm 3.7.0

### Open the folder you are in

- Two buttons beside the workspace name open the focused terminal's folder in
  Explorer or VS Code, and so do `Alt+Shift+E` / `Alt+Shift+C` and two rows in
  `Alt+K`. The folder is where that shell is right now (it follows `cd`), else
  the workspace folder. VS Code is started from `Code.exe`, never the batch
  shim, because the folder name comes from the shell and cmd.exe re-parses
  batch arguments.

### Drag panes into place

- Drag a pane by its header onto another pane. The edges of the target dock
  the dragged pane on that side, the middle swaps the two, and a box shows
  the spot before you let go. Escape cancels. The layout autosaves like
  after a split.

## QuickTerm 3.6.0

### The sidebar is the whole interface

- The status bar, the quick-settings drawer and the pane header on a lone
  pane are gone. A single terminal fills the window edge to edge; the sidebar
  names it and shows its state. Headers come back with a second pane and
  their actions only draw on hover.
- The sidebar is one list: **+ name** opens a terminal and the chevron beside
  it changes what that is; the workspace is a dropdown with **+ new scratch**
  as its last row; then every live terminal as a dot and a name, with
  double-click to rename; then four icons.
- `Alt+Shift+S` cycles the sidebar through full, a 30 px rail of dots, and
  hidden. Hidden leaves a small **+** over the terminal's left edge that can
  be dragged up and down and remembers where it was.
- Claude Code needs no profile any more. When the CLI is installed, **Claude ·
  continue / new / resume** are offered next to the system shells and open in
  the workspace folder like any shell.
- Boot no longer waits for the shell inventory scan or a full process-metrics
  sweep: the inventory is cached in the browser and on the server, and the
  first session list is the cheap one. Both were about half a second on the
  path to the first prompt.
- `Ctrl+±/0` change the focused pane's text size; the saved default is in
  Settings. The **This pane / All panes** scope switch is gone with the drawer.
- About 25 KB of stylesheet for the old top bar and status bar was removed.

## QuickTerm 3.3.0

### Profiles no longer carry a folder

- A terminal profile has no folder of any kind. The workspace you launch it
  from places every session, so one "Claude Code" or "PowerShell" profile is
  usable in every project and none of them can point somewhere you cannot see.
- **Always this folder** and the profile subfolder are gone, from Settings and
  from the config file. The spawn order is now short: an explicit request
  folder, else the workspace root, else your home directory.
- Existing configs keep working. The `cwd` and `subpath` keys are simply
  unknown now, so they are dropped when the config loads and written out on the
  next save. A profile pointing at a folder that has since been deleted used to
  make the whole config invalid; it cannot any more.
- Set the folder per workspace in the Dashboard, which is where the native
  folder picker now lives.

### A pane whose session the backend forgot can be closed again

- A pane could get stuck with no way to remove it. Once the idle reaper drops
  an exited terminal from the registry, the backend answers 404 for that id.
  Kill treated the 404 as a failed kill and offered a **Retry** that could never
  succeed; detach treated it as a failed retain and left the pane open with the
  same result. Both now recognise a session that is already gone and close the
  pane. A real failure, where the process survives, still keeps the pane visible
  as before.

### Small interface additions

- Dashboard, Settings and Help have shortcuts: `Alt+G`, `Alt+S` and `Alt+I`.
  Each one closes its own panel again, and the sidebar buttons now print the key
  beside their label so it can be learned without hunting. The keys are cold by
  design: readline, PSReadLine and Claude Code all leave G, S and I unbound.
- `Alt+D` and `Alt+W` now mark the header control they stand for while their
  confirmation is open. The bar used to appear with nothing tying it to a
  button, which read as if it came from nowhere.
- A Claude Code pane shows **working** or **idle** in its header. The signal is
  the live output stream the pane already receives, so it costs no extra process
  sampling and it stays honest while Claude thinks between tool calls.

### Documentation and wording

- Rewrote the README, agent guide, contracts and code comments to drop
  marketing wording and machine-sounding punctuation. No behaviour changed.
- Corrected the README: the pane's `×` button detaches and keeps the terminal
  running. The separate **Kill** button and `Alt+W` are the destructive path.
  The old text described `×` as destructive, which was wrong and dangerous.
- `docs/CONTRACTS.md` pointed readers at a `plan.md` that does not exist. It
  now points at `AGENTS.md`.
- Settings → About and a few status messages lost their promotional phrasing
  and now say what the app does.

## QuickTerm 3.2.0

### Workspaces are folders

- A workspace now has a **folder**, and every terminal it owns starts there.
  Switching workspace switches project. Set or change it from the Dashboard:
  each workspace row shows its folder and has a **Folder** button with a native
  picker, and naming a new workspace asks for the folder in the same form.
- Terminal profiles no longer carry a project path. A profile either **follows
  the workspace folder** (optionally into a **subfolder** such as `backend`) or
  pins itself to one fixed directory with **Always this folder**, never both,
  so switching one off leaves nothing invisible behind. Existing profiles with
  a folder keep it and are shown as pinned; nothing needs migrating.
- Claude Code profiles no longer require their own project folder. One Claude
  profile is now usable in every project, taking its context from the workspace.
- Scratch opens in a throwaway folder under your system temp directory instead
  of your home folder, so nothing typed in a disposable terminal lands
  somewhere that matters by accident. Naming a scratch offers the folder its
  focused terminal is really in, never the temp folder itself.
- A workspace folder that has been moved or deleted is reported in the sidebar,
  the Dashboard and the message banner. It degrades to your home folder rather
  than failing the next terminal, and a subfolder that has gone missing falls
  back to the workspace root.
- Administrator terminals and restored layouts follow the workspace folder too,
  so an elevated shell no longer lands somewhere different from its siblings.
- `GET /api/workspaces/{name}` now returns `path` and `path_exists`, `PUT`
  accepts `path` (absent preserves the stored folder, `null` clears it), and
  `SessionInfo` reports the `cwd` a terminal actually started in.

### Fixes and polish

- **Settings and Dashboard no longer stretch to the corners of the screen.**
  They are a centred, bounded sheet again: the click-outside-to-close target is
  back, rows stop stretching to the full width of a wide monitor, and a dialog
  reads as a dialog rather than a second application.
- A profile pinned to a fixed folder is no longer overridden by the workspace
  root. The Settings choice is honoured exactly as written.
- Saving a workspace layout no longer fsyncs on the event loop. The layout
  autosaves on every pane change, so that write briefly stalled every terminal's
  output pump.
- One shared folder-picker control now backs every folder field, so the
  "Browse" button behaves identically in Settings and the Dashboard and appears
  as soon as the desktop API is ready.
- The command palette shows each workspace's folder next to its name, and
  fixed spacing in terminal profile cards where a hint ran into the next label.

## QuickTerm 3.1.0

### Nothing destructive without consent

- The pane title bar's `×` now closes the view and leaves the terminal
  running, matching what that glyph means everywhere else. Killing moved to a
  separate, divided, labelled **Kill** control, and every destructive
  confirmation now opens with **Cancel** focused so a reflexive Enter cannot
  complete it.
- Clicking the workspace row you are already on is a no-op for every workspace,
  scratch included. Previously the row drawn as "current" discarded every live
  scratch terminal without asking; replacing scratch is now the explicit,
  confirmed **new scratch** action.
- Removed the palette's free-text workspace prompts, where a typo silently tore
  down the whole layout. Workspaces are offered as exact `load workspace: <name>`
  rows, and saving is handled by the Dashboard, which validates the name.
- The in-app updater now stands the window down before starting Setup. It used
  to launch the installer while close-to-tray was actively refusing to close,
  leaving Setup stalled on a window missing from the taskbar, or
  force-terminating the app and every terminal in it.

### Nothing fails silently

- Added a single dismissible message banner for blocking failures, drawn above
  the panel overlay. Errors previously went to a 9 px status-bar slot that
  collapsed when empty, never cleared, and sat underneath open panels.
- The sidebar **admin** button now reports its outcome instead of swallowing
  every failure, including a declined UAC prompt, in an empty catch.
- A global shortcut that Windows refuses to register (another program owns it)
  is now reported in Settings next to the field, along with the fact that the
  shortcut and port apply after a restart.
- Failed workspace saves roll back instead of leaving the app pointing at a
  workspace that was never written, and rejected names explain themselves.
- Snippets show the command and the destination pane before running, and
  multi-line snippets are confirmed in the pane first.
- Settings' **System default shell** option works; it previously always
  resolved to the first personal profile.

### No lost terminal output

- A viewer that falls behind now recovers even if the session exits during the
  resync: an exited session still in the registry is served in replay-only
  mode instead of being refused, so its final output stays reachable.
- A fresh attachment is drained from the moment it exists. A busy session could
  previously overflow its queue during the replay handshake and be disconnected
  the instant it went live, looping on "output busy · resynchronizing" forever.
- Output still queued in the browser when a session exits is flushed to the
  terminal instead of being dropped mid-stream and then retained.

### Correctness and performance

- Saving Settings no longer writes the runtime port into `config.json`. An
  Administrator window or any `--port` launch used to overwrite the configured
  port with an ephemeral one for every later launch.
- `Ctrl+]` and `Ctrl+/` reach the shell again on US/UK layouts. The vim tag
  jump and the readline/PSReadLine undo were being swallowed as font zoom.
- Moved the idle reaper, bulk session cleanup and the UAC handshake off the
  event loop; a reaper pass that killed a live shell froze every pane for
  hundreds of milliseconds and then overflowed the queues it had stalled.
- Process metrics sample only the session process trees rather than every
  process on the machine, and the dashboard stops polling while hidden.
- Workspace names that differ only in case no longer share one file on NTFS.
- POSIX `kill()` verifies termination instead of reporting success on `EPERM`,
  and the POSIX resize/write paths can no longer touch a recycled descriptor.
- Fixed Escape closing a whole panel instead of cancelling the destructive
  confirmation inside it, confirmation popovers drifting away from their
  trigger while the panel scrolled, pane resizing silently dropping zoom, the
  palette running a different item than the highlighted one, Advanced-tab JSON
  edits being discarded on tab switch, a folder handoff retrying a permanently
  failing spawn forever, and replaced branding assets never being reclaimed.
- Removed duplicate entry points: the Dashboard had two adjacent identical
  sidebar buttons, and pane sizing was offered in three places at once.

## QuickTerm 3.0.1

### Native profile folder picker

- Added a Windows folder chooser beside every local terminal profile's
  Starting folder or Claude Project folder while preserving direct path entry.
- Cancel leaves the existing path untouched; failed dialogs remain retryable,
  and standalone browsers clearly disable the native-only control rather than
  pretending they can disclose a host path.
- WSL profiles continue accepting Linux paths manually and can use Browse to
  select an absolute Windows directory for `wsl.exe --cd`.

## QuickTerm 3.0.0

### Terminal-first workspace

- Replaced the card-heavy launcher and top bar with a compact, collapsible
  terminal-style sidebar while letting panes use the full window height.
- Added dense pane chrome for horizontal and vertical splits, zoom, true
  detach, and confirmed process-tree termination, plus current-workspace and
  global live-session counters.
- Added `Alt+N` new-terminal, `Alt+D` detach, `Alt+W` confirmed kill,
  `Alt+Z` zoom, directional focus/split shortcuts, and fast profile cycling
  while preserving native PowerShell/readline navigation and Chromium paste.

### Reliable sessions and desktop handoff

- Separated explicit retention from typed activity so detached shells remain
  alive without falsifying usage state; verified kills remove only processes
  the backend actually terminated.
- Restored missing sessions as transcript-free unavailable panes with explicit
  recovery instead of silently starting a different process under the old ID.
- Made workspace ownership and destructive cleanup server-authoritative, with
  protection against stale duplicate references killing a moved terminal.
- A second ordinary QuickTerm launch now hands Explorer's folder to the
  authenticated running instance, summons that one window, and opens the
  terminal in Scratch instead of creating another QuickTerm.
- Hardened focus restoration across terminal creation, splits, attach/replay,
  panel close, recovery, detach, kill, and workspace transitions.

### Claude Code, folders, and file drops

- Promoted Claude Code to a first-class project profile with new, continue,
  session-picker, and background-agent-manager modes plus explicit recovery
  actions when its PTY is gone.
- Splits use the selected terminal profile in the focused pane's OSC 7 or
  OSC 9;9 directory, falling back to its launch/project folder without prompt
  scraping. Claude agent views remain an explicit separate action.
- Explorer file and image drops now insert host-verified, shell-quoted paths
  without submitting the command, including WSL path conversion and explicit
  refusal for misleading remote-terminal paths.

### Privacy, performance, and packaging

- Kept terminal transcripts and session IDs off disk. Normal diagnostics are
  warning/error-only, path-redacted, and bounded to 128 KiB plus one rotation;
  raw terminal bytes remain opt-in through `QUICKTERM_DEBUG_IO=1` only.
- Reduced status polling and frozen dependencies while retaining bounded
  scrollback, subscriber resynchronization, WebSocket coalescing, and xterm
  write-backpressure. The unpacked Windows build is 47.05 MB.
- Fixed GUI-subsystem ConPTY startup by allocating one hidden process-wide
  console before pywinpty creates terminal sessions.
- Added a packaged-app smoke test that verifies authenticated real-PTY spawn,
  initial attach, reconnect replay, live I/O, exit, and dynamic route bundling.

## QuickTerm 2.4.0

### Tested terminal attachment

- Extracted the pane replay, write-backpressure, resync, and live-input phases
  into an explicit state machine.
- Added fast Node tests for replay ordering, stale WebSocket callbacks, input
  gating, and overflow-triggered resync, plus shared panel utility tests.
- Added architectural contract tests that keep panes on the tested protocol and
  prevent the panel coordinator growing back into a monolith.

### Smaller, maintainable frontend

- Split the 1,456-line panels class into a small coordinator and focused
  dashboard, help, settings, terminal, snippet, appearance, and shared modules.
- Preserved the existing no-build ES-module frontend and its public UI behavior.

### One-command manual CI

- Added `uv run --no-sync python scripts/check.py` as the local release gate:
  Python tests, Ruff, byte compilation, JavaScript tests and syntax, version
  consistency, and clean diffs.
- Added `--artifacts` verification for the exact updater-facing release names
  and their SHA-256 manifest. Hosted CI remains intentionally disabled.

### Maintenance and diagnostics

- Session and PTY snapshot/write failures now leave debug diagnostics instead
  of disappearing silently.
- Production routes now rely on the real session-manager interface; test fakes
  implement that interface instead of shaping production branches.
- Removed the stray server source BOM, consolidated duplicate agent guidance,
  and replaced scattered root release notes with this changelog.

## QuickTerm 2.3.0

## Session controls that actually stay visible

- Fixed the dashboard confirmation bug that hid **Kill** and **Kill all** before
  measuring their position, which could place the confirmation outside the
  visible window and make the action appear broken.
- Destructive controls now remain visible and disabled while their confirmation
  is open, and the confirmation is clamped above or below the trigger inside the
  viewport.
- Kill All reports verified per-session successes and failures. Only confirmed
  kills are removed; failures remain visible and retryable.
- Successful kills remove stale session ownership and pane references from saved
  workspaces. Exited or stale session cards cannot be attached again.
- A real WSL PTY kill and registry-removal smoke test passes.

## Better background-agent awareness

- Detached terminals now show when new output arrived, how much arrived, and how
  long ago it appeared.
- Reattaching acknowledges that output, providing a lightweight working/waiting
  signal without guessing from terminal contents.

## Expanded dark theme catalog

- Added Catppuccin Frappé, Rosé Pine Moon, Tokyo Night Storm, GitHub Dark
  Dimmed, and Oxocarbon.
- The 27-theme catalog now separates Neon palettes while preserving custom
  themes, live preview, cancel-to-revert, and fallback behavior.

## Additional hardening

- Configuration validation now rejects malformed runtime-facing field types
  before they can break profile launch or accidentally enable autostart.
- Ctrl-click accepts HTTP and HTTPS schemes case-insensitively.
- Public contracts and agent guidance document the verified kill semantics.

## Validation

- 231 automated tests pass.
- Ruff, Python compilation, JavaScript syntax checks, diff checks, real WSL
  termination, PyInstaller packaging, and isolated packaged smoke tests pass.

## QuickTerm 2.2.0

## Familiar Windows shortcuts

- `Ctrl+C` copies selected terminal text and remains the terminal interrupt
  when nothing is selected.
- `Ctrl+V` uses the native WebView2/xterm paste path. The existing
  `Ctrl+Shift+C` and `Ctrl+Shift+V` gestures remain available as aliases.
- `Ctrl+Plus`, `Ctrl+Minus`, and `Ctrl+0` now control terminal text size,
  including German and other non-US keyboard-layout fallbacks.
- Plain `Alt+V` remains untouched for Claude Code image paste.

## Reliable session cleanup

- Background-session kills are now verified instead of trusting that
  `taskkill` succeeded. Windows uses a direct process-termination fallback
  when necessary.
- Kill, Kill All, scratch cleanup, and workspace deletion now report failures
  instead of hiding a process that is still running.
- Session state changes and removal timers are marshalled safely onto the
  owning asyncio loop, so killed sessions disappear promptly and consistently.

## Hardening and correctness

- Live terminal WebSocket frames remain within their documented 128 KiB cap,
  preserving input responsiveness during heavy output.
- JSON requests and image uploads are size-bounded before buffering; malformed
  JSON now produces a client error instead of an internal server error.
- Corrupt local authentication tokens are repaired automatically, and OSC 52
  clipboard writes from terminal output are capped at 1 MiB.
- Workspace filenames no longer collide after Windows-safe normalization, and
  malformed workspace files cannot break the workspace list.
- Windows process APIs now use explicit 64-bit-safe handle signatures.

## Validation

- 215 automated tests pass.
- Ruff, Python compilation, JavaScript syntax checks, the PyInstaller build,
  and packaged health/opener/update smoke tests pass.

## QuickTerm 2.1.0

## SSH and SFTP terminals, powered by bundled PuTTY

- **New terminal types: SSH and SFTP.** Create a profile in Settings →
  Terminals with a host, optional port, username and PuTTY `.ppk` private
  key. Sessions run through the bundled PuTTY `plink`/`psftp`, with no separate
  install needed. Passphrases and passwords are never stored; you are
  prompted inside the terminal.
- **`pscp`, `plink` and `psftp` work in every terminal.** The bundled tools
  folder is appended to each session's `PATH`, so one-off transfers are as
  simple as `pscp file.txt user@host:/tmp/`. A tool you installed yourself
  still takes precedence.
- **SSH remote command.** An SSH profile can run a single remote command
  instead of opening a shell.
- The PuTTY binaries (release 0.84) are pinned and SHA-256-verified against
  the official published checksums at build time. Licences ship in
  `THIRD-PARTY-NOTICES.md`.

## Fixes and details

- Settings: picking Git Bash or Nushell as a profile's type now fills in the
  detected executable path automatically.
- The launcher lists SSH/SFTP under personal profiles only; system entries
  stay limited to shells that work without configuration.

## QuickTerm 2.0.3

This security release hardens terminal profile environment variables from
storage through process launch without changing normal profile behavior.

## Environment security

- Encrypts profile environment values at rest with Windows current-user DPAPI
  and automatically migrates existing plaintext values.
- Protects administrator-terminal launch specifications with DPAPI instead of
  placing recoverable Base64 JSON in the process command line.
- Rejects malformed names, NUL characters, case-insensitive duplicates, and
  oversized environment payloads consistently across config, API, UAC, and PTY
  entry points.
- Caps configuration/session JSON requests before buffering and prevents
  sensitive API responses from being cached.

## Local secret handling

- Creates the local auth token atomically and enforces user-only token/config
  permissions on POSIX fallback systems.
- Enables raw terminal I/O logging only for the exact value
  `QUICKTERM_DEBUG_IO=1`; values such as `0` no longer activate it accidentally.
- Warns in the log whenever raw input tracing is enabled and documents that
  child processes inherit profile variables.

## Compatibility

- Keeps the public in-memory and API environment shape as `dict[str, str]`.
- Continues accepting legacy plaintext config values and rewrites them securely
  after a successful load.

Validated with 184 tests, Ruff, frontend syntax checks, Windows DPAPI
round-trips, and a packaged application smoke test covering encrypted config,
real ConPTY environment delivery, authentication, and dynamic routes.

## QuickTerm 2.0.2

This release adds visible resource usage and safer session controls while keeping QuickTerm's security claims precise and auditable.

## Usage and limits

- Added live per-terminal RAM, CPU, process-count, and uptime reporting, plus aggregate RAM in the dashboard.
- Usage is measured locally from each terminal's process tree. No metrics are uploaded or persisted.
- Added a configurable live-session limit. Once reached, QuickTerm refuses new sessions with a clear in-app message while existing sessions continue normally.
- Reports WSL measurements as partial instead of implying host-and-guest accounting is exact.

## Session termination

- Added `Alt+Shift+W` to terminate the focused terminal's process tree and close its pane.
- Added a Kill all action for terminating every live session.
- Destructive actions use keyboard-accessible in-app confirmations next to the relevant control; Enter confirms and Escape cancels.
- Removed browser-native confirmation dialogs from QuickTerm-owned flows, including terminal link handling.

## UI and documentation

- Fixed the launcher controls clipping their borders in narrow windows and kept the New terminal label readable.
- Added an honest company-use security guide covering the local-only architecture, authentication boundaries, operational limitations, usage-measurement scope, deployment checklist, and Windows code-signing options.
- Documented the new API fields, session-limit response, and kill-all endpoint.

Validated with 167 tests, Ruff, frontend syntax checks, live browser interaction at desktop and 442 px widths, Windows process-tree metric probes, and packaged application/API smoke tests.

## QuickTerm 2.0.1

This is a broad developer-experience, reliability, and packaging pass over 2.0.

## Faster and smaller in real use

- Replaced the self-extracting one-file runtime with a normal per-user app-folder install. The installer is 17.23 MB, the portable ZIP is 20.15 MB, and the 45.1 MB runtime is shared by every window instead of extracting about 37.7 MB per process.
- Health-ready startup averaged 1.60 s in local tests, down from 2.73 s for the old one-file build.
- Desktop and Start Menu shortcuts point at the installed launcher; no administrator access is required.

## Terminal usability

- Added a compact View drawer with pane-first text sizing, explicit minus/plus/reset buttons, selected/all scope, width/height controls, split balancing, focus mode, and a Settings shortcut.
- Fixed the decrease-font shortcut across WebView2 and international/numpad keyboard reports.
- Made splitters wider and visible, pointer-friendly, arrow-key adjustable, and double-clickable to balance.
- Restored a clearly visible themed scrollbar in every terminal with scrollback.
- WSL profiles with no folder now start in Linux `~`; Windows shells start in the Windows user home. WSL profile folders and startup commands now resolve together correctly.
- Session counts now distinguish open terminals from background sessions instead of presenting every backend process as a visible terminal.

## Reliability and safety

- Added paced, acknowledged scrollback replay and stale-reconnect guards.
- Bounded PTY input queues on Windows and POSIX so blocked shells cannot stall or grow memory indefinitely.
- Preserved autostart sessions and made autostart/global-hotkey launches use the same profile resolver as normal launches.
- Added visible workspace-save state with retry and stopped optimistic UI deletion when backend operations fail.
- Hardened config/workspace recovery, spawn and resize validation, passive-file opening, and update download URL/size/version/checksum verification.
- Added categorized themes with live app-wide preview, stronger derived contrast, and a four-theme featured catalog.
- MCP remains completely removed.

Validated with 162 tests, Ruff, frontend syntax checks, live browser/xterm interaction, WSL path probes, packaged ConPTY/API smoke tests, and installer/portable builds.

## QuickTerm 2.0.0

QuickTerm 2.0 is a focused developer-workspace release.

Highlights:

- Reworked the interface into a compact, neutral workbench with flatter controls, denser panes, clearer focus and exit states, keyboard-operable splitters, stronger contrast, improved screen-reader semantics, and a four-theme featured picker with the remaining designs in a catalog.
- Added easier directional split shortcuts: `Alt+Shift+Right` and `Alt+Shift+Down`. Existing `Alt+Shift+H/V` shortcuts remain available.
- Hardened long-running sessions: touched or busy terminals are never idle-reaped, slow viewers resync instead of losing terminal control bytes, reconnect replay has no output race, resize geometry stays current, and stale workspace session references are pruned.
- Improved responsiveness through bounded WebSocket queues, capped frames, disabled terminal compression, byte-accurate PTY batching, frontend write backpressure, and duplicate-spawn protection.
- Made destructive session/workspace actions confirm intent, paused dashboard refresh while editing, fixed default-profile launching and the zero idle-timeout setting, and made JSON saves atomic.
- Removed MCP completely: bridge executable, server module, REST routes, discovery environment variables, configuration, UI, documentation, tests, and packaging hooks are gone.

This is a breaking major release for anyone who used `quickterm-mcp` or the removed terminal-control REST endpoints.
