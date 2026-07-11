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

test("refreshAccounts can filter multiple banned accounts and remove them from active key files", async () => {
  const originalCwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-refresh-filter-ban-"));

  try {
    process.chdir(tmp);

    const wallets = Array.from({ length: 4 }, () => Keypair.generate());
    const publicKeys = wallets.map((wallet) => wallet.publicKey.toBase58());
    const privateKeys = wallets.map((wallet) => bs58.encode(wallet.secretKey));

    fs.writeFileSync(path.join(tmp, "keys.txt"), `${privateKeys.join("\n")}\n`);
    fs.writeFileSync(path.join(tmp, "keys.good.txt"), `${privateKeys.join("\n")}\n`);
    fs.writeFileSync(path.join(tmp, "keys.bad.txt"), "");

    const tokensDir = path.join(tmp, "accounts", "tokens");
    fs.mkdirSync(tokensDir, { recursive: true });
    const expFresh = Date.now() + 12 * 60_000;
    for (const publicKey of publicKeys) writeTokens(tokensDir, publicKey, expFresh);

    const { AccountManager } = await import("../src/ui/account-manager");
    const manager = new AccountManager();

    const calls: string[] = [];
    manager.setBrowserSession({
      refreshAccount: async (refreshToken: string) => {
        calls.push(refreshToken);
        const publicKey = refreshToken.replace("refresh-", "");
        if (publicKey === publicKeys[0] || publicKey === publicKeys[2]) {
          const err: any = new Error('refresh-access-token 500: {"error":"Weird Error!"}');
          err.status = 500;
          throw err;
        }
        return {
          cookies: "auth-access-token=ok; auth-refresh-token=ok",
          accessToken: jwtWithExp(Math.floor((Date.now() + 15 * 60_000) / 1000)),
          refreshToken,
        };
      },
    } as any);

    const result = await manager.refreshAccounts(publicKeys, undefined, {
      force: true,
      continueOnBan: true,
      delayMinMs: 0,
      delayMaxMs: 0,
    });

    assert.equal(calls.length, 4);
    assert.equal(result.success, 2);
    assert.equal(result.banDetected, true);
    assert.deepEqual(result.bannedPublicKeys, [publicKeys[0], publicKeys[2]]);
    assert.equal(manager.isAccountBanned(publicKeys[0]), true);
    assert.equal(manager.isAccountBanned(publicKeys[2]), true);

    const activeKeys = fs.readFileSync(path.join(tmp, "keys.txt"), "utf-8");
    const goodKeys = fs.readFileSync(path.join(tmp, "keys.good.txt"), "utf-8");
    const badKeys = fs.readFileSync(path.join(tmp, "keys.bad.txt"), "utf-8");

    assert.ok(!activeKeys.includes(privateKeys[0]));
    assert.ok(activeKeys.includes(privateKeys[1]));
    assert.ok(!activeKeys.includes(privateKeys[2]));
    assert.ok(activeKeys.includes(privateKeys[3]));
    assert.ok(!goodKeys.includes(privateKeys[0]));
    assert.ok(!goodKeys.includes(privateKeys[2]));
    assert.ok(badKeys.includes(privateKeys[0]));
    assert.ok(badKeys.includes(privateKeys[2]));
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
