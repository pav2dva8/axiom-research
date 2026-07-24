import test from "node:test";
import assert from "node:assert/strict";
import {
  planEnterFromFeed,
  planTokenToToken,
  planLeaveAll,
  planMinimalViewer,
  planPageUpdateOnlyViewer,
  GLOBAL_LIVENESS_ROOMS,
} from "../src/session/token-navigation-plan";

const T = { pairAddress: "Pair111", tokenAddress: "Token111" };
const U = { pairAddress: "Pair222", tokenAddress: "Token222" };
const fixed = () => 0; // min delays

test("planEnterFromFeed stages early then late joins and meme pageUpdate", () => {
  const plan = planEnterFromFeed(T, fixed);
  const roomsAt0 = plan.filter((a) => a.atMs === 0 && a.op === "join").map((a) => a.room);
  assert.deepEqual(roomsAt0.sort(), ["Pair111_refresh", "f:Pair111", "t:Pair111"].sort());
  const late = plan.filter((a) => a.atMs >= 450 && a.op === "join").map((a) => a.room!);
  for (const need of [
    "e-Pair111", "td:Pair111", "s:Pair111", "Pair111-dex-paid",
    "Pair111-wallet_funding", "kol_tx:Pair111", "pump-cto:Pair111",
    "a:Token111", "soc_bub:Token111",
  ]) {
    assert.equal(late.includes(need), true, `missing ${need}`);
  }
  assert.equal(late.includes("b-Pair111"), true);
  const pu = plan.find((a) => a.op === "pageUpdate");
  assert.ok(pu && pu.atMs >= 450 && pu.ws === "friends");
  assert.deepEqual(pu.pageUpdate, {
    type: "pageUpdate",
    page: "meme",
    subpage: {
      pairAddress: "Pair111",
      tokenAddress: "Token111",
    },
    chain: "sol",
  });
});

test("planTokenToToken leaves prev before joining next, delays e- leave, and updates meme page", () => {
  const plan = planTokenToToken(T, U, fixed);
  const firstJoin = Math.min(...plan.filter((a) => a.op === "join").map((a) => a.atMs));
  const leaves = plan.filter((a) => a.op === "leave");
  assert.ok(leaves.every((a) => a.atMs < firstJoin || a.room === "e-Pair111"));
  const eLeave = leaves.find((a) => a.room === "e-Pair111");
  assert.ok(eLeave && eLeave.atMs >= firstJoin + 36);
  const pu = plan.find((a) => a.op === "pageUpdate");
  assert.deepEqual(pu?.pageUpdate, {
    type: "pageUpdate",
    page: "meme",
    subpage: {
      pairAddress: "Pair222",
      tokenAddress: "Token222",
    },
    chain: "sol",
  });
});

test("planLeaveAll leaves token rooms including e-", () => {
  const rooms = planLeaveAll(T).filter((a) => a.op === "leave").map((a) => a.room!);
  assert.equal(rooms.includes("e-Pair111"), true);
  assert.equal(rooms.includes("t:Pair111"), true);
});

test("planMinimalViewer joins early rooms + e-{pair} and sends meme pageUpdate", () => {
  const plan = planMinimalViewer(T);
  assert.equal(plan.length, 5);
  const joins = plan.filter((a) => a.op === "join").map((a) => a.room!).sort();
  assert.deepEqual(joins, [
    "Pair111_refresh",
    "e-Pair111",
    "f:Pair111",
    "t:Pair111",
  ]);
  const pu = plan.find((a) => a.op === "pageUpdate");
  assert.ok(pu);
  assert.equal(pu.ws, "friends");
  assert.equal(pu.atMs, 0);
  assert.deepEqual(pu.pageUpdate, {
    type: "pageUpdate",
    page: "meme",
    subpage: {
      pairAddress: "Pair111",
      tokenAddress: "Token111",
    },
    chain: "sol",
  });
});

test("planPageUpdateOnlyViewer sends only a friends pageUpdate with no cluster token rooms", () => {
  const plan = planPageUpdateOnlyViewer(T);
  assert.equal(plan.length, 1);
  assert.equal(plan.some((a) => a.ws === "cluster"), false);
  const pu = plan.find((a) => a.op === "pageUpdate");
  assert.ok(pu);
  assert.equal(pu.ws, "friends");
  assert.equal(pu.atMs, 0);
  assert.deepEqual(pu.pageUpdate, {
    type: "pageUpdate",
    page: "meme",
    subpage: {
      pairAddress: "Pair111",
      tokenAddress: "Token111",
    },
    chain: "sol",
  });
});

test("planPageUpdateOnlyViewer carries robinhood chain into the pageUpdate", () => {
  const rhToken = {
    pairAddress: "0xRhPair",
    tokenAddress: "0xRhToken",
    chain: "robinhood",
  };
  const plan = planPageUpdateOnlyViewer(rhToken);
  const pu = plan.find((a) => a.op === "pageUpdate");
  assert.ok(pu);
  assert.equal((pu.pageUpdate as { chain: string }).chain, "robinhood");
});

test("GLOBAL_LIVENESS_ROOMS contains the high-traffic global rooms and no token-specific rooms", () => {
  // These are the global broadcast rooms observed in the HAR (joined at 0ms on
  // every cluster9 open). They keep the socket non-idle so it is not reaped.
  for (const need of [
    "sol_price",
    "btc_price",
    "eth_price",
    "bnb_price",
    "block_hash",
    "sol-priority-fee-v2",
    "connection_monitor",
    "online-users-count",
    "lighthouse",
  ]) {
    assert.equal(
      GLOBAL_LIVENESS_ROOMS.includes(need as never),
      true,
      `missing ${need}`,
    );
  }
  // Must NOT contain token-specific rooms — these are connection-level.
  for (const forbidden of ["t:", "f:", "e-", "td:", "s:", "b-", "a:", "kol_tx:", "soc_bub:", "pump-cto:"]) {
    assert.equal(
      GLOBAL_LIVENESS_ROOMS.some((r) => r.startsWith(forbidden)),
      false,
      `should not contain a ${forbidden} token room`,
    );
  }
  // No duplicates.
  assert.equal(
    GLOBAL_LIVENESS_ROOMS.length,
    new Set(GLOBAL_LIVENESS_ROOMS).size,
    "duplicate liveness rooms",
  );
});
