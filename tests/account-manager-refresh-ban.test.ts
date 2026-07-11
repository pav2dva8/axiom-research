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

test("refreshAccounts marks Weird Error accounts banned and stops the refresh batch", async () => {
  const originalCwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-refresh-ban-"));

  try {
    process.chdir(tmp);

    const wallets = Array.from({ length: 3 }, () => Keypair.generate());
    const publicKeys = wallets.map((wallet) => wallet.publicKey.toBase58());

    fs.writeFileSync(
      path.join(tmp, "keys.txt"),
      `${wallets.map((wallet) => bs58.encode(wallet.secretKey)).join("\n")}\n`,
    );

    const tokensDir = path.join(tmp, "accounts", "tokens");
    fs.mkdirSync(tokensDir, { recursive: true });
    const expSoon = Date.now() + 2 * 60_000;
    for (const publicKey of publicKeys) writeTokens(tokensDir, publicKey, expSoon);

    const { AccountManager } = await import("../src/ui/account-manager");
    const manager = new AccountManager();
    manager.setRunSelection(publicKeys);

    const calls: string[] = [];
    const progress: string[] = [];
    manager.setBrowserSession({
      refreshAccount: async (refreshToken: string) => {
        calls.push(refreshToken);
        const err: any = new Error('refresh-access-token 500: {"error":"Weird Error!"}');
        err.status = 500;
        throw err;
      },
    } as any);

    const result = await manager.refreshAccounts(publicKeys, (_done, _total, message) => {
      progress.push(message);
    });

    assert.equal(calls.length, 1);
    assert.equal(result.banDetected, true);
    assert.equal(result.bannedPublicKey, publicKeys[0]);
    assert.equal(manager.isAccountBanned(publicKeys[0]), true);
    assert.match(progress.join("\n"), /BAN signal/);
    assert.deepEqual(
      manager.loadExplicitRunSelectedAccounts().map((account) => account.publicKey),
      publicKeys.slice(1),
    );
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
