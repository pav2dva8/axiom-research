import test from "node:test";
import assert from "node:assert/strict";
import { FeedPool, parseMemeTrendingPayload } from "../src/session/feed-pool";

test("parseMemeTrendingPayload extracts tokens from common feed shapes", () => {
  const tokens = parseMemeTrendingPayload({
    data: {
      trending: [
        {
          pairAddress: "Pair111",
          tokenAddress: "Token111",
          ticker: "ONE",
          name: "Token One",
        },
        {
          pair: { address: "Pair222" },
          token: { address: "Token222", ticker: "TWO", name: "Token Two" },
        },
        {
          pairAddress: "Pair333",
          tokenMint: "Token333",
          symbol: "THREE",
        },
        { pairAddress: "PairMissingToken" },
      ],
    },
  });

  assert.deepEqual(tokens, [
    { pairAddress: "Pair111", tokenAddress: "Token111", ticker: "ONE", name: "Token One" },
    { pairAddress: "Pair222", tokenAddress: "Token222", ticker: "TWO", name: "Token Two" },
    { pairAddress: "Pair333", tokenAddress: "Token333", ticker: "THREE" },
  ]);
});

test("FeedPool refreshes from fetchTrending and picks a deterministic token", async () => {
  const pool = new FeedPool({
    fetchTrending: async () => [
      { pairAddress: "Pair111", tokenAddress: "Token111" },
      { pairAddress: "Pair222", tokenAddress: "Token222" },
      { pairAddress: "Pair333", tokenAddress: "Token333" },
    ],
  });

  await pool.refresh();

  assert.deepEqual(pool.pickRandom(() => 0.4), { pairAddress: "Pair222", tokenAddress: "Token222" });
  assert.deepEqual(pool.list(), [
    { pairAddress: "Pair111", tokenAddress: "Token111" },
    { pairAddress: "Pair222", tokenAddress: "Token222" },
    { pairAddress: "Pair333", tokenAddress: "Token333" },
  ]);
});

test("FeedPool skips refresh while cached entries are within ttl", async () => {
  let fetches = 0;
  const pool = new FeedPool({
    ttlMs: 60_000,
    fetchTrending: async () => {
      fetches++;
      return [{ pairAddress: `Pair${fetches}`, tokenAddress: `Token${fetches}` }];
    },
  });

  await pool.refresh();
  await pool.refresh();

  assert.equal(fetches, 1);
  assert.deepEqual(pool.list(), [{ pairAddress: "Pair1", tokenAddress: "Token1" }]);
});
