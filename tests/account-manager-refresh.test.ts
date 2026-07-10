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

function writeTokens(dir: string, publicKey: string, refreshToken: string, expMs: number): void {
  fs.writeFileSync(
    path.join(dir, `${publicKey}.json`),
    JSON.stringify(
      {
        cookies: "",
        accessToken: jwtWithExp(Math.floor(expMs / 1000)),
        refreshToken,
      },
      null,
      2,
    ),
  );
}

test("refreshAccounts skips fresh accounts using a 3-minute default refresh threshold", async () => {
  const originalCwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-account-manager-"));

  try {
    process.chdir(tmp);

    const freshWallet = Keypair.generate();
    const thresholdWallet = Keypair.generate();
    const dueWallet = Keypair.generate();
    const freshPk = freshWallet.publicKey.toBase58();
    const thresholdPk = thresholdWallet.publicKey.toBase58();
    const duePk = dueWallet.publicKey.toBase58();

    fs.writeFileSync(
      path.join(tmp, "keys.txt"),
      [
        bs58.encode(freshWallet.secretKey),
        bs58.encode(thresholdWallet.secretKey),
        bs58.encode(dueWallet.secretKey),
      ].join("\n") + "\n",
    );

    const tokensDir = path.join(tmp, "accounts", "tokens");
    fs.mkdirSync(tokensDir, { recursive: true });

    const now = Date.now();
    writeTokens(tokensDir, freshPk, "refresh-fresh", now + 20 * 60_000);
    writeTokens(tokensDir, thresholdPk, "refresh-threshold", now + 4 * 60_000);
    writeTokens(tokensDir, duePk, "refresh-due", now + 30_000);

    const { AccountManager } = await import("../src/ui/account-manager");
    const manager = new AccountManager();
    const refreshCalls: string[] = [];

    manager.setBrowserSession({
      refreshAccount: async (refreshToken: string) => {
        refreshCalls.push(refreshToken);
        return {
          cookies: "",
          accessToken: jwtWithExp(Math.floor((Date.now() + 20 * 60_000) / 1000)),
          refreshToken,
        };
      },
    } as any);

    const result = await manager.refreshAccounts([freshPk, thresholdPk, duePk]);

    assert.deepEqual(refreshCalls, ["refresh-due"]);
    assert.deepEqual(result, { success: 1, total: 3, skippedFresh: 2 });
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
