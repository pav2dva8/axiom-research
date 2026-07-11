import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import { RegisterService } from "../src/ui/register-service";
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

test("register without proxies writes keys and tokens for amountPerIp", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
  fs.mkdirSync(path.join(cwd, "accounts", "tokens"), { recursive: true });
  const wallets = [Keypair.generate(), Keypair.generate(), Keypair.generate()].map(walletFromKeypair);
  let wi = 0;
  const calls: Array<string | undefined> = [];
  const svc = new RegisterService({
    cwd,
    now: () => new Date(2026, 6, 11),
    sleep: async () => {},
    loadProxies: () => [],
    generateWallet: () => {
      const w = wallets[wi++];
      return { publicKey: w.publicKey, secretKeyBase58: w.secretKeyBase58, wallet: w };
    },
    signup: async (wallet, agent) => {
      calls.push(agent === undefined ? "direct" : "proxy");
      return tokens(wallet.publicKey);
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
  assert.deepEqual(calls, ["direct", "direct"]);
});

test("register with proxies runs IPs sequentially and amount per IP", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
  fs.mkdirSync(path.join(cwd, "accounts", "tokens"), { recursive: true });
  const proxies: ProxyConfig[] = [
    { id: 1, label: "proxy 1", server: "http://1.1.1.1:1", username: "a", password: "b" },
    { id: 2, label: "proxy 2", server: "http://2.2.2.2:2" },
  ];
  const agents: string[] = [];
  let n = 0;
  const svc = new RegisterService({
    cwd,
    now: () => new Date(2026, 6, 11),
    sleep: async () => {},
    loadProxies: () => proxies,
    createAgent: (url) => ({ url }),
    generateWallet: () => {
      const kp = Keypair.generate();
      const w = walletFromKeypair(kp);
      n++;
      return { publicKey: w.publicKey, secretKeyBase58: w.secretKeyBase58, wallet: w };
    },
    signup: async (_wallet, agent) => {
      agents.push((agent as any).url);
      return tokens(`pk${agents.length}`);
    },
  });

  const result = await svc.run({ amountPerIp: 2, delaySec: 0, useProxies: true }, () => {});
  assert.equal(result.succeeded, 4);
  assert.equal(n, 4);
  assert.equal(agents[0], "http://a:b@1.1.1.1:1");
  assert.equal(agents[1], "http://a:b@1.1.1.1:1");
  assert.equal(agents[2], "http://2.2.2.2:2");
  assert.equal(agents[3], "http://2.2.2.2:2");
});

test("signup failure skips remaining slots on that IP", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
  fs.mkdirSync(path.join(cwd, "accounts", "tokens"), { recursive: true });
  const proxies: ProxyConfig[] = [
    { id: 1, label: "proxy 1", server: "http://1.1.1.1:1" },
    { id: 2, label: "proxy 2", server: "http://2.2.2.2:2" },
  ];
  let attempts = 0;
  const svc = new RegisterService({
    cwd,
    now: () => new Date(2026, 6, 11),
    sleep: async () => {},
    loadProxies: () => proxies,
    createAgent: (url) => ({ url }),
    generateWallet: () => {
      const w = walletFromKeypair(Keypair.generate());
      return { publicKey: w.publicKey, secretKeyBase58: w.secretKeyBase58, wallet: w };
    },
    signup: async () => {
      attempts++;
      if (attempts === 1) throw new Error("rate limited");
      return tokens(`ok${attempts}`);
    },
  });

  const result = await svc.run({ amountPerIp: 3, delaySec: 0, useProxies: true }, () => {});
  assert.equal(attempts, 4);
  assert.equal(result.succeeded, 3);
  assert.equal(result.failed, 1);
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
    signup: async (wallet) => {
      svc.requestStop();
      return tokens(wallet.publicKey);
    },
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
    signup: async () => {
      throw new Error("should not signup");
    },
  });

  await assert.rejects(
    () => svc.run({ amountPerIp: 1, delaySec: 0, useProxies: true }, () => {}),
    /proxies/i,
  );
});
