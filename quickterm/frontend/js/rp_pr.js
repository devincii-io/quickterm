// The right panel's Pull request tab: the branch's PR through gh, its
// checks grouped failing / pending / passing, a failing check's log tail,
// a merge split button, and "Fix with Claude" for failed checks.

import * as api from "./api.js";
import * as wsApi from "./ws_api.js";
import { confirmNear } from "./confirm_popover.js";
import { toggleMenu } from "./menu.js";
import { itemFor, patchList, setClass, setText } from "./render.js";
import { checkGroups, checksFixPrompt, mergeChoices, prBadge, prEmptyLine } from "./right_panel_model.js";
import { icon, iconButton, make } from "./rp_dom.js";

const GROUP_TITLES = { failing: "Failing", pending: "Pending", passing: "Passing" };
const CHECK_ICONS = { failing: "x-circle", pending: "spinner", passing: "check-circle" };

export function createPrTab(ctx) {
  const el = make("section", "rp-pane rp-pr");
  el.setAttribute("aria-label", "Pull request");
  const empty = make("div", "rp-note rp-pr-empty");
  const emptyText = make("span");
  const emptyCommand = make("code", "rp-command");
  empty.append(emptyText, emptyCommand);
  empty.hidden = true;

  const head = make("div", "rp-pr-head");
  const number = make("span", "rp-pr-number");
  const badge = make("span", "rp-pr-badge");
  const openLink = iconButton("arrow-up-right", "Open the pull request in the browser");
  const top = make("div", "rp-pr-top");
  top.append(number, badge, openLink);
  const title = make("div", "rp-pr-title");
  const refs = make("div", "rp-pr-refs");
  const split = make("div", "rp-split rp-merge");
  const merge = make("button", "rp-primary rp-merge-main");
  merge.type = "button";
  const mergeMore = iconButton("chevron-down", "Other merge methods", "rp-primary-more");
  split.append(merge, mergeMore);
  const mergeOutput = make("pre", "rp-output-text rp-merge-output");
  mergeOutput.hidden = true;
  head.append(top, title, refs, split, mergeOutput);
  head.hidden = true;

  const checks = make("div", "rp-sections rp-checks");
  el.append(empty, head, checks);

  let data = null;
  let generation = 0;
  let loading = false;
  const expanded = new Set();
  const logs = new Map();

  const name = () => ctx.workspace();

  const groupNodes = new Map();
  for (const id of ["failing", "pending", "passing"]) {
    const section = make("div", `rp-section rp-check-group ${id}`);
    const header = make("div", "rp-section-head");
    const label = make("span", "rp-section-title");
    const count = make("span", "rp-count");
    const actions = make("span", "rp-row-actions rp-always");
    if (id === "failing") {
      const fixAll = make("button", "rp-text-button rp-fix", "Fix with Claude");
      fixAll.type = "button";
      fixAll.title = "Open Claude Code with every failed check and its log";
      fixAll.addEventListener("click", () => fixChecks(checkGroups(data?.checks || []).failing));
      actions.append(fixAll);
    }
    header.append(label, count, actions);
    const list = make("div", "rp-list");
    section.append(header, list);
    checks.append(section);
    groupNodes.set(id, { section, label, count, list });
  }

  function createCheck() {
    const row = make("div", "rp-check");
    const line = make("div", "rp-row rp-check-line");
    line.tabIndex = 0;
    const status = make("span", "rp-check-icon");
    const label = make("span", "rp-name");
    const workflow = make("span", "rp-dir");
    const actions = make("span", "rp-row-actions");
    const fixOne = make("button", "rp-text-button rp-fix", "Fix");
    fixOne.type = "button";
    fixOne.title = "Fix with Claude: open Claude Code with this check's log";
    const link = iconButton("arrow-up-right", "Open the check in the browser");
    actions.append(fixOne, link);
    line.append(status, label, workflow, actions);
    const log = make("pre", "rp-log");
    log.hidden = true;
    row.append(line, log);
    const toggle = () => {
      const check = itemFor(row);
      if (!check || check.group !== "failing") return;
      const key = checkKey(check);
      if (expanded.has(key)) expanded.delete(key);
      else {
        expanded.add(key);
        loadLog(check);
      }
      render();
    };
    line.addEventListener("click", toggle);
    line.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });
    link.addEventListener("click", (event) => {
      event.stopPropagation();
      const check = itemFor(row);
      if (check?.link) api.openTarget(check.link).catch((error) => ctx.showError(error.detail || "Could not open the link."));
    });
    fixOne.addEventListener("click", (event) => {
      event.stopPropagation();
      const check = itemFor(row);
      if (check) fixChecks([check]);
    });
    return row;
  }

  function updateCheck(row, check) {
    const [line, log] = row.children;
    const [status, label, workflow, actions] = line.children;
    if (status.dataset.group !== check.group) {
      status.dataset.group = check.group;
      status.replaceChildren(icon(CHECK_ICONS[check.group], 14));
    }
    setText(label, check.name || "check");
    setText(workflow, check.workflow || "");
    actions.children[0].hidden = check.group !== "failing";
    actions.children[1].hidden = !check.link;
    const failing = check.group === "failing";
    const open = failing && expanded.has(checkKey(check));
    setClass(line, "expandable", failing);
    if (failing) line.setAttribute("aria-expanded", String(open));
    else line.removeAttribute("aria-expanded");
    log.hidden = !open;
    const entry = logs.get(checkKey(check));
    setText(log, !entry ? "" : entry.loading ? "Loading the log…" : entry.text || "No log output.");
    line.title = check.state ? `${check.name}: ${String(check.state).toLowerCase()}` : check.name || "";
  }

  const checkKey = (check) => `${check.workflow || ""}/${check.name || ""}/${check.run_id || ""}`;

  async function loadLog(check, workspace = name()) {
    const key = checkKey(check);
    if (logs.has(key) && !logs.get(key).failed) return logs.get(key).text;
    if (!check.run_id) {
      logs.set(key, { text: "This check has no GitHub Actions run to read a log from." });
      render();
      return "";
    }
    logs.set(key, { loading: true });
    render();
    try {
      const answer = await wsApi.getPrLog(workspace, check.run_id, check.job_id);
      logs.set(key, { text: answer.text || "" });
    } catch (error) {
      logs.set(key, { text: error.detail || "Could not read the log.", failed: true });
    }
    render();
    return logs.get(key).text;
  }

  // Bound to the workspace and PR shown at the click: the logs load first,
  // and a switch meanwhile must not hand them to another workspace.
  async function fixChecks(failed) {
    if (!failed.length) return;
    const workspace = name();
    const pr = data?.pr || null;
    const withLogs = await Promise.all(failed.map(async (check) => ({ ...check, log: await loadLog(check, workspace) })));
    ctx.fixWithClaude((max) => checksFixPrompt({ pr, checks: withLogs }, max), workspace);
  }

  function render() {
    const line = prEmptyLine(data);
    empty.hidden = !line && !loading;
    if (!data && loading) {
      setText(emptyText, "Asking GitHub…");
      setText(emptyCommand, "");
      emptyCommand.hidden = true;
    } else if (line) {
      setText(emptyText, line.text);
      setText(emptyCommand, line.command || "");
      emptyCommand.hidden = !line.command;
    }
    const pr = data?.pr || null;
    head.hidden = !pr;
    checks.hidden = !pr;
    if (!pr) return;
    setText(number, `#${pr.number}`);
    const state = prBadge(pr);
    setText(badge, state || "");
    badge.dataset.state = (state || "").toLowerCase();
    setText(title, pr.title || "");
    setText(refs, pr.headRefName && pr.baseRefName ? `${pr.headRefName} → ${pr.baseRefName}` : "");
    const choices = mergeChoices(pr);
    split.hidden = !choices.length;
    if (choices.length) {
      setText(merge, choices[0].label);
      merge.dataset.method = choices[0].method;
      mergeMore.hidden = choices.length < 2;
    }
    const grouped = checkGroups(data.checks || []);
    for (const [id, nodes] of groupNodes) {
      const list = grouped[id].map((check) => ({ ...check, group: id }));
      nodes.section.hidden = !list.length;
      setText(nodes.label, GROUP_TITLES[id]);
      setText(nodes.count, String(list.length));
      patchList(nodes.list, list, { key: checkKey, create: createCheck, update: updateCheck });
    }
  }

  // The merge names the PR and head commit this confirmation showed; the
  // backend refuses if either changed since.
  function askMerge(choice, trigger) {
    const pr = data?.pr;
    const workspace = name();
    if (!pr || !workspace) return;
    confirmNear(trigger, {
      message: `${choice.label}: pull request #${pr.number} into ${pr.baseRefName || "its base"}?`,
      confirmLabel: "Merge",
      action: async () => {
        const answer = await wsApi.mergePr(workspace, choice.method, pr.number, pr.headRefOid);
        if (workspace !== name()) return;
        mergeOutput.textContent = answer.output || "";
        mergeOutput.hidden = !answer.output || answer.ok;
        await refresh();
        if (!answer.ok) throw { detail: answer.output || "gh could not merge the pull request." };
      },
      onClose: () => (trigger.isConnected ? trigger.focus() : null),
    });
  }

  merge.addEventListener("click", () => {
    const choice = mergeChoices(data?.pr).find((item) => item.method === merge.dataset.method);
    if (choice) askMerge(choice, merge);
  });
  mergeMore.addEventListener("click", () => {
    toggleMenu({
      anchor: split,
      trigger: mergeMore,
      align: "end",
      label: "Merge methods",
      items: mergeChoices(data?.pr).map((choice) => ({ label: choice.label, run: () => askMerge(choice, merge) })),
      onClose: () => mergeMore.focus(),
    });
  });
  openLink.addEventListener("click", () => {
    if (data?.pr?.url) api.openTarget(data.pr.url).catch((error) => ctx.showError(error.detail || "Could not open the link."));
  });

  async function refresh() {
    const run = generation;
    const workspace = name();
    if (!workspace) {
      data = { gh: "ok", pr: null, checks: [], reason: null };
      setText(emptyText, ctx.emptyText());
      empty.hidden = false;
      emptyCommand.hidden = true;
      head.hidden = true;
      checks.hidden = true;
      return;
    }
    loading = true;
    if (!data) render();
    try {
      const answer = await wsApi.getPr(workspace);
      if (run !== generation) return;
      data = answer;
      ctx.notePr?.(workspace, answer);
    } catch (error) {
      if (run !== generation) return;
      if (data?.pr) {
        // Keep the pull request on screen; the next poll tries again.
        loading = false;
        render();
        return;
      }
      data = { gh: "ok", pr: null, checks: [], reason: error.detail || "Could not ask GitHub." };
      loading = false;
      render();
      setText(emptyText, data.reason);
      emptyCommand.hidden = true;
      return;
    }
    loading = false;
    render();
  }

  function reset() {
    generation++;
    data = null;
    loading = false;
    expanded.clear();
    logs.clear();
    mergeOutput.hidden = true;
    render();
  }

  render();
  return {
    id: "pr",
    title: "Pull request",
    icon: "pr",
    el,
    refresh,
    reset,
    interval: 30000,
    focus: () => (el.querySelector(".rp-row, button:not([hidden])") || el).focus?.(),
  };
}
