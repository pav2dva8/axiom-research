import test from "node:test";
import assert from "node:assert/strict";

import {
  ViewerService,
  looksLikeTokenInfoData,
  normalizeTokenInfo,
} from "../src/ui/viewer-service";

test("normalizeTokenInfo accepts nested Axiom pair metadata", () => {
  const tokenInfo = normalizeTokenInfo("fallback-pair", {
    pair: { address: "pair-from-body", dex: "Raydium" },
    baseToken: {
      address: "token-ca",
      symbol: "TOK",
      name: "Token Name",
      totalSupply: "12345",
    },
    priceUsd: "0.001",
    isMigrated: true,
  });

  assert.deepEqual(tokenInfo, {
    pairAddress: "pair-from-body",
    tokenAddress: "token-ca",
    ticker: "TOK",
    name: "Token Name",
    protocol: "Raydium",
    isMigrated: true,
    supply: 12345,
    price: 0.001,
  });
});

test("looksLikeTokenInfoData rejects empty success bodies", () => {
  assert.equal(looksLikeTokenInfoData({}), false);
  assert.equal(looksLikeTokenInfoData({ error: "not found" }), false);
});

test("fetchTokenInfo rejects an empty 200 response instead of treating input as a pair", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    const service = new ViewerService();
    assert.equal(await service.fetchTokenInfo("not-a-real-pair"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchTokenInfo keeps requested pair when pair-info omits pairAddress", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        baseToken: { address: "token-ca", symbol: "TOK", name: "Token" },
        protocol: "Pump V1",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );

  try {
    const service = new ViewerService();
    const tokenInfo = await service.fetchTokenInfo("pair-address");
    assert.equal(tokenInfo?.pairAddress, "pair-address");
    assert.equal(tokenInfo?.tokenAddress, "token-ca");
    assert.equal(tokenInfo?.ticker, "TOK");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
