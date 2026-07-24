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

test("test selection is independent from run/accounts and only loads valid tokens", async () => {
  const originalCwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-test-selection-"));

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
    writeTokens(tokensDir, publicKeys[0], Date.now() + 10 * 60_000);
    writeTokens(tokensDir, publicKeys[1], Date.now() + 10 * 60_000);
    writeTokens(tokensDir, publicKeys[2], Date.now() - 60_000);

    const { AccountManager } = await import("../src/ui/account-manager");
    const manager = new AccountManager();

    manager.setSelection([publicKeys[0]]);
    manager.setRunSelection([publicKeys[0]]);
    manager.setTestSelection([publicKeys[1], publicKeys[2]]);

    assert.deepEqual(
      manager.listAccounts().filter((a) => a.selected).map((a) => a.publicKey),
      [publicKeys[0]],
    );
    assert.deepEqual(
      manager.listRunAccounts().filter((a) => a.selected).map((a) => a.publicKey),
      [publicKeys[0]],
    );
    assert.deepEqual(
      manager.listTestAccounts().filter((a) => a.selected).map((a) => a.publicKey),
      [publicKeys[1]],
    );
    assert.deepEqual(
      manager.loadExplicitTestSelectedAccounts().map((a) => a.publicKey),
      [publicKeys[1]],
    );
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
