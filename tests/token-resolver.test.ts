import test from "node:test";
import assert from "node:assert/strict";

import { resolveTokenInput } from "../src/ui/token-resolver";

test("bare address resolves locally as a CA without browser auth", async () => {
  const ca = "C4AYNMP4Hor2fNkLSkatgN8DuLfQRepGJpAVBhHUz5Ak";
  const derivedPair = "6NUpZcjcfN8TV14gpSnnnpyn8hiKgJod1dQUnmXxDi8s";

  const result = await resolveTokenInput(ca);

  assert.equal(result.tokenInfo.pairAddress, derivedPair);
  assert.equal(result.tokenInfo.tokenAddress, ca);
  assert.equal(result.tokenInfo.protocol, "Pump V1");
  assert.equal(result.tokenInfo.chain, "sol");
  assert.equal(result.derived, true);
});

test("full Axiom link uses the embedded address as pair without fetching metadata", async () => {
  const pairAddress = "F43ZMQDkEnFxs3P3DU4BYQD6NnyPjAqDb7NzrdxzrB8L";

  const result = await resolveTokenInput(
    `https://axiom.trade/meme/${pairAddress}?chain=sol`,
  );

  assert.equal(result.tokenInfo.pairAddress, pairAddress);
  assert.equal(result.tokenInfo.tokenAddress, "");
  assert.equal(result.tokenInfo.ticker, "TOKEN");
  assert.equal(result.tokenInfo.chain, "sol");
  assert.equal(result.derived, false);
});

test("bare CA can resolve a non-pump-suffix token to its local pump pair", async () => {
  const ca = "DadLHhi9h1P3YcDRUurHaTcoaLUquNRK3qtZg8ay4hPF";
  const derivedPair = "GkuT1F4aNAauKrVYpNsn1UT5SrPpGSKTuxHesK57Fdcc";

  const result = await resolveTokenInput(ca);

  assert.equal(result.tokenInfo.pairAddress, derivedPair);
  assert.equal(result.tokenInfo.tokenAddress, ca);
  assert.equal(result.tokenInfo.protocol, "Pump V1");
});

test("robinhood link with ?chain=robinhood resolves 0x pair + chain", async () => {
  const pairAddress = "0xef043c8aba35eb9422aca2952467310456b21f95";
  const result = await resolveTokenInput(
    `https://axiom.trade/meme/${pairAddress}?chain=robinhood&pulseChains=robinhood`,
  );

  assert.equal(result.tokenInfo.pairAddress, pairAddress);
  assert.equal(result.tokenInfo.chain, "robinhood");
  assert.equal(result.derived, false);
});

test("bare 0x address is always Robinhood", async () => {
  const ca = "0xa7254b5806775bba1efed7ec7b8f50a2d21f786c";
  const pool = "0x219fa6b37bb0c1218e6013a157897822c9799933";

  const result = await resolveTokenInput(ca, {
    findRobinhoodPool: async () => ({
      pool,
      fee: 10000,
      blockNumber: 1,
    }),
  });

  assert.equal(result.tokenInfo.chain, "robinhood");
  assert.equal(result.tokenInfo.tokenAddress, ca);
  assert.equal(result.tokenInfo.pairAddress, pool);
  assert.equal(result.tokenInfo.protocol, "Uniswap v3");
  assert.equal(result.derived, true);
});

test("0x link without ?chain= defaults to robinhood", async () => {
  const pairAddress = "0xef043c8aba35eb9422aca2952467310456b21f95";
  const result = await resolveTokenInput(
    `https://axiom.trade/meme/${pairAddress}`,
  );

  assert.equal(result.tokenInfo.pairAddress, pairAddress);
  assert.equal(result.tokenInfo.chain, "robinhood");
  assert.equal(result.derived, false);
});

test("bare 0x without a pool yet tells the user to watch deploy", async () => {
  await assert.rejects(
    () =>
      resolveTokenInput("0xa7254b5806775bba1efed7ec7b8f50a2d21f786c", {
        findRobinhoodPool: async () => null,
      }),
    /Watch deploy/i,
  );
});
