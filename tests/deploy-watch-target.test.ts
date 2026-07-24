import test from "node:test";
import assert from "node:assert/strict";

import { derivePumpPair } from "../src/pump-pair";
import { resolveDeployWatchTarget } from "../src/ui/deploy-watch-target";

test("deploy watch target uses only local pair derivation", () => {
  const ca = "C4AYNMP4Hor2fNkLSkatgN8DuLfQRepGJpAVBhHUz5Ak";
  const derivedPair = "6NUpZcjcfN8TV14gpSnnnpyn8hiKgJod1dQUnmXxDi8s";

  const target = resolveDeployWatchTarget(ca);

  assert.equal(derivePumpPair(ca), derivedPair);
  assert.equal(target.parsed.ca, ca);
  assert.equal(target.parsed.pairAddress, derivedPair);
  assert.equal(target.parsed.chain, "sol");
  assert.equal(target.tokenInfo.pairAddress, derivedPair);
  assert.equal(target.tokenInfo.tokenAddress, ca);
  assert.equal(target.resolvedByAxiom, false);
});

test("deploy watch target accepts Robinhood bare 0x CA", () => {
  const ca = "0xa7254b5806775bba1efed7ec7b8f50a2d21f786c";
  const target = resolveDeployWatchTarget(ca);
  assert.equal(target.parsed.chain, "robinhood");
  assert.equal(target.parsed.ca, ca);
  assert.equal(target.tokenInfo.chain, "robinhood");
  assert.equal(target.tokenInfo.tokenAddress, ca);
});
