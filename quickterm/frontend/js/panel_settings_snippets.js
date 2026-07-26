import { icon } from "./icons.js";
import {
  displaySnippet, make, runnableSnippet,
} from "./panel_shared.js";
export function renderSnippetSettings(host, rerender) {
    const cfg = this.settingsDraft;
    cfg.snippets ||= [];
    const heading = this._sectionHeading("Snippets", "Reusable commands, one keystroke away in the command palette (Alt+K).");
    const add = this._button("", "primary-button compact");
    add.append(icon("plus", 13), make("span", "", "Add snippet"));
    add.addEventListener("click", () => {
      let n = 1;
      const names = new Set(cfg.snippets.map((snippet) => snippet.name));
      while (names.has(`Snippet ${n}`)) n += 1;
      cfg.snippets.push({ name: `Snippet ${n}`, text: "" });
      rerender();
      host.lastElementChild?.scrollIntoView({ block: "nearest" });
    });
    heading.append(add);
    host.append(heading);
    if (!cfg.snippets.length) {
      const empty = make("div", "profiles-empty");
      empty.append(make("p", "", "No snippets yet. Add one to keep a command you type often ready to run from the palette."));
      host.append(empty);
    }
    for (const [index, snippet] of cfg.snippets.entries()) {
      const card = make("article", "snippet-card");
      const cardHead = make("div", "snippet-card-head");
      const name = this._textInput(snippet.name, "Snippet name");
      name.addEventListener("input", () => { snippet.name = name.value; });
      const remove = this._button("", "text-button danger-text");
      remove.append(icon("trash", 13), make("span", "", "Remove"));
      remove.addEventListener("click", () => {
        cfg.snippets.splice(index, 1);
        rerender();
      });
      cardHead.append(name, remove);
      const command = make("textarea", "ui-input snippet-text");
      command.rows = 2;
      command.spellcheck = false;
      command.placeholder = "git status";
      command.value = displaySnippet(snippet.text);
      command.addEventListener("keydown", (event) => event.stopPropagation());
      command.addEventListener("input", () => { snippet.text = runnableSnippet(command.value); });
      card.append(cardHead, this._field("Command", command, "Runs in the focused terminal; a trailing Enter is added for you."));
      host.append(card);
    }
  }
