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

function writeTokens(dir: string, publicKey: string): void {
  fs.writeFileSync(
    path.join(dir, `${publicKey}.json`),
    JSON.stringify(
      {
        cookies: "",
        accessToken: jwtWithExp(Math.floor((Date.now() + 10 * 60_000) / 1000)),
        refreshToken: `refresh-${publicKey}`,
      },
      null,
      2,
    ),
  );
}

test("banned accounts are disabled from run selection and viewer loading", async () => {
  const originalCwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-banned-"));

  try {
    process.chdir(tmp);

    const wallets = Array.from({ length: 2 }, () => Keypair.generate());
    const publicKeys = wallets.map((wallet) => wallet.publicKey.toBase58());

    fs.writeFileSync(
      path.join(tmp, "keys.txt"),
      `${wallets.map((wallet) => bs58.encode(wallet.secretKey)).join("\n")}\n`,
    );

    const tokensDir = path.join(tmp, "accounts", "tokens");
    fs.mkdirSync(tokensDir, { recursive: true });
    for (const publicKey of publicKeys) writeTokens(tokensDir, publicKey);

    const { AccountManager } = await import("../src/ui/account-manager");
    const manager = new AccountManager();
    manager.markAccountBanned(publicKeys[0], 'Verify failed: 500 - {"error":"Weird Error!"}');
    manager.setRunSelection(publicKeys);

    const listed = manager.listRunAccounts();
    const banned = listed.find((account) => account.publicKey === publicKeys[0]);
    const healthy = listed.find((account) => account.publicKey === publicKeys[1]);

    assert.equal(banned?.banned, true);
    assert.equal(banned?.tokenValid, false);
    assert.equal(banned?.selected, false);
    assert.equal(healthy?.selected, true);
    assert.deepEqual(
      manager.loadExplicitRunSelectedAccounts().map((account) => account.publicKey),
      [publicKeys[1]],
    );
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
