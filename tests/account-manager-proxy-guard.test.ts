import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

function jwtWithExp(expSec: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSec })).toString("base64url");
  return `${header}.${payload}.sig`;
}

function writeTokens(dir: string, publicKey: string, expMs: number): void {
  fs.writeFileSync(
    path.join(dir, `${publicKey}.json`),
    JSON.stringify(
      {
        cookies: "",
        accessToken: jwtWithExp(Math.floor(expMs / 1000)),
        refreshToken: `refresh-${publicKey}`,
      },
      null,
      2,
    ),
  );
}

async function withProxyFixture(fn: (publicKeys: string[]) => Promise<void>): Promise<void> {
  const originalCwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-proxy-guard-"));

  try {
    process.chdir(tmp);

    const wallets = Array.from({ length: 2 }, () => Keypair.generate());
    const publicKeys = wallets.map((wallet) => wallet.publicKey.toBase58());

    fs.writeFileSync(
      path.join(tmp, "keys.txt"),
      `${wallets.map((wallet) => bs58.encode(wallet.secretKey)).join("\n")}\n`,
    );
    fs.writeFileSync(path.join(tmp, "proxies.txt"), "http://proxy-one.local:8080\n");

    const tokensDir = path.join(tmp, "accounts", "tokens");
    fs.mkdirSync(tokensDir, { recursive: true });
    for (const publicKey of publicKeys) writeTokens(tokensDir, publicKey, Date.now() + 30_000);

    await fn(publicKeys);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("manual account actions refuse direct browser use when proxies are configured but keep-warm is not ready", async () => {
  await withProxyFixture(async (publicKeys) => {
    const { AccountManager } = await import("../src/ui/account-manager");
    const manager = new AccountManager();
    let directRefreshCalls = 0;
    const progress: string[] = [];

    manager.setBrowserSession({
      refreshAccount: async () => {
        directRefreshCalls++;
        throw new Error("direct session used");
      },
    } as any);

    const result = await manager.refreshAccounts(publicKeys, (_done, _total, message) => {
      progress.push(message);
    });

    assert.equal(directRefreshCalls, 0);
    assert.equal(result.success, 0);
    assert.equal(result.total, publicKeys.length);
    assert.match(progress.join("\n"), /Start keep-warm first/);

    const probeProgress: string[] = [];
    const probe = await manager.probeLimit(publicKeys, publicKeys.length, (message) => {
      probeProgress.push(message);
    });

    assert.equal(directRefreshCalls, 0);
    assert.equal(probe.attempted, 0);
    assert.match(probeProgress.join("\n"), /Start keep-warm first/);

    const reloginProgress: string[] = [];
    const relogin = await manager.reloginAccounts(publicKeys, (_done, _total, message) => {
      reloginProgress.push(message);
    });
    assert.equal(relogin.success, 0);
    assert.equal(relogin.total, publicKeys.length);
    assert.match(reloginProgress.join("\n"), /Start keep-warm first/);
  });
});
