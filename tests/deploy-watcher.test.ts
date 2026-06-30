import test from "node:test";
import assert from "node:assert/strict";

import type { PublicKey } from "@solana/web3.js";
import {
  DEFAULT_DEPLOY_WATCH_POLL_MS,
  DEFAULT_SOLANA_RPC_URL,
  DeployWatchCanceledError,
  DeployWatcher,
  buildDeployTokenInfo,
  getDeployWatchConfig,
  parseDeployWatchInput,
  type DeployWatchConnection,
} from "../src/ui/deploy-watcher";

function fakeAccountInfo(publicKey: PublicKey) {
  return {
    data: Buffer.alloc(0),
    executable: false,
    lamports: 1,
    owner: publicKey,
    rentEpoch: 0,
  };
}

type FakeRead = null | { slot: number };

class FakeConnection implements DeployWatchConnection {
  private nextSubId = 1;
  private reads: FakeRead[];
  readonly callbacks = new Map<number, (accountInfo: any, context: any) => void>();
  readonly removed: number[] = [];

  constructor(reads: FakeRead[]) {
    this.reads = [...reads];
  }

  async getAccountInfoAndContext(publicKey: PublicKey) {
    const next = this.reads.length > 0 ? this.reads.shift() : null;
    return {
      context: { slot: next?.slot ?? 0 },
      value: next ? fakeAccountInfo(publicKey) : null,
    };
  }

  onAccountChange(
    _publicKey: PublicKey,
    callback: (accountInfo: any, context: any) => void,
  ): number {
    const id = this.nextSubId++;
    this.callbacks.set(id, callback);
    return id;
  }

  async removeAccountChangeListener(id: number): Promise<void> {
    this.removed.push(id);
    this.callbacks.delete(id);
  }

  fire(id: number, publicKey: PublicKey): void {
    const callback = this.callbacks.get(id);
    if (callback) callback(fakeAccountInfo(publicKey), { slot: 999 });
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

  assert.equal(getDeployWatchConfig({ DEPLOY_WATCH_POLL_MS: "0" }).pollMs, 0);
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
    () => parseDeployWatchInput("111111111111111111111111111111111"),
    /Invalid Solana CA/i,
  );

  assert.throws(
    () => parseDeployWatchInput("11111111111111111111111111111111"),
    /pump.fun CAs/i,
  );
});

test("DeployWatcher resolves immediately when mint account already exists", async () => {
  const parsed = parseDeployWatchInput(
    "2eCCtb16cJkQs3LbCXRG1p97KKSv1c9cNHZUZVchpump",
  );
  const fake = new FakeConnection([{ slot: 123 }]);
  const watcher = new DeployWatcher(() => fake);

  const result = await watcher.waitForDeploy(parsed, {
    rpcUrl: "http://rpc.local",
    pollMs: 1,
  });

  assert.equal(result.source, "initial");
  assert.equal(result.slot, 123);
  assert.equal(watcher.isActive(), false);
});

test("DeployWatcher detects mint via polling fallback", async () => {
  const parsed = parseDeployWatchInput(
    "2eCCtb16cJkQs3LbCXRG1p97KKSv1c9cNHZUZVchpump",
  );
  const fake = new FakeConnection([null, null, { slot: 222 }]);
  const watcher = new DeployWatcher(() => fake);

  const result = await watcher.waitForDeploy(parsed, {
    rpcUrl: "http://rpc.local",
    pollMs: 1,
  });

  assert.equal(result.source, "poll");
  assert.equal(result.slot, 222);
});

test("DeployWatcher confirms a websocket notification with an HTTP read", async () => {
  const parsed = parseDeployWatchInput(
    "2eCCtb16cJkQs3LbCXRG1p97KKSv1c9cNHZUZVchpump",
  );
  const fake = new FakeConnection([null, { slot: 333 }]);
  const watcher = new DeployWatcher(() => fake);

  const promise = watcher.waitForDeploy(parsed, {
    rpcUrl: "http://rpc.local",
    wsUrl: "ws://rpc.local",
    pollMs: 1000,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  fake.fire(1, parsed.mint);

  const result = await promise;
  assert.equal(result.source, "ws");
  assert.equal(result.slot, 333);
  assert.deepEqual(fake.removed, [1]);
});

test("DeployWatcher cancel rejects the pending watch and cleans up", async () => {
  const parsed = parseDeployWatchInput(
    "2eCCtb16cJkQs3LbCXRG1p97KKSv1c9cNHZUZVchpump",
  );
  const fake = new FakeConnection([null, null, null]);
  const watcher = new DeployWatcher(() => fake);

  const promise = watcher.waitForDeploy(parsed, {
    rpcUrl: "http://rpc.local",
    pollMs: 1000,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  watcher.cancel("Deploy watch canceled by test.");

  await assert.rejects(promise, DeployWatchCanceledError);
  assert.equal(watcher.isActive(), false);
});

test("DeployWatcher cancel during initial HTTP read rejects and suppresses detected event", async () => {
  const parsed = parseDeployWatchInput(
    "2eCCtb16cJkQs3LbCXRG1p97KKSv1c9cNHZUZVchpump",
  );
  const initialRead = createDeferred<{
    context: { slot: number };
    value: ReturnType<typeof fakeAccountInfo>;
  }>();
  const detectedEvents: unknown[] = [];
  const fake: DeployWatchConnection = {
    getAccountInfoAndContext: async () => initialRead.promise,
    onAccountChange: () => 1,
    removeAccountChangeListener: async () => {},
  };
  const watcher = new DeployWatcher(() => fake);
  const unsubscribe = watcher.onDeployWatch((event) => {
    if (event.state === "detected") detectedEvents.push(event);
  });

  const promise = watcher.waitForDeploy(parsed, {
    rpcUrl: "http://rpc.local",
    pollMs: 1000,
  });

  watcher.cancel("Deploy watch canceled by test.");
  await assert.rejects(promise, DeployWatchCanceledError);
  assert.equal(watcher.isActive(), false);

  initialRead.resolve({
    context: { slot: 444 },
    value: fakeAccountInfo(parsed.mint),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(detectedEvents, []);
  unsubscribe();
});

test("DeployWatcher cancel during WS confirmation rejects, unsubscribes, and suppresses detected event", async () => {
  const parsed = parseDeployWatchInput(
    "2eCCtb16cJkQs3LbCXRG1p97KKSv1c9cNHZUZVchpump",
  );
  const confirmationRead = createDeferred<{
    context: { slot: number };
    value: ReturnType<typeof fakeAccountInfo> | null;
  }>();
  const reads = [null];
  const detectedEvents: unknown[] = [];
  const fake = new FakeConnection(reads);
  const originalRead = fake.getAccountInfoAndContext.bind(fake);
  let readCount = 0;
  fake.getAccountInfoAndContext = async (publicKey) => {
    readCount += 1;
    if (readCount === 1) {
      return originalRead(publicKey);
    }
    return confirmationRead.promise;
  };
  const watcher = new DeployWatcher(() => fake);
  const unsubscribe = watcher.onDeployWatch((event) => {
    if (event.state === "detected") detectedEvents.push(event);
  });

  const promise = watcher.waitForDeploy(parsed, {
    rpcUrl: "http://rpc.local",
    wsUrl: "ws://rpc.local",
    pollMs: 1000,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  fake.fire(1, parsed.mint);
  await new Promise((resolve) => setTimeout(resolve, 0));
  watcher.cancel("Deploy watch canceled by test.");

  await assert.rejects(promise, DeployWatchCanceledError);
  assert.equal(watcher.isActive(), false);
  assert.deepEqual(fake.removed, [1]);

  confirmationRead.resolve({
    context: { slot: 555 },
    value: fakeAccountInfo(parsed.mint),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(detectedEvents, []);
  unsubscribe();
});

test("DeployWatcher cancel removes an active WS subscription", async () => {
  const parsed = parseDeployWatchInput(
    "2eCCtb16cJkQs3LbCXRG1p97KKSv1c9cNHZUZVchpump",
  );
  const fake = new FakeConnection([null]);
  const watcher = new DeployWatcher(() => fake);

  const promise = watcher.waitForDeploy(parsed, {
    rpcUrl: "http://rpc.local",
    wsUrl: "ws://rpc.local",
    pollMs: 1000,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  watcher.cancel("Deploy watch canceled by test.");

  await assert.rejects(promise, DeployWatchCanceledError);
  assert.deepEqual(fake.removed, [1]);
});

test("DeployWatcher remains active until cancellation cleanup completes", async () => {
  const parsed = parseDeployWatchInput(
    "2eCCtb16cJkQs3LbCXRG1p97KKSv1c9cNHZUZVchpump",
  );
  const cleanupDone = createDeferred<void>();
  const events: string[] = [];
  const fake = new FakeConnection([null]);
  fake.removeAccountChangeListener = async (id: number) => {
    fake.removed.push(id);
    await cleanupDone.promise;
    fake.callbacks.delete(id);
  };
  const watcher = new DeployWatcher(() => fake);
  const unsubscribe = watcher.onDeployWatch((event) => {
    events.push(event.state);
  });

  const promise = watcher.waitForDeploy(parsed, {
    rpcUrl: "http://rpc.local",
    wsUrl: "ws://rpc.local",
    pollMs: 1000,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  watcher.cancel("Deploy watch canceled by test.");
  await new Promise((resolve) => setTimeout(resolve, 0));

  try {
    assert.equal(watcher.isActive(), true);
    await assert.rejects(
      watcher.waitForDeploy(parsed, {
        rpcUrl: "http://rpc.local",
        wsUrl: "ws://rpc.local",
        pollMs: 1000,
      }),
      /already active/i,
    );
    assert.deepEqual(events, ["watching"]);
  } finally {
    cleanupDone.resolve();
    await assert.rejects(promise, DeployWatchCanceledError);
    unsubscribe();
  }

  assert.equal(watcher.isActive(), false);
  assert.deepEqual(fake.removed, [1]);
  assert.deepEqual(events, ["watching", "canceled"]);
});

test("DeployWatcher emits failed on non-cancel read errors and rejects with the original error", async () => {
  const parsed = parseDeployWatchInput(
    "2eCCtb16cJkQs3LbCXRG1p97KKSv1c9cNHZUZVchpump",
  );
  const failure = new Error("read failed");
  const fake: DeployWatchConnection = {
    getAccountInfoAndContext: async () => {
      throw failure;
    },
    onAccountChange: () => 1,
    removeAccountChangeListener: async () => {},
  };
  const watcher = new DeployWatcher(() => fake);
  const events: string[] = [];
  const unsubscribe = watcher.onDeployWatch((event) => {
    events.push(event.state);
  });

  await assert.rejects(
    watcher.waitForDeploy(parsed, {
      rpcUrl: "http://rpc.local",
      pollMs: 1000,
    }),
    failure,
  );

  assert.deepEqual(events, ["failed"]);
  assert.equal(watcher.isActive(), false);
  unsubscribe();
});

test("DeployWatcher rejects a second concurrent watch while the first remains active", async () => {
  const parsed = parseDeployWatchInput(
    "2eCCtb16cJkQs3LbCXRG1p97KKSv1c9cNHZUZVchpump",
  );
  const initialRead = createDeferred<{
    context: { slot: number };
    value: ReturnType<typeof fakeAccountInfo> | null;
  }>();
  const fake: DeployWatchConnection = {
    getAccountInfoAndContext: async () => initialRead.promise,
    onAccountChange: () => 1,
    removeAccountChangeListener: async () => {},
  };
  const watcher = new DeployWatcher(() => fake);

  const first = watcher.waitForDeploy(parsed, {
    rpcUrl: "http://rpc.local",
    pollMs: 1000,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  await assert.rejects(
    watcher.waitForDeploy(parsed, {
      rpcUrl: "http://rpc.local",
      pollMs: 1000,
    }),
    /already active/i,
  );

  watcher.cancel("Deploy watch canceled by test.");
  await assert.rejects(first, DeployWatchCanceledError);
  initialRead.resolve({
    context: { slot: 666 },
    value: null,
  });
});
