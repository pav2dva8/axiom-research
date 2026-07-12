import test from "node:test";
import assert from "node:assert/strict";

import { runNavPlan } from "../src/session/run-nav-plan";
import type { NavAction } from "../src/session/token-navigation-plan";

test("runNavPlan sends actions in timestamp order with relative waits", async () => {
  const actions: NavAction[] = [
    { atMs: 250, ws: "cluster", op: "leave", room: "old-room" },
    { atMs: 0, ws: "friends", op: "pageUpdate", pageUpdate: { page: "meme" } },
    { atMs: 100, ws: "cluster", op: "join", room: "new-room" },
  ];
  const sent: NavAction[] = [];
  const waits: number[] = [];
  let clock = 1000;

  await runNavPlan(
    actions,
    async (action) => {
      sent.push(action);
    },
    async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    () => clock,
  );

  assert.deepEqual(sent.map((action) => action.room ?? action.op), [
    "pageUpdate",
    "new-room",
    "old-room",
  ]);
  assert.deepEqual(waits, [100, 150]);
});
