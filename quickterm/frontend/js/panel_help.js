import { make } from "./panel_shared.js";
export function renderHelp() {
    const intro = make("div", "help-intro");
    intro.append(make("h2", "", "Your terminals stay organized."), make("p", "", "Alt+W detaches a used terminal without stopping it. It remains inside the current workspace — including Scratch — and appears on the dashboard with Attach and Kill controls."));
    this.bodyEl.append(intro);
    const grid = make("div", "help-grid");
    const shortcuts = [
      ["Alt K", "Open command palette"], ["Alt Shift →", "Split to the right"],
      ["Alt Shift ↓", "Split below"], ["Alt arrows", "Move between panes"],
      ["Alt Z", "Focus one pane"], ["Alt W", "Detach current pane"],
      ["Alt Shift W", "Kill terminal and close pane"],
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
      ["Profiles", "Reusable terminal types, folders and start commands."],
      ["Workspaces", "Named arrangements that restore your split layout."],
      ["Sessions live in workspaces", "Detached sessions stay with their workspace and do not expire. The palette only shows the current workspace; moving a session from another workspace requires the explicit menu."],
      ["Scratch is temporary", "Scratch keeps its detached sessions for this run, but the whole Scratch workspace is deleted when QuickTerm quits."],
      ["Snippets", "Small reusable commands available in the palette."],
    ]) {
      const item = make("div", "concept-row");
      item.append(make("strong", "", title), make("p", "", copy));
      conceptCard.append(item);
    }
    grid.append(keyCard, conceptCard);
    this.bodyEl.append(grid);
  }
