/**
 * Browser-based Cloudflare bypass.
 * Launches a real Chrome via command line with remote debugging,
 * connects via CDP. API calls are made from the browser context
 * so CF cookies are automatically included.
 */

import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AuthTokens, WalletInfo } from './auth';
import { buildSignMessage } from './auth';

/**
 * Viewer-manager script installed on every page in the context via
 * `addInitScript`. Exposes:
 *   - __connectViewerStart(id, tokenInfo, opts) → number (sync)
 *       Synchronously constructs the cluster9 + friends WebSocket pair so
 *       cookies are captured at the moment of construction. Stores a Promise
 *       in `__pendingPromises[id]` that resolves when both handshakes open.
 *   - __connectViewerAwait(id) → Promise<number>
 *       Returns the stored Promise so the caller can await handshake
 *       completion separately (without holding the cookie lock).
 *   - __disconnectViewer(id), __disconnectAll(), __activeCount()
 *
 * Why split start/await? Cookies live on the BrowserContext (global). If
 * worker A is mid-handshake while worker B sets account-B cookies, A's
 * handshake would pick up B's identity. Splitting lets us release the
 * cookie lock the instant `new WebSocket()` has captured cookies.
 *
 * Written with `function` declarations (not arrows) so esbuild/tsx don't
 * wrap nested arrows with `__name(...)` (we shim it anyway, but plain
 * functions are simpler when the body is stringified).
 */
const VIEWER_MANAGER_SCRIPT = `
(function() {
  if (typeof window === 'undefined' || window.__viewerManagerInstalled) return;
  window.__viewerManagerInstalled = true;
  window.__viewers = {};
  window.__pendingPromises = {};

  var CLUSTER_URL = 'wss://cluster9.axiom.trade/';
  var FRIENDS_URL = 'wss://friends.axiom.trade/ws';

  window.__connectViewerStart = function(id, tokenInfo, opts) {
    opts = opts || {};
    var pingJitterMs = typeof opts.pingJitterMs === 'number' ? opts.pingJitterMs : Math.floor(Math.random() * 1000);
    var pairAddress = tokenInfo.pairAddress;

    var resolveFn, rejectFn;
    var promise = new Promise(function(res, rej) { resolveFn = res; rejectFn = rej; });
    window.__pendingPromises[id] = promise;

    var clusterWs = new WebSocket(CLUSTER_URL);
    var friendsWs = new WebSocket(FRIENDS_URL);
    var timeout = setTimeout(function() { fail('WS timeout'); }, 12000);

    var tokenRooms = [
      't:'  + pairAddress,
      'f:'  + pairAddress,
      'td:' + pairAddress,
      's:'  + pairAddress,
      'b-'  + pairAddress,
      'e-'  + pairAddress
    ];

    var clusterOpen = false, friendsOpen = false;
    var settled = false;
    var friendsPingTimer = 0, clusterPingTimer = 0, friendsPingStart = 0;
    var tStart = Date.now();

    function killBoth() {
      try { clusterWs.close(); } catch (_) {}
      try { friendsWs.close(); } catch (_) {}
    }
    function fail(why) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      killBoth();
      rejectFn(new Error(why));
    }
    function tryResolve() {
      if (!clusterOpen || !friendsOpen || settled) return;
      settled = true;
      clearTimeout(timeout);

      friendsPingStart = setTimeout(function() {
        friendsPingTimer = setInterval(function() {
          if (friendsWs.readyState === 1) friendsWs.send('.');
          else clearInterval(friendsPingTimer);
        }, 1000);
      }, pingJitterMs);

      clusterPingTimer = setInterval(function() {
        if (clusterWs.readyState === 1) clusterWs.send(JSON.stringify({ method: 'ping' }));
        else clearInterval(clusterPingTimer);
      }, 30000 + Math.floor(Math.random() * 5000));

      window.__viewers[id] = {
        clusterWs: clusterWs, friendsWs: friendsWs,
        friendsPingTimer: friendsPingTimer, clusterPingTimer: clusterPingTimer, friendsPingStart: friendsPingStart,
        pairAddress: pairAddress
      };
      resolveFn(id);
    }

    clusterWs.onopen = function() {
      for (var i = 0; i < tokenRooms.length; i++) {
        clusterWs.send(JSON.stringify({ action: 'join', room: tokenRooms[i] }));
      }
      console.log('[viewer ' + id + '] cluster9 joined ' + tokenRooms.length + ' rooms (e-' + pairAddress.slice(0, 6) + '...)');
      clusterOpen = true;
      tryResolve();
    };
    clusterWs.onmessage = function(e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.room === 'e-' + pairAddress) {
          console.log('[viewer ' + id + '] eye-room count = ' + msg.content);
        }
      } catch (_) {}
    };
    clusterWs.onerror = function() {
      console.log('[viewer ' + id + '] cluster9 error event');
    };
    clusterWs.onclose = function(e) {
      var dt = Date.now() - tStart;
      console.log('[viewer ' + id + '] cluster9 closed code=' + e.code + ' clean=' + e.wasClean + ' reason="' + (e.reason || '') + '" after ' + dt + 'ms');
      var v = window.__viewers[id];
      if (v) {
        clearTimeout(v.friendsPingStart);
        clearInterval(v.friendsPingTimer);
        clearInterval(v.clusterPingTimer);
        delete window.__viewers[id];
      }
      if (!settled) fail('cluster9 closed code=' + e.code + (e.reason ? ' reason=' + e.reason : ''));
    };

    friendsWs.onopen = function() {
      friendsWs.send(JSON.stringify({
        type: 'pageUpdate',
        page: 'meme',
        subpage: tokenInfo,
        chain: 'sol'
      }));
      friendsOpen = true;
      tryResolve();
    };
    friendsWs.onmessage = function(e) {
      if (e.data === '.') return;
      try {
        var msg = JSON.parse(e.data);
        if (msg.type === 'ping') friendsWs.send(JSON.stringify({ type: 'pong' }));
      } catch (_) {}
    };
    friendsWs.onerror = function() {
      console.log('[viewer ' + id + '] friends error event');
    };
    friendsWs.onclose = function(e) {
      var dt = Date.now() - tStart;
      console.log('[viewer ' + id + '] friends closed code=' + e.code + ' clean=' + e.wasClean + ' reason="' + (e.reason || '') + '" after ' + dt + 'ms');
      if (!settled) fail('friends closed code=' + e.code + (e.reason ? ' reason=' + e.reason : ''));
    };

    return id;
  };

  window.__connectViewerAwait = function(id) {
    var p = window.__pendingPromises[id];
    delete window.__pendingPromises[id];
    return p;
  };

  window.__disconnectViewer = function(id) {
    var v = window.__viewers[id];
    if (!v) return;
    clearTimeout(v.friendsPingStart);
    clearInterval(v.friendsPingTimer);
    clearInterval(v.clusterPingTimer);
    try { v.clusterWs.close(); } catch (_) {}
    try { v.friendsWs.close(); } catch (_) {}
    delete window.__viewers[id];
  };

  window.__disconnectAll = function() {
    var keys = Object.keys(window.__viewers);
    for (var i = 0; i < keys.length; i++) {
      var v = window.__viewers[keys[i]];
      clearTimeout(v.friendsPingStart);
      clearInterval(v.friendsPingTimer);
      clearInterval(v.clusterPingTimer);
      try { v.clusterWs.close(); } catch (_) {}
      try { v.friendsWs.close(); } catch (_) {}
    }
    window.__viewers = {};
  };

  window.__activeCount = function() {
    var vals = Object.keys(window.__viewers).map(function(k) { return window.__viewers[k]; });
    return vals.filter(function(v) { return v.clusterWs.readyState === 1; }).length;
  };
})();
`;

const TURNSTILE_SITEKEY = '0x4AAAAAACb1mthF4yHVUfUh';
// Axiom shards its API across apiN.axiom.trade hosts and rotates which one the
// frontend uses. As of 2026-06 the live site uses api7 for /wallet-nonce +
// /verify-wallet-v2 (api2 is stale and 500s on verify). If login starts failing
// with "We can't process this right now", re-check the host the real frontend
// hits (DevTools → Network) and bump this. (refreshAccount similarly pins api9.)
const API_BASE = 'https://api7.axiom.trade';
const DEBUG_PORT = 9222;

export interface BrowserSession {
  loginAccount(wallet: WalletInfo): Promise<AuthTokens>;
  getCfData(): Promise<{ cfCookies: string; userAgent: string }>;
  resolvePairFromCa(ca: string, accessToken?: string, refreshToken?: string): Promise<any | null>;
  /**
   * Run the session bootstrap that the real client fires on every page load
   * (user-data, lighthouse, get-settings, ...). Without this the server
   * appears to skip new accounts when computing the e-{pair} viewer count
   * even though the account is otherwise logged in.
   */
  bootstrapSession(walletAddress: string, accessToken: string, refreshToken: string): Promise<void>;
  probeEucalyptus(pairAddress: string, accessToken?: string, refreshToken?: string): Promise<void>;
  /**
   * Refresh the access token via Axiom's /refresh-access-token endpoint.
   * Returns new AuthTokens (the refresh token may rotate too). Much faster
   * than a full login since it doesn't need Turnstile or wallet signing.
   */
  refreshAccount(refreshToken: string): Promise<AuthTokens>;
  /** Grow the friendsPage pool to at least `n` pages so workers can run in parallel. */
  ensurePageSlots(n: number): Promise<void>;
  connectViewer(accessToken: string, refreshToken: string, tokenInfo: any, pingJitterMs?: number, slotIndex?: number): Promise<number>;
  disconnectViewer(viewerId: number): Promise<void>;
  disconnectAllViewers(): Promise<void>;
  getActiveViewerCount(): Promise<number>;
  close(): Promise<void>;
}

function findChrome(): string {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('Chrome not found. Install Google Chrome.');
}

export async function openBrowserSession(): Promise<BrowserSession> {
  console.log('[BrowserAuth] Launching real Chrome...');

  // Kill any leftover Chrome on the debug port before spawning a new one
  try {
    const { execSync } = await import('child_process');
    execSync(`lsof -ti :${DEBUG_PORT} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 500));
  } catch {}

  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-chrome-'));
  const chromePath = findChrome();

  const chromeProc: ChildProcess = spawn(chromePath, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${tmpProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=800,600',
    '--window-position=100,100',
    'about:blank',
  ], {
    stdio: 'ignore',
    detached: false,
  });

  await new Promise(r => setTimeout(r, 2000));

  // Force IPv4 — Node 22's DNS prefers ::1 but Chrome's --remote-debugging-port
  // binds to 127.0.0.1 only. Retry a few times in case Chrome is still warming
  // up (cold launches on macOS can take a few seconds).
  const cdpUrl = `http://127.0.0.1:${DEBUG_PORT}`;
  let browser: Browser | null = null;
  let cdpErr: any;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
      break;
    } catch (err: any) {
      cdpErr = err;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  if (!browser) {
    chromeProc.kill();
    throw new Error(`Failed to connect to Chrome at ${cdpUrl}: ${cdpErr?.message}`);
  }

  console.log('[BrowserAuth] Connected to Chrome via CDP');

  const context: BrowserContext = browser.contexts()[0];
  const page: Page = context.pages()[0] || await context.newPage();

  // Navigate to axiom.trade
  await page.goto('https://axiom.trade', { waitUntil: 'load', timeout: 30000 });
  console.log('[BrowserAuth] Page loaded, URL:', page.url());

  // ── Cloudflare / Turnstile readiness helpers ───────────────────────────
  // The main axiom.trade page runs the live SPA and is the only page under
  // Cloudflare's *managed* challenge. Both the SPA and CF can navigate it at
  // any moment, which destroys the JS execution context of any in-flight
  // page.evaluate — including the long-lived Turnstile token render. These
  // helpers let us detect that, wait it out, and re-prime Turnstile before
  // each login attempt.

  // Is the main page currently sitting on a Cloudflare interstitial?
  async function mainPageOnChallenge(): Promise<boolean> {
    try {
      if (/\/cdn-cgi\/|challenge/i.test(page.url())) return true;
      const html = await page.content();
      return /challenges\.cloudflare\.com|challenge-platform|Verify you are human|перевірка безпеки/i.test(html);
    } catch {
      // content()/url() can throw if a navigation is in flight — treat as "not ready".
      return true;
    }
  }

  // Wait out a CF challenge on the main page (auto-pass or manual solve, up to 2m).
  async function waitForMainPageClear(): Promise<void> {
    console.log('[BrowserAuth] Cloudflare challenge on main page — waiting for it to clear (auto or manual)...');
    await page.waitForURL(/axiom\.trade\/(?!.*challenge)/, { timeout: 120000 });
    await page.waitForLoadState('load');
    console.log('[BrowserAuth] Cloudflare challenge passed');
  }

  // (Re-)inject the Turnstile container + API script. Idempotent: a navigation
  // wipes both, so this is safe to call again before every login attempt.
  async function injectTurnstile(): Promise<void> {
    await page.evaluate(`(() => {
      if (!document.getElementById('__ts_container')) {
        const div = document.createElement('div');
        div.id = '__ts_container';
        div.style.position = 'fixed';
        div.style.bottom = '0';
        div.style.right = '0';
        div.style.zIndex = '99999';
        document.body.appendChild(div);
      }
      if (typeof window.turnstile === 'undefined' && !document.getElementById('__ts_script')) {
        const script = document.createElement('script');
        script.id = '__ts_script';
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        document.head.appendChild(script);
      }
    })()`);
    await page.waitForFunction('typeof window.turnstile !== "undefined"', null, { timeout: 15000 })
      .catch(() => { throw new Error('Failed to load Turnstile API script'); });
  }

  // Pre-flight before each login attempt: clear any CF re-challenge and make
  // sure Turnstile is loaded on the main page.
  async function ensureMainPageReady(): Promise<void> {
    if (await mainPageOnChallenge()) {
      await waitForMainPageClear();
    }
    await injectTurnstile();
  }

  // Issue an authenticated API POST from the real SPA page (axiom.trade origin)
  // to API_BASE, via XMLHttpRequest. We deliberately use the SPA page — not the
  // bare api page — for two things /verify-wallet-v2 depends on:
  //   1. Origin/Referer become https://axiom.trade. Browsers forbid setting
  //      those headers from JS, so the request must *originate* from that page.
  //   2. Axiom's anti-bot SDK hooks XMLHttpRequest on this page and stamps its
  //      per-request headers (Xa<rand>-A..Z); a fetch from a bare page gets none.
  // XHR (not fetch) because the frontend uses axios/XHR — the layer the SDK patches.
  async function apiPostFromPage(pathName: string, bodyJson: string): Promise<{ status: number; body: string }> {
    const url = `${API_BASE}${pathName}`;
    return page.evaluate(`
      new Promise((resolve, reject) => {
        try {
          var xhr = new XMLHttpRequest();
          xhr.open('POST', ${JSON.stringify(url)}, true);
          xhr.withCredentials = true;
          xhr.setRequestHeader('Content-Type', 'application/json');
          xhr.timeout = 20000;
          xhr.onload = function () { resolve({ status: xhr.status, body: xhr.responseText }); };
          xhr.onerror = function () { reject(new Error('XHR network error')); };
          xhr.ontimeout = function () { reject(new Error('XHR timeout')); };
          xhr.send(${JSON.stringify(bodyJson)});
        } catch (e) { reject(e); }
      })
    `) as Promise<{ status: number; body: string }>;
  }

  // Initial readiness on session open.
  if (await mainPageOnChallenge()) {
    await waitForMainPageClear();
  } else {
    console.log('[BrowserAuth] No CF challenge — page loaded directly');
  }
  await page.waitForTimeout(3000);
  console.log('[BrowserAuth] Current URL:', page.url());
  await injectTurnstile();
  console.log('[BrowserAuth] Turnstile API loaded');

  // Probe what Axiom's own JS sends — must pass auth tokens so the page loads as a real user
  async function probeEucalyptusMessages(pairAddress: string, accessToken?: string, refreshToken?: string): Promise<void> {
    if (accessToken) {
      await context.addCookies([
        { name: 'auth-access-token', value: accessToken, domain: '.axiom.trade', path: '/' },
        { name: 'auth-refresh-token', value: refreshToken || '', domain: '.axiom.trade', path: '/' },
      ]);
    }
    const probePage = await context.newPage();
    probePage.on('websocket', ws => {
      const tag = ws.url().includes('eucalyptus') ? 'eucalyptus' : ws.url().includes('friends') ? 'friends' : null;
      if (!tag) return;
      console.log(`[Probe] ${tag} WS opened`);
      ws.on('framesent', frame => console.log(`[Probe] ${tag} SENT:`, frame.payload));
      ws.on('framereceived', frame => console.log(`[Probe] ${tag} RECEIVED:`, frame.payload));
      ws.on('close', () => console.log(`[Probe] ${tag} WS closed`));
    });
    console.log('[Probe] navigating to token page as authenticated user...');
    await probePage.goto(`https://axiom.trade/meme/${pairAddress}?chain=sol`, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
    await probePage.waitForTimeout(60000); // watch 60s to capture pings
    await probePage.close();
    if (accessToken) {
      await context.clearCookies({ name: 'auth-access-token' });
      await context.clearCookies({ name: 'auth-refresh-token' });
    }
    console.log('[Probe] done');
  }

  // Shim esbuild/tsx helpers (`__name`, `__publicField`) in every page.
  // Functions passed to page.evaluate are stringified, and tsx wraps nested
  // `const x = (...) => ...` arrows with `__name(x, "x")` to preserve
  // Function.name. Without this shim those calls throw `ReferenceError:
  // __name is not defined` in the browser context. Passed as raw script
  // content so esbuild doesn't transform the shim itself.
  await context.addInitScript({
    content: `
      if (typeof globalThis.__name !== 'function') {
        globalThis.__name = function (fn) { return fn; };
      }
      if (typeof globalThis.__publicField !== 'function') {
        globalThis.__publicField = function (obj, key, value) { obj[key] = value; return value; };
      }
    `,
  });
  // Viewer manager auto-installs on every page navigation in this context.
  await context.addInitScript({ content: VIEWER_MANAGER_SCRIPT });

  // Open a single api2 tab for all API calls
  const apiPage = await context.newPage();
  await apiPage.goto(`${API_BASE}/`, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
  await apiPage.waitForTimeout(1000);
  console.log('[BrowserAuth] API page ready');

  // Page pool for WS viewer handshakes. Playwright/Chrome serializes
  // page.evaluate calls on the same page — a single shared page is the
  // throughput chokepoint at any concurrency > 1. Multiple pages let
  // evaluates run truly in parallel.
  //
  // Pool grows lazily via ensurePageSlots(n). Cookies are still on the
  // shared BrowserContext, so the addCookies → start → clearCookies
  // critical section is serialized by a tiny in-process mutex (~10-30ms).
  // After WS objects are constructed (synchronous), cookies are captured
  // and the lock is released.
  const wsUrlByReq = new Map<string, string>();
  function tag(reqId: string): string {
    const u = wsUrlByReq.get(reqId) || reqId;
    return u.includes('cluster9') ? 'cluster9' : u.includes('friends') ? 'friends' : u;
  }
  async function attachCdpListenersTo(p: Page): Promise<void> {
    const cdp = await context.newCDPSession(p);
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketCreated', ({ requestId, url }: any) => {
      wsUrlByReq.set(requestId, url);
    });
    cdp.on('Network.webSocketHandshakeResponseReceived', ({ requestId, response }: any) => {
      const status = response?.status;
      const statusText = response?.statusText;
      if (status !== 101) {
        console.log(`[CDP] ${tag(requestId)} handshake ${status} ${statusText || ''}`);
      }
    });
    cdp.on('Network.webSocketFrameSent', ({ requestId, response }) => {
      if (response.payloadData) console.log(`[CDP→${tag(requestId)}]`, response.payloadData.slice(0, 300));
    });
    cdp.on('Network.webSocketFrameReceived', ({ requestId, response }) => {
      if (response.payloadData) console.log(`[CDP←${tag(requestId)}]`, response.payloadData.slice(0, 300));
    });
    cdp.on('Network.webSocketFrameError', ({ requestId, errorMessage }: any) => {
      console.log(`[CDP] ${tag(requestId)} frame error: ${errorMessage}`);
    });
    cdp.on('Network.webSocketClosed', ({ requestId }) => {
      console.log(`[CDP] ${tag(requestId)} closed`);
      wsUrlByReq.delete(requestId);
    });
  }

  async function setupFriendsPage(): Promise<Page> {
    const p = await context.newPage();
    await p.goto('https://axiom.trade', { waitUntil: 'load', timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(500);
    p.on('console', msg => {
      const t = msg.text();
      if (t.startsWith('[viewer ') || t.startsWith('[viewer]')) console.log('[Browser]', t);
    });
    await attachCdpListenersTo(p);
    return p;
  }

  const friendsPages: Page[] = [];
  friendsPages.push(await setupFriendsPage());
  const friendsPage = friendsPages[0]; // primary for non-pool operations (resolvePairFromCa, bootstrapSession)
  console.log('[BrowserAuth] Axiom page ready for WS connections');

  async function ensurePageSlots(n: number): Promise<void> {
    while (friendsPages.length < n) {
      friendsPages.push(await setupFriendsPage());
      console.log(`[BrowserAuth] friendsPage pool grew to ${friendsPages.length}`);
    }
  }

  // Global cookie mutex (promise-chain). Held only across:
  //   addCookies → page.evaluate('__connectViewerStart(...)') → clearCookies
  // Total ~10-30ms. Handshake (~700ms) runs outside the lock.
  let cookieChain: Promise<void> = Promise.resolve();
  function withCookieLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = cookieChain;
    let release!: () => void;
    cookieChain = new Promise<void>(r => { release = r; });
    return prev.then(async () => {
      try { return await fn(); }
      finally { release(); }
    });
  }

  // Track which page each viewer was created on, so disconnect routes correctly.
  const viewerToPage = new Map<number, Page>();
  let nextViewerId = 0;

  // Viewer manager is auto-installed on every page via context.addInitScript
  // (see VIEWER_MANAGER_SCRIPT at top of file). Each friendsPage in the pool
  // already has __connectViewerStart / __connectViewerAwait / __disconnectViewer
  // / __disconnectAll / __activeCount available on window — no inline eval needed.

  async function getTurnstileToken(): Promise<string> {
    const token = await page.evaluate(`
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Turnstile timeout (30s)')), 30000);
        const container = document.getElementById('__ts_container');
        if (container) container.innerHTML = '';

        turnstile.render('#__ts_container', {
          sitekey: '${TURNSTILE_SITEKEY}',
          execution: 'execute',
          appearance: 'execute',
          callback: (token) => { clearTimeout(timeout); resolve(token); },
          'error-callback': (err) => { clearTimeout(timeout); reject(new Error('Turnstile error: ' + err)); },
        });

        setTimeout(() => { try { turnstile.execute('#__ts_container'); } catch(e) {} }, 500);
      })
    `);
    console.log('[BrowserAuth] Got Turnstile token (' + String(token).length + ' chars)');
    return token as string;
  }

  return {
    async probeEucalyptus(pairAddress: string, accessToken?: string, refreshToken?: string): Promise<void> {
      return probeEucalyptusMessages(pairAddress, accessToken, refreshToken);
    },

    async loginAccount(wallet: WalletInfo): Promise<AuthTokens> {
      const MAX_ATTEMPTS = 3;
      let lastErr: any;

      // A Cloudflare re-challenge (or SPA redirect) can navigate the main page
      // mid-login and destroy the JS execution context of the in-flight
      // Turnstile evaluate ("Execution context was destroyed, most likely
      // because of a navigation"). On that specific, navigation-caused error we
      // re-clear the page and retry — bounded — instead of failing the account.
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          console.log(`[BrowserAuth] Logging in wallet: ${wallet.publicKey} (attempt ${attempt}/${MAX_ATTEMPTS})`);

          // 0. Recover from any CF re-challenge / navigation that wiped the main
          //    page since the previous attempt, before the long Turnstile evaluate.
          await ensureMainPageReady();

          // 1. Get turnstile token
          const turnstileToken = await getTurnstileToken();

          // 2. Get nonce — issued from the SPA page → API_BASE (see
          // apiPostFromPage). `v` is the client epoch-ms the frontend sends.
          const nonceRes = await apiPostFromPage('/wallet-nonce', JSON.stringify({
            walletAddress: wallet.publicKey,
            v: Date.now(),
          }));
          if (nonceRes.status < 200 || nonceRes.status >= 300) {
            throw new Error('Nonce failed: ' + nonceRes.status + ' - ' + nonceRes.body);
          }
          const nonce = nonceRes.body;
          console.log('[BrowserAuth] Got nonce:', nonce);

          // 3. Sign message in Node.js
          const message = buildSignMessage(nonce);
          const signature = nacl.sign.detached(new TextEncoder().encode(message), wallet.secretKey);
          const signatureBase58 = bs58.encode(signature);

          // 4. Verify wallet — same SPA-page path. Field set + `v` mirror the
          // live frontend's request exactly.
          const verifyRes = await apiPostFromPage('/verify-wallet-v2', JSON.stringify({
            walletAddress: wallet.publicKey,
            allowLinking: false,
            allowRegistration: false,
            forAddCredential: false,
            isVerify: false,
            nonce,
            referrer: null,
            signature: signatureBase58,
            turnstileToken,
            v: Date.now(),
          }));
          if (verifyRes.status < 200 || verifyRes.status >= 300) {
            throw new Error('Verify failed: ' + verifyRes.status + ' - ' + verifyRes.body);
          }
          console.log('[BrowserAuth] Verify response received');

          // 5. Extract auth + CF cookies from browser
          await apiPage.waitForTimeout(500);
          const browserCookies = await context.cookies();
          let accessToken = '';
          let refreshToken = '';
          const parts: string[] = [];
          const seen = new Set<string>();

          for (const c of browserCookies) {
            // Auth cookies
            if (c.name === 'auth-access-token') { accessToken = c.value; }
            if (c.name === 'auth-refresh-token') { refreshToken = c.value; }

            // Include auth + CF cookies (needed for API and WS connections)
            if (c.name.startsWith('auth-') || c.name === 'cf_clearance' || c.name === '__cf_bm') {
              const key = `${c.name}=${c.value}`;
              if (!seen.has(c.name)) {
                seen.add(c.name);
                parts.push(key);
              }
            }
          }

          if (!accessToken) {
            throw new Error('No auth cookies received after verify');
          }

          console.log('[BrowserAuth] Login successful! Access token:', accessToken.slice(0, 20) + '...');
          console.log('[BrowserAuth] Cookie types:', [...seen].join(', '));

          // Clear auth cookies so next account starts fresh (keep CF cookies)
          await context.clearCookies({ name: 'auth-access-token' });
          await context.clearCookies({ name: 'auth-refresh-token' });

          return {
            accessToken,
            refreshToken,
            cookies: parts.join('; '),
          };
        } catch (err: any) {
          lastErr = err;
          const emsg = String(err?.message || err);
          // Playwright's symptom of a navigation landing mid-evaluate.
          const navRace = /Execution context was destroyed|frame (?:was |got )?detached|because of (?:a )?navigation/i.test(emsg);
          if (navRace && attempt < MAX_ATTEMPTS) {
            console.warn(`[BrowserAuth] Login attempt ${attempt}/${MAX_ATTEMPTS} hit a page navigation (${emsg.split('\n')[0]}); recovering & retrying...`);
            await page.waitForTimeout(1000);
            continue;
          }
          throw err;
        }
      }

      throw lastErr;
    },

    async refreshAccount(oldRefreshToken: string): Promise<AuthTokens> {
      // POST /refresh-access-token from the axiom.trade origin. The endpoint
      // reads auth-refresh-token from the cookie jar (we set it on the
      // context first) and responds with Set-Cookie for the new access token
      // (and usually a rotated refresh token). CORS allow-origin is
      // https://axiom.trade, so the fetch MUST run on friendsPage.
      const domains = ['cluster9.axiom.trade', 'friends.axiom.trade', '.axiom.trade'];
      const cookiesToAdd: { name: string; value: string; domain: string; path: string }[] = [];
      for (const domain of domains) {
        cookiesToAdd.push({ name: 'auth-refresh-token', value: oldRefreshToken, domain, path: '/' });
      }
      await context.addCookies(cookiesToAdd);

      try {
        const result = await friendsPage.evaluate(async () => {
          try {
            const r = await fetch('https://api9.axiom.trade/refresh-access-token', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            });
            const text = await r.text();
            return { ok: r.ok, status: r.status, body: text.slice(0, 500) };
          } catch (e: any) {
            return { ok: false, status: 0, body: 'fetch error: ' + (e?.message || String(e)) };
          }
        });

        if (!result.ok) {
          throw new Error(`refresh-access-token ${result.status}: ${result.body}`);
        }

        // Pull the rotated tokens out of the context cookie jar (set by Set-Cookie).
        await friendsPage.waitForTimeout(50); // tiny pause to let Set-Cookie commit
        const browserCookies = await context.cookies();
        let accessToken = '';
        let refreshToken = '';
        const parts: string[] = [];
        const seen = new Set<string>();
        for (const c of browserCookies) {
          if (c.name === 'auth-access-token') accessToken = c.value;
          if (c.name === 'auth-refresh-token') refreshToken = c.value;
          if (c.name.startsWith('auth-') || c.name === 'cf_clearance' || c.name === '__cf_bm') {
            if (!seen.has(c.name)) {
              seen.add(c.name);
              parts.push(`${c.name}=${c.value}`);
            }
          }
        }
        if (!accessToken) {
          throw new Error('refresh-access-token returned 200 but no new auth-access-token cookie set');
        }
        console.log(`[BrowserAuth] Refresh OK, new access token ${accessToken.slice(0, 20)}... (refresh ${refreshToken ? 'rotated' : 'kept'})`);
        return {
          accessToken,
          refreshToken: refreshToken || oldRefreshToken,
          cookies: parts.join('; '),
        };
      } finally {
        await context.clearCookies({ name: 'auth-access-token' });
        await context.clearCookies({ name: 'auth-refresh-token' });
      }
    },

    async bootstrapSession(walletAddress: string, accessToken: string, refreshToken: string): Promise<void> {
      // Mirror the HTTP burst the real React client fires on first page load.
      // Empirically: viewer counts drop accounts that haven't called these
      // endpoints — even when otherwise logged in. Calling them appears to
      // "register" the session server-side so cluster9 includes the user in
      // the e-{pair} broadcast.
      const domains = ['cluster9.axiom.trade', 'friends.axiom.trade', '.axiom.trade'];
      const cookiesToAdd: { name: string; value: string; domain: string; path: string }[] = [];
      for (const domain of domains) {
        cookiesToAdd.push(
          { name: 'auth-access-token', value: accessToken, domain, path: '/' },
          { name: 'auth-refresh-token', value: refreshToken, domain, path: '/' },
        );
      }
      await context.addCookies(cookiesToAdd);

      try {
        const results = await friendsPage.evaluate(async (wallet: string) => {
          const v = Date.now();
          const j = (url: string, init?: RequestInit) => fetch(url, { credentials: 'include', ...(init || {}) })
            .then(r => ({ url, status: r.status }))
            .catch((e: any) => ({ url, error: String(e?.message || e) }));
          const POST = (url: string, body: any) => j(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });

          // Order/grouping mirrors the bootstrap probe captured for a real client.
          return Promise.all([
            POST('https://api9.axiom.trade/bundle-key-and-wallets', { v }),
            POST('https://api9.axiom.trade/meme-open-positions-v3', { walletAddresses: [wallet], v }),
            POST('https://api9.axiom.trade/user-nonce-accounts', { userWallets: [wallet], v }),
            j('https://api9.axiom.trade/tracked-wallets-v3?v=' + v),
            j('https://api9.axiom.trade/watchlist-v2?v=' + v),
            j('https://api9.axiom.trade/get-settings?v=' + v),
            j('https://api9.axiom.trade/get-notifications?v=' + v),
            j('https://api9.axiom.trade/user-data?v=' + v),
            j('https://api9.axiom.trade/lighthouse?v=' + v),
            j('https://api9.axiom.trade/online-users-count?v=' + v),
          ]);
        }, walletAddress);

        const summary = (results as any[])
          .map(r => r.error ? `ERR(${r.url.split('/').pop()})` : `${r.url.split('/').pop()}=${r.status}`)
          .join(' ');
        console.log(`[BrowserAuth] bootstrap ${walletAddress.slice(0, 8)}... ${summary}`);
      } finally {
        await context.clearCookies({ name: 'auth-access-token' });
        await context.clearCookies({ name: 'auth-refresh-token' });
      }
    },

    async ensurePageSlots(n: number): Promise<void> {
      await ensurePageSlots(n);
    },

    async connectViewer(accessToken: string, refreshToken: string, tokenInfo: any, pingJitterMs?: number, slotIndex: number = 0): Promise<number> {
      // Pick a page from the pool; default to slot 0 for callers that don't
      // care. viewer-service passes its worker index so each worker owns a
      // distinct page → evaluates run truly in parallel.
      const page = friendsPages[slotIndex % friendsPages.length];

      // Set this account's auth cookies on every axiom subdomain we touch.
      // The WS handshake reads cookies from the matching domain, so the
      // auth-access-token must be present for cluster9, friends, AND
      // .axiom.trade (the wildcard, used as fallback).
      const domains = [
        'cluster9.axiom.trade',
        'friends.axiom.trade',
        '.axiom.trade',
      ];
      const cookiesToAdd: { name: string; value: string; domain: string; path: string }[] = [];
      for (const domain of domains) {
        cookiesToAdd.push(
          { name: 'auth-access-token', value: accessToken, domain, path: '/' },
          { name: 'auth-refresh-token', value: refreshToken, domain, path: '/' },
        );
      }

      const opts = { pingJitterMs: typeof pingJitterMs === 'number' ? pingJitterMs : Math.floor(Math.random() * 1000) };
      const viewerId = ++nextViewerId;

      // Cookie-locked critical section: addCookies → synchronously construct
      // the WS pair (so cookies are captured) → clear cookies. Lock is held
      // ~10-30ms total. The handshake (~700ms) runs OUTSIDE the lock, in
      // parallel across pool slots.
      const tStart = Date.now();
      await withCookieLock(async () => {
        await context.addCookies(cookiesToAdd);
        await page.evaluate(
          `window.__connectViewerStart(${viewerId}, ${JSON.stringify(tokenInfo)}, ${JSON.stringify(opts)})`
        );
        await context.clearCookies({ name: 'auth-access-token' });
        await context.clearCookies({ name: 'auth-refresh-token' });
      });
      const tStartDone = Date.now();

      // Wait for both WS handshakes to complete (no cookie lock held).
      await page.evaluate(`window.__connectViewerAwait(${viewerId})`);
      const tAwaitDone = Date.now();
      console.log(`[Timing] slot=${slotIndex} cookieLocked=${tStartDone - tStart}ms handshake=${tAwaitDone - tStartDone}ms`);

      viewerToPage.set(viewerId, page);
      console.log(`[BrowserAuth] Viewer ${viewerId} connected on slot ${slotIndex} (acct token=${accessToken.slice(0, 12)}..., pingJitter=${opts.pingJitterMs}ms)`);
      return viewerId;
    },

    async resolvePairFromCa(ca: string, accessToken?: string, refreshToken?: string): Promise<any | null> {
      // Real client: GET /clipboard-pair-info?address={CA}. This endpoint is
      // AUTHENTICATED — without a valid auth-access-token cookie it returns a
      // 502 with {"error":"Session invalid, please login again"} (not a host
      // outage). So set a logged-in account's cookies for the call — a
      // cookie-locked critical section, like every other authed op — then
      // clear them. CORS allow-origin is axiom.trade only, so the fetch MUST
      // run on friendsPage.
      const domains = ['cluster9.axiom.trade', 'friends.axiom.trade', '.axiom.trade'];
      if (accessToken) {
        const cookiesToAdd: { name: string; value: string; domain: string; path: string }[] = [];
        for (const domain of domains) {
          cookiesToAdd.push({ name: 'auth-access-token', value: accessToken, domain, path: '/' });
          if (refreshToken) cookiesToAdd.push({ name: 'auth-refresh-token', value: refreshToken, domain, path: '/' });
        }
        await context.addCookies(cookiesToAdd);
      }

      // A single apiN host can still 502 transiently; try a couple.
      const hosts = ['api9.axiom.trade', 'api7.axiom.trade', 'api2.axiom.trade'];
      try {
        for (const host of hosts) {
          try {
            const url = `https://${host}/clipboard-pair-info?address=${ca}&v=${Date.now()}`;
            const result = await friendsPage.evaluate(async (u) => {
              try {
                const r = await fetch(u, { credentials: 'include' });
                if (!r.ok) return { __err: 'status ' + r.status };
                return await r.json();
              } catch (e: any) {
                return { __err: 'fetch ' + (e?.message || String(e)) };
              }
            }, url);
            if (result && !(result as any).__err && (result as any).pairAddress) {
              console.log(`[BrowserAuth] resolvePairFromCa OK via ${host} pair=${(result as any).pairAddress}`);
              return result;
            }
            console.log(`[BrowserAuth] resolvePairFromCa ${host} -> ${(result as any)?.__err || 'no pairAddress'}`);
          } catch (e: any) {
            console.log(`[BrowserAuth] resolvePairFromCa evaluate error on ${host}:`, e.message);
          }
        }
        console.log('[BrowserAuth] resolvePairFromCa returned null for', ca);
        return null;
      } finally {
        if (accessToken) {
          await context.clearCookies({ name: 'auth-access-token' });
          await context.clearCookies({ name: 'auth-refresh-token' });
        }
      }
    },

    async disconnectViewer(viewerId: number): Promise<void> {
      const page = viewerToPage.get(viewerId) ?? friendsPage;
      await page.evaluate(`window.__disconnectViewer(${viewerId})`);
      viewerToPage.delete(viewerId);
    },

    async disconnectAllViewers(): Promise<void> {
      await Promise.all(friendsPages.map(p => p.evaluate('window.__disconnectAll()')));
      viewerToPage.clear();
      console.log('[BrowserAuth] All viewers disconnected');
    },

    async getActiveViewerCount(): Promise<number> {
      const counts = await Promise.all(friendsPages.map(p => p.evaluate('window.__activeCount()') as Promise<number>));
      return counts.reduce((a, b) => a + b, 0);
    },

    async getCfData(): Promise<{ cfCookies: string; userAgent: string }> {
      // Get the exact user-agent from the browser
      const userAgent = await page.evaluate('navigator.userAgent') as string;

      // Get CF cookies from all axiom domains
      const allCookies = await context.cookies();
      const cfParts: string[] = [];
      const seen = new Set<string>();
      for (const c of allCookies) {
        if ((c.name === 'cf_clearance' || c.name === '__cf_bm') && !seen.has(c.name)) {
          seen.add(c.name);
          cfParts.push(`${c.name}=${c.value}`);
        }
      }

      console.log('[BrowserAuth] CF data: UA=' + userAgent.slice(0, 50) + '..., cookies=' + cfParts.length);
      return { cfCookies: cfParts.join('; '), userAgent };
    },

    async close(): Promise<void> {
      console.log('[BrowserAuth] Closing browser');
      try { await browser.close(); } catch {}
      try { chromeProc.kill(); } catch {}
      setTimeout(() => {
        try { fs.rmSync(tmpProfile, { recursive: true, force: true, maxRetries: 3 }); } catch {}
      }, 2000);
    },
  };
}
