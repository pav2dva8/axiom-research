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

test("keep-warm defaults use staggered proxy groups, slower group refresh, and 2-6m refresh age", async () => {
  const { normalizeKeepWarmOptions } = await import("../src/ui/keepwarm-config");
  const defaults = normalizeKeepWarmOptions({});

  assert.deepEqual(defaults.groupStartDelayMs, { min: 5000, max: 15_000 });
  assert.deepEqual(defaults.refreshDelayMs, { min: 5000, max: 10_000 });
  assert.deepEqual(defaults.refreshThresholdMs, { min: 2 * 60_000, max: 6 * 60_000 });
  assert.equal(defaults.accessTokenLifetimeMs, 15 * 60_000);

  const custom = normalizeKeepWarmOptions({
    groupStartDelayMinMs: 1000,
    groupStartDelayMaxMs: 2000,
    refreshDelayMinMs: 3000,
    refreshDelayMaxMs: 4000,
    refreshThresholdMinMin: 1,
    refreshThresholdMaxMin: 7,
  });

  assert.deepEqual(custom.groupStartDelayMs, { min: 1000, max: 2000 });
  assert.deepEqual(custom.refreshDelayMs, { min: 3000, max: 4000 });
  assert.deepEqual(custom.refreshThresholdMs, { min: 60_000, max: 7 * 60_000 });

  const legacy = normalizeKeepWarmOptions({ delayMs: 1234, thresholdMin: 3 });
  assert.deepEqual(legacy.refreshDelayMs, { min: 1234, max: 1234 });
  assert.deepEqual(legacy.refreshThresholdMs, { min: 3 * 60_000, max: 3 * 60_000 });
});

test("keep-warm refresh threshold is stable per account inside the configured range", async () => {
  const { keepWarmRefreshThresholdMs, normalizeKeepWarmOptions } = await import("../src/ui/keepwarm-config");
  const options = normalizeKeepWarmOptions({
    refreshThresholdMinMin: 2,
    refreshThresholdMaxMin: 6,
  });

  const first = keepWarmRefreshThresholdMs("acct-one", options);
  const again = keepWarmRefreshThresholdMs("acct-one", options);
  const second = keepWarmRefreshThresholdMs("acct-two", options);

  assert.equal(first, again);
  assert.ok(first >= 2 * 60_000 && first <= 6 * 60_000);
  assert.ok(second >= 2 * 60_000 && second <= 6 * 60_000);
});

test("keep-warm reports ETA and does not classify rejected refresh tokens as an IP rate limit", async () => {
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

    const tokensDir = path.join(tmp, "accounts", "tokens");
    fs.mkdirSync(tokensDir, { recursive: true });

    const now = Date.now();
    writeTokens(tokensDir, firstPk, "refresh-first", now + 30_000);
    writeTokens(tokensDir, secondPk, "refresh-second", now + 30_000);

    const { AccountManager } = await import("../src/ui/account-manager");
    manager = new AccountManager();
    manager.setBrowserSession({
      refreshAccount: async (refreshToken: string) => ({
        cookies: "",
        accessToken: jwtWithExp(Math.floor((Date.now() + 20 * 60_000) / 1000)),
        refreshToken,
      }),
    } as any);

    const refreshedMessage = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for refreshed progress")), 1000);
      manager!.startKeepLoggedIn([firstPk, secondPk], {}, (message) => {
        if (message.startsWith("refreshed ")) {
          clearTimeout(timeout);
          manager!.stopKeepLoggedIn();
          resolve(message);
        }
      }).catch((err: unknown) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    assert.match(refreshedMessage, /(?:ETA|left|refresh all)/i);
    assert.doesNotMatch(refreshedMessage, /good for/i);

    manager.stopKeepLoggedIn();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const deadFirstWallet = Keypair.generate();
    const deadSecondWallet = Keypair.generate();
    const deadFirstPk = deadFirstWallet.publicKey.toBase58();
    const deadSecondPk = deadSecondWallet.publicKey.toBase58();

    fs.writeFileSync(
      path.join(tmp, "keys.txt"),
      `${bs58.encode(deadFirstWallet.secretKey)}\n${bs58.encode(deadSecondWallet.secretKey)}\n`,
    );

    writeTokens(tokensDir, deadFirstPk, "dead-refresh-first", Date.now() + 30_000);
    writeTokens(tokensDir, deadSecondPk, "dead-refresh-second", Date.now() + 30_000);

    manager = new AccountManager();
    manager.setBrowserSession({
      refreshAccount: async () => {
        const err: any = new Error("refresh-access-token 401 invalid refresh token");
        err.status = 401;
        throw err;
      },
    } as any);

    const messages = await new Promise<string[]>((resolve, reject) => {
      const seen: string[] = [];
      const timeout = setTimeout(() => {
        manager!.stopKeepLoggedIn();
        resolve(seen);
      }, 5000);

    manager!.startKeepLoggedIn([deadFirstPk, deadSecondPk], { refreshDelayMinMs: 500, refreshDelayMaxMs: 500 }, (message) => {
        seen.push(message);
        if (/rate limit/i.test(message) || seen.filter((m) => /manual re-login/i.test(m)).length >= 2) {
          clearTimeout(timeout);
          manager!.stopKeepLoggedIn();
          resolve(seen);
        }
      }).catch((err: unknown) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    assert.equal(messages.some((message) => /rate limit/i.test(message)), false, messages.join("\n"));
    assert.equal(messages.filter((message) => /manual re-login/i.test(message)).length, 2, messages.join("\n"));

    manager.stopKeepLoggedIn();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const noCookieWallet = Keypair.generate();
    const noCookiePk = noCookieWallet.publicKey.toBase58();

    fs.writeFileSync(path.join(tmp, "keys.txt"), `${bs58.encode(noCookieWallet.secretKey)}\n`);
    writeTokens(tokensDir, noCookiePk, "no-cookie-refresh", Date.now() + 30_000);

    manager = new AccountManager();
    manager.setBrowserSession({
      refreshAccount: async () => {
        const err: any = new Error("refresh-access-token returned 200 but no new auth-access-token cookie set");
        err.status = 200;
        err.code = "NO_ACCESS_COOKIE";
        throw err;
      },
    } as any);

    const noCookieMessages = await new Promise<string[]>((resolve, reject) => {
      const seen: string[] = [];
      const timeout = setTimeout(() => {
        manager!.stopKeepLoggedIn();
        resolve(seen);
      }, 1000);

      manager!.startKeepLoggedIn([noCookiePk], {}, (message) => {
        seen.push(message);
        if (/manual re-login/i.test(message) || /will retry/i.test(message)) {
          clearTimeout(timeout);
          manager!.stopKeepLoggedIn();
          resolve(seen);
        }
      }).catch((err: unknown) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    assert.equal(noCookieMessages.some((message) => /manual re-login/i.test(message)), true, noCookieMessages.join("\n"));
    assert.equal(noCookieMessages.some((message) => /will retry/i.test(message)), false, noCookieMessages.join("\n"));

    manager.stopKeepLoggedIn();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const networkFirstWallet = Keypair.generate();
    const networkSecondWallet = Keypair.generate();
    const networkFirstPk = networkFirstWallet.publicKey.toBase58();
    const networkSecondPk = networkSecondWallet.publicKey.toBase58();

    fs.writeFileSync(
      path.join(tmp, "keys.txt"),
      `${bs58.encode(networkFirstWallet.secretKey)}\n${bs58.encode(networkSecondWallet.secretKey)}\n`,
    );

    writeTokens(tokensDir, networkFirstPk, "network-refresh-first", Date.now() + 30_000);
    writeTokens(tokensDir, networkSecondPk, "network-refresh-second", Date.now() + 30_000);

    manager = new AccountManager();
    manager.setBrowserSession({
      refreshAccount: async () => {
        const err: any = new Error("refresh-access-token 0: fetch error: Failed to fetch");
        err.status = 0;
        throw err;
      },
    } as any);

    const networkMessages = await new Promise<string[]>((resolve, reject) => {
      const seen: string[] = [];
      const timeout = setTimeout(() => {
        manager!.stopKeepLoggedIn();
        resolve(seen);
      }, 3500);

      manager!.startKeepLoggedIn([networkFirstPk, networkSecondPk], { delayMs: 500 }, (message) => {
        seen.push(message);
        if (/manual re-login/i.test(message) || /network.*backing off/i.test(message)) {
          clearTimeout(timeout);
          manager!.stopKeepLoggedIn();
          resolve(seen);
        }
      }).catch((err: unknown) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    assert.equal(networkMessages.some((message) => /manual re-login/i.test(message)), false, networkMessages.join("\n"));
    assert.equal(networkMessages.some((message) => /network.*backing off/i.test(message)), true, networkMessages.join("\n"));
    assert.ok(networkMessages.filter((message) => /will retry/i.test(message)).length <= 3, networkMessages.join("\n"));
  } finally {
    manager?.stopKeepLoggedIn();
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
