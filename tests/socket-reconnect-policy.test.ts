import test from "node:test";
import assert from "node:assert/strict";

import {
  friendsReconnectRequiresOpenCluster,
  resolveFriendsReconnectDelayMs,
  shouldScheduleSocketReconnect,
} from "../src/session/socket-reconnect-policy";

test("fixed-delay mode schedules reconnect instead of teardown", () => {
  assert.equal(
    shouldScheduleSocketReconnect({ closed: false, friendsReconnectDelayMs: 20_000 }),
    true,
  );
  assert.equal(
    shouldScheduleSocketReconnect({ closed: true, friendsReconnectDelayMs: 20_000 }),
    false,
  );
  assert.equal(
    shouldScheduleSocketReconnect({ closed: false }),
    false,
  );
});

test("fixed-delay mode does not require cluster for friends reconnect", () => {
  assert.equal(
    friendsReconnectRequiresOpenCluster({ friendsReconnectDelayMs: 20_000 }),
    false,
  );
  assert.equal(friendsReconnectRequiresOpenCluster({}), true);
});

test("fixed-delay mode uses the configured wait", () => {
  assert.equal(resolveFriendsReconnectDelayMs({ friendsReconnectDelayMs: 20_000 }, 1), 20_000);
  assert.equal(resolveFriendsReconnectDelayMs({ friendsReconnectDelayMs: 5000 }, 9), 5000);
});

test("classic mode uses exponential backoff base", () => {
  assert.equal(resolveFriendsReconnectDelayMs({}, 1), 150);
  assert.equal(resolveFriendsReconnectDelayMs({}, 2), 300);
  assert.equal(resolveFriendsReconnectDelayMs({}, 8), 15_000);
});

test("browser-auth mutes friends heartbeat logs unless WS_VERBOSE", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = fs.readFileSync(
    path.join(process.cwd(), "src/browser-auth.ts"),
    "utf8",
  );
  assert.match(src, /Friends keepalive "\." is high-frequency noise/);
  assert.match(src, /label === 'friends' && process\.env\.WS_VERBOSE/);
  assert.doesNotMatch(src, /friendsHeartbeatCount % 10 === 0/);
});

test("browser-auth schedules cluster reconnect in fixed-delay mode", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = fs.readFileSync(
    path.join(process.cwd(), "src/browser-auth.ts"),
    "utf8",
  );
  assert.match(src, /function scheduleClusterReconnect/);
  assert.match(src, /isFixedReconnectMode\(v\) && !v\.closed/);
  assert.match(src, /cluster reconnect: waiting '/);
  assert.match(src, /friends reconnect: opening now \(waited '/);
});
