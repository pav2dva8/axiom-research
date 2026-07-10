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
