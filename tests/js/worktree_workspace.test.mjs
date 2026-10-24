// New worktree workspace (CONTRACTS 4.2): create through the backend, open
// its view through the normal path, type the setup command into the
// terminal that view started. Backed by fakes; no server, no browser.
import test from "node:test";
import assert from "node:assert/strict";

import { createWorktreeWorkspace } from "../../quickterm/frontend/js/workspace_actions.js";

function harness({ setup = { command: "uv sync", source: "uv.lock" }, created = null, refuse = null, view = { id: "v" }, session = "s1", sendFails = false } = {}) {
  const calls = [];
  const errors = [];
  const api = {
    async createWorktree(from, branch) {
      calls.push(["create", from, branch]);
      if (refuse) throw refuse;
      return created || { workspace: `${from}/${branch.replace(/\//g, "-")}`, path: "C:\\src\\qt-x", setup };
    },
    async sendInput(id, text, enter) {
      calls.push(["send", id, text, enter]);
      if (sendFails) throw { detail: "409 exited" };
    },
  };
  let asks = 0;
  const options = {
    api, from: "qt",
    openView: async (name) => { calls.push(["open", name]); return view; },
    appFor: () => ({ focusedSessionId: () => (++asks >= 2 ? session : null) }),
    onWorkspacesChanged: async () => calls.push(["changed"]),
    showError: (text) => errors.push(text),
    wait: async () => {},
  };
  return { options, calls, errors };
}

test("a worktree opens as its own view and runs its setup command there", async () => {
  const { options, calls, errors } = harness();
  const created = await createWorktreeWorkspace({ ...options, branch: "  feat/x " });
  assert.equal(created.workspace, "qt/feat-x");
  assert.deepEqual(calls, [
    ["create", "qt", "feat/x"],
    ["changed"],
    ["open", "qt/feat-x"],
    ["send", "s1", "uv sync", true],
  ]);
  assert.deepEqual(errors, []);
});

test("no setup command means nothing is typed", async () => {
  const { options, calls } = harness({ setup: null });
  await createWorktreeWorkspace({ ...options, branch: "x" });
  assert.ok(!calls.some(([kind]) => kind === "send"));
});

test("a refusal goes back to the input that asked, and nothing opens", async () => {
  const { options, calls, errors } = harness({ refuse: { status: 409, detail: "branch x already exists" } });
  await assert.rejects(createWorktreeWorkspace({ ...options, branch: "x" }), { detail: "branch x already exists" });
  assert.deepEqual(calls, [["create", "qt", "x"]]);
  assert.deepEqual(errors, []);
  await assert.rejects(createWorktreeWorkspace({ ...options, branch: "  " }), { detail: "Name the new branch." });
});

test("after the worktree exists, failures go to the banner", async () => {
  const closed = harness({ view: false });
  await createWorktreeWorkspace({ ...closed.options, branch: "x" });
  assert.match(closed.errors[0], /view did not open/);

  const silent = harness({ session: null });
  await createWorktreeWorkspace({ ...silent.options, branch: "x", tries: 3 });
  assert.match(silent.errors[0], /Run uv sync there yourself/);

  const refused = harness({ sendFails: true });
  await createWorktreeWorkspace({ ...refused.options, branch: "x" });
  assert.deepEqual(refused.errors, ["409 exited"]);
});
