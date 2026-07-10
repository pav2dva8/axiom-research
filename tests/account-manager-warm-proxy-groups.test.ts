import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import type { BrowserSession } from "../src/browser-auth";

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

test("keep-warm opens reusable proxy viewer groups even when tokens are fresh", async () => {
  const originalCwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-account-manager-"));
  let manager: { stopKeepLoggedIn(): void } | undefined;

  try {
    process.chdir(tmp);

    const firstWallet = Keypair.generate();
    const secondWallet = Keypair.generate();
    const firstPk = firstWallet.publicKey.toBase58();
    const secondPk = secondWallet.publicKey.toBase58();

    fs.writeFileSync(
      path.join(tmp, "keys.txt"),
      `${bs58.encode(firstWallet.secretKey)}\n${bs58.encode(secondWallet.secretKey)}\n`,
    );
    fs.writeFileSync(
      path.join(tmp, "proxies.txt"),
      "http://proxy-one.local:8080\nhttp://proxy-two.local:8080\n",
    );

    const tokensDir = path.join(tmp, "accounts", "tokens");
    fs.mkdirSync(tokensDir, { recursive: true });
    writeTokens(tokensDir, firstPk, "refresh-first", Date.now() + 10 * 60_000);
    writeTokens(tokensDir, secondPk, "refresh-second", Date.now() + 10 * 60_000);

    const { AccountManager } = await import("../src/ui/account-manager");
    manager = new AccountManager();

    const openedGroups: number[] = [];
    const fakeSession = (groupId: number): BrowserSession => ({
      refreshAccount: async (refreshToken: string) => ({
        cookies: "",
        accessToken: jwtWithExp(Math.floor((Date.now() + 15 * 60_000) / 1000)),
        refreshToken,
      }),
      close: async () => {},
      connectViewer: async () => groupId,
      disconnectViewer: async () => {},
      disconnectAllViewers: async () => {},
    } as any);

    await manager.startKeepLoggedIn(
      [firstPk, secondPk],
      {
        groupStartDelayMinMs: 0,
        groupStartDelayMaxMs: 0,
        refreshDelayMinMs: 500,
        refreshDelayMaxMs: 500,
        openProxySession: async (group) => {
          openedGroups.push(group.id);
          return fakeSession(group.id);
        },
      },
      () => {},
    );

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 1000;
      const poll = () => {
        if (openedGroups.length === 2) return resolve();
        if (Date.now() > deadline) return reject(new Error(`Only opened ${openedGroups.length} group(s)`));
        setTimeout(poll, 25);
      };
      poll();
    });

    const accounts = manager.loadSelectedAccounts();
    const plan = manager.getWarmProxyViewerGroups(accounts);

    assert.equal(plan.ready, true);
    assert.equal(plan.groups.length, 2);
    assert.deepEqual(plan.groups.map((group) => group.accounts.map((account) => account.publicKey)), [
      [firstPk],
      [secondPk],
    ]);
  } finally {
    manager?.stopKeepLoggedIn();
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
