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

test("parseMemeTrendingPayload reads live meme-trending-v2 tuple rows", () => {
  const tokens = parseMemeTrendingPayload([
    [
      "G21JBCbAdB45chyS7gUKNKdVchNFEt2SvuJnPvgeVWjX",
      "5VMbcRosto1RT6GZHRucUZEM26XEoTYcmoSbNhq3pump",
      "FrogCat",
      "FrogCat",
      "https://example.com/img.webp",
      6,
      "Pump AMM",
    ],
    [
      "27Wij19hyhYGCxN7jQMpumpPairAddr11111111112",
      "So11111111111111111111111111111111111111112",
      "ABC",
      "Alpha",
    ],
    ["not-an-address", "also-bad"],
  ]);

  assert.equal(tokens.length, 2);
  assert.equal(tokens[0]?.pairAddress, "G21JBCbAdB45chyS7gUKNKdVchNFEt2SvuJnPvgeVWjX");
  assert.equal(tokens[0]?.tokenAddress, "5VMbcRosto1RT6GZHRucUZEM26XEoTYcmoSbNhq3pump");
  assert.equal(tokens[0]?.ticker, "FrogCat");
  assert.equal(tokens[1]?.ticker, "ABC");
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
