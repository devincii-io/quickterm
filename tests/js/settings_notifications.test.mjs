// Settings > General > Notifications and sleep: the choices and their defaults.
import test from "node:test";
import assert from "node:assert/strict";

import {
  KEEP_AWAKE_OPTIONS, NOTIFY_OPTIONS, notificationSettings,
} from "../../quickterm/frontend/js/panel_settings_general.js";

test("each kind is off, flash or notify; keep awake has three modes", () => {
  assert.deepEqual(NOTIFY_OPTIONS.map((option) => [option.value, option.label]),
    [["off", "Off"], ["flash", "Flash"], ["notify", "Notify"]]);
  assert.deepEqual(KEEP_AWAKE_OPTIONS.map((option) => option.value), ["agents", "always", "off"]);
});

test("a config from before the setting gets notify, flash and no sound", () => {
  assert.deepEqual(notificationSettings({}), { needs_you: "notify", finished: "flash", sound: false });
  assert.deepEqual(notificationSettings(null), { needs_you: "notify", finished: "flash", sound: false });
  assert.deepEqual(
    notificationSettings({ notifications: { needs_you: "off", finished: "notify", sound: true } }),
    { needs_you: "off", finished: "notify", sound: true },
  );
  // A value from a newer build or a hand edit reads as the default.
  assert.deepEqual(
    notificationSettings({ notifications: { needs_you: "loud", finished: 3, sound: "yes" } }),
    { needs_you: "notify", finished: "flash", sound: false },
  );
});
