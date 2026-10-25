import test from "node:test";
import assert from "node:assert/strict";

import {
  agentSummary, compactDuration, footerParts, formatMemory, headlineWindow, longDuration,
  minutesLabel, resetsIn, resourceRows, totals, updatedAgo, usageBlocks, windowLabel,
} from "../../quickterm/frontend/js/usage_footer.js";

const NOW = 1_800_000_000;
const DAY = 86400;
const GB = 1024 ** 3;

const claude = {
  windows: [
    { id: "five_hour", used_percent: 12.4, resets_at: NOW + 3 * 3600 },
    { id: "seven_day", used_percent: 32.2, resets_at: NOW + 4 * DAY + 14 * 3600 },
  ],
  updated_at: NOW - 180,
};
const codex = {
  windows: [{ id: "primary", used_percent: 0, window_minutes: 43200, resets_at: NOW + 29 * DAY + 5 }],
  plan: "go",
  updated_at: NOW - 30,
};

const session = (id, bytes, cpu = 1.5) => ({
  id, name: `t-${id}`, usage: { available: true, working_set_bytes: bytes, cpu_percent: cpu },
});

test("the footer names the higher window and the time until it resets", () => {
  assert.equal(agentSummary(claude, NOW), "32% · 4d");
  assert.equal(agentSummary(codex, NOW), "0% · 29d");
  const fiveHourAhead = { windows: [{ ...claude.windows[0], used_percent: 80 }, claude.windows[1]] };
  assert.equal(agentSummary(fiveHourAhead, NOW), "80% · 3h");
});

test("headlineWindow picks the most used window and keeps the first on a tie", () => {
  assert.equal(headlineWindow(claude.windows).id, "seven_day");
  const tie = [{ id: "a", used_percent: 5 }, { id: "b", used_percent: 5 }];
  assert.equal(headlineWindow(tie).id, "a");
  assert.equal(headlineWindow([{ id: "x", used_percent: null }]), null);
  assert.equal(headlineWindow(undefined), null);
});

test("a window without a reset time shows only its percent", () => {
  assert.equal(agentSummary({ windows: [{ id: "five_hour", used_percent: 7.6, resets_at: null }] }, NOW), "8%");
  assert.equal(agentSummary(null, NOW), null);
  assert.equal(agentSummary({ windows: [] }, NOW), null);
});

test("durations are compact in the footer and two units in the popover", () => {
  assert.equal(compactDuration(30), "now");
  assert.equal(compactDuration(12 * 60 + 5), "12m");
  assert.equal(compactDuration(5 * 3600 + 59 * 60), "5h");
  assert.equal(compactDuration(29 * DAY + 23 * 3600), "29d");
  assert.equal(compactDuration(-5), "now");
  assert.equal(longDuration(4 * DAY + 14 * 3600 + 20 * 60), "4d 14h");
  assert.equal(longDuration(3 * 3600 + 20 * 60), "3h 20m");
  assert.equal(longDuration(2 * DAY), "2d");
  assert.equal(longDuration(12 * 60), "12m");
  assert.equal(resetsIn(NOW + 4 * DAY + 14 * 3600, NOW), "resets in 4d 14h");
  assert.equal(resetsIn(NOW - 10, NOW), "resets now");
  assert.equal(resetsIn(null, NOW), null);
  assert.equal(updatedAgo(NOW - 180, NOW), "updated 3m ago");
  assert.equal(updatedAgo(NOW - 5, NOW), "updated now");
});

test("windows are named from the agent and from window_minutes", () => {
  assert.equal(windowLabel("claude", { id: "five_hour" }), "5 hours");
  assert.equal(windowLabel("claude", { id: "seven_day" }), "7 days");
  assert.equal(windowLabel("codex", { id: "primary", window_minutes: 300 }), "5 hours");
  assert.equal(windowLabel("codex", { id: "secondary", window_minutes: 10080 }), "7 days");
  assert.equal(windowLabel("codex", { id: "primary", window_minutes: 43200 }), "30 days");
  assert.equal(windowLabel("codex", { id: "secondary", window_minutes: null }), "secondary");
  assert.equal(minutesLabel(60), "1 hour");
  assert.equal(minutesLabel(90), "90 minutes");
  assert.equal(minutesLabel(1440), "1 day");
});

test("the footer line has each part only when its data exists", () => {
  const sessions = [session("a", 1.5 * GB), session("b", 0.7 * GB), { id: "c", usage: { available: false } }];
  assert.deepEqual(footerParts({ claude, codex }, sessions, NOW).map((part) => part.text),
    ["✳ 32% · 4d", "◎ 0% · 29d", "2.2 GB"]);
  assert.deepEqual(footerParts({ claude: null, codex }, [], NOW).map((part) => part.kind), ["codex"]);
  assert.deepEqual(footerParts(null, sessions, NOW).map((part) => part.kind), ["memory"]);
  assert.deepEqual(footerParts({ claude: null, codex: null }, [{ id: "x" }], NOW), []);
  assert.deepEqual(footerParts(undefined, undefined, NOW), []);
});

test("memory reads in GB with one decimal and MB below", () => {
  assert.equal(formatMemory(2.2 * GB), "2.2 GB");
  assert.equal(formatMemory(640 * 1024 * 1024), "640 MB");
  assert.equal(formatMemory(NaN), "");
  assert.deepEqual(totals([session("a", 100, 1), session("b", 50, null)]), { memory: 150, cpu: 1 });
  assert.deepEqual(totals([]), { memory: null, cpu: null });
});

test("the usage popover lists each agent's windows with bar, percent and reset", () => {
  const blocks = usageBlocks({ claude, codex }, NOW);
  assert.deepEqual(blocks.map((block) => block.title), ["Claude Code", "Codex · go"]);
  assert.equal(blocks[0].updated, "updated 3m ago");
  assert.deepEqual(blocks[0].windows[1], {
    id: "seven_day", label: "7 days", percent: "32%", fill: 32.2, resets: "resets in 4d 14h",
  });
  assert.equal(blocks[1].windows[0].label, "30 days");
  assert.deepEqual(usageBlocks({ claude: null, codex: null }, NOW), []);
  assert.equal(usageBlocks({ claude: { windows: [{ id: "five_hour", used_percent: 140 }] } }, NOW)[0].windows[0].fill, 100);
});

test("resources list open workspaces, then their terminals, with metrics joined by id", () => {
  const groups = [
    { key: "ws:api", label: "api", open: true, sessions: [{ session: { id: "a", name: "shell" } }, { session: { id: "b" } }] },
    { key: "ws:old", label: "old", open: false, sessions: [{ session: { id: "c" } }] },
  ];
  const rows = resourceRows(groups, [session("a", 3 * 1024 * 1024, 2), session("c", 1)]);
  assert.deepEqual(rows.map((row) => [row.type, row.label, row.memory, row.cpu]), [
    ["group", "api", 3 * 1024 * 1024, 2],
    ["terminal", "t-a", 3 * 1024 * 1024, 2],
    ["terminal", "b", null, null],
  ]);
  assert.equal(rows[1].session.id, "a");
  assert.deepEqual(resourceRows([], []), []);
});

test("one block per account, Claude first and the busiest first, with plan, who and where", async () => {
  const { accountBlocks, planLabel } = await import("../../quickterm/frontend/js/usage_footer.js");
  assert.equal(planLabel("claude_max"), "Max");
  assert.equal(planLabel("plus"), "Plus");
  assert.equal(planLabel("some_new_plan"), "some new plan");
  assert.equal(planLabel(null), null);
  const window = (used) => ({ id: "session", label: "5 hours", used_percent: used, resets_at: NOW + 3600 });
  const blocks = accountBlocks([
    { agent: "codex", key: "c", email: "a@x", plan: "plus", where: ["This PC"], windows: [window(90)], updated_at: NOW, source: "session log" },
    { agent: "claude", key: "1", email: "a@x", plan: "claude_max", where: ["This PC"], windows: [window(20)], updated_at: NOW - 120, source: "live" },
    { agent: "claude", key: "2", email: "b@x", plan: "claude_team", where: ["This PC", "WSL: Ubuntu (b)"], windows: [window(70)], updated_at: NOW, source: "Claude Code", note: "sign-in expired; open Claude Code to renew it" },
    { agent: "other", key: "z", windows: [] },
  ], NOW);
  assert.deepEqual(blocks.map((block) => block.title), ["Claude Code · Team", "Claude Code · Max", "Codex · Plus"]);
  assert.equal(blocks[0].who, "b@x · This PC, WSL: Ubuntu (b)");
  assert.equal(blocks[0].updated, "now · cached");
  assert.equal(blocks[0].note, "sign-in expired; open Claude Code to renew it");
  assert.equal(blocks[1].updated, "2m ago", "live numbers name no source");
  assert.equal(blocks[2].windows[0].percent, "90%");
  const empty = accountBlocks([{ agent: "claude", key: "3", windows: [] }], NOW);
  assert.equal(empty[0].note, "No limits known yet.");
});
