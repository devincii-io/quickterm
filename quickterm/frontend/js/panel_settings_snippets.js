import { icon } from "./icons.js";
import {
  displaySnippet, make, runnableSnippet,
} from "./panel_shared.js";
import {
  FILTER_THRESHOLD, configDescription, configEmpty, configFilter, configNoMatch,
  configProblems, configPurpose, configSummary, matchesQuery,
} from "./panel_settings_kit.js";

// The one-line preview of what a snippet sends. The stored text ends in the
// carriage return that runs it, which `displaySnippet` hides; a multi-line
// snippet must not stretch a row, so only the first line is shown and the rest
// is counted.
export function commandPreview(text) {
  const body = displaySnippet(text);
  if (!body.trim()) return "no command yet";
  const lines = body.split("\n");
  const head = lines[0].length > 72 ? `${lines[0].slice(0, 71)}…` : lines[0];
  return lines.length > 1 ? `${head} … (+${lines.length - 1} more)` : head;
}

// Everything that would stop this one snippet from working, said at the
// snippet. panels.js `_settings()` still refuses the save; this only answers
// "which one?", which a single footer line never could.
export function snippetProblems(snippet, all) {
  const name = (snippet.name || "").trim();
  const problems = [];
  if (!name) {
    problems.push("This snippet has no name, so the palette cannot offer it.");
  } else if (all.filter((other) => (other.name || "").trim().toLowerCase() === name.toLowerCase()).length > 1) {
    problems.push("Another snippet already has this name. Names must be unique.");
  }
  if (!displaySnippet(snippet.text).trim()) {
    problems.push("This snippet has no command, so there is nothing to run.");
  }
  return problems;
}

export function renderSnippetSettings(host, rerender) {
    const cfg = this.settingsDraft;
    cfg.snippets ||= [];
    this.settingsFilters ||= { terminals: "", snippets: "" };
    const heading = this._sectionHeading(
      "Snippets",
      "A snippet is a command you keep: a name you would search for, a line saying what it is for, and the exact keystrokes. Alt+K finds it and types it into the focused terminal.",
    );
    const addSnippet = () => {
      let n = 1;
      const names = new Set(cfg.snippets.map((snippet) => snippet.name));
      while (names.has(`Snippet ${n}`)) n += 1;
      cfg.snippets.push({ name: `Snippet ${n}`, description: "", text: "" });
      // A new card the active filter would hide reads as a button that did
      // nothing, so adding always clears the filter.
      this.settingsFilters.snippets = "";
      rerender();
      host.lastElementChild?.scrollIntoView({ block: "nearest" });
    };
    const add = this._button("", "primary-button compact");
    add.append(icon("plus", 13), make("span", "", "Add snippet"));
    add.addEventListener("click", addSnippet);
    heading.append(add);
    host.append(heading);

    if (!cfg.snippets.length) {
      const emptyAdd = this._button("", "primary-button compact");
      emptyAdd.append(icon("plus", 13), make("span", "", "Add your first snippet"));
      emptyAdd.addEventListener("click", addSnippet);
      host.append(configEmpty({
        lead: "No snippets yet.",
        body: "A snippet is a command you already type, kept with a note about when you reach for it. "
          + "“git status” is the smallest useful one: name it, describe it, and it is one Alt+K away in every terminal.",
        action: emptyAdd,
      }));
      return;
    }

    const buildCard = (snippet) => {
      const el = make("article", "snippet-card");
      const cardHead = make("div", "snippet-card-head");
      const identity = make("div", "config-identity");
      const title = make("h3", "", snippet.name || "Untitled snippet");
      let description = configDescription(snippet.description);
      const summary = configSummary(commandPreview(snippet.text));
      identity.append(title, description, summary);
      const remove = this._button("", "text-button danger-text");
      remove.append(icon("trash", 13), make("span", "", "Remove"));
      remove.addEventListener("click", () => {
        // Splice by identity: the visible list is filtered, so its position is
        // not the position in the draft.
        const at = cfg.snippets.indexOf(snippet);
        if (at >= 0) cfg.snippets.splice(at, 1);
        rerender();
      });
      cardHead.append(identity, remove);
      el.append(cardHead);

      const problemSlot = make("div", "config-problem-slot");
      const showProblems = () => {
        problemSlot.textContent = "";
        const box = configProblems(snippetProblems(snippet, cfg.snippets));
        if (box) problemSlot.append(box);
      };
      showProblems();
      el.append(problemSlot);

      el.append(configPurpose(
        "The command is sent to the focused terminal exactly as written. Enter is added for you, so a one-line snippet runs the moment you pick it.",
      ));

      const fields = make("div", "settings-grid two-column");
      const name = this._textInput(snippet.name, "git status");
      name.addEventListener("input", () => {
        snippet.name = name.value;
        title.textContent = name.value || "Untitled snippet";
        showProblems();
      });
      const describe = this._textInput(snippet.description, "What it does and when you want it");
      describe.addEventListener("input", () => {
        snippet.description = describe.value;
        const fresh = configDescription(describe.value);
        description.replaceWith(fresh);
        description = fresh;
      });
      fields.append(
        this._field("Snippet name", name, "Shown in the palette as “snippet: name”, so name it the way you would search for it."),
        this._field("Description", describe, "One line about what it does and when you want it. It is what makes a list of snippets readable a month from now."),
      );
      el.append(fields);

      const command = make("textarea", "ui-input snippet-text");
      command.rows = 2;
      command.spellcheck = false;
      command.placeholder = "git status";
      command.value = displaySnippet(snippet.text);
      command.addEventListener("keydown", (event) => event.stopPropagation());
      command.addEventListener("input", () => {
        snippet.text = runnableSnippet(command.value);
        summary.textContent = commandPreview(snippet.text);
        summary.title = summary.textContent;
        showProblems();
      });
      el.append(this._field("Command", command, "Runs in the focused terminal; a trailing Enter is added for you."));
      return el;
    };

    // The list lives in its own host so typing in the filter repaints only the
    // cards. Rebuilding the input under the caret would drop focus on every
    // keystroke.
    const listHost = make("div", "config-list");
    let filterCount = null;
    const paint = () => {
      const query = this.settingsFilters.snippets;
      listHost.textContent = "";
      const visible = cfg.snippets.filter((snippet) =>
        matchesQuery(query, snippet.name, snippet.description, displaySnippet(snippet.text)));
      if (filterCount) {
        filterCount.textContent = visible.length === cfg.snippets.length
          ? `${cfg.snippets.length} snippets`
          : `${visible.length} of ${cfg.snippets.length}`;
      }
      if (!visible.length) {
        listHost.append(configNoMatch(query, "snippets"));
        return;
      }
      for (const snippet of visible) listHost.append(buildCard(snippet));
    };

    if (cfg.snippets.length >= FILTER_THRESHOLD) {
      const filter = configFilter({
        value: this.settingsFilters.snippets,
        placeholder: "Filter snippets by name, description or command",
        onInput: (value) => {
          this.settingsFilters.snippets = value;
          paint();
        },
      });
      filterCount = filter.count;
      host.append(filter.el);
    }
    host.append(listHost);
    paint();
  }
