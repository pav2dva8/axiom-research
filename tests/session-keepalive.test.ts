import test from "node:test";
import assert from "node:assert/strict";

import { startSessionKeepalive } from "../src/session/session-keepalive";

test("startSessionKeepalive ticks friends after jitter then on interval, and cluster on its interval", () => {
  const timeouts: Array<{ id: number; ms: number; fn: () => void }> = [];
  const intervals: Array<{ id: number; ms: number; fn: () => void }> = [];
  let nextId = 1;
  const friendsTicks: number[] = [];
  const clusterTicks: number[] = [];
  let now = 0;

  const handle = startSessionKeepalive({
    friendsJitterMs: 250,
    friendsIntervalMs: 1000,
    clusterIntervalMs: 30_000,
    tickFriends: () => {
      friendsTicks.push(now);
    },
    tickCluster: () => {
      clusterTicks.push(now);
    },
    setTimeoutFn: ((fn: () => void, ms: number) => {
      const id = nextId++;
      timeouts.push({ id, ms, fn: fn as () => void });
      return id as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
    clearTimeoutFn: ((id: NodeJS.Timeout) => {
      const idx = timeouts.findIndex((t) => t.id === (id as unknown as number));
      if (idx >= 0) timeouts.splice(idx, 1);
    }) as typeof clearTimeout,
    setIntervalFn: ((fn: () => void, ms: number) => {
      const id = nextId++;
      intervals.push({ id, ms, fn: fn as () => void });
      return id as unknown as NodeJS.Timeout;
    }) as typeof setInterval,
    clearIntervalFn: ((id: NodeJS.Timeout) => {
      const idx = intervals.findIndex((t) => t.id === (id as unknown as number));
      if (idx >= 0) intervals.splice(idx, 1);
    }) as typeof clearInterval,
  });

  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0]?.ms, 250);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0]?.ms, 30_000);

  now = 250;
  const startTimeout = timeouts[0]!;
  startTimeout.fn();
  // Fired timeouts are not auto-removed from our fake list.
  const idx = timeouts.findIndex((t) => t.id === startTimeout.id);
  if (idx >= 0) timeouts.splice(idx, 1);
  assert.deepEqual(friendsTicks, [250]);
  assert.equal(intervals.some((i) => i.ms === 1000), true);

  const friendsInterval = intervals.find((i) => i.ms === 1000)!;
  now = 1250;
  friendsInterval.fn();
  now = 2250;
  friendsInterval.fn();
  assert.deepEqual(friendsTicks, [250, 1250, 2250]);

  const clusterInterval = intervals.find((i) => i.ms === 30_000)!;
  now = 30_000;
  clusterInterval.fn();
  assert.deepEqual(clusterTicks, [30_000]);

  handle.stop();
  assert.equal(intervals.length, 0);

  // Stopped handle must not tick further even if a stale callback fires.
  friendsInterval.fn();
  clusterInterval.fn();
  assert.deepEqual(friendsTicks, [250, 1250, 2250]);
  assert.deepEqual(clusterTicks, [30_000]);
});
