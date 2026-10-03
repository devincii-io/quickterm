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
      ["Split folders", "Splits use OSC 7 or OSC 9;9 shell directory signals, falling back to the pane launch folder. Open and Alt+N start in the workspace folder."],
      ["Workspaces", "A workspace is a folder plus a saved split layout. Every terminal you open in it starts in that folder. Open one from the sidebar; it tiles beside the ones already open."],
      ["Scratch is temporary", "Scratch opens in a throwaway folder under your system temp directory and is deleted when QuickTerm quits. Name it in the Dashboard to keep it; you choose the real folder then."],
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
