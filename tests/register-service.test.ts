import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import { RegisterService } from "../src/ui/register-service";
import type { RegisterSignupSession } from "../src/ui/register-service";
import type { AuthTokens, WalletInfo } from "../src/auth";
import type { ProxyConfig } from "../src/proxy-groups";

function walletFromKeypair(kp: Keypair): WalletInfo & { secretKeyBase58: string } {
  return {
    publicKey: kp.publicKey.toBase58(),
    secretKey: kp.secretKey,
    keypair: kp,
    secretKeyBase58: bs58.encode(kp.secretKey),
  };
}

function tokens(pk: string): AuthTokens {
  return { accessToken: `a-${pk}`, refreshToken: `r-${pk}`, cookies: `c=${pk}` };
}

function mockSession(
  signupAccount: (wallet: WalletInfo) => Promise<AuthTokens>,
  onClose?: () => void,
): RegisterSignupSession {
  return {
    signupAccount,
    close: async () => {
      onClose?.();
    },
  };
}

test("register without proxies writes keys and tokens for amountPerIp", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
  fs.mkdirSync(path.join(cwd, "accounts", "tokens"), { recursive: true });
  const wallets = [Keypair.generate(), Keypair.generate(), Keypair.generate()].map(walletFromKeypair);
  let wi = 0;
  const labels: string[] = [];
  const svc = new RegisterService({
    cwd,
    now: () => new Date(2026, 6, 11),
    sleep: async () => {},
    loadProxies: () => [],
    generateWallet: () => {
      const w = wallets[wi++];
      return { publicKey: w.publicKey, secretKeyBase58: w.secretKeyBase58, wallet: w };
    },
    openSession: async (ctx) => {
      labels.push(ctx.label);
      return mockSession(async (wallet) => tokens(wallet.publicKey));
    },
  });

  const result = await svc.run({ amountPerIp: 2, delaySec: 0, useProxies: false }, () => {});
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 0);
  const keysPath = path.join(cwd, "2026-07-11_fresh_keys.txt");
  const lines = fs.readFileSync(keysPath, "utf-8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], wallets[0].secretKeyBase58);
  assert.ok(fs.existsSync(path.join(cwd, "accounts", "tokens", `${wallets[0].publicKey}.json`)));
  assert.deepEqual(labels, ["direct"]);
});

test("register with proxies runs IPs sequentially and amount per IP", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
  fs.mkdirSync(path.join(cwd, "accounts", "tokens"), { recursive: true });
  const proxies: ProxyConfig[] = [
    { id: 1, label: "proxy 1", server: "http://1.1.1.1:1", username: "a", password: "b" },
    { id: 2, label: "proxy 2", server: "http://2.2.2.2:2" },
  ];
  const sessionLabels: string[] = [];
  const signupLabels: string[] = [];
  let n = 0;
  const svc = new RegisterService({
    cwd,
    now: () => new Date(2026, 6, 11),
    sleep: async () => {},
    loadProxies: () => proxies,
    generateWallet: () => {
      const kp = Keypair.generate();
      const w = walletFromKeypair(kp);
      n++;
      return { publicKey: w.publicKey, secretKeyBase58: w.secretKeyBase58, wallet: w };
    },
    openSession: async (ctx) => {
      sessionLabels.push(ctx.label);
      assert.ok(ctx.proxy);
      return mockSession(async () => {
        signupLabels.push(ctx.label);
        return tokens(`pk${signupLabels.length}`);
      });
    },
  });

  const result = await svc.run({ amountPerIp: 2, delaySec: 0, useProxies: true }, () => {});
  assert.equal(result.succeeded, 4);
  assert.equal(n, 4);
  assert.deepEqual(sessionLabels, ["proxy 1", "proxy 2"]);
  assert.deepEqual(signupLabels, ["proxy 1", "proxy 1", "proxy 2", "proxy 2"]);
});

test("signup failure retries then stops after MAX_CONSECUTIVE_FAILURES (no spam across proxies)", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
  fs.mkdirSync(path.join(cwd, "accounts", "tokens"), { recursive: true });
  const proxies: ProxyConfig[] = [
    { id: 1, label: "proxy 1", server: "http://1.1.1.1:1" },
    { id: 2, label: "proxy 2", server: "http://2.2.2.2:2" },
  ];
  let signupCalls = 0;
  let sessionsOpened = 0;
  const svc = new RegisterService({
    cwd,
    now: () => new Date(2026, 6, 11),
    sleep: async () => {},
    loadProxies: () => proxies,
    generateWallet: () => {
      const w = walletFromKeypair(Keypair.generate());
      return { publicKey: w.publicKey, secretKeyBase58: w.secretKeyBase58, wallet: w };
    },
    openSession: async () => {
      sessionsOpened++;
      return mockSession(async () => {
        signupCalls++;
        throw new Error("rate limited");
      });
    },
  });

  const result = await svc.run({ amountPerIp: 3, delaySec: 0, useProxies: true }, () => {});
  // Each signup gets 3 tries (1 + 2 retries); 3 consecutive failures stop the
  // job => 3 signups × 3 tries = 9 signup calls. Only one proxy session opened
  // because the job stops before reaching proxy 2.
  assert.equal(signupCalls, 9);
  assert.equal(sessionsOpened, 1);
  assert.equal(result.succeeded, 0);
  assert.equal(result.failed, 3);
  assert.equal(result.phase, "stopped");
  assert.match(result.message, /consecutive signup failures/i);
});

test("transient signup error retries then succeeds", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
  fs.mkdirSync(path.join(cwd, "accounts", "tokens"), { recursive: true });
  let signupCalls = 0;
  const svc = new RegisterService({
    cwd,
    now: () => new Date(2026, 6, 11),
    sleep: async () => {},
    loadProxies: () => [],
    generateWallet: () => {
      const w = walletFromKeypair(Keypair.generate());
      return { publicKey: w.publicKey, secretKeyBase58: w.secretKeyBase58, wallet: w };
    },
    openSession: async () =>
      mockSession(async (wallet) => {
        signupCalls++;
        if (signupCalls === 1) throw new Error("transient blip");
        return tokens(wallet.publicKey);
      }),
  });

  const result = await svc.run({ amountPerIp: 1, delaySec: 0, useProxies: false }, () => {});
  assert.equal(signupCalls, 2); // first threw, second succeeded
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.phase, "finished");
});

test("a success resets the consecutive-failure counter (fail, ok, fail, fail, fail stops)", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
  fs.mkdirSync(path.join(cwd, "accounts", "tokens"), { recursive: true });
  // amountPerIp is clamped to REGISTER_AMOUNT_MAX (3), so a direct run does at
  // most 3 signups. To prove the reset works, use two proxy IPs so we get more
  // signups total. Pattern across 6 signups (3 per IP):
  //   IP1: fail, succeed, fail     -> counter ends at 1 (reset by the success)
  //   IP2: fail, fail, fail        -> counter climbs 2,3 -> STOP at the 3rd
  // If the reset were broken, IP1's two failures (calls 1 and 3) would already
  // be "2 consecutive" and IP2 would stop after just one more (call 4), giving
  // failed=3 too early — but more importantly succeeded would be 0. With the
  // reset, the success is recorded and the job reaches IP2.
  const proxies: ProxyConfig[] = [
    { id: 1, label: "proxy 1", server: "http://1.1.1.1:1" },
    { id: 2, label: "proxy 2", server: "http://2.2.2.2:2" },
  ];
  const perSignupOutcome = ["err", "ok", "err", "err", "err", "err"];
  let signupIdx = -1;
  const svc = new RegisterService({
    cwd,
    now: () => new Date(2026, 6, 11),
    sleep: async () => {},
    loadProxies: () => proxies,
    generateWallet: () => {
      const w = walletFromKeypair(Keypair.generate());
      signupIdx++;
      return { publicKey: w.publicKey, secretKeyBase58: w.secretKeyBase58, wallet: w };
    },
    openSession: async () =>
      mockSession(async (wallet) => {
        if (perSignupOutcome[signupIdx] === "ok") return tokens(wallet.publicKey);
        throw new Error("fail");
      }),
  });

  const result = await svc.run({ amountPerIp: 3, delaySec: 0, useProxies: true }, () => {});
  // The success (signup 2) must be recorded, proving the reset happened.
  assert.equal(result.succeeded, 1);
  assert.equal(result.phase, "stopped");
  assert.match(result.message, /consecutive signup failures/i);
});

test("write failure after signup stops before next proxy", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
  fs.mkdirSync(path.join(cwd, "accounts"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "accounts", "tokens"), "not a directory");
  const proxies: ProxyConfig[] = [
    { id: 1, label: "proxy 1", server: "http://1.1.1.1:1" },
    { id: 2, label: "proxy 2", server: "http://2.2.2.2:2" },
  ];
  const signupLabels: string[] = [];
  const svc = new RegisterService({
    cwd,
    now: () => new Date(2026, 6, 11),
    sleep: async () => {},
    loadProxies: () => proxies,
    generateWallet: () => {
      const w = walletFromKeypair(Keypair.generate());
      return { publicKey: w.publicKey, secretKeyBase58: w.secretKeyBase58, wallet: w };
    },
    openSession: async (ctx) =>
      mockSession(async (wallet) => {
        signupLabels.push(ctx.label);
        return tokens(wallet.publicKey);
      }),
  });

  await assert.rejects(
    () => svc.run({ amountPerIp: 1, delaySec: 0, useProxies: true }, () => {}),
    /EEXIST|ENOTDIR|not a directory/i,
  );
  assert.deepEqual(signupLabels, ["proxy 1"]);
  assert.equal(fs.existsSync(path.join(cwd, "2026-07-11_fresh_keys.txt")), false);
});

test("write failure exposes accumulated counts and output file", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
  fs.mkdirSync(path.join(cwd, "accounts", "tokens"), { recursive: true });
  const wallets = [Keypair.generate(), Keypair.generate()].map(walletFromKeypair);
  let wi = 0;
  const outputFile = path.join(cwd, "2026-07-11_fresh_keys.txt");
  const svc = new RegisterService({
    cwd,
    now: () => new Date(2026, 6, 11),
    sleep: async () => {},
    loadProxies: () => [],
    generateWallet: () => {
      const w = wallets[wi++];
      return { publicKey: w.publicKey, secretKeyBase58: w.secretKeyBase58, wallet: w };
    },
    openSession: async () =>
      mockSession(async (wallet) => {
        if (wallet.publicKey === wallets[1].publicKey) {
          fs.rmSync(path.join(cwd, "accounts", "tokens"), { recursive: true, force: true });
          fs.writeFileSync(path.join(cwd, "accounts", "tokens"), "not a directory");
        }
        return tokens(wallet.publicKey);
      }),
  });

  let thrown: any;
  try {
    await svc.run({ amountPerIp: 2, delaySec: 0, useProxies: false }, () => {});
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown);
  assert.equal(thrown.progress.succeeded, 1);
  assert.equal(thrown.progress.failed, 1);
  assert.equal(thrown.progress.outputFile, outputFile);
  assert.equal(fs.readFileSync(outputFile, "utf-8"), `${wallets[0].secretKeyBase58}\n`);
});

test("stop halts between attempts", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
  fs.mkdirSync(path.join(cwd, "accounts", "tokens"), { recursive: true });
  const svc = new RegisterService({
    cwd,
    now: () => new Date(2026, 6, 11),
    sleep: async () => {},
    loadProxies: () => [],
    generateWallet: () => {
      const w = walletFromKeypair(Keypair.generate());
      return { publicKey: w.publicKey, secretKeyBase58: w.secretKeyBase58, wallet: w };
    },
    openSession: async () =>
      mockSession(async (wallet) => {
        svc.requestStop();
        return tokens(wallet.publicKey);
      }),
  });

  const result = await svc.run({ amountPerIp: 3, delaySec: 0, useProxies: false }, () => {});
  assert.equal(result.succeeded, 1);
  assert.equal(result.phase, "stopped");
});

test("useProxies with empty proxy list throws before starting", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
  const svc = new RegisterService({
    cwd,
    now: () => new Date(2026, 6, 11),
    sleep: async () => {},
    loadProxies: () => [],
    generateWallet: () => {
      throw new Error("should not generate");
    },
    openSession: async () => {
      throw new Error("should not open session");
    },
  });

  await assert.rejects(
    () => svc.run({ amountPerIp: 1, delaySec: 0, useProxies: true }, () => {}),
    /proxies/i,
  );
});
