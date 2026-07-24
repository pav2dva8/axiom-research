import test from "node:test";
import assert from "node:assert/strict";

import {
  ROBINHOOD_WETH,
  UNISWAP_V3_FACTORY_ROBINHOOD,
  V3_FEE_TIERS,
  decodeEthAddressResult,
  encodeUniswapV3GetPoolCalldata,
  findUniswapV3WethPool,
  normalizeHexAddress,
  type RobinhoodRpcClient,
} from "../src/ui/robinhood-deploy-watch";

test("normalizeHexAddress lowercases and validates 0x addresses", () => {
  assert.equal(
    normalizeHexAddress("0xA7254B5806775BBA1EFED7EC7B8F50A2D21F786C"),
    "0xa7254b5806775bba1efed7ec7b8f50a2d21f786c",
  );
  assert.throws(() => normalizeHexAddress("not-hex"), /Invalid Robinhood CA/i);
});

test("encodeUniswapV3GetPoolCalldata sorts tokens and encodes fee", () => {
  const ca = "0xa7254b5806775bba1efed7ec7b8f50a2d21f786c";
  const data = encodeUniswapV3GetPoolCalldata(ROBINHOOD_WETH, ca, 10000);
  assert.match(data, /^0x1698ee82/);
  // token0 = WETH (lower address), token1 = CA
  assert.equal(data.slice(10, 74), ROBINHOOD_WETH.slice(2).toLowerCase().padStart(64, "0"));
  assert.equal(data.slice(74, 138), ca.slice(2).toLowerCase().padStart(64, "0"));
  assert.equal(data.slice(138), (10000).toString(16).padStart(64, "0"));
});

test("decodeEthAddressResult ignores zero address", () => {
  assert.equal(
    decodeEthAddressResult(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    ),
    null,
  );
  assert.equal(
    decodeEthAddressResult(
      "0x000000000000000000000000219fa6b37bb0c1218e6013a157897822c9799933",
    ),
    "0x219fa6b37bb0c1218e6013a157897822c9799933",
  );
});

test("findUniswapV3WethPool returns first non-zero fee tier pool", async () => {
  const calls: Array<{ to: string; data: string }> = [];
  const client: RobinhoodRpcClient = {
    async ethCall(to, data) {
      calls.push({ to, data });
      if (calls.length < 4) {
        return "0x0000000000000000000000000000000000000000000000000000000000000000";
      }
      return "0x000000000000000000000000219fa6b37bb0c1218e6013a157897822c9799933";
    },
    async ethBlockNumber() {
      return 42;
    },
  };

  const found = await findUniswapV3WethPool(
    "0xa7254b5806775bba1efed7ec7b8f50a2d21f786c",
    client,
  );

  assert.equal(found?.pool, "0x219fa6b37bb0c1218e6013a157897822c9799933");
  assert.equal(found?.fee, 10000);
  assert.equal(found?.blockNumber, 42);
  assert.equal(calls.length, V3_FEE_TIERS.length);
  assert.equal(calls[0]?.to.toLowerCase(), UNISWAP_V3_FACTORY_ROBINHOOD.toLowerCase());
});

test("findUniswapV3WethPool returns null when no pool exists", async () => {
  const client: RobinhoodRpcClient = {
    async ethCall() {
      return "0x0000000000000000000000000000000000000000000000000000000000000000";
    },
    async ethBlockNumber() {
      return 1;
    },
  };

  assert.equal(
    await findUniswapV3WethPool("0xa7254b5806775bba1efed7ec7b8f50a2d21f786c", client),
    null,
  );
});
