// The read-only file view the right panel opens over the stage. The head
// names the path, offers "Changes" when git reports the file modified and
// "Open in editor" for a local workspace. The body is the text with line
// numbers and highlight.js colours (vendored, a classic script like the
// xterm addons), Ctrl+F find with a match count and Ctrl+G go to line.
// Binary and large files say so; images show as images. Nothing is edited.

import * as wsApi from "./ws_api.js";
import { formatSize } from "./right_panel_model.js";
import { iconButton, make } from "./rp_dom.js";

// highlight.js on a very large file blocks the window for seconds; past this
// the text is shown plain.
const HIGHLIGHT_CAP = 400 * 1024;
const FIND_CAP = 5000;

// Where `query` occurs in `text`, case-insensitive, at most FIND_CAP times.
export function findAll(text, query) {
  const needle = String(query || "").toLowerCase();
  if (!needle) return [];
  const hay = String(text || "").toLowerCase();
  const found = [];
  let at = hay.indexOf(needle);
  while (at >= 0 && found.length < FIND_CAP) {
    found.push(at);
    at = hay.indexOf(needle, at + needle.length);
  }
  return found;
}

// The 1-based line holding character `offset`.
export function lineAt(text, offset) {
  let line = 1;
  for (let index = text.indexOf("\n"); index >= 0 && index < offset; index = text.indexOf("\n", index + 1)) line++;
  return line;
}

function highlighted(text, language) {
  const hljs = globalThis.hljs;
  if (!hljs || !language || text.length > HIGHLIGHT_CAP || !hljs.getLanguage(language)) return null;
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch (_) {
    return null;
  }
}

export function createFileView(ctx) {
  const el = make("div", "rp-viewer rp-file-view");
  el.tabIndex = -1;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "File");
  const head = make("div", "rp-viewer-head");
  const path = make("span", "rp-viewer-path");
  const changes = make("button", "rp-text-button", "Changes");
  changes.type = "button";
  changes.title = "Show this file's changes";
  changes.hidden = true;
  const editor = make("button", "rp-text-button", "Open in editor");
  editor.type = "button";
  const close = iconButton("x", "Close (Esc)");
  head.append(path, changes, editor, close);

  const find = make("div", "rp-find");
  find.hidden = true;
  const findInput = make("input", "rp-find-input");
  findInput.spellcheck = false;
  const findCount = make("span", "rp-find-count");
  const findPrev = iconButton("arrow-up", "Previous match (Shift+Enter)");
  const findNext = iconButton("arrow-down", "Next match (Enter)");
  find.append(findInput, findCount, findPrev, findNext);

  const body = make("div", "rp-viewer-body");
  el.append(head, find, body);

  let current = null; // {name, path, text, lines}
  let matches = [];
  let matchIndex = -1;
  let mode = "find";
  let code = null;
  let mark = null;

  const supportsHighlights = () => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function";

  function clearFind() {
    matches = [];
    matchIndex = -1;
    findCount.textContent = "";
    if (supportsHighlights()) {
      CSS.highlights.delete("rp-find");
      CSS.highlights.delete("rp-find-current");
    }
  }

  function message(text, withEditor = true) {
    const box = make("div", "rp-viewer-message");
    box.append(make("p", "", text));
    if (withEditor && !ctx.isRemote()) {
      const open = make("button", "rp-text-button", "Open in editor");
      open.type = "button";
      open.addEventListener("click", () => ctx.openExternal(current.path, "editor"));
      box.append(open);
    }
    body.replaceChildren(box);
  }

  function renderText(text, language) {
    const lines = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
    const view = make("div", "rp-code");
    const gutter = make("pre", "rp-gutter");
    gutter.setAttribute("aria-hidden", "true");
    gutter.textContent = Array.from({ length: Math.max(1, lines) }, (_, index) => index + 1).join("\n");
    code = make("pre", "rp-code-text hljs");
    const html = highlighted(text, language);
    // highlight.js escapes the text it returns; anything else goes in as text.
    if (html !== null) code.innerHTML = html;
    else code.textContent = text;
    mark = make("div", "rp-line-mark");
    mark.hidden = true;
    view.append(gutter, code, mark);
    body.replaceChildren(view);
    current.lines = lines;
  }

  function lineHeight() {
    return parseFloat(getComputedStyle(code).lineHeight) || 18;
  }

  function showLine(line) {
    if (!code || !line) return;
    const target = Math.max(1, Math.min(current.lines || 1, Number(line)));
    const height = lineHeight();
    const top = code.offsetTop + (target - 1) * height;
    mark.style.top = `${top}px`;
    mark.style.height = `${height}px`;
    mark.hidden = false;
    body.scrollTop = Math.max(0, top - body.clientHeight / 3);
  }

  async function open(name, file, { line = null } = {}) {
    current = { name, path: file, text: "", lines: 0 };
    path.textContent = file;
    path.title = file;
    editor.hidden = ctx.isRemote();
    changes.hidden = true;
    find.hidden = true;
    clearFind();
    code = null;
    body.replaceChildren(make("div", "rp-viewer-message", "Loading…"));
    ctx.modifiedGroup(file).then((group) => {
      if (current?.path !== file) return;
      changes.hidden = !group;
      changes.dataset.group = group || "";
    });
    let answer;
    try {
      answer = await wsApi.readFile(name, file);
    } catch (error) {
      if (current?.path === file) message(error.detail || "Could not read the file.", false);
      return;
    }
    if (current?.path !== file) return;
    if (answer.image_url) {
      const box = make("div", "rp-image");
      const image = make("img");
      image.alt = file;
      image.src = answer.image_url;
      box.append(image);
      body.replaceChildren(box);
      return;
    }
    if (answer.text == null) {
      message(answer.binary ? "Binary file." : `File too large (${formatSize(answer.size)}).`);
      return;
    }
    current.text = answer.text;
    renderText(answer.text, answer.language);
    if (line) requestAnimationFrame(() => showLine(line));
  }

  // ---- find and go to line ----

  function openFind(as) {
    if (!code) return;
    mode = as;
    find.hidden = false;
    findInput.placeholder = as === "line" ? `Go to line (1 to ${current.lines})` : "Find in file";
    findInput.setAttribute("aria-label", findInput.placeholder);
    findInput.inputMode = as === "line" ? "numeric" : "text";
    findPrev.hidden = as === "line";
    findNext.hidden = as === "line";
    if (as === "line") {
      findInput.value = "";
      clearFind();
    }
    findInput.focus();
    findInput.select();
  }

  function closeFind() {
    find.hidden = true;
    clearFind();
    el.focus();
  }

  function textNodes() {
    const nodes = [];
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let offset = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push({ node, start: offset });
      offset += node.data.length;
    }
    return nodes;
  }

  function rangeAt(nodes, start, length) {
    const locate = (offset) => {
      let low = 0;
      let high = nodes.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (nodes[middle].start <= offset) low = middle;
        else high = middle - 1;
      }
      const entry = nodes[low];
      return [entry.node, Math.min(entry.node.data.length, offset - entry.start)];
    };
    const range = document.createRange();
    range.setStart(...locate(start));
    range.setEnd(...locate(start + length));
    return range;
  }

  function runFind() {
    clearFind();
    const query = findInput.value;
    if (!query || !code) return;
    matches = findAll(current.text, query);
    if (!matches.length) {
      findCount.textContent = "0/0";
      return;
    }
    if (supportsHighlights()) {
      const nodes = textNodes();
      const ranges = matches.map((at) => rangeAt(nodes, at, query.length));
      CSS.highlights.set("rp-find", new Highlight(...ranges));
      current.ranges = ranges;
    }
    step(1, true);
  }

  function step(delta, fromStart = false) {
    if (!matches.length) return;
    matchIndex = fromStart ? 0 : (matchIndex + delta + matches.length) % matches.length;
    findCount.textContent = `${matchIndex + 1}/${matches.length}${matches.length >= FIND_CAP ? "+" : ""}`;
    if (supportsHighlights() && current.ranges) {
      CSS.highlights.set("rp-find-current", new Highlight(current.ranges[matchIndex]));
    }
    showLine(lineAt(current.text, matches[matchIndex]));
    mark.hidden = true;
  }

  findInput.addEventListener("input", () => {
    if (mode === "find") runFind();
  });
  findInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeFind();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (mode === "line") {
        const line = parseInt(findInput.value, 10);
        if (Number.isFinite(line)) showLine(line);
        closeFind();
      } else {
        step(event.shiftKey ? -1 : 1);
      }
    }
  });
  findPrev.addEventListener("click", () => step(-1));
  findNext.addEventListener("click", () => step(1));
  changes.addEventListener("click", () => ctx.openDiff(current.path, changes.dataset.group || "changes"));
  editor.addEventListener("click", () => ctx.openExternal(current.path, "editor"));
  close.addEventListener("click", () => ctx.close());

  // Keys while the view has the keyboard. True when the key was ours.
  function handleKey(event) {
    const key = event.key.toLowerCase();
    if (event.ctrlKey && !event.altKey && key === "f") {
      openFind("find");
      return true;
    }
    if (event.ctrlKey && !event.altKey && key === "g") {
      openFind("line");
      return true;
    }
    if (event.key === "F3" && mode === "find" && !find.hidden) {
      step(event.shiftKey ? -1 : 1);
      return true;
    }
    return false;
  }

  return {
    kind: "file",
    el,
    open,
    handleKey,
    path: () => current?.path || null,
    dispose: () => clearFind(),
  };
}
