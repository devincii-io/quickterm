// The two editors of a workspace's setup in Workspace settings
// (panel_workspace.js): environment variables as name and value rows, and
// the "Start with" list. The rules are workspace_setup.js; this draws them.
//
// Both patch their rows (render.js) so adding, removing or moving one keeps
// the keyboard where it was, and every listener reads itemFor(node), never
// the row it was built for.

import { agentModeOf, isAgentType } from "./agent_profile.js";
import { icon } from "./icons.js";
import { make } from "./panel_shared.js";
import { renderAgentFields } from "./panel_agent_fields.js";
import { configChoice, panelMenu } from "./panel_settings_kit.js";
import { itemFor, patchList, setAttrs, setText } from "./render.js";
import { DEFAULT_SHELL, availableShells, shellValueLabel } from "./shell_choice.js";
import {
  STARTUP_KINDS, STARTUP_MAX, addStartupItem, canAddStartup, envFromRows, envProblems, envRows, envValueType,
  moveStartupItem, newEnvRow, removeStartupItem, setStartupKind, startupKindLabel, startupProblems,
} from "./workspace_setup.js";

function textInput(value, placeholder, label) {
  const input = make("input", "ui-input");
  input.value = value ?? "";
  input.placeholder = placeholder || "";
  input.spellcheck = false;
  input.autocomplete = "off";
  if (label) input.setAttribute("aria-label", label);
  // keys.js must not read the typing; the sheet still sees Escape and Tab
  // in its capture listener.
  input.addEventListener("keydown", (event) => event.stopPropagation());
  return input;
}

function iconButton(name, label, className = "icon-button") {
  const button = make("button", className);
  button.type = "button";
  button.append(icon(name, 14));
  button.title = label;
  button.setAttribute("aria-label", label);
  return button;
}

function setProblem(node, text) {
  setText(node, text || "");
  node.hidden = !text;
}

/**
 * Name and value rows. A value is masked until its field has the keyboard.
 * `onChange(env)` runs after every edit with the variables as they would be
 * saved. Returns `{el, value(), check(), focusProblem()}`.
 */
export function envEditor({ env = {}, addLabel = "Add variable", note = "", onChange } = {}) {
  let rows = envRows(env);
  const box = make("div", "setup-env");
  const list = make("div", "setup-env-rows");
  const listProblem = make("p", "setup-problem");
  listProblem.hidden = true;
  const add = make("button", "secondary-button compact setup-env-add", addLabel);
  add.type = "button";
  add.title = "Values are encrypted on disk with your Windows account.";
  box.append(list, listProblem, add);
  if (note) box.append(make("p", "field-hint setup-note", note));

  const parts = new WeakMap();
  const changed = () => {
    check();
    onChange?.(envFromRows(rows));
  };
  const spec = {
    key: (row) => row.key,
    create: () => {
      const line = make("div", "setup-env-row");
      const name = textInput("", "NAME", "Variable name");
      name.classList.add("setup-env-name");
      const value = textInput("", "value", "Variable value");
      value.type = envValueType(false);
      value.classList.add("setup-env-value");
      const remove = iconButton("x", "Remove variable");
      const problem = make("p", "setup-problem");
      problem.hidden = true;
      line.append(name, value, remove, problem);
      parts.set(line, { name, value, problem });
      name.addEventListener("input", () => {
        const row = itemFor(line);
        if (row) row.name = name.value;
        changed();
      });
      value.addEventListener("input", () => {
        const row = itemFor(line);
        if (row) row.value = value.value;
        changed();
      });
      value.addEventListener("focus", () => { value.type = envValueType(true); });
      value.addEventListener("blur", () => { value.type = envValueType(false); });
      remove.addEventListener("click", () => {
        const index = rows.indexOf(itemFor(line));
        if (index < 0) return;
        rows = rows.filter((_, at) => at !== index);
        draw();
        changed();
        // The row that moved up, else the one before, else Add.
        const next = list.children[Math.min(index, list.children.length - 1)];
        (next ? parts.get(next)?.name : add).focus();
      });
      return line;
    },
    update: (line, row) => {
      const { name, value } = parts.get(line);
      if (name.value !== row.name) name.value = row.name;
      if (value.value !== row.value) value.value = row.value;
    },
  };
  function draw() {
    patchList(list, rows, spec);
  }
  function check() {
    const problems = envProblems(rows);
    for (const line of list.children) {
      const { name, value, problem } = parts.get(line);
      const found = problems.byKey.get(itemFor(line)?.key) || {};
      setAttrs(name, { "aria-invalid": found.name ? "true" : false });
      setAttrs(value, { "aria-invalid": found.value ? "true" : false });
      setProblem(problem, found.name || found.value || "");
    }
    setProblem(listProblem, problems.list);
    return problems;
  }
  add.addEventListener("click", () => {
    rows = [...rows, newEnvRow()];
    draw();
    parts.get(list.lastElementChild)?.name.focus();
  });
  draw();
  check();
  return {
    el: box,
    value: () => envFromRows(rows),
    check,
    focusProblem() {
      const problems = check();
      for (const line of list.children) {
        const found = problems.byKey.get(itemFor(line)?.key);
        if (found) {
          (found.name ? parts.get(line).name : parts.get(line).value).focus();
          return true;
        }
      }
      if (problems.list) add.focus();
      return Boolean(problems.list);
    },
  };
}

// What renderAgentFields edits for one item. A mode the item leaves open is
// shown as the one Settings > Agents starts, and only a choice writes it.
function agentView(item, fallbackMode) {
  return {
    terminal_type: item.kind,
    get agent_mode() { return item.agent_mode ?? fallbackMode; },
    set agent_mode(value) { item.agent_mode = value; },
    get agent() { return item.agent || (item.agent = {}); },
    set agent(value) { item.agent = value; },
    // The pre-4.0 key setAgentMode writes for Claude; an item has no use for it.
    set claude_mode(_) { /* dropped */ },
  };
}

/**
 * The "Start with" list: a type menu, a name, a command for a shell, the
 * agent's mode and options, and the item's own variables; up, down and
 * remove on every item; at most STARTUP_MAX. `catalog()` resolves to GET
 * /api/system/agents, `agentSettings(kind)` to that agent's saved settings.
 * Returns `{el, value(), check(), focusProblem()}`.
 */
export function startupEditor({
  items: initial = [], catalog, shells, defaultShell = DEFAULT_SHELL, agentSettings = () => null, remote = false, onChange,
} = {}) {
  let items = [...initial];
  // Which shell a shell item starts on this PC: "" is the configured one.
  // One list shared by every item's menu, filled once the inventory answers
  // (configChoice reads it when it opens).
  const shellOptions = [{ value: "", label: `Default (${shellValueLabel(defaultShell)})` }];
  if (!remote) {
    Promise.resolve(shells?.()).catch(() => null).then((inventory) => {
      if (!inventory) return;
      shellOptions.push(...availableShells(inventory, defaultShell));
      for (const node of list.children) parts.get(node)?.shell.set(itemFor(node)?.shell || "");
    });
  }
  const box = make("div", "setup-start");
  const list = make("ol", "setup-start-list");
  const empty = make("p", "field-hint setup-start-empty",
    "Nothing yet: the workspace opens with one shell.");
  const listProblem = make("p", "setup-problem");
  listProblem.hidden = true;
  const add = make("button", "secondary-button compact setup-start-add");
  add.type = "button";
  add.setAttribute("aria-haspopup", "menu");
  box.append(list, empty, listProblem, add);

  const parts = new WeakMap();
  const changed = () => {
    check();
    onChange?.();
  };

  function drawAgent(node, item) {
    const part = parts.get(node);
    if (part.agentKind === item.kind) return;
    part.agentKind = item.kind;
    part.agentHost.textContent = "";
    part.agentHost.hidden = !isAgentType(item.kind);
    if (!isAgentType(item.kind)) return;
    part.agentHost.append(make("p", "config-detail-placeholder", "Loading options…"));
    const kind = item.kind;
    Promise.resolve(catalog?.()).catch(() => null).then((answer) => {
      // The type may have changed while the catalog loaded.
      if (part.agentKind !== kind) return;
      const type = answer?.types?.find((entry) => entry.id === kind) || null;
      const saved = agentSettings(kind);
      const fallback = agentModeOf({ agent_mode: saved?.agent_mode ?? null }, kind);
      part.agentHost.textContent = "";
      // Without the catalog only the mode is offered, with a note saying so.
      renderAgentFields(part.agentHost, agentView(itemFor(node), fallback), type, { onChange: changed });
    });
  }

  const spec = {
    key: (item) => item.key,
    create: () => {
      const node = make("li", "setup-item");
      const head = make("div", "setup-item-head");
      const number = make("span", "setup-item-number");
      const kind = configChoice({
        label: "Type",
        value: "shell",
        options: STARTUP_KINDS.map((entry) => ({ value: entry.id, label: entry.label })),
        onChange: (next) => {
          const item = itemFor(node);
          if (!item) return;
          setStartupKind(item, next);
          spec.update(node, item);
          changed();
        },
      });
      kind.el.classList.add("setup-item-kind");
      const name = textInput("", "Name (optional)", "Terminal name");
      name.classList.add("setup-item-name");
      const up = iconButton("chevron-down", "Move up", "icon-button setup-item-up");
      const down = iconButton("chevron-down", "Move down", "icon-button setup-item-down");
      const remove = iconButton("x", "Remove", "icon-button setup-item-remove");
      head.append(number, kind.el, name, up, down, remove);

      const shell = configChoice({
        label: "Shell",
        value: "",
        options: shellOptions,
        onChange: (next) => {
          const item = itemFor(node);
          if (!item) return;
          item.shell = next || null;
          changed();
        },
      });
      const shellField = make("div", "settings-field setup-item-shell-field");
      shellField.append(make("span", "field-label", "Shell"), shell.el);
      shellField.hidden = true;
      const command = textInput("", "e.g. npm run dev", "Command");
      command.classList.add("setup-item-command");
      const commandField = make("label", "settings-field setup-item-command-field");
      commandField.append(make("span", "field-label", "Command"), command,
        make("span", "field-hint", "Runs in the shell, which then stays at its prompt. Empty: a plain shell."));
      const agentHost = make("div", "agent-fields setup-item-agent");
      const envBox = make("details", "config-advanced setup-item-env");
      const envSummary = make("summary", "", "Variables for this terminal");
      envBox.append(envSummary);
      const problem = make("p", "setup-problem");
      problem.hidden = true;
      node.append(head, shellField, commandField, agentHost, envBox, problem);

      parts.set(node, {
        number, kind, name, up, down, remove, shell, shellField, command, commandField, agentHost, envBox, envSummary, env: null,
        problem, agentKind: null,
      });
      // The editor starts empty; it is filled from the item on first open.
      let envDrawn = false;
      envBox.addEventListener("toggle", () => {
        if (!envBox.open || envDrawn) return;
        envDrawn = true;
        const item = itemFor(node);
        const filled = envEditor({
          env: item?.env || {},
          onChange: (value) => {
            const current = itemFor(node);
            if (!current) return;
            current.env = Object.keys(value).length ? value : null;
            setText(envSummary, envLabel(current));
            changed();
          },
        });
        parts.get(node).env = filled;
        envBox.append(filled.el);
      });

      name.addEventListener("input", () => {
        const item = itemFor(node);
        if (item) item.name = name.value;
        changed();
      });
      command.addEventListener("input", () => {
        const item = itemFor(node);
        if (item) item.command = command.value;
        changed();
      });
      const move = (delta, button) => {
        const index = items.indexOf(itemFor(node));
        if (index < 0) return;
        items = moveStartupItem(items, index, delta);
        draw();
        changed();
        // Moving the node took the keyboard with it; give it back, or to the
        // other arrow once this one stops at an end.
        (button.disabled ? (delta < 0 ? down : up) : button).focus();
      };
      up.addEventListener("click", () => move(-1, up));
      down.addEventListener("click", () => move(1, down));
      remove.addEventListener("click", () => {
        const index = items.indexOf(itemFor(node));
        if (index < 0) return;
        items = removeStartupItem(items, index);
        draw();
        changed();
        const next = list.children[Math.min(index, list.children.length - 1)];
        (next ? parts.get(next).name : add).focus();
      });
      return node;
    },
    update: (node, item, index = items.indexOf(item)) => {
      const part = parts.get(node);
      setText(part.number, String(index + 1));
      part.kind.set(item.kind);
      if (part.name.value !== (item.name || "")) part.name.value = item.name || "";
      const shell = item.kind === "shell";
      part.commandField.hidden = !shell;
      part.shellField.hidden = !shell || remote;
      part.shell.set(item.shell || "");
      if (part.command.value !== (item.command || "")) part.command.value = item.command || "";
      setText(part.envSummary, envLabel(item));
      part.up.disabled = index <= 0;
      part.down.disabled = index >= items.length - 1;
      setAttrs(node, { "aria-label": `${index + 1}. ${item.name || startupKindLabel(item.kind)}` });
      drawAgent(node, item);
    },
  };

  function draw() {
    patchList(list, items, spec);
    empty.hidden = items.length > 0;
    add.disabled = !canAddStartup(items);
    setText(add, canAddStartup(items) ? "Add terminal" : `At most ${STARTUP_MAX} terminals`);
  }

  function check() {
    const problems = startupProblems(items, { defaultShell: remote ? null : defaultShell });
    for (const node of list.children) {
      const found = problems.byKey.get(itemFor(node)?.key) || {};
      const part = parts.get(node);
      setAttrs(part.name, { "aria-invalid": found.name ? "true" : false });
      setAttrs(part.command, { "aria-invalid": found.command ? "true" : false });
      setProblem(part.problem, found.name || found.command || found.env || "");
    }
    setProblem(listProblem, problems.list);
    return problems;
  }

  // "Add terminal" asks which kind first.
  add.addEventListener("click", () => {
    if (!canAddStartup(items)) return;
    const choose = (kind) => {
      items = addStartupItem(items, kind);
      draw();
      changed();
      parts.get(list.lastElementChild)?.name.focus();
    };
    panelMenu({
      anchor: add,
      label: "Add terminal",
      items: STARTUP_KINDS.map((entry) => ({ label: entry.label, run: () => choose(entry.id) })),
      onClose: (reason) => { if (reason === "escape") add.focus(); },
    });
  });

  draw();
  check();
  if (remote) box.append(make("p", "field-hint setup-note", "Over SSH and in WSL a shell is the location's login shell."));
  return {
    el: box,
    value: () => items,
    check,
    focusProblem() {
      const problems = check();
      for (const node of list.children) {
        const found = problems.byKey.get(itemFor(node)?.key);
        if (!found) continue;
        const part = parts.get(node);
        if (found.env) {
          part.envBox.open = true;
          part.env?.focusProblem();
        } else {
          (found.command ? part.command : part.name).focus();
        }
        return true;
      }
      return Boolean(problems.list);
    },
  };
}

function envLabel(item) {
  const count = Object.keys(item?.env || {}).length;
  return count ? `Variables for this terminal (${count})` : "Variables for this terminal";
}
