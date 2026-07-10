import test from "node:test";
import assert from "node:assert/strict";

import {
  AXIOM_BROWSER_PAGE_URL,
  LOGIN_API_HOSTS,
  PROXY_BACKGROUND_BROWSER_WINDOW,
  REFRESH_ACCESS_TOKEN_HOSTS,
  buildAxiomWorkerReadinessUrls,
  buildChromeWindowArgs,
  buildChromeProxyArgs,
  buildProxyKeepWarmBrowserSessionOptions,
  isCloudflareChallengePage,
  isLoginHostRetryableStatus,
  isRefreshResponseSuccessful,
  runLoginApiHostVerification,
} from "../src/browser-auth";

test("browser auth uses the lightweight Axiom page for Cloudflare readiness", () => {
  assert.equal(AXIOM_BROWSER_PAGE_URL, "https://axiom.trade/terms");
});

test("Chrome proxy args keep credentials out of proxy-server", () => {
  assert.deepEqual(buildChromeProxyArgs({
    server: "http://1.2.3.4:8080",
    username: "alice",
    password: "secret",
  }), ["--proxy-server=http://1.2.3.4:8080"]);
});

test("Chrome window args keep direct sessions visible by default", () => {
  assert.deepEqual(buildChromeWindowArgs(), [
    "--window-size=800,600",
    "--window-position=100,100",
  ]);
});

test("Chrome window args park proxy sessions visibly near the bottom-right", () => {
  assert.deepEqual(buildChromeWindowArgs(PROXY_BACKGROUND_BROWSER_WINDOW), [
    "--window-size=480,360",
    "--window-position=1200,700",
  ]);
});

test("worker readiness probes use the same healthy refresh API hosts", () => {
  assert.deepEqual(buildAxiomWorkerReadinessUrls(123), [
    "https://api3.axiom.trade/server-time?v=123",
    "https://api9.axiom.trade/server-time?v=123",
    "https://api7.axiom.trade/server-time?v=123",
  ]);
});

test("proxy keep-warm sessions load visibly, then minimize after readiness", () => {
  const options = buildProxyKeepWarmBrowserSessionOptions(
    {
      server: "http://1.2.3.4:8080",
      username: "alice",
      password: "secret",
      label: "proxy 1",
    },
    "proxy 1",
  );

  assert.equal(options.label, "proxy 1");
  assert.deepEqual(options.window, PROXY_BACKGROUND_BROWSER_WINDOW);
  assert.equal(options.surfaceOnCloudflareChallenge, true);
  assert.equal(options.minimizeAfterReady, true);
});

test("Cloudflare challenge detection handles same-url checkbox pages", () => {
  assert.equal(isCloudflareChallengePage(
    "https://axiom.trade/terms",
    `
      <main>
        <h1>axiom.trade</h1>
        <h2>Триває перевірка безпеки</h2>
        <label>Підтвердіть, що ви людина</label>
      </main>
    `,
  ), true);
});

test("Cloudflare challenge detection ignores our injected Turnstile script", () => {
  assert.equal(isCloudflareChallengePage(
    "https://axiom.trade/terms",
    `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"></script>`,
  ), false);
});

test("Cloudflare challenge detection ignores background JS detection scripts", () => {
  assert.equal(isCloudflareChallengePage(
    "https://axiom.trade/terms?chain=sol",
    `<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>Login Sign up Terms of Use`,
  ), false);
});

test("login endpoint candidates can move across API shards", () => {
  assert.equal(LOGIN_API_HOSTS[0], "api7.axiom.trade");
  assert.equal(LOGIN_API_HOSTS.includes("api3.axiom.trade"), true);
  assert.equal(LOGIN_API_HOSTS.includes("api2.axiom.trade"), false);
});

test("login host retry classification only retries shard/network style failures", () => {
  assert.equal(isLoginHostRetryableStatus(0), true);
  assert.equal(isLoginHostRetryableStatus(404), true);
  assert.equal(isLoginHostRetryableStatus(418), true);
  assert.equal(isLoginHostRetryableStatus(429), true);
  assert.equal(isLoginHostRetryableStatus(500), true);
  assert.equal(isLoginHostRetryableStatus(401), false);
});

test("login fallback checks nonce before spending a Turnstile token", async () => {
  const calls: string[] = [];

  const nonceCallsByHost = new Map<string, number>();
  const result = await runLoginApiHostVerification({
    hosts: ["dead.axiom.trade", "ok.axiom.trade"],
    walletPublicKey: "wallet-1",
    getNonce: async (host, walletPublicKey) => {
      calls.push(`nonce:${host}:${walletPublicKey}`);
      if (host === "dead.axiom.trade") {
        const err: any = new Error("XHR network error");
        err.status = 0;
        throw err;
      }
      const next = (nonceCallsByHost.get(host) ?? 0) + 1;
      nonceCallsByHost.set(host, next);
      return `nonce-ok-${next}`;
    },
    signNonce: (nonce) => {
      calls.push(`sign:${nonce}`);
      return `sig-${nonce}`;
    },
    getTurnstileToken: async () => {
      calls.push("turnstile");
      return "turnstile-token";
    },
    verify: async (host, payload) => {
      calls.push(`verify:${host}:${payload.allowRegistration}:${payload.nonce}:${payload.signature}:${payload.turnstileToken}`);
    },
  });

  assert.equal(result.host, "ok.axiom.trade");
  assert.equal(result.nonce, "nonce-ok-2");
  assert.deepEqual(calls, [
    "nonce:dead.axiom.trade:wallet-1",
    "nonce:ok.axiom.trade:wallet-1",
    "turnstile",
    "nonce:ok.axiom.trade:wallet-1",
    "sign:nonce-ok-2",
    "verify:ok.axiom.trade:false:nonce-ok-2:sig-nonce-ok-2:turnstile-token",
  ]);
});

test("login fallback does not retry API hosts after a Turnstile timeout", async () => {
  const calls: string[] = [];

  await assert.rejects(
    runLoginApiHostVerification({
      hosts: ["first.axiom.trade", "second.axiom.trade"],
      walletPublicKey: "wallet-2",
      getNonce: async (host) => {
        calls.push(`nonce:${host}`);
        return "nonce-first";
      },
      signNonce: (nonce) => {
        calls.push(`sign:${nonce}`);
        return `sig-${nonce}`;
      },
      getTurnstileToken: async () => {
        calls.push("turnstile");
        throw new Error("Turnstile timeout (30s)");
      },
      verify: async () => {
        calls.push("verify");
      },
    }),
    /Turnstile timeout/,
  );

  assert.deepEqual(calls, [
    "nonce:first.axiom.trade",
    "turnstile",
  ]);
});

test("login fallback does not retry API hosts after verify returns Weird Error", async () => {
  const calls: string[] = [];

  await assert.rejects(
    runLoginApiHostVerification({
      hosts: ["first.axiom.trade", "second.axiom.trade"],
      walletPublicKey: "wallet-3",
      getNonce: async (host) => {
        calls.push(`nonce:${host}`);
        return `nonce-${host}`;
      },
      signNonce: (nonce) => {
        calls.push(`sign:${nonce}`);
        return `sig-${nonce}`;
      },
      getTurnstileToken: async () => {
        calls.push("turnstile");
        return "turnstile-token";
      },
      verify: async (host) => {
        calls.push(`verify:${host}`);
        const err: any = new Error('Verify failed: 500 - {"error":"Weird Error!"}');
        err.status = 500;
        throw err;
      },
    }),
    /Weird Error/,
  );

  assert.deepEqual(calls, [
    "nonce:first.axiom.trade",
    "turnstile",
    "nonce:first.axiom.trade",
    "sign:nonce-first.axiom.trade",
    "verify:first.axiom.trade",
  ]);
});

test("refresh endpoint candidates follow the live frontend shard", () => {
  assert.equal(REFRESH_ACCESS_TOKEN_HOSTS[0], "api3.axiom.trade");
  assert.equal(REFRESH_ACCESS_TOKEN_HOSTS.includes("api10.axiom.trade"), false);
});

test("refresh response is successful when fetch rejects but CDP saw a 2xx wire status", () => {
  assert.equal(isRefreshResponseSuccessful(false, 200), true);
  assert.equal(isRefreshResponseSuccessful(false, 204), true);
  assert.equal(isRefreshResponseSuccessful(false, 0), false);
  assert.equal(isRefreshResponseSuccessful(false, 429), false);
});
