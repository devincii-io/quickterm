import { displaySnippet, make, runnableSnippet } from "./panel_shared.js";
import { configEmpty, configProblems, configPurpose } from "./panel_settings_kit.js";
import { itemDirty, renderConfigList } from "./config_list.js";

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
// snippet. The footer Save still refuses the save; this only answers "which?".
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

export function renderSnippetSettings(host) {
  const cfg = this.settingsDraft;
  cfg.snippets ||= [];
  this.configSelection ||= {};
  this.configFilters ||= {};
  host.append(this._sectionHeading(
    "Snippets",
    "A command you keep, with a name you would search for and a line about what it is for. Alt+K finds it and types it into the focused terminal.",
  ));

  const focus = this.configFocus?.kind === "snippet" ? this.configFocus : null;
  this.configFocus = null;
  const remembered = this.configSelection.snippet;
  const selected = (focus?.name && cfg.snippets.find((snippet) => snippet.name === focus.name))
    || (cfg.snippets.includes(remembered) ? remembered : cfg.snippets.find((snippet) => snippet.name === this.configSelection.snippetName))
    || null;

  const addSnippet = () => {
    let n = 1;
    const names = new Set(cfg.snippets.map((snippet) => snippet.name));
    while (names.has(`Snippet ${n}`)) n += 1;
    const snippet = { name: `Snippet ${n}`, description: "", text: "" };
    cfg.snippets.push(snippet);
    list.add(snippet);
  };

  const list = renderConfigList({
    host,
    items: () => cfg.snippets,
    noun: "snippets",
    filterPlaceholder: "Filter snippets",
    addLabel: "Add snippet",
    onAdd: addSnippet,
    filter: this.configFilters.snippets || "",
    onFilter: (value) => { this.configFilters.snippets = value; },
    selected,
    onSelect: (snippet) => {
      this.configSelection.snippet = snippet;
      this.configSelection.snippetName = snippet?.name || "";
    },
    placeholder: "Choose a snippet on the left to edit it, or add one.",
    matches: (snippet, query) => [snippet.name, snippet.description, displaySnippet(snippet.text)]
      .some((field) => String(field || "").toLowerCase().includes(query.trim().toLowerCase())),
    row: (snippet) => ({
      name: snippet.name,
      summary: commandPreview(snippet.text),
      problems: snippetProblems(snippet, cfg.snippets),
      dirty: itemDirty(this.savedSnapshots, snippet),
      dot: "snippet",
    }),
    editor: (snippet, pane, { updateRow }) => renderSnippetEditor.call(this, snippet, pane, updateRow),
    removeMessage: (snippet) => `Remove the snippet "${snippet.name || "Untitled"}"?`,
    confirm: (button, message, label, action, options) => this._confirmNear(button, message, label, action, options),
    onRemove: (snippet) => {
      const at = cfg.snippets.indexOf(snippet);
      if (at >= 0) cfg.snippets.splice(at, 1);
    },
    emptyState: () => {
      const add = this._button("Add your first snippet", "primary-button compact");
      add.addEventListener("click", addSnippet);
      return configEmpty({
        lead: "No snippets yet.",
        body: "A snippet is a command you already type, kept with a note about when you reach for it. "
          + '"git status" is the smallest useful one: name it, describe it, and it is one Alt+K away in every terminal.',
        action: add,
      });
    },
  });
  this._configList = list;
  if (focus && !focus.name) requestAnimationFrame(() => list.openAdd());
  return list;
}

function renderSnippetEditor(snippet, pane, updateRow) {
  const cfg = this.settingsDraft;
  pane.append(make("h3", "config-editor-title", "Snippet"));
  pane.append(configPurpose("The command is sent to the focused terminal exactly as written. Enter is added for you, so a one-line snippet runs the moment you pick it."));
  const problemSlot = make("div", "config-problem-slot");
  pane.append(problemSlot);
  const changed = () => {
    problemSlot.textContent = "";
    const box = configProblems(snippetProblems(snippet, cfg.snippets));
    if (box) problemSlot.append(box);
    updateRow();
  };

  const fields = make("div", "settings-grid");
  const name = this._textInput(snippet.name, "git status");
  name.setAttribute("aria-label", "Snippet name");
  name.addEventListener("input", () => { snippet.name = name.value; changed(); });
  const describe = this._textInput(snippet.description, "What it does and when you want it");
  describe.setAttribute("aria-label", "Description");
  describe.addEventListener("input", () => { snippet.description = describe.value; changed(); });
  const command = make("textarea", "ui-input snippet-text");
  command.rows = 4;
  command.spellcheck = false;
  command.placeholder = "git status";
  command.value = displaySnippet(snippet.text);
  command.setAttribute("aria-label", "Command");
  command.addEventListener("keydown", (event) => event.stopPropagation());
  command.addEventListener("input", () => { snippet.text = runnableSnippet(command.value); changed(); });
  fields.append(
    this._field("Name", name, 'Shown in the palette as "snippet: name".'),
    this._field("Description", describe, "One line about what it does and when you want it."),
    this._field("Command", command, "Runs in the focused terminal; a trailing Enter is added for you."),
  );
  pane.append(fields);

  const footer = make("div", "config-editor-footer");
  const save = this._button("Save changes", "primary-button compact");
  save.title = "Save every change in Settings (Ctrl+S)";
  save.addEventListener("click", () => this._saveSettings?.());
  footer.append(save);
  pane.append(footer);
  changed();
}
