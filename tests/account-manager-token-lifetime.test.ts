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

test("account access expiry is capped to a 15-minute token window", async () => {
  const originalCwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-account-manager-"));

  try {
    process.chdir(tmp);

    const wallet = Keypair.generate();
    const publicKey = wallet.publicKey.toBase58();
    fs.writeFileSync(path.join(tmp, "keys.txt"), `${bs58.encode(wallet.secretKey)}\n`);

    const tokensDir = path.join(tmp, "accounts", "tokens");
    fs.mkdirSync(tokensDir, { recursive: true });

    const now = Date.now();
    const tokenPath = path.join(tokensDir, `${publicKey}.json`);
    fs.writeFileSync(
      tokenPath,
      JSON.stringify(
        {
          cookies: "",
          accessToken: jwtWithExp(Math.floor((now + 16 * 60_000) / 1000)),
          refreshToken: "refresh-token",
        },
        null,
        2,
      ),
    );
    fs.utimesSync(tokenPath, now / 1000, now / 1000);

    const { AccountManager } = await import("../src/ui/account-manager");
    const manager = new AccountManager();
    const [account] = manager.listAccounts();

    assert.ok(account.accessExpiresAt != null);
    assert.ok(account.accessExpiresAt <= now + 15 * 60_000 + 1000);
    assert.ok(account.accessExpiresAt >= now + 15 * 60_000 - 1000);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
