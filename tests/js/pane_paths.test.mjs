import test from "node:test";
import assert from "node:assert/strict";

import {
  droppedFilePaths, fileUrlToPath, parseOscCwd, quoteDroppedPath, windowsPathForWsl,
} from "../../quickterm/frontend/js/pane.js";

test("desktop file drops keep only full paths and file URLs", () => {
  const transfer = {
    files: [{ path: "C:\\work\\image one.png" }, { name: "unsafe-name-only.txt" }],
    getData(type) {
      return type === "text/uri-list" ? "file:///C:/work/notes.txt\nhttps://example.com/x" : "";
    },
  };
  assert.deepEqual(droppedFilePaths(transfer), [
    "C:\\work\\image one.png",
    "C:\\work\\notes.txt",
  ]);
  assert.equal(fileUrlToPath("https://example.com/x"), null);
  assert.equal(fileUrlToPath("file:///tmp/image%20one.png"), "/tmp/image one.png");
  assert.equal(fileUrlToPath("file://server/share/image.png"), "\\\\server\\share\\image.png");
});

test("dropped paths are quoted without submitting the command", () => {
  assert.equal(
    quoteDroppedPath("C:\\work\\Devin's image.png", "PowerShell 7"),
    "'C:\\work\\Devin''s image.png'",
  );
  assert.equal(
    quoteDroppedPath("C:\\work\\image.png", "Command Prompt"),
    '"C:\\work\\image.png"',
  );
  assert.equal(quoteDroppedPath("/tmp/a'b", "bash"), "'/tmp/a'\\''b'");
  assert.equal(windowsPathForWsl("C:\\work\\image one.png"), "/mnt/c/work/image one.png");
});

test("OSC 7 and OSC 9;9 track shell directories without prompt scraping", () => {
  assert.equal(parseOscCwd(7, "file:///C:/work/project", "windows-powershell"), "C:\\work\\project");
  assert.equal(parseOscCwd(7, "file://host/home/dev", "wsl"), "/home/dev");
  assert.equal(parseOscCwd(9, "9;C:\\work\\other", "windows-powershell"), "C:\\work\\other");
  assert.equal(parseOscCwd(9, "4;ignored", "windows-powershell"), null);
  assert.equal(parseOscCwd(9, "9;bad\u0000path", "windows-powershell"), null);
});
