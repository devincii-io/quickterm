import { make } from "./panel_shared.js";
export function renderHelp() {
    const intro = make("div", "help-intro");
    intro.append(make("h2", "", "Your terminals stay organized."), make("p", "", "Alt+D detaches a terminal without stopping it. X or Alt+W always asks before killing its process tree."));
    this.bodyEl.append(intro);
    const grid = make("div", "help-grid");
    const shortcuts = [
      ["Alt K", "Open command palette"], ["Alt Shift →", "Split selected profile right in current folder"],
      ["Alt Shift ↓", "Split selected profile below in current folder"], ["Alt arrows", "Move between panes"],
      ["Alt N", "New default terminal"], ["Alt Z", "Focus one pane"],
      ["Alt Shift ← / ↑", "Previous / next new-terminal profile"],
      ["Alt D", "Detach current pane"], ["Alt W", "Confirm kill and close"],
      ["Ctrl +", "Bigger terminal text"], ["Ctrl -", "Smaller terminal text"],
      ["Ctrl 0", "Reset terminal text size"],
      ["Ctrl C", "Copy selection (otherwise interrupt)"], ["Ctrl V", "Paste into terminal"],
      ["Right click", "Copy the current selection"],
      ["Ctrl click", "Open a link or file path printed in the terminal"],
    ];
    const keyCard = make("section", "help-card");
    keyCard.append(make("h3", "", "Keyboard shortcuts"));
    for (const [key, label] of shortcuts) {
      const row = make("div", "shortcut-row");
      row.append(make("kbd", "", key), make("span", "", label));
      keyCard.append(row);
    }
    const conceptCard = make("section", "help-card");
    conceptCard.append(make("h3", "", "A few useful ideas"));
    for (const [title, copy] of [
      ["Your keys stay yours", "Ctrl+C copies only when text is selected; otherwise it interrupts the terminal. Plain Alt+V (Claude Code image paste), Alt+P (model switch), Ctrl+P, the Alt+B/F word motions and other shell keys pass through untouched."],
      ["Profiles", "Reusable terminal types, start commands and shortcuts. A profile carries no folder: it always opens in the folder of the workspace you launch it from, so one profile works in every project."],
      ["Split folders", "Splits use OSC 7 or OSC 9;9 shell directory signals, falling back to the pane launch folder. Open and Alt+N start in the workspace folder."],
      ["Claude agent view", "Normal Claude splits stay in the profile project and never surprise-open the agent manager. Use the explicit Split Claude agent view command in Alt+K."],
      ["Workspaces", "A workspace is a folder plus a saved split layout. Every terminal you open in it starts in that folder, so switching workspace switches project. Set or change the folder from the Dashboard."],
      ["Sessions live in workspaces", "Detached sessions stay with their workspace and do not expire. The palette only shows the current workspace; moving a session from another workspace requires the explicit menu."],
      ["Scratch is temporary", "Scratch opens in a throwaway folder under your system temp directory, keeps its detached sessions for this run, and is deleted when QuickTerm quits. Name it in the Dashboard to keep it; you choose the real folder then."],
      ["Snippets", "Small reusable commands available in the palette."],
    ]) {
      const item = make("div", "concept-row");
      item.append(make("strong", "", title), make("p", "", copy));
      conceptCard.append(item);
    }
    grid.append(keyCard, conceptCard);
    this.bodyEl.append(grid);
  }
