import test from "node:test";
import assert from "node:assert/strict";
import { Palette } from "../../quickterm/frontend/js/palette.js";

test("the palette distinguishes external windows and uses the workspace folder", () => {
  const app = {
    profiles: [
      { name: "Remote", terminal_type: "rdp", connection: { host: "server" } },
      { name: "Assistant", terminal_type: "claude-code", cmd: "claude", cwd: "obsolete" },
    ],
    snippets: [], workspacePath: () => "C:/project",
  };
  const items = Palette.prototype._staticItems.call({ app });
  assert.equal(items.find((item) => item.label === "open window: Remote").kind, "window");
  assert.equal(items.find((item) => item.label === "open terminal: Assistant").kind, "terminal");
  assert.equal(items.find((item) => item.label === "claude continue: Assistant").hint, "C:/project");
});
