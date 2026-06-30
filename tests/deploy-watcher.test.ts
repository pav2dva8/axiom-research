import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_DEPLOY_WATCH_POLL_MS,
  DEFAULT_SOLANA_RPC_URL,
  buildDeployTokenInfo,
  getDeployWatchConfig,
  parseDeployWatchInput,
} from "../src/ui/deploy-watcher";

test("getDeployWatchConfig uses defaults and trims env values", () => {
  assert.deepEqual(getDeployWatchConfig({}), {
    rpcUrl: DEFAULT_SOLANA_RPC_URL,
    wsUrl: undefined,
    pollMs: DEFAULT_DEPLOY_WATCH_POLL_MS,
  });

  assert.deepEqual(
    getDeployWatchConfig({
      SOLANA_RPC_URL: " https://rpc.example ",
      SOLANA_WS_URL: " wss://rpc.example ",
      DEPLOY_WATCH_POLL_MS: "100",
    }),
    {
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      pollMs: 100,
    },
  );

  assert.equal(
    getDeployWatchConfig({ DEPLOY_WATCH_POLL_MS: "abc" }).pollMs,
    DEFAULT_DEPLOY_WATCH_POLL_MS,
  );
});

test("parseDeployWatchInput accepts a bare pump CA and derives the pair", () => {
  const parsed = parseDeployWatchInput(
    "2eCCtb16cJkQs3LbCXRG1p97KKSv1c9cNHZUZVchpump",
  );

  assert.equal(
    parsed.ca,
    "2eCCtb16cJkQs3LbCXRG1p97KKSv1c9cNHZUZVchpump",
  );
  assert.equal(
    parsed.pairAddress,
    "Amk61ySm6z9hWSRSEsCKiMMb3i1G8ph89wNP9FzhBzsN",
  );

  const tokenInfo = buildDeployTokenInfo(parsed);
  assert.equal(tokenInfo.pairAddress, parsed.pairAddress);
  assert.equal(tokenInfo.tokenAddress, parsed.ca);
  assert.equal(tokenInfo.ticker, "TOKEN");
  assert.equal(tokenInfo.protocol, "Pump V1");
});

test("parseDeployWatchInput rejects links, invalid keys, and non-pump CAs", () => {
  assert.throws(
    () =>
      parseDeployWatchInput(
        "https://axiom.trade/meme/Amk61ySm6z9hWSRSEsCKiMMb3i1oEph89wNP9FzhBzsN?chain=sol",
      ),
    /bare token CA/i,
  );

  assert.throws(() => parseDeployWatchInput("not-a-solana-address"), /bare token CA/i);

  assert.throws(
    () => parseDeployWatchInput("11111111111111111111111111111111"),
    /pump.fun CAs/i,
  );
});
