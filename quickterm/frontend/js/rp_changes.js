// The right panel's Changes tab: the branch against its target, a commit
// message, one primary button whose label follows the state (its menu holds
// the other actions), git's output with "Fix with Claude" when something
// failed, and the Staged / Changes / Committed on branch sections.

import * as wsApi from "./ws_api.js";
import { confirmNear } from "./confirm_popover.js";
import { toggleMenu } from "./menu.js";
import { itemFor, patchList, setAttrs, setClass, setText } from "./render.js";
import {
  GROUPS, branchSummary, createGitLedger, gitSteps, groupFiles, headIsPushed, hookFixPrompt, primaryAction, secondaryActions, splitPath,
} from "./right_panel_model.js";
import { gitMark, icon, iconButton, make } from "./rp_dom.js";

const BUSY_LABELS = {
  "stage-all": "Staging…", commit: "Committing…", "commit-push": "Committing…", amend: "Amending…",
  push: "Pushing…", publish: "Publishing…", pull: "Pulling…",
};
const MESSAGE_MIN_ROWS = 2;
const MESSAGE_MAX_ROWS = 6;

export function createChangesTab(ctx) {
  const el = make("section", "rp-pane rp-changes");
  el.setAttribute("aria-label", "Changes");

  const head = make("div", "rp-branch");
  const branch = make("span", "rp-branch-name");
  const target = make("span", "rp-branch-target");
  const counts = make("span", "rp-branch-counts");
  const added = make("span", "rp-branch-added");
  head.append(icon("branch", 13), branch, target, counts, added);

  const form = make("div", "rp-commit");
  const message = make("textarea", "rp-message");
  message.rows = MESSAGE_MIN_ROWS;
  message.placeholder = "Message (Ctrl+Enter to commit)";
  message.setAttribute("aria-label", "Commit message");
  message.spellcheck = false;
  const split = make("div", "rp-split");
  const primary = make("button", "rp-primary");
  primary.type = "button";
  const more = iconButton("chevron-down", "More git actions", "rp-primary-more");
  more.setAttribute("aria-haspopup", "menu");
  split.append(primary, more);
  const output = make("div", "rp-output");
  output.hidden = true;
  const outputText = make("pre", "rp-output-text");
  const outputActions = make("div", "rp-output-actions");
  const fix = make("button", "rp-text-button rp-fix", "Fix with Claude");
  fix.type = "button";
  fix.title = "Open Claude Code in this workspace with this error";
  const dismiss = make("button", "rp-text-button", "Dismiss");
  dismiss.type = "button";
  outputActions.append(fix, dismiss);
  output.append(outputText, outputActions);
  form.append(message, split, output);

  const note = make("div", "rp-note");
  note.hidden = true;
  const sections = make("div", "rp-sections");
  const capNote = make("div", "rp-note");
  capNote.hidden = true;
  el.append(head, form, note, capNote, sections);

  let data = null;
  let generation = 0;
  const ledger = createGitLedger();
  const collapsed = new Set();

  const name = () => ctx.workspace();

  // ---- sections ----

  const sectionNodes = new Map();
  for (const group of GROUPS) {
    const section = make("div", "rp-section");
    section.dataset.group = group.id;
    const header = make("div", "rp-section-head");
    const toggle = make("button", "rp-section-toggle");
    toggle.type = "button";
    const chevron = make("span", "rp-chevron");
    const title = make("span", "rp-section-title", group.title);
    const count = make("span", "rp-count");
    toggle.append(chevron, title, count);
    const actions = make("span", "rp-row-actions");
    if (group.id === "staged") {
      actions.append(sectionAction("minus", "Unstage all", (button) => run("unstage", paths("staged"), button)));
    } else if (group.id === "changes") {
      actions.append(
        sectionAction("undo", "Discard all changes", (button) => discard(paths("changes"), button, "all")),
        sectionAction("plus", "Stage all", (button) => run("stage", paths("changes"), button)),
      );
    }
    header.append(toggle, actions);
    const list = make("div", "rp-list");
    list.setAttribute("role", "list");
    section.append(header, list);
    toggle.addEventListener("click", () => {
      if (collapsed.has(group.id)) collapsed.delete(group.id);
      else collapsed.add(group.id);
      render();
    });
    sections.append(section);
    sectionNodes.set(group.id, { section, toggle, chevron, count, list, actions });
  }

  function sectionAction(iconName, title, handler) {
    const button = iconButton(iconName, title);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      handler(button);
    });
    return button;
  }

  const groups = () => groupFiles(data?.files || []);
  const paths = (group) => groups()[group].map((file) => file.path);

  function createRow() {
    const row = make("div", "rp-row rp-change");
    row.setAttribute("role", "listitem");
    row.tabIndex = 0;
    const label = make("span", "rp-name");
    const dir = make("span", "rp-dir");
    const stats = make("span", "rp-stats");
    const plus = make("span", "rp-plus");
    const minus = make("span", "rp-minus");
    stats.append(plus, minus);
    const actions = make("span", "rp-row-actions");
    const mark = make("span", "rp-git");
    row.append(label, dir, actions, stats, mark);
    const open = () => {
      const file = itemFor(row);
      if (file) ctx.openDiff(file.path, file.group === "untracked" ? "changes" : file.group);
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter") open();
      if (event.key === "ArrowDown") row.nextElementSibling?.focus();
      if (event.key === "ArrowUp") row.previousElementSibling?.focus();
    });
    return row;
  }

  function updateRow(row, file) {
    const { name: base, dir } = splitPath(file.path);
    const [label, dirNode, actions, stats, mark] = row.children;
    setText(label, base);
    setText(dirNode, dir);
    setText(stats.children[0], file.added != null ? `+${file.added}` : "");
    setText(stats.children[1], file.removed ? `-${file.removed}` : "");
    const git = gitMark(file.status);
    setText(mark, git.text);
    setAttrs(mark, { title: git.title || false });
    setClass(row, "git-new", git.tint === "git-new");
    setClass(row, "git-mod", git.tint === "git-mod");
    setClass(row, "git-del", git.tint === "git-del");
    row.title = file.path;
    const kind = file.group === "staged" ? "staged" : file.group === "committed" ? "committed" : "changes";
    if (actions.dataset.kind !== kind) {
      actions.dataset.kind = kind;
      actions.replaceChildren();
      if (kind === "staged") {
        actions.append(sectionAction("minus", "Unstage", (button) => run("unstage", [itemFor(row).path], button)));
      } else if (kind === "changes") {
        actions.append(
          sectionAction("undo", "Discard changes", (button) => discard([itemFor(row).path], button, itemFor(row))),
          sectionAction("plus", "Stage", (button) => run("stage", [itemFor(row).path], button)),
        );
      }
    }
  }

  function render() {
    const summary = branchSummary(data);
    head.hidden = !summary;
    if (summary) {
      setText(branch, summary.branch);
      setText(target, summary.target ? `→ ${summary.target}` : "");
      const ab = [summary.ahead ? `↑${summary.ahead}` : "", summary.behind ? `↓${summary.behind}` : ""].filter(Boolean).join(" ");
      setText(counts, ab);
      setText(added, summary.added ? `+${summary.added}` : "");
      head.title = summary.target
        ? `${summary.branch} against ${summary.target}: ${summary.ahead} ahead, ${summary.behind} behind, ${summary.added} lines added on the branch`
        : summary.branch;
    }
    const grouped = groups();
    for (const group of GROUPS) {
      const nodes = sectionNodes.get(group.id);
      const files = grouped[group.id];
      nodes.section.hidden = !data || (group.id !== "changes" && !files.length);
      const open = !collapsed.has(group.id);
      nodes.chevron.replaceChildren(icon(open ? "chevron-down" : "chevron-right", 12));
      setText(nodes.count, String(files.length));
      nodes.toggle.setAttribute("aria-expanded", String(open));
      nodes.list.hidden = !open;
      nodes.actions.hidden = !files.length;
      patchList(nodes.list, open ? files : [], { key: (file) => `${file.group}:${file.path}`, create: createRow, update: updateRow });
    }
    renderPrimary();
  }

  // What runs and what it said belong to the workspace it ran in, not to the
  // one on screen when it finishes: a switch mid-commit must neither free the
  // button of the workspace still committing nor show its output elsewhere.
  const busyIn = () => ledger.busy(name());

  function renderPrimary() {
    const action = primaryAction(data, message.value);
    const busy = busyIn();
    setText(primary, busy ? BUSY_LABELS[busy] || "Working…" : action.label);
    primary.disabled = Boolean(busy) || !action.enabled;
    primary.dataset.action = action.id || "";
    primary.title = action.hint || "";
    more.disabled = Boolean(busy) || !data;
    form.hidden = !data;
  }

  function fitMessage() {
    message.rows = MESSAGE_MIN_ROWS;
    const lines = message.value.split("\n").length;
    message.rows = Math.min(MESSAGE_MAX_ROWS, Math.max(MESSAGE_MIN_ROWS, lines));
  }

  function paintOutput() {
    const entry = ledger.said(name());
    setText(outputText, entry?.text || "");
    output.hidden = !entry?.text;
    setClass(output, "failed", Boolean(entry?.failure));
    fix.hidden = !entry?.failure;
  }

  function showOutput(workspace, text, failure = null) {
    ledger.say(workspace, text, failure);
    if (workspace === name()) paintOutput();
  }

  // Refresh only while the workspace an action ran in is still on screen.
  async function refreshIf(workspace) {
    if (workspace === name()) await refresh();
  }

  // ---- actions ----

  async function run(action, list, trigger) {
    const workspace = name();
    if (!workspace || !list.length) return false;
    try {
      const answer = await wsApi.changeFiles(workspace, action, list);
      if (!answer.ok) showOutput(workspace, answer.output || `git could not ${action} that.`);
    } catch (error) {
      showOutput(workspace, error.detail || `Could not ${action} that.`);
    }
    await refreshIf(workspace);
    trigger?.isConnected && trigger.focus?.();
    return true;
  }

  function discard(list, trigger, what) {
    const workspace = name();
    const untracked = what && what !== "all" && what.group === "untracked";
    const text = what === "all"
      ? `Discard all ${list.length} changes? Untracked files are deleted. This cannot be undone.`
      : untracked
        ? `Delete ${splitPath(what.path).name}? It is not tracked by git. This cannot be undone.`
        : `Discard the changes to ${splitPath(what.path).name}? This cannot be undone.`;
    confirmNear(trigger, {
      message: text,
      confirmLabel: untracked ? "Delete" : "Discard",
      action: async () => {
        const answer = await wsApi.changeFiles(workspace, "discard", list);
        await refreshIf(workspace);
        if (!answer.ok) throw { detail: answer.output || "git could not discard that." };
      },
      onClose: () => (trigger.isConnected ? trigger.focus() : message.focus()),
    });
  }

  async function git(action) {
    const workspace = name();
    // Everything the steps decide on is taken now, from this workspace.
    const text = message.value;
    const steps = gitSteps(action, { upstream: Boolean(data?.upstream) });
    const staged = paths("staged");
    const changed = paths("changes");
    if (!ledger.start(workspace, action)) return;
    renderPrimary();
    paintOutput();
    try {
      if (action === "stage-all") {
        const answer = await wsApi.changeFiles(workspace, "stage", changed);
        if (!answer.ok) showOutput(workspace, answer.output || "git could not stage the changes.");
      } else {
        for (const step of steps) {
          const commitLike = step === "commit" || step === "amend";
          const answer = await wsApi.gitAction(workspace, step, commitLike ? (text.trim() ? text : null) : null);
          if (!answer.ok) {
            showOutput(workspace, answer.output || `git ${step} failed.`,
              commitLike ? { output: answer.output, message: text, staged } : null);
            break;
          }
          if (commitLike && workspace === name() && message.value === text) {
            message.value = "";
            fitMessage();
          }
        }
      }
    } catch (error) {
      showOutput(workspace, error.detail || "That git action did not work.");
    } finally {
      ledger.finish(workspace);
      if (workspace === name()) renderPrimary();
      await refreshIf(workspace);
    }
  }

  function runPrimary() {
    const id = primary.dataset.action;
    if (id) git(id);
  }

  primary.addEventListener("click", runPrimary);
  more.addEventListener("click", () => {
    toggleMenu({
      anchor: split,
      trigger: more,
      align: "end",
      label: "Git actions",
      items: secondaryActions(data, message.value).map((item) => ({
        label: item.label,
        disabled: !item.enabled,
        run: () => {
          if (item.id === "amend" && headIsPushed(data)) {
            confirmNear(more, {
              message: "The last commit is already pushed. Amending it rewrites history others may have. Amend anyway?",
              confirmLabel: "Amend",
              action: async () => { await git("amend"); },
              onClose: () => message.focus(),
            });
            return;
          }
          git(item.id);
        },
      })),
      onClose: () => more.focus(),
    });
  });
  message.addEventListener("input", () => {
    fitMessage();
    renderPrimary();
  });
  message.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.ctrlKey) {
      event.preventDefault();
      if (paths("staged").length && message.value.trim()) git("commit");
    }
  });
  // Bound to the workspace whose commit failed, whichever is on screen.
  fix.addEventListener("click", () => {
    const workspace = name();
    const failure = ledger.said(workspace)?.failure;
    if (failure) ctx.fixWithClaude((max) => hookFixPrompt(failure, max), workspace);
  });
  dismiss.addEventListener("click", () => showOutput(name(), ""));

  // ---- lifecycle ----

  async function refresh() {
    const run = generation;
    const workspace = name();
    if (!workspace) {
      data = null;
      setText(note, ctx.emptyText());
      note.hidden = false;
      render();
      return;
    }
    try {
      const answer = await wsApi.getChanges(workspace);
      if (run !== generation) return;
      data = answer;
      ctx.noteChanges?.(workspace, answer);
      note.hidden = true;
    } catch (error) {
      if (run !== generation) return;
      data = null;
      ctx.noteChanges?.(workspace, null);
      setText(note, error.status === 409 ? "Not a git repository." : error.detail || "Could not read the changes.");
      note.hidden = false;
    }
    setText(capNote, data?.truncated ? "Showing the first 5000 files of each kind." : "");
    capNote.hidden = !data?.truncated;
    render();
  }

  function reset() {
    generation++;
    data = null;
    message.value = "";
    fitMessage();
    paintOutput();
    capNote.hidden = true;
    render();
  }

  render();
  return {
    id: "changes",
    title: "Changes",
    icon: "branch",
    el,
    refresh,
    reset,
    interval: 10000,
    focus: () => (form.hidden ? sections.querySelector(".rp-row")?.focus() : message.focus()),
  };
}
