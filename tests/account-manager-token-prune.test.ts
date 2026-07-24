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

test("token prune keeps fresh-register tokens not yet in keys.txt", async () => {
  const { tokenPublicKeysToPrune } = await import("../src/ui/account-manager");
  const previous = new Set(["active-a", "active-b"]);
  const current = new Set(["active-a"]);
  const tokens = ["active-a", "active-b", "fresh-not-imported"];

  assert.deepEqual(
    tokenPublicKeysToPrune(tokens, previous, current),
    ["active-b"],
  );
});

test("token prune keeps all tokens on first keys load", async () => {
  const { tokenPublicKeysToPrune } = await import("../src/ui/account-manager");
  const previous = new Set<string>();
  const current = new Set(["only-in-keys"]);
  const tokens = ["fresh-a", "fresh-b"];

  assert.deepEqual(tokenPublicKeysToPrune(tokens, previous, current), []);
});

test("AccountManager keeps register tokens until keys are imported, then refreshable", async () => {
  const originalCwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-token-prune-"));

  try {
    process.chdir(tmp);

    const existing = Keypair.generate();
    const fresh = Keypair.generate();
    const existingPk = existing.publicKey.toBase58();
    const freshPk = fresh.publicKey.toBase58();

    fs.writeFileSync(path.join(tmp, "keys.txt"), `${bs58.encode(existing.secretKey)}\n`);
    const tokensDir = path.join(tmp, "accounts", "tokens");
    fs.mkdirSync(tokensDir, { recursive: true });
    writeTokens(tokensDir, existingPk);
    writeTokens(tokensDir, freshPk); // registered, not yet in keys.txt

    const { AccountManager } = await import("../src/ui/account-manager");
    const manager = new AccountManager();
    manager.listAccounts(); // triggers refreshKeys + prune

    assert.equal(fs.existsSync(path.join(tokensDir, `${freshPk}.json`)), true);
    assert.equal(fs.existsSync(path.join(tokensDir, `${existingPk}.json`)), true);

    // Import fresh key into keys.txt — token must still be there for refresh.
    fs.writeFileSync(
      path.join(tmp, "keys.txt"),
      `${bs58.encode(existing.secretKey)}\n${bs58.encode(fresh.secretKey)}\n`,
    );
    const listed = manager.listAccounts();
    const freshAccount = listed.find((account) => account.publicKey === freshPk);
    assert.equal(freshAccount?.hasTokens, true);
    assert.equal(fs.existsSync(path.join(tokensDir, `${freshPk}.json`)), true);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("AccountManager deletes tokens only when a key is removed from keys.txt", async () => {
  const originalCwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-token-prune-rm-"));

  try {
    process.chdir(tmp);

    const keep = Keypair.generate();
    const remove = Keypair.generate();
    const keepPk = keep.publicKey.toBase58();
    const removePk = remove.publicKey.toBase58();

    fs.writeFileSync(
      path.join(tmp, "keys.txt"),
      `${bs58.encode(keep.secretKey)}\n${bs58.encode(remove.secretKey)}\n`,
    );
    const tokensDir = path.join(tmp, "accounts", "tokens");
    fs.mkdirSync(tokensDir, { recursive: true });
    writeTokens(tokensDir, keepPk);
    writeTokens(tokensDir, removePk);

    const { AccountManager } = await import("../src/ui/account-manager");
    const manager = new AccountManager();
    manager.listAccounts();

    fs.writeFileSync(path.join(tmp, "keys.txt"), `${bs58.encode(keep.secretKey)}\n`);
    manager.listAccounts();

    assert.equal(fs.existsSync(path.join(tokensDir, `${keepPk}.json`)), true);
    assert.equal(fs.existsSync(path.join(tokensDir, `${removePk}.json`)), false);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
