import test from "node:test";
import assert from "node:assert/strict";

import type { LoadedAccount } from "../src/ui/account-manager";
import { ViewerService, type TokenInfo } from "../src/ui/viewer-service";
import type { BrowserSession } from "../src/browser-auth";

function account(publicKey: string): LoadedAccount {
  return {
    publicKey,
    cookies: "",
    accessToken: `access-${publicKey}`,
    refreshToken: `refresh-${publicKey}`,
  };
}

function tokenInfo(pairAddress = "pair"): TokenInfo {
  return {
    pairAddress,
    tokenAddress: "token",
    ticker: "TOKEN",
    name: "Token",
    protocol: "Pump V1",
    isMigrated: false,
    supply: 1_000_000_000,
    price: 0,
  };
}

test("connectGroups connects each group through its warmed browser session", async () => {
  const service = new ViewerService();
  service.setTokenInfo(tokenInfo());

  const calls: string[] = [];
  const session = (label: string): BrowserSession => ({
    connectViewer: async (accessToken: string) => {
      calls.push(`${label}:${accessToken}`);
      return calls.length;
    },
    disconnectViewer: async () => {},
    disconnectAllViewers: async () => {},
  } as any);

  const connected = await service.connectGroups(
    [
      { id: 1, label: "proxy 1", session: session("proxy 1"), accounts: [account("acct-1")] },
      { id: 2, label: "proxy 2", session: session("proxy 2"), accounts: [account("acct-2")] },
    ],
    {
      minGapMs: 0,
      maxGapMs: 0,
      groupStartDelayMinMs: 0,
      groupStartDelayMaxMs: 0,
      bootstrapDisabled: true,
    },
  );

  assert.equal(connected, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(new Set(calls), new Set(["proxy 1:access-acct-1", "proxy 2:access-acct-2"]));
});

test("connectGroups retries transient websocket closes before marking an account failed", async () => {
  const service = new ViewerService();
  service.setTokenInfo(tokenInfo());

  const events: string[] = [];
  service.on("viewer-failed", (pk) => events.push(`failed:${pk}`));
  service.on("viewer-connected", (pk) => events.push(`connected:${pk}`));

  let attempts = 0;
  const session: BrowserSession = {
    connectViewer: async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("page.evaluate: Error: friends closed code=1006");
      }
      return 7;
    },
    disconnectViewer: async () => {},
    disconnectAllViewers: async () => {},
  } as any;

  const connected = await service.connectGroups(
    [{ id: 1, label: "proxy 1", session, accounts: [account("acct-1")] }],
    {
      minGapMs: 0,
      maxGapMs: 0,
      groupStartDelayMinMs: 0,
      groupStartDelayMaxMs: 0,
      connectRetryMinMs: 0,
      connectRetryMaxMs: 0,
      bootstrapDisabled: true,
    },
  );

  assert.equal(connected, 1);
  assert.equal(attempts, 2);
  assert.deepEqual(events, ["connected:acct-1"]);
});

test("connectGroups reuses the warmed proxy page instead of opening extra tabs", async () => {
  const service = new ViewerService();
  service.setTokenInfo(tokenInfo());

  let ensureCalls = 0;
  const usedSlots: number[] = [];
  const session: BrowserSession = {
    ensurePageSlots: async () => {
      ensureCalls++;
    },
    connectViewer: async (_accessToken, _refreshToken, _tokenInfo, _pingJitterMs, slotIndex) => {
      usedSlots.push(slotIndex ?? -1);
      return usedSlots.length;
    },
    disconnectViewer: async () => {},
    disconnectAllViewers: async () => {},
  } as any;

  const connected = await service.connectGroups(
    [
      {
        id: 1,
        label: "proxy 1",
        session,
        accounts: [account("acct-1"), account("acct-2"), account("acct-3")],
      },
    ],
    {
      minGapMs: 0,
      maxGapMs: 0,
      groupStartDelayMinMs: 0,
      groupStartDelayMaxMs: 0,
      bootstrapDisabled: true,
      shuffle: false,
    },
  );

  assert.equal(connected, 3);
  assert.equal(ensureCalls, 0);
  assert.deepEqual(usedSlots, [0, 0, 0]);
});

test("connectGroups skips bootstrap by default for warmed proxy sessions", async () => {
  const service = new ViewerService();
  service.setTokenInfo(tokenInfo());

  let bootstrapCalls = 0;
  const session: BrowserSession = {
    bootstrapSession: async () => {
      bootstrapCalls++;
    },
    connectViewer: async () => 1,
    disconnectViewer: async () => {},
    disconnectAllViewers: async () => {},
  } as any;

  const connected = await service.connectGroups(
    [{ id: 1, label: "proxy 1", session, accounts: [account("acct-1")] }],
    {
      minGapMs: 0,
      maxGapMs: 0,
      groupStartDelayMinMs: 0,
      groupStartDelayMaxMs: 0,
      shuffle: false,
    },
  );

  assert.equal(connected, 1);
  assert.equal(bootstrapCalls, 0);
});

test("changing token info clears the previous viewer run before the next start", async () => {
  const service = new ViewerService();
  service.setTokenInfo(tokenInfo("pair-a"));

  let disconnectAllCalls = 0;
  const session: BrowserSession = {
    connectViewer: async () => service.getActiveCount() + 1,
    disconnectViewer: async () => {},
    disconnectAllViewers: async () => {
      disconnectAllCalls++;
    },
  } as any;

  const firstConnected = await service.connectGroups(
    [
      {
        id: 1,
        label: "proxy 1",
        session,
        accounts: [account("acct-1"), account("acct-2")],
      },
    ],
    {
      minGapMs: 0,
      maxGapMs: 0,
      groupStartDelayMinMs: 0,
      groupStartDelayMaxMs: 0,
      bootstrapDisabled: true,
      shuffle: false,
    },
  );

  assert.equal(firstConnected, 2);
  assert.equal(service.getActiveCount(), 2);

  service.setTokenInfo(tokenInfo("pair-b"));

  assert.equal(service.getActiveCount(), 0);
  assert.equal(disconnectAllCalls, 1);
});

test("slow stop disconnects proxy-group viewers without a direct browser session", async () => {
  const service = new ViewerService();
  service.setTokenInfo(tokenInfo());

  const disconnected: number[] = [];
  const session: BrowserSession = {
    ensurePageSlots: async () => {},
    connectViewer: async () => disconnected.length + service.getActiveCount() + 1,
    disconnectViewer: async (viewerId: number) => {
      disconnected.push(viewerId);
    },
    disconnectAllViewers: async () => {},
  } as any;

  const connected = await service.connectGroups(
    [
      {
        id: 1,
        label: "proxy 1",
        session,
        accounts: [account("acct-1"), account("acct-2")],
      },
    ],
    {
      minGapMs: 0,
      maxGapMs: 0,
      groupStartDelayMinMs: 0,
      groupStartDelayMaxMs: 0,
      bootstrapDisabled: true,
      shuffle: false,
    },
  );

  assert.equal(connected, 2);
  assert.equal(service.getActiveCount(), 2);

  const stopped = await service.disconnectSlowly(0);

  assert.equal(stopped, 2);
  assert.equal(service.getActiveCount(), 0);
  assert.deepEqual(disconnected, [1, 2]);
});
