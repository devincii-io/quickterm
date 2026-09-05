import test from "node:test";
import assert from "node:assert/strict";
import { save } from "../../quickterm/frontend/js/workspace.js";

test("workspace saves preserve invocation order and snapshot mutable layouts", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  let release;
  globalThis.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body));
    if (calls.length === 1) await new Promise(resolve => { release = resolve; });
    return { ok: true, status: 204 };
  };
  try {
    const old = save("ordering", { type: "pane", title: "old" }, null);
    await new Promise(resolve => setImmediate(resolve));
    const layout = { type: "pane", title: "new" };
    const newer = save("ordering", layout, null);
    layout.title = "mutated after save";
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1);
    release();
    await Promise.all([old, newer]);
    assert.deepEqual(calls.map(call => call.layout.title), ["old", "new"]);
    assert.equal("path" in calls[1], false);
  } finally { globalThis.fetch = previousFetch; }
});

test("a failed save does not block later saves or unrelated workspaces", async () => {
  const previousFetch = globalThis.fetch;
  let fail = true;
  globalThis.fetch = async () => {
    if (fail) { fail = false; throw new Error("offline"); }
    return { ok: true, status: 204 };
  };
  try {
    const first = save("recovery", { type: "pane" }, null);
    const second = save("recovery", { type: "pane", title: "recovered" }, null);
    await assert.rejects(first, /offline/);
    await second;
    await save("different", { type: "pane" }, null);
  } finally { globalThis.fetch = previousFetch; }
});
