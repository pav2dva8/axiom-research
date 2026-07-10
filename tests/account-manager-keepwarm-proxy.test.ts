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

test("keep-warm proxy groups refresh in parallel and use stagger/delay ranges", async () => {
  const originalCwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-account-manager-"));
  let manager: { stopKeepLoggedIn(): void } | undefined;
  let releaseRefreshes: (() => void) | undefined;

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
    writeTokens(tokensDir, firstPk, "refresh-first", Date.now() + 30_000);
    writeTokens(tokensDir, secondPk, "refresh-second", Date.now() + 30_000);

    const { AccountManager } = await import("../src/ui/account-manager");
    manager = new AccountManager();

    const startedRefreshes: string[] = [];
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefreshes = resolve;
    });
    const bothGroupsStarted = new Promise<string[]>((resolve) => {
      const maybeResolve = () => {
        if (startedRefreshes.length === 2) resolve([...startedRefreshes]);
      };
      const sessionFor = (): BrowserSession => ({
        refreshAccount: async (refreshToken: string) => {
          startedRefreshes.push(refreshToken);
          maybeResolve();
          await refreshGate;
          return {
            cookies: "",
            accessToken: jwtWithExp(Math.floor((Date.now() + 15 * 60_000) / 1000)),
            refreshToken,
          };
        },
        close: async () => {},
      } as any);
      void manager!.startKeepLoggedIn(
        [firstPk, secondPk],
        {
          groupStartDelayMinMs: 0,
          groupStartDelayMaxMs: 0,
          refreshDelayMinMs: 5000,
          refreshDelayMaxMs: 10_000,
          refreshThresholdMinMin: 2,
          refreshThresholdMaxMin: 6,
          openProxySession: async () => sessionFor(),
        },
        () => {},
      );
    });

    const started = await Promise.race([
      bothGroupsStarted,
      new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for both proxy groups to refresh")), 750)),
    ]);

    assert.deepEqual(new Set(started), new Set(["refresh-first", "refresh-second"]));
  } finally {
    manager?.stopKeepLoggedIn();
    releaseRefreshes?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
