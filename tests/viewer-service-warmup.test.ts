import test from "node:test";
import assert from "node:assert/strict";

import type { BrowserSession } from "../src/browser-auth";
import type { LoadedAccount } from "../src/ui/account-manager";
import { ViewerService, type TokenInfo } from "../src/ui/viewer-service";
import type { NavAction } from "../src/session/token-navigation-plan";

type SessionCall =
  | { type: "open"; accessToken: string; refreshToken: string; opts: unknown }
  | { type: "navigate"; sessionId: number; actions: NavAction[] }
  | { type: "close"; sessionId: number }
  | { type: "legacy-connect" };

function account(publicKey: string): LoadedAccount {
  return {
    publicKey,
    cookies: "",
    accessToken: `access-${publicKey}`,
    refreshToken: `refresh-${publicKey}`,
  };
}

function tokenInfo(pairAddress = "deploy-pair"): TokenInfo {
  return {
    pairAddress,
    tokenAddress: "deploy-token",
    ticker: "TOKEN",
    name: "Token",
    protocol: "Pump V1",
    isMigrated: false,
    supply: 1_000_000_000,
    price: 0,
  };
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function sessionWithActorApis(calls: SessionCall[]): BrowserSession {
  let nextSessionId = 100;
  return {
    fetchMemeTrending: async () => [
      {
        pairAddress: "warm-pair",
        tokenAddress: "warm-token",
        ticker: "WARM",
        name: "Warm Token",
      },
    ],
    getSessionShards: () => ({ apiHost: "api9.axiom.trade", clusterHost: "cluster9.axiom.trade" }),
    ensurePageSlots: async () => {},
    openSession: async (accessToken: string, refreshToken: string, opts: unknown) => {
      calls.push({ type: "open", accessToken, refreshToken, opts });
      return nextSessionId++;
    },
    navigateSession: async (sessionId: number, actions: NavAction[]) => {
      calls.push({ type: "navigate", sessionId, actions });
    },
    closeSession: async (sessionId: number) => {
      calls.push({ type: "close", sessionId });
    },
    connectViewer: async () => {
      calls.push({ type: "legacy-connect" });
      throw new Error("legacy connectViewer should not be used once warmup actors exist");
    },
    disconnectViewer: async () => {},
    disconnectAllViewers: async () => {
      throw new Error("legacy disconnectAllViewers should not be used for warmup actors");
    },
  } as any;
}

test("connectAll deploys warmed direct sessions through SessionActor", async (t) => {
  const service = new ViewerService();
  const calls: SessionCall[] = [];
  const session = sessionWithActorApis(calls);
  const acct = account("acct-direct");
  t.after(async () => {
    await service.stopWarmup();
  });

  service.setBrowserSession(session);
  await service.startWarmupForGroups([
    { id: 0, label: "direct", session, accounts: [acct] },
  ]);
  await flushAsyncWork();

  service.setTokenInfo(tokenInfo("direct-pair"));
  const connected = await service.connectAll([acct], {
    minGapMs: 0,
    maxGapMs: 0,
    shuffle: false,
    bootstrapDisabled: true,
  });

  assert.equal(connected, 1);
  assert.equal(service.getActiveCount(), 1);
  assert.equal(
    calls.some(
      (call) =>
        call.type === "navigate" &&
        call.actions.some((action) => action.op === "join" && action.room === "t:direct-pair"),
    ),
    true,
  );
  assert.equal(
    calls.some((call) => call.type === "legacy-connect"),
    false,
  );
});

test("startWarmupForGroups staggers accounts and groups using connect delay options", async () => {
  const service = new ViewerService();
  const calls: SessionCall[] = [];
  const sessionA = sessionWithActorApis(calls);
  const sessionB = sessionWithActorApis(calls);
  const sleeps: number[] = [];
  (service as any).sleep = async (ms: number) => {
    sleeps.push(ms);
  };

  await service.startWarmupForGroups(
    [
      {
        id: 1,
        label: "proxy 1",
        session: sessionA,
        accounts: [account("acct-a1"), account("acct-a2")],
      },
      {
        id: 2,
        label: "proxy 2",
        session: sessionB,
        accounts: [account("acct-b1")],
      },
    ],
    {
      minGapMs: 1000,
      maxGapMs: 1000,
      groupStartDelayMinMs: 5000,
      groupStartDelayMaxMs: 5000,
    },
  );

  // Between a1→a2 (1s), then between group1→group2 (5s). No trailing sleeps.
  assert.deepEqual(sleeps, [1000, 5000]);
  await service.stopWarmup();
});

test("stopWarmup emits viewer-cleared for warmup-only accounts", async () => {
  const service = new ViewerService();
  const calls: SessionCall[] = [];
  const clearedEvents: string[] = [];
  const disconnectedEvents: string[] = [];
  const session = sessionWithActorApis(calls);
  const acct = account("acct-warmup-only");

  service.on("viewer-cleared", (publicKey) => clearedEvents.push(publicKey));
  service.on("viewer-disconnected", (publicKey) => disconnectedEvents.push(publicKey));

  await service.startWarmupForGroups([
    { id: 1, label: "proxy 1", session, accounts: [acct] },
  ]);
  await flushAsyncWork();

  assert.equal(service.isSessionWarmupRunning(), true);

  await service.stopWarmup();

  assert.equal(service.isSessionWarmupRunning(), false);
  assert.deepEqual(clearedEvents, ["acct-warmup-only"]);
  assert.deepEqual(disconnectedEvents, []);
  assert.equal(calls.some((call) => call.type === "close"), true);
});

test("warmup actors deploy, return to warmup, and force close through browser session APIs", async () => {
  const service = new ViewerService();
  const calls: SessionCall[] = [];
  const warmupEvents: string[] = [];
  const connectedEvents: string[] = [];
  const disconnectedEvents: string[] = [];
  const session = sessionWithActorApis(calls);
  const acct = account("acct-1");

  service.on("viewer-warmup", (publicKey) => warmupEvents.push(publicKey));
  service.on("viewer-connected", (publicKey) => connectedEvents.push(publicKey));
  service.on("viewer-disconnected", (publicKey) => disconnectedEvents.push(publicKey));

  await service.startWarmupForGroups([
    { id: 1, label: "proxy 1", session, accounts: [acct] },
  ]);
  await flushAsyncWork();

  assert.equal(calls.some((call) => call.type === "open"), true);
  assert.deepEqual(warmupEvents, ["acct-1"]);
  assert.equal(service.getActiveCount(), 0);

  service.setTokenInfo(tokenInfo());
  const connected = await service.connectGroups(
    [{ id: 1, label: "proxy 1", session, accounts: [acct] }],
    {
      minGapMs: 0,
      maxGapMs: 0,
      groupStartDelayMinMs: 0,
      groupStartDelayMaxMs: 0,
      shuffle: false,
    },
  );

  assert.equal(connected, 1);
  assert.equal(service.getActiveCount(), 1);
  assert.deepEqual(connectedEvents, ["acct-1"]);
  assert.equal(
    calls.some(
      (call) =>
        call.type === "navigate" &&
        call.actions.some((action) => action.op === "join" && action.room === "t:deploy-pair"),
    ),
    true,
  );

  const slowlyStopped = await service.disconnectSlowly(0, 0);

  assert.equal(slowlyStopped, 1);
  assert.equal(service.getActiveCount(), 0);
  assert.deepEqual(disconnectedEvents, ["acct-1"]);
  assert.equal(warmupEvents.at(-1), "acct-1");
  assert.equal(
    calls.some(
      (call) =>
        call.type === "navigate" &&
        call.actions.some((action) => action.op === "leave" && action.room === "t:deploy-pair"),
    ),
    true,
  );

  await service.stopWarmup();

  assert.equal(calls.some((call) => call.type === "close"), true);
});

test("disconnectSlowly removes actor connection when return to warmup fails once", async () => {
  const service = new ViewerService();
  const calls: SessionCall[] = [];
  const disconnectedEvents: string[] = [];
  let failedReturnAttempts = 0;
  const session = {
    ...sessionWithActorApis(calls),
    navigateSession: async (sessionId: number, actions: NavAction[]) => {
      calls.push({ type: "navigate", sessionId, actions });
      if (
        actions.some(
          (action) => action.op === "leave" && action.room === "t:deploy-pair",
        ) &&
        failedReturnAttempts === 0
      ) {
        failedReturnAttempts++;
        throw new Error("return failed");
      }
    },
  } as BrowserSession;
  const acct = account("acct-fail-return");

  service.on("viewer-disconnected", (publicKey) => disconnectedEvents.push(publicKey));

  await service.startWarmupForGroups([
    { id: 1, label: "proxy 1", session, accounts: [acct] },
  ]);
  await flushAsyncWork();

  service.setTokenInfo(tokenInfo());
  const connected = await service.connectGroups(
    [{ id: 1, label: "proxy 1", session, accounts: [acct] }],
    {
      minGapMs: 0,
      maxGapMs: 0,
      groupStartDelayMinMs: 0,
      groupStartDelayMaxMs: 0,
      shuffle: false,
    },
  );
  assert.equal(connected, 1);
  assert.equal(service.getActiveCount(), 1);

  const slowlyStopped = await service.disconnectSlowly(0, 0);

  assert.equal(slowlyStopped, 1);
  assert.equal(service.getActiveCount(), 0);
  assert.deepEqual(disconnectedEvents, ["acct-fail-return"]);
  assert.equal(failedReturnAttempts, 1);

  await service.stopWarmup();
});
