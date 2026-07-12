import test from "node:test";
import assert from "node:assert/strict";

import { FeedPool } from "../src/session/feed-pool";
import { SessionActor, type SessionBridge } from "../src/session/session-actor";
import type { NavAction } from "../src/session/token-navigation-plan";

type BridgeCall =
  | { type: "open"; args: unknown[] }
  | { type: "navigate"; sessionId: number; actions: NavAction[] }
  | { type: "close"; sessionId: number };

function token(pairAddress: string, tokenAddress: string) {
  return { pairAddress, tokenAddress, ticker: pairAddress, name: tokenAddress };
}

class FakeBridge implements SessionBridge {
  readonly calls: BridgeCall[] = [];

  async openSession(...args: unknown[]): Promise<number> {
    this.calls.push({ type: "open", args });
    return 42;
  }

  async navigateSession(sessionId: number, actions: NavAction[]): Promise<void> {
    this.calls.push({ type: "navigate", sessionId, actions });
  }

  async closeSession(sessionId: number): Promise<void> {
    this.calls.push({ type: "close", sessionId });
  }
}

function deferredWaits() {
  const waits: Array<{ ms: number; resolve: () => void }> = [];
  return {
    waits,
    wait: async (ms: number) => {
      await new Promise<void>((resolve) => waits.push({ ms, resolve }));
    },
  };
}

function navigateCalls(bridge: FakeBridge): Extract<BridgeCall, { type: "navigate" }>[] {
  return bridge.calls.filter((call): call is Extract<BridgeCall, { type: "navigate" }> => call.type === "navigate");
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function makeFeed(...tokens: ReturnType<typeof token>[]): Promise<FeedPool> {
  const feed = new FeedPool({ fetchTrending: async () => tokens });
  await feed.refresh();
  return feed;
}

test("gotoDeploy cancels warmup and navigates to deploy token", async () => {
  const bridge = new FakeBridge();
  const waits = deferredWaits();
  const feed = await makeFeed(token("WarmPair", "WarmToken"));
  const actor = new SessionActor({
    publicKey: "Pub111",
    bridge,
    feed,
    timing: { contextGapMs: [5, 5], dwellMs: [5, 5], wait: waits.wait, rng: () => 0 },
  });

  await actor.startWarmup("access", "refresh", { proxy: "http://proxy" });
  await flushAsyncWork();
  assert.deepEqual(bridge.calls[0], {
    type: "open",
    args: ["access", "refresh", { proxy: "http://proxy" }],
  });
  assert.equal(actor.getMode(), "warmup");
  assert.equal(waits.waits[0]?.ms, 5);

  await actor.gotoDeploy(token("DeployPair", "DeployToken"));

  assert.equal(actor.getMode(), "deploy");
  const navigations = navigateCalls(bridge);
  assert.equal(navigations.length, 2);
  assert.equal(navigations[0].actions.length, 1);
  assert.equal(navigations[0].actions[0].op, "pageUpdate");
  assert.equal(navigations[1].actions.some((action) => action.op === "join" && action.room === "t:DeployPair"), true);
  assert.equal(navigations[1].actions.some((action) => action.room === "t:WarmPair"), false);
});

test("returnToWarmup leaves deploy and resumes warmup mode", async () => {
  const bridge = new FakeBridge();
  const waits = deferredWaits();
  const feed = await makeFeed(token("WarmPair", "WarmToken"));
  const actor = new SessionActor({
    publicKey: "Pub111",
    bridge,
    feed,
    timing: { contextGapMs: [5, 5], dwellMs: [5, 5], wait: waits.wait, rng: () => 0 },
  });

  await actor.startWarmup("access", "refresh", {});
  await flushAsyncWork();
  assert.deepEqual(bridge.calls[0], { type: "open", args: ["access", "refresh", {}] });
  await actor.gotoDeploy(token("DeployPair", "DeployToken"));
  await actor.returnToWarmup();
  await flushAsyncWork();

  assert.equal(actor.getMode(), "warmup");
  const navigations = navigateCalls(bridge);
  const leaveDeploy = navigations[2];
  const resumedContext = navigations[3];
  assert.ok(leaveDeploy.actions.some((action) => action.op === "leave" && action.room === "t:DeployPair"));
  assert.equal(leaveDeploy.actions.some((action) => action.op === "pageUpdate"), true);
  assert.equal(resumedContext.actions.length, 1);
  assert.equal(resumedContext.actions[0].op, "pageUpdate");
  assert.equal(waits.waits.length, 2);
});

test("warmup refreshes feed before picking token", async () => {
  const bridge = new FakeBridge();
  const waits = deferredWaits();
  let refreshes = 0;
  const feed = new FeedPool({
    fetchTrending: async () => {
      refreshes++;
      return [token("FreshPair", "FreshToken")];
    },
  });
  const actor = new SessionActor({
    publicKey: "Pub111",
    bridge,
    feed,
    timing: { contextGapMs: [5, 5], dwellMs: [5, 5], wait: waits.wait, rng: () => 0 },
  });

  await actor.startWarmup("access", "refresh", {});
  await flushAsyncWork();
  waits.waits[0]?.resolve();
  await flushAsyncWork();
  await flushAsyncWork();

  assert.equal(refreshes, 1);
  assert.equal(
    navigateCalls(bridge).some((call) =>
      call.actions.some((action) => action.op === "join" && action.room === "t:FreshPair"),
    ),
    true,
  );

  await actor.forceClose();
});

test("forceClose closes session", async () => {
  const bridge = new FakeBridge();
  const waits = deferredWaits();
  const feed = await makeFeed(token("WarmPair", "WarmToken"));
  const actor = new SessionActor({
    publicKey: "Pub111",
    bridge,
    feed,
    timing: { contextGapMs: [5, 5], dwellMs: [5, 5], wait: waits.wait, rng: () => 0 },
  });

  await actor.startWarmup("access", "refresh", {});
  await flushAsyncWork();
  assert.deepEqual(bridge.calls[0], { type: "open", args: ["access", "refresh", {}] });
  await actor.forceClose();

  assert.equal(actor.getMode(), "warmup");
  assert.deepEqual(bridge.calls.at(-1), { type: "close", sessionId: 42 });
});
