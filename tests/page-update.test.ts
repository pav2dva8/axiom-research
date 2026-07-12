import test from "node:test";
import assert from "node:assert/strict";
import {
  pageUpdateDiscover,
  pageUpdatePulse,
  pageUpdateMeme,
} from "../src/session/page-update";

test("pageUpdateDiscover matches HAR-shaped discover payload", () => {
  const payload = pageUpdateDiscover();
  assert.deepEqual(payload, {
    type: "pageUpdate",
    page: "discover",
    subpage: { tab: "DEX Screener" },
    chain: "sol",
  });
});

test("pageUpdatePulse matches HAR-shaped pulse payload", () => {
  const payload = pageUpdatePulse();
  assert.deepEqual(payload, {
    type: "pageUpdate",
    page: "pulse",
    chain: "sol",
  });
});

test("pageUpdateMeme includes pairAddress in subpage and spreads tokenInfo", () => {
  const tokenInfo = {
    pairAddress: "Pair111",
    tokenAddress: "Token111",
    ticker: "TEST",
    name: "Test Token",
    protocol: "Pump V1",
    isMigrated: false,
    supply: 1_000_000_000,
    price: 0.00001,
  };
  const payload = pageUpdateMeme(tokenInfo);
  assert.equal(payload.type, "pageUpdate");
  assert.equal(payload.page, "meme");
  assert.equal(payload.chain, "sol");
  assert.equal((payload.subpage as { pairAddress: string }).pairAddress, "Pair111");
  assert.equal((payload.subpage as { tokenAddress: string }).tokenAddress, "Token111");
  assert.equal((payload.subpage as { ticker: string }).ticker, "TEST");
});
