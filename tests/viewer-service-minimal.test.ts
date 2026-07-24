import test from "node:test";
import assert from "node:assert/strict";

import type { LoadedAccount } from "../src/ui/account-manager";
import { ViewerService, type TokenInfo } from "../src/ui/viewer-service";
import type { BrowserSession } from "../src/browser-auth";
import type { NavAction } from "../src/session/token-navigation-plan";

function account(publicKey: string): LoadedAccount {
  return {
    publicKey,
    cookies: "",
    accessToken: `access-${publicKey}`,
    refreshToken: `refresh-${publicKey}`,
  };
}

function tokenInfo(pairAddress = "PairABC"): TokenInfo {
  return {
    pairAddress,
    tokenAddress: "TokenXYZ",
    ticker: "TOKEN",
    name: "Token",
    protocol: "Pump V1",
    isMigrated: false,
    supply: 1_000_000_000,
    price: 0,
    chain: "sol",
  };
}

/** Mock Chrome session that records openSession/navigateSession calls. */
function mockSession(): BrowserSession & { navCalls: NavAction[][] } {
  const navCalls: NavAction[][] = [];
  let nextId = 1;
  return {
    openSession: async () => nextId++,
    navigateSession: async (_id: number, actions: NavAction[]) => {
      navCalls.push(actions);
    },
    closeSession: async () => {},
    connectViewer: async () => {
      throw new Error("connectViewer should not be used");
    },
    disconnectViewer: async () => {},
    disconnectAllViewers: async () => {},
    getSessionShards: () => ({
      apiHost: "api9.axiom.trade",
      clusterWsUrl: "wss://cluster9.axiom.trade/",
    }),
    ensureSessionShards: async () => ({
      apiHost: "api9.axiom.trade",
      clusterWsUrl: "wss://cluster9.axiom.trade/",
    }),
    getProxyConfig: () => undefined,
    navCalls,
  } as any;
}

test("connectGroups navMode minimal navigates with early rooms + e- + pageUpdate", async () => {
  const service = new ViewerService();
  service.setTokenInfo(tokenInfo());

  const session = mockSession();
  const connected = await service.connectGroups(
    [{ id: 1, label: "proxy 1", session, accounts: [account("acct-1")] }],
    {
      minGapMs: 0,
      maxGapMs: 0,
      groupStartDelayMinMs: 0,
      groupStartDelayMaxMs: 0,
      bootstrapDisabled: true,
      navMode: "minimal",
      shuffle: false,
    },
  );

  assert.equal(connected, 1);
  assert.equal(session.navCalls.length, 1);
  const actions = session.navCalls[0]!;
  const rooms = actions
    .filter((a) => a.op === "join")
    .map((a) => a.room)
    .sort();
  assert.deepEqual(rooms, [
    "PairABC_refresh",
    "e-PairABC",
    "f:PairABC",
    "t:PairABC",
  ]);
  assert.equal(actions.some((a) => a.op === "pageUpdate"), true);
});

test("connectGroups connects every selected account in a proxy group", async () => {
  const service = new ViewerService();
  service.setTokenInfo(tokenInfo());

  const session = mockSession();
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
      navMode: "page-update",
      shuffle: false,
    },
  );

  assert.equal(connected, 2);
  assert.equal(session.navCalls.length, 2);
});

test("connectGroups passes friendsReconnectDelayMs into openSession", async () => {
  const service = new ViewerService();
  service.setTokenInfo(tokenInfo());

  const openOpts: unknown[] = [];
  const session = mockSession();
  session.openSession = async (_a, _r, opts) => {
    openOpts.push(opts);
    return 1;
  };

  await service.connectGroups(
    [{ id: 1, label: "proxy 1", session, accounts: [account("acct-1")] }],
    {
      minGapMs: 0,
      maxGapMs: 0,
      groupStartDelayMinMs: 0,
      groupStartDelayMaxMs: 0,
      bootstrapDisabled: true,
      navMode: "page-update",
      shuffle: false,
      friendsReconnectDelayMs: 20_000,
    },
  );

  assert.equal(openOpts.length, 1);
  assert.equal((openOpts[0] as { friendsReconnectDelayMs: number }).friendsReconnectDelayMs, 20_000);
});

test("connectGroups navMode page-update sends pageUpdate only (no token rooms)", async () => {
  const service = new ViewerService();
  service.setTokenInfo(tokenInfo());

  const session = mockSession();
  const connected = await service.connectGroups(
    [{ id: 1, label: "proxy 1", session, accounts: [account("acct-1")] }],
    {
      minGapMs: 0,
      maxGapMs: 0,
      groupStartDelayMinMs: 0,
      groupStartDelayMaxMs: 0,
      bootstrapDisabled: true,
      navMode: "page-update",
      shuffle: false,
    },
  );

  assert.equal(connected, 1);
  assert.equal(session.navCalls.length, 1);
  const actions = session.navCalls[0]!;
  // page-update sends only a friends pageUpdate — no cluster token rooms.
  assert.equal(actions.length, 1);
  assert.equal(actions[0].op, "pageUpdate");
  assert.equal(actions[0].ws, "friends");
  assert.equal(
    actions.some((a) => a.ws === "cluster" && a.op === "join"),
    false,
  );
});

test("connectGroups navMode page-update carries robinhood chain into pageUpdate", async () => {
  const service = new ViewerService();
  const rhToken: TokenInfo = {
    pairAddress: "0xef043c8aba35eb9422aca2952467310456b21f95",
    tokenAddress: "0xa0aded6600428b148e770552f1a7d71ed29409f2",
    ticker: "PAIGU",
    name: "Paigu",
    protocol: "Uniswap v3",
    isMigrated: false,
    supply: 1_000_000_000,
    price: 0,
    chain: "robinhood",
  };
  service.setTokenInfo(rhToken);

  const session = mockSession();
  await service.connectGroups(
    [{ id: 1, label: "proxy 1", session, accounts: [account("acct-1")] }],
    {
      minGapMs: 0,
      maxGapMs: 0,
      groupStartDelayMinMs: 0,
      groupStartDelayMaxMs: 0,
      bootstrapDisabled: true,
      navMode: "page-update",
      shuffle: false,
    },
  );

  const pu = session.navCalls[0]!.find((a) => a.op === "pageUpdate")!;
  assert.equal((pu.pageUpdate as { chain: string }).chain, "robinhood");
  assert.equal(
    (pu.pageUpdate as { subpage: { pairAddress: string } }).subpage.pairAddress,
    rhToken.pairAddress,
  );
});
