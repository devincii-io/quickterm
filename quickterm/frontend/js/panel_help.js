import { make } from "./panel_shared.js";
import { SHORTCUTS } from "./keys.js";

// Pointer gestures have no key to claim, so they are not in SHORTCUTS.
const GESTURES = [
  ["Right click", "Copy the current selection"],
  ["Drag a pane header", "Move the pane: an edge of another pane docks it there, the middle swaps the two"],
  ["Ctrl click", "Open a link or file path printed in the terminal"],
];

export function renderHelp() {
    const intro = make("div", "help-intro");
    intro.append(make("h2", "", "Your terminals stay organized."), make("p", "", "Alt+D detaches a terminal without stopping it. X or Alt+W always asks before killing its process tree."));
    this.bodyEl.append(intro);
    const tour = this._button("Setup tour", "secondary-button compact");
    tour.addEventListener("click", () => this.show("setup"));
    this.bodyEl.append(tour);
    const grid = make("div", "help-grid");
    const keyCard = make("section", "help-card");
    keyCard.append(make("h3", "", "Keyboard shortcuts"));
    for (const [key, label] of [...SHORTCUTS.map((item) => [item.keys, item.label]), ...GESTURES]) {
      const row = make("div", "shortcut-row");
      row.append(make("kbd", "", key), make("span", "", label));
      keyCard.append(row);
    }
    const conceptCard = make("section", "help-card");
    conceptCard.append(make("h3", "", "A few useful ideas"));
    for (const [title, copy] of [
      ["Your keys stay yours", "Ctrl+C copies only when text is selected; otherwise it interrupts the terminal. Plain Alt+V (Claude Code image paste), Alt+P (model switch), Ctrl+P, the Alt+B/F word motions and other shell keys pass through untouched."],
      ["Terminals", "A saved terminal has a name, a description, a type and an optional global shortcut. It carries no folder: it always opens in the folder of the workspace you launch it from, so one config works in every project."],
      ["Agents", "Claude Code and Codex are terminals too. Settings lists their options from the installed CLI, and the palette offers new, continue, choose session and the agent manager for each."],
      ["Agent state", "An agent's dot pulses while it works, rings when it waits for you, and turns green or red when a turn ends. Hover the row for its last prompt, tool and message; running subagents show under it. Alt+J jumps to the next terminal that needs you."],
      ["Workspaces on a server", "A workspace can live on a machine you reach over SSH: choose \"new workspace on host\" in the palette or the Workspaces \"+\" menu, pick an SSH terminal that uses OpenSSH and type the folder there. Its terminals, Claude Code and Codex then run on that host, and its row shows @host. Key or agent sign-in works best; each terminal is its own connection."],
      ["New terminals", "The + at the top starts what you picked last in its menu: another shell, Claude Code, Codex or a saved terminal; PowerShell or the shell in Settings until then. Alt+N does the same. A shell starts in the focused terminal's folder while that is inside the workspace folder (QuickTerm's shells report their folder as you cd), else in the workspace folder."],
      ["Moving around", "Ctrl+Tab lists the terminals you used last, across workspaces: keep Ctrl down, Tab to the one you want, let go. One tap flips between the last two. Ctrl+Shift+1 to 9 shows a workspace by its place in the sidebar, Alt+PgDn and Alt+PgUp the next and previous open one."],
      ["Workspaces", "A workspace is a folder plus a saved split layout. Every terminal you open in it starts in that folder. \"New workspace…\" in the Workspaces \"+\" menu makes one from a folder you choose. Click one in the sidebar to show it; the window shows one workspace at a time, and the others stay open behind it."],
      ["Scratch is temporary", "Scratch opens in a throwaway folder under your system temp directory and is deleted when QuickTerm quits. cd into a project there and the sidebar offers to make that folder a workspace and takes the terminal along. \"save workspace as\" in the palette (Alt+K) names it yourself."],
      ["Workspace board", "Alt+G shows every saved workspace as a card in Todo, In progress, In review or Done, with its repo, branch and live terminals. Drag a card to another column, or focus it and press Alt+Left or Alt+Right. Click a card to show that workspace."],
      ["Files and changes", "Alt+Shift+E opens the right panel for the shown workspace: its files (click one to read it, Alt+click pastes its path into the terminal), its git changes with one button that stages, commits, pushes or pulls, and the branch's pull request with its checks."],
      ["Snippets", "A command you keep: a name, a description of what it does, and the exact keystrokes. Alt+K finds it and types it into the focused terminal, Enter included."],
      ["Find any setting", "Type in the search box at the top of Settings, or press / while Settings is open. The palette (Alt+K) finds settings too."],
    ]) {
      const item = make("div", "concept-row");
      item.append(make("strong", "", title), make("p", "", copy));
      conceptCard.append(item);
    }
    grid.append(keyCard, conceptCard);
    this.bodyEl.append(grid);
  }
