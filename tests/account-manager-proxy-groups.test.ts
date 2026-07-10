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

test("proxy account groups stay stable when only part of the wallet list is selected", async () => {
  const originalCwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-account-manager-"));
  let manager: { stopKeepLoggedIn(): void } | undefined;

  try {
    process.chdir(tmp);

    const wallets = Array.from({ length: 4 }, () => Keypair.generate());
    const publicKeys = wallets.map((wallet) => wallet.publicKey.toBase58());

    fs.writeFileSync(
      path.join(tmp, "keys.txt"),
      `${wallets.map((wallet) => bs58.encode(wallet.secretKey)).join("\n")}\n`,
    );
    fs.writeFileSync(
      path.join(tmp, "proxies.txt"),
      "http://proxy-one.local:8080\nhttp://proxy-two.local:8080\n",
    );

    const tokensDir = path.join(tmp, "accounts", "tokens");
    fs.mkdirSync(tokensDir, { recursive: true });
    for (const publicKey of publicKeys) {
      writeTokens(tokensDir, publicKey, `refresh-${publicKey}`, Date.now() + 10 * 60_000);
    }

    const { AccountManager } = await import("../src/ui/account-manager");
    manager = new AccountManager();
    (manager as any).setSelection([publicKeys[2], publicKeys[3]]);

    const listedGroups = (manager as any).listProxyGroups();
    assert.equal(listedGroups.enabled, true);
    assert.deepEqual(listedGroups.groups.map((group: any) => group.accounts.map((account: any) => account.publicKey)), [
      [publicKeys[0], publicKeys[1]],
      [publicKeys[2], publicKeys[3]],
    ]);

    const openedGroups: Array<{ id: number; accounts: string[] }> = [];
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

    await (manager as any).startKeepLoggedIn(
      undefined,
      {
        groupStartDelayMinMs: 0,
        groupStartDelayMaxMs: 0,
        refreshDelayMinMs: 500,
        refreshDelayMaxMs: 500,
        openProxySession: async (group: any) => {
          openedGroups.push({ id: group.id, accounts: group.accounts });
          return fakeSession(group.id);
        },
      },
      () => {},
    );

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 1000;
      const poll = () => {
        if (openedGroups.length > 0) return resolve();
        if (Date.now() > deadline) return reject(new Error("No proxy groups opened"));
        setTimeout(poll, 25);
      };
      poll();
    });

    assert.deepEqual(openedGroups, [{ id: 2, accounts: [publicKeys[2], publicKeys[3]] }]);
  } finally {
    manager?.stopKeepLoggedIn();
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
